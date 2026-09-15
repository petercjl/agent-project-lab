import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import pg from "pg";

const suffix = `${process.pid}_${Date.now()}`;
const database = `project_lab_auth_${suffix}`;
const appPort = 4321;
const mockPort = 4322;
const admin = new pg.Client({
  connectionString: "postgresql://localhost:55432/postgres",
});
await admin.connect();
await admin.query(`CREATE DATABASE ${database}`);

let tokenCalls = 0;
let profileCalls = 0;
const mock = createServer(async (req, res) => {
  if (req.url === "/v1.0/oauth2/userAccessToken" && req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.clientId, "test-client");
    assert.equal(body.clientSecret, "test-secret");
    assert.ok(["valid-code", "other-corp-code"].includes(body.code));
    assert.equal(body.grantType, "authorization_code");
    tokenCalls++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        accessToken: "mock-user-token",
        corpId:
          body.code === "other-corp-code"
            ? "other-corp"
            : "corp-verified",
      }),
    );
    return;
  }
  if (req.url === "/v1.0/contact/users/me" && req.method === "GET") {
    assert.equal(req.headers["x-acs-dingtalk-access-token"], "mock-user-token");
    profileCalls++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        unionId: "union-first-admin",
        openId: "open-first-admin",
        nick: "本地认证测试员工",
      }),
    );
    return;
  }
  res.statusCode = 404;
  res.end();
});
await new Promise<void>((resolve) =>
  mock.listen(mockPort, "127.0.0.1", resolve),
);

const server = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
  env: {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(appPort),
    DATABASE_URL: `postgresql://localhost:55432/${database}`,
    DATA_DIR: `data/auth-verification-${suffix}`,
    AUTH_MODE: "dingtalk",
    DINGTALK_CLIENT_ID: "test-client",
    DINGTALK_CLIENT_SECRET: "test-secret",
    DINGTALK_CORP_ID: "corp-verified",
    DINGTALK_REDIRECT_URI: `http://127.0.0.1:${appPort}/api/auth/dingtalk/callback`,
    DINGTALK_BOOTSTRAP_FIRST_ADMIN: "true",
    DINGTALK_TEST_API_BASE_URL: `http://127.0.0.1:${mockPort}`,
    DINGTALK_TEST_LOGIN_BASE_URL: `http://127.0.0.1:${mockPort}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", (chunk) => (logs += chunk));
server.stderr.on("data", (chunk) => (logs += chunk));
const base = `http://127.0.0.1:${appPort}`;
let checks = 0;

function cookieHeader(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

try {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) break;
    } catch {}
    if (attempt === 49) throw new Error(logs || "认证测试服务启动失败");
    await delay(200);
  }

  const anonymous = await fetch(`${base}/api/state`);
  assert.equal(anonymous.status, 401);
  checks++;

  const start = await fetch(`${base}/api/auth/dingtalk/start?returnTo=/`, {
    redirect: "manual",
  });
  assert.equal(start.status, 302);
  const authorization = new URL(start.headers.get("location")!);
  assert.equal(authorization.origin, `http://127.0.0.1:${mockPort}`);
  assert.equal(authorization.searchParams.get("scope"), "openid corpid");
  const state = authorization.searchParams.get("state")!;
  const stateCookies = cookieHeader(start);
  assert.match(stateCookies, /project_lab_oauth_state=/);
  checks += 2;

  const callback = await fetch(
    `${base}/api/auth/dingtalk/callback?authCode=valid-code&state=${encodeURIComponent(state)}`,
    { headers: { cookie: stateCookies }, redirect: "manual" },
  );
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/");
  const sessionCookie = callback.headers
    .getSetCookie()
    .find((value) => value.startsWith("project_lab_session="))!
    .split(";", 1)[0];
  assert(sessionCookie);
  assert.equal(tokenCalls, 1);
  assert.equal(profileCalls, 1);
  checks += 2;

  const session = await fetch(`${base}/api/auth/session`, {
    headers: { cookie: sessionCookie },
  }).then((response) => response.json());
  assert.equal(session.data.authenticated, true);
  assert.equal(session.data.memberId, "supervisor");
  assert.equal(session.data.name, "本地认证测试员工");
  checks++;

  assert.equal(
    (
      await fetch(`${base}/api/state`, {
        headers: { cookie: sessionCookie },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${base}/api/state`, {
        headers: {
          authorization: "Bearer test-agent-token",
          "x-actor": "agent",
        },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${base}/api/state`, {
        headers: { authorization: "Bearer wrong-token" },
      })
    ).status,
    401,
  );
  checks += 3;

  const verifier = "device-verifier-for-auth-test";
  const verifierHash = createHash("sha256").update(verifier).digest("hex");
  const cliStart = await fetch(`${base}/api/auth/cli/start`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ verifierHash, clientName: "procli/test" }),
  }).then((response) => response.json());
  assert.equal(cliStart.ok, true);
  const requestId = cliStart.data.requestId;
  assert.equal(
    cliStart.data.verificationUrl,
    `${base}/api/auth/cli/authorize?request=${encodeURIComponent(requestId)}`,
  );
  const authorizePage = await fetch(cliStart.data.verificationUrl, {
    headers: { cookie: sessionCookie },
  });
  assert.equal(authorizePage.status, 200);
  assert.match(await authorizePage.text(), /确认授权/);
  checks += 2;

  const authorize = await fetch(`${base}/api/auth/cli/authorize`, {
    method: "POST",
    headers: {
      cookie: sessionCookie,
      origin: base,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ request: requestId }),
  });
  assert.equal(authorize.status, 200);
  checks++;

  const wrongPoll = await fetch(`${base}/api/auth/cli/poll`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ requestId, verifier: "wrong" }),
  });
  const wrongPollBody = await wrongPoll.json();
  assert.equal(wrongPoll.status, 403, JSON.stringify(wrongPollBody));
  const cliPoll = await fetch(`${base}/api/auth/cli/poll`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ requestId, verifier }),
  }).then((response) => response.json());
  assert.equal(cliPoll.ok, true);
  assert.equal(cliPoll.data.member.id, "supervisor");
  const cliToken = cliPoll.data.token;
  assert.match(cliToken, /^pro_/);
  checks += 2;

  const cliStatus = await fetch(`${base}/api/auth/cli/status`, {
    headers: { authorization: `Bearer ${cliToken}` },
  }).then((response) => response.json());
  assert.equal(cliStatus.data.authenticated, true);
  assert.equal(cliStatus.data.member.id, "supervisor");
  assert.equal(
    (
      await fetch(`${base}/api/state`, {
        headers: { authorization: `Bearer ${cliToken}` },
      })
    ).status,
    200,
  );
  checks += 2;

  assert.equal(
    (
      await fetch(`${base}/api/auth/cli/revoke`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${cliToken}`,
          origin: base,
          "content-type": "application/json",
        },
        body: "{}",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${base}/api/state`, {
        headers: { authorization: `Bearer ${cliToken}` },
      })
    ).status,
    401,
  );
  checks += 2;

  const otherCorpStart = await fetch(
    `${base}/api/auth/dingtalk/start?returnTo=/`,
    { redirect: "manual" },
  );
  const otherCorpAuthorization = new URL(
    otherCorpStart.headers.get("location")!,
  );
  const otherCorpCallback = await fetch(
    `${base}/api/auth/dingtalk/callback?authCode=other-corp-code&state=${encodeURIComponent(otherCorpAuthorization.searchParams.get("state")!)}`,
    {
      headers: { cookie: cookieHeader(otherCorpStart) },
      redirect: "manual",
    },
  );
  assert.equal(otherCorpCallback.status, 302);
  assert.match(
    decodeURIComponent(otherCorpCallback.headers.get("location")!),
    /请选择本企业账号登录/,
  );
  checks += 2;

  const invalidState = await fetch(
    `${base}/api/auth/dingtalk/callback?authCode=valid-code&state=wrong`,
    { redirect: "manual" },
  );
  assert.equal(invalidState.status, 302);
  assert.match(invalidState.headers.get("location")!, /authError=/);
  checks++;

  const logout = await fetch(`${base}/api/auth/logout`, {
    method: "POST",
    headers: {
      cookie: sessionCookie,
      origin: base,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(logout.status, 200);
  assert.equal(
    (
      await fetch(`${base}/api/state`, {
        headers: { cookie: sessionCookie },
      })
    ).status,
    401,
  );
  checks++;

  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  server.kill("SIGTERM");
  await delay(200);
  await new Promise<void>((resolve) => mock.close(() => resolve()));
  await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await admin.end();
}
