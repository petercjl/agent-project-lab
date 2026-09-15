import type { Express, Request, Response, NextFunction } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { pool, read, change } from "./store.ts";
import { Fault, uid } from "./domain.ts";

const sessionCookie = "project_lab_session";
const stateCookie = "project_lab_oauth_state";

export function authMode() {
  const mode = process.env.AUTH_MODE || "dingtalk";
  if (!["dingtalk", "development"].includes(mode))
    throw new Error("AUTH_MODE 必须是 dingtalk 或 development");
  return mode as "dingtalk" | "development";
}

export function authConfig() {
  const testing = process.env.NODE_ENV === "test";
  return {
    mode: authMode(),
    clientId: process.env.DINGTALK_CLIENT_ID || "",
    clientSecret: process.env.DINGTALK_CLIENT_SECRET || "",
    redirectUri:
      process.env.DINGTALK_REDIRECT_URI ||
      "http://127.0.0.1:4317/api/auth/dingtalk/callback",
    corpId: process.env.DINGTALK_CORP_ID || "",
    adminUnionId: process.env.DINGTALK_ADMIN_UNION_ID || "",
    bootstrapFirstAdmin: process.env.DINGTALK_BOOTSTRAP_FIRST_ADMIN === "true",
    agentToken: process.env.AGENT_API_TOKEN || "",
    sessionDays: Math.min(
      30,
      Math.max(1, Number(process.env.AUTH_SESSION_DAYS || 7)),
    ),
    loginBaseUrl:
      (testing && process.env.DINGTALK_TEST_LOGIN_BASE_URL) ||
      "https://login.dingtalk.com",
    apiBaseUrl:
      (testing && process.env.DINGTALK_TEST_API_BASE_URL) ||
      "https://api.dingtalk.com",
  };
}

export function safeReturnTo(input: unknown) {
  const value = typeof input === "string" ? input : "/";
  return value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export function buildAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  loginBaseUrl = "https://login.dingtalk.com",
) {
  const url = new URL("/oauth2/auth", loginBaseUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("scope", "openid corpid");
  return url.toString();
}

function cookies(req: Request) {
  const result: Record<string, string> = {};
  for (const item of String(req.headers.cookie || "").split(";")) {
    const at = item.indexOf("=");
    if (at < 1) continue;
    try {
      result[item.slice(0, at).trim()] = decodeURIComponent(
        item.slice(at + 1).trim(),
      );
    } catch {}
  }
  return result;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function equal(a: string, b: string) {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function secureCookie(req: Request) {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

async function sessionIdentity(req: Request) {
  const token = cookies(req)[sessionCookie];
  if (!token) return null;
  const result = await pool.query(
    `SELECT u.id,u.name,u.avatar_url AS "avatarUrl",u.member_id AS "memberId",
            u.union_id AS "unionId",u.open_id AS "openId",u.corp_id AS "corpId",
            s.expires_at AS "expiresAt"
       FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>now()`,
    [hash(token)],
  );
  if (!result.rowCount) return null;
  await pool.query(
    "UPDATE auth_sessions SET last_seen_at=now() WHERE token_hash=$1",
    [hash(token)],
  );
  return { kind: "dingtalk", ...result.rows[0] };
}

async function apiTokenIdentity(raw: string) {
  if (!raw) return null;
  const result = await pool.query(
    `SELECT u.id,u.name,u.avatar_url AS "avatarUrl",u.member_id AS "memberId",
            u.union_id AS "unionId",u.open_id AS "openId",u.corp_id AS "corpId",
            t.expires_at AS "expiresAt",t.client_name AS "clientName"
       FROM api_tokens t JOIN auth_users u ON u.id=t.user_id
      WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND t.expires_at>now()`,
    [hash(raw)],
  );
  if (!result.rowCount) return null;
  await pool.query(
    "UPDATE api_tokens SET last_used_at=now() WHERE token_hash=$1",
    [hash(raw)],
  );
  return { kind: "cli", ...result.rows[0] };
}

function bearerToken(req: Request) {
  const authorization = String(req.headers.authorization || "");
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}

async function requestJson(url: string, init: RequestInit, label: string) {
  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new Fault("DINGTALK_UNAVAILABLE", `${label}暂时不可用`, 502);
  }
  if (!response.ok)
    throw new Fault("DINGTALK_AUTH_FAILED", `${label}失败`, 502);
  return response.json() as Promise<any>;
}

async function provisionUser(token: any, profile: any) {
  const cfg = authConfig();
  const unionId = String(profile.unionId || profile.unionid || "");
  const openId = String(profile.openId || profile.openid || "");
  const identityKey = unionId || openId;
  if (!identityKey)
    throw new Fault("DINGTALK_IDENTITY_MISSING", "钉钉未返回稳定用户标识", 502);
  const corpId = String(token.corpId || profile.corpId || "");
  if (cfg.corpId && corpId !== cfg.corpId)
    throw new Fault("CORP_NOT_ALLOWED", "请选择本企业账号登录", 403);
  const name = String(profile.nick || profile.name || "钉钉用户").slice(0, 100);
  const rawAvatarUrl = String(profile.avatarUrl || "").slice(0, 1000);
  const avatarUrl = /^https:\/\//.test(rawAvatarUrl) ? rawAvatarUrl : "";
  const found = await pool.query(
    'SELECT id,member_id AS "memberId" FROM auth_users WHERE union_id=$1',
    [identityKey],
  );
  let id = found.rows[0]?.id as string | undefined;
  let memberId = found.rows[0]?.memberId as string | undefined;
  if (!id) {
    const count = Number(
      (await pool.query("SELECT count(*) FROM auth_users")).rows[0].count,
    );
    const isAdmin =
      cfg.adminUnionId === identityKey ||
      (count === 0 && cfg.bootstrapFirstAdmin);
    memberId = isAdmin ? "supervisor" : `dt_${hash(identityKey).slice(0, 20)}`;
    await change(
      memberId,
      "",
      `auth.provision.${identityKey}`,
      (state: any) => {
        const member = state.members.find((m: any) => m.id === memberId);
        if (member) {
          member.name = name;
          member.dingtalkUnionId = unionId || null;
          member.dingtalkOpenId = openId || null;
        } else {
          state.members.push({
            id: memberId,
            name,
            role: isAdmin ? "reviewer" : "member",
            dingtalkUnionId: unionId || null,
            dingtalkOpenId: openId || null,
          });
        }
      },
    );
    id = uid();
    await pool.query(
      `INSERT INTO auth_users(id,union_id,open_id,corp_id,name,avatar_url,member_id)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        identityKey,
        openId || null,
        corpId || null,
        name,
        avatarUrl || null,
        memberId,
      ],
    );
  } else {
    await change(memberId!, "", `auth.refresh.${identityKey}`, (state: any) => {
      const member = state.members.find((item: any) => item.id === memberId);
      if (member) {
        member.name = name;
        member.dingtalkUnionId = unionId || null;
        member.dingtalkOpenId = openId || null;
      }
    });
    await pool.query(
      `UPDATE auth_users SET open_id=$2,corp_id=$3,name=$4,avatar_url=$5,last_login_at=now()
        WHERE id=$1`,
      [id, openId || null, corpId || null, name, avatarUrl || null],
    );
  }
  return { id, memberId, name, avatarUrl, unionId, openId, corpId };
}

async function createSession(userId: string) {
  const raw = randomBytes(32).toString("base64url");
  const days = authConfig().sessionDays;
  await pool.query(
    `INSERT INTO auth_sessions(token_hash,user_id,expires_at)
     VALUES($1,$2,now()+($3 || ' days')::interval)`,
    [hash(raw), userId, String(days)],
  );
  return { raw, maxAge: days * 86400 * 1000 };
}

export function installAuth(app: Express) {
  if (process.env.TRUST_PROXY === "true") app.set("trust proxy", 1);

  app.get("/api/auth/session", async (req: any, res, next) => {
    try {
      const cfg = authConfig();
      if (cfg.mode === "development") {
        const state = await read();
        const memberId = String(req.headers["x-actor"] || "supervisor");
        const member =
          state.members.find((m: any) => m.id === memberId) || state.members[0];
        return res.json({
          ok: true,
          data: {
            authenticated: true,
            mode: cfg.mode,
            memberId: member.id,
            name: member.name,
          },
        });
      }
      const identity = await sessionIdentity(req);
      res.json({
        ok: true,
        data: identity
          ? {
              authenticated: true,
              mode: cfg.mode,
              kind: identity.kind,
              memberId: identity.memberId,
              name: identity.name,
              avatarUrl: identity.avatarUrl,
              expiresAt: identity.expiresAt,
            }
          : {
              authenticated: false,
              mode: cfg.mode,
              configured: Boolean(
                cfg.clientId && cfg.clientSecret && cfg.corpId,
              ),
            },
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/auth/dingtalk/start", (req, res, next) => {
    try {
      const cfg = authConfig();
      if (cfg.mode !== "dingtalk")
        throw new Fault("AUTH_MODE", "当前不是钉钉认证模式", 409);
      if (!cfg.clientId || !cfg.clientSecret || !cfg.corpId)
        throw new Fault(
          "AUTH_NOT_CONFIGURED",
          "尚未完整配置钉钉应用凭证和企业 Corp ID",
          503,
        );
      const state = randomBytes(24).toString("base64url");
      const cookieOptions = {
        httpOnly: true,
        sameSite: "lax" as const,
        secure: secureCookie(req),
        maxAge: 10 * 60 * 1000,
        path: "/api/auth/dingtalk/callback",
      };
      res.cookie(stateCookie, state, cookieOptions);
      res.cookie(
        "project_lab_return_to",
        safeReturnTo(req.query.returnTo),
        cookieOptions,
      );
      res.redirect(
        buildAuthorizeUrl(
          cfg.clientId,
          cfg.redirectUri,
          state,
          cfg.loginBaseUrl,
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/auth/dingtalk/callback", async (req, res, next) => {
    try {
      const jar = cookies(req);
      const returnedState = String(req.query.state || "");
      if (
        !jar[stateCookie] ||
        !returnedState ||
        !equal(jar[stateCookie], returnedState)
      )
        throw new Fault(
          "OAUTH_STATE_INVALID",
          "登录状态已失效，请重新发起登录",
          400,
        );
      res.clearCookie(stateCookie, { path: "/api/auth/dingtalk/callback" });
      const code = String(req.query.authCode || req.query.code || "");
      if (!code || req.query.error)
        throw new Fault("OAUTH_DENIED", "钉钉授权未完成", 401);
      const cfg = authConfig();
      const token = await requestJson(
        `${cfg.apiBaseUrl}/v1.0/oauth2/userAccessToken`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientId: cfg.clientId,
            clientSecret: cfg.clientSecret,
            code,
            grantType: "authorization_code",
          }),
        },
        "获取钉钉用户凭证",
      );
      const profile = await requestJson(
        `${cfg.apiBaseUrl}/v1.0/contact/users/me`,
        {
          method: "GET",
          headers: {
            "x-acs-dingtalk-access-token": token.accessToken,
          },
        },
        "获取钉钉用户信息",
      );
      const user = await provisionUser(token, profile);
      const session = await createSession(user.id!);
      res.cookie(sessionCookie, session.raw, {
        httpOnly: true,
        sameSite: "lax",
        secure: secureCookie(req),
        maxAge: session.maxAge,
        path: "/",
      });
      const returnTo = safeReturnTo(jar.project_lab_return_to);
      res.clearCookie("project_lab_return_to", {
        path: "/api/auth/dingtalk/callback",
      });
      res.redirect(returnTo);
    } catch (error: any) {
      const message =
        error instanceof Fault ? error.message : "登录失败，请稍后重试";
      res.clearCookie(stateCookie, { path: "/api/auth/dingtalk/callback" });
      res.clearCookie("project_lab_return_to", {
        path: "/api/auth/dingtalk/callback",
      });
      res.redirect(`/?authError=${encodeURIComponent(message)}`);
    }
  });

  app.post("/api/auth/logout", async (req, res, next) => {
    try {
      const token = cookies(req)[sessionCookie];
      if (token)
        await pool.query("DELETE FROM auth_sessions WHERE token_hash=$1", [
          hash(token),
        ]);
      res.clearCookie(sessionCookie, { path: "/" });
      res.json({ ok: true, data: { loggedOut: true } });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/cli/start", async (req, res, next) => {
    try {
      const verifierHash = String(req.body.verifierHash || "");
      if (!/^[a-f0-9]{64}$/.test(verifierHash))
        throw new Fault("VALIDATION", "无效的 CLI 授权校验值");
      const clientName = String(req.body.clientName || "procli").slice(0, 100);
      const requestId = randomBytes(24).toString("base64url");
      await pool.query(
        `INSERT INTO cli_auth_requests(request_id,verifier_hash,client_name,expires_at)
         VALUES($1,$2,$3,now()+interval '10 minutes')`,
        [requestId, verifierHash, clientName],
      );
      const origin = `${req.protocol}://${req.get("host")}`;
      res.json({
        ok: true,
        data: {
          requestId,
          verificationUrl: `${origin}/api/auth/cli/authorize?request=${encodeURIComponent(requestId)}`,
          intervalMs: 1500,
          expiresIn: 600,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/auth/cli/authorize", async (req, res, next) => {
    try {
      const requestId = String(req.query.request || "");
      if (!/^[A-Za-z0-9_-]{20,80}$/.test(requestId))
        throw new Fault("AUTH_REQUEST_INVALID", "CLI 授权请求无效", 400);
      const found = await pool.query(
        "SELECT status,expires_at FROM cli_auth_requests WHERE request_id=$1 AND expires_at>now()",
        [requestId],
      );
      if (!found.rowCount)
        throw new Fault("AUTH_REQUEST_EXPIRED", "CLI 授权请求已失效", 410);
      const identity = await sessionIdentity(req);
      if (!identity) {
        const returnTo = `/api/auth/cli/authorize?request=${encodeURIComponent(requestId)}`;
        return res.redirect(
          `/api/auth/dingtalk/start?returnTo=${encodeURIComponent(returnTo)}`,
        );
      }
      if (found.rows[0].status === "approved")
        return res.type("html").send("<!doctype html><meta charset=utf-8><title>procli 已授权</title><h1>procli 已授权</h1><p>可以返回终端继续使用。</p>");
      res.type("html").send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>授权 procli</title><style>body{font-family:system-ui;max-width:520px;margin:12vh auto;padding:24px;color:#172033}button{padding:12px 24px;background:#2563eb;color:white;border:0;border-radius:8px;font-size:16px}</style><h1>授权 procli</h1><p>当前钉钉身份：${String(identity.name).replace(/[<>&"]/g, "")}</p><p>授权后，procli 将以你的项目成员身份操作所选环境。</p><form method="post"><input type="hidden" name="request" value="${requestId}"><button type="submit">确认授权</button></form></html>`);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/cli/authorize", async (req, res, next) => {
    try {
      const requestId = String(req.body.request || "");
      const identity = await sessionIdentity(req);
      if (!identity) throw new Fault("AUTH_REQUIRED", "请先使用钉钉账号登录", 401);
      const result = await pool.query(
        `UPDATE cli_auth_requests SET user_id=$2,status='approved'
          WHERE request_id=$1 AND status='pending' AND expires_at>now()
          RETURNING request_id`,
        [requestId, identity.id],
      );
      if (!result.rowCount)
        throw new Fault("AUTH_REQUEST_EXPIRED", "CLI 授权请求已失效", 410);
      res.type("html").send("<!doctype html><meta charset=utf-8><title>procli 授权成功</title><h1>授权成功</h1><p>可以关闭此页面并返回终端。</p>");
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/cli/poll", async (req, res, next) => {
    const client = await pool.connect();
    try {
      const requestId = String(req.body.requestId || "");
      const verifier = String(req.body.verifier || "");
      await client.query("BEGIN");
      const found = await client.query(
        `SELECT verifier_hash,client_name,user_id,status,expires_at
           FROM cli_auth_requests WHERE request_id=$1 FOR UPDATE`,
        [requestId],
      );
      if (!found.rowCount || found.rows[0].expires_at <= new Date())
        throw new Fault("AUTH_REQUEST_EXPIRED", "CLI 授权请求已失效", 410);
      if (!equal(hash(verifier), String(found.rows[0].verifier_hash)))
        throw new Fault("AUTH_REQUEST_INVALID", "CLI 授权校验失败", 403);
      if (found.rows[0].status !== "approved" || !found.rows[0].user_id) {
        await client.query("COMMIT");
        return res.status(202).json({ ok: true, data: { status: "pending" } });
      }
      const raw = `pro_${randomBytes(36).toString("base64url")}`;
      const expiresAt = new Date(Date.now() + 90 * 86400 * 1000);
      const user = await client.query(
        `SELECT name,member_id AS "memberId" FROM auth_users WHERE id=$1`,
        [found.rows[0].user_id],
      );
      if (!user.rowCount)
        throw new Fault("AUTH_REQUIRED", "授权用户不存在", 401);
      await client.query(
        `INSERT INTO api_tokens(token_hash,user_id,client_name,expires_at)
         VALUES($1,$2,$3,$4)`,
        [hash(raw), found.rows[0].user_id, found.rows[0].client_name, expiresAt],
      );
      await client.query("DELETE FROM cli_auth_requests WHERE request_id=$1", [
        requestId,
      ]);
      await client.query("COMMIT");
      res.json({
        ok: true,
        data: {
          token: raw,
          expiresAt: expiresAt.toISOString(),
          member: {
            id: user.rows[0].memberId,
            name: user.rows[0].name,
          },
        },
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      next(error);
    } finally {
      client.release();
    }
  });

  app.get("/api/auth/cli/status", async (req, res, next) => {
    try {
      const identity = await apiTokenIdentity(bearerToken(req));
      if (!identity) throw new Fault("AUTH_REQUIRED", "procli 尚未登录或凭证已失效", 401);
      res.json({
        ok: true,
        data: {
          authenticated: true,
          member: { id: identity.memberId, name: identity.name },
          clientName: identity.clientName,
          expiresAt: identity.expiresAt,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/cli/revoke", async (req, res, next) => {
    try {
      const raw = bearerToken(req);
      const identity = await apiTokenIdentity(raw);
      if (!identity) throw new Fault("AUTH_REQUIRED", "procli 尚未登录或凭证已失效", 401);
      await pool.query("UPDATE api_tokens SET revoked_at=now() WHERE token_hash=$1", [
        hash(raw),
      ]);
      res.json({ ok: true, data: { revoked: true } });
    } catch (error) {
      next(error);
    }
  });

  app.use("/api", async (req: any, res: Response, next: NextFunction) => {
    try {
      if (
        req.path === "/health" ||
        req.path === "/capabilities" ||
        req.path.startsWith("/auth/")
      )
        return next();
      const cfg = authConfig();
      if (cfg.mode === "development") {
        req.auth = {
          kind: "development",
          memberId: String(req.headers["x-actor"] || "supervisor"),
        };
        return next();
      }
      const bearer = bearerToken(req);
      if (bearer && cfg.agentToken && equal(bearer, cfg.agentToken)) {
        req.auth = {
          kind: "agent",
          memberId: String(req.headers["x-actor"] || "agent"),
        };
        return next();
      }
      const cliIdentity = await apiTokenIdentity(bearer);
      if (cliIdentity) {
        req.auth = cliIdentity;
        return next();
      }
      const identity = await sessionIdentity(req);
      if (!identity)
        throw new Fault("AUTH_REQUIRED", "请使用钉钉账号登录", 401);
      req.auth = identity;
      next();
    } catch (error) {
      next(error);
    }
  });
}
