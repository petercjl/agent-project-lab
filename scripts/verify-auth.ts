import { spawn } from "node:child_process";
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
    assert.deepEqual(body, {
      clientId: "test-client",
      clientSecret: "test-secret",
      code: "valid-code",
      grantType: "authorization_code",
    });
    tokenCalls++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        accessToken: "mock-user-token",
        corpId: "corp-verified",
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
    AGENT_API_TOKEN: "test-agent-token",
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
    200,
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
