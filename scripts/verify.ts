import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import pg from "pg";
import { chromium } from "playwright";
const admin = new pg.Client({
  connectionString: "postgresql://localhost:55432/postgres",
});
await admin.connect();
if (
  !(
    await admin.query(
      "SELECT 1 FROM pg_database WHERE datname='project_lab_verification'",
    )
  ).rowCount
)
  await admin.query("CREATE DATABASE project_lab_verification");
await admin.end();
const server = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
  env: {
    ...process.env,
    PORT: "4318",
    DATABASE_URL: "postgresql://localhost:55432/project_lab_verification",
    DATA_DIR: "data/verification",
    AUTH_MODE: "development",
    DINGTALK_WEBHOOK: "",
    DINGTALK_SECRET: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", (b) => (logs += b));
server.stderr.on("data", (b) => (logs += b));
const base = "http://127.0.0.1:4318/api";
let checks = 0;
async function api(
  url: string,
  method = "GET",
  body?: any,
  actor = "agent",
  key = "",
) {
  const res = await fetch(base + url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-actor": actor,
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { ...(await res.json()), status: res.status };
}
async function ok(
  url: string,
  method = "GET",
  body?: any,
  actor = "agent",
  key = "",
) {
  const r = await api(url, method, body, actor, key);
  assert.equal(r.ok, true, JSON.stringify(r));
  checks++;
  return r.data;
}
let browser: any;
try {
  for (let i = 0; i < 50; i++) {
    try {
      await ok("/health");
      break;
    } catch {
      if (i === 49) throw Error(logs);
      await delay(200);
    }
  }
  const key = "verify-" + Date.now(),
    p = await ok(
      "/projects",
      "POST",
      { name: "自动验收项目 " + key, goal: "自动测试，不代表真实业务" },
      "agent",
      key,
    );
  assert.equal(
    (
      await ok(
        "/projects",
        "POST",
        { name: p.name, goal: p.goal },
        "agent",
        key,
      )
    ).id,
    p.id,
  );
  assert.equal(
    (await api("/projects", "POST", { name: "different" }, "agent", key)).error
      .code,
    "IDEMPOTENCY_CONFLICT",
  );
  checks++;
  let s = await ok("/state");
  const ts = s.tasks.filter((t: any) => t.projectId === p.id),
    t = ts[0],
    next = ts[1];
  assert.equal(ts.length, 7);
  assert.equal(
    (await api(`/tasks/${next.id}/actions/start`, "POST", {})).error.code,
    "DEPENDENCY_BLOCKED",
  );
  checks++;
  await ok(`/tasks/${t.id}/actions/start`, "POST", {});
  assert.equal(
    (await api(`/tasks/${t.id}/actions/submit`, "POST", {})).error.code,
    "EVIDENCE_REQUIRED",
  );
  checks++;
  const content =
    "# 自动验收交付\n\n这是一份固定输入的软件测试文档，不是市场调研结论。\n\n## 输入依据\n模拟数据仅用于测试提交、审核、搜索与版本恢复。";
  const page = await ok(`/projects/${p.id}/wiki`, "PUT", {
    path: t.wikiPath,
    content,
    version: 1,
  });
  assert.equal(
    (
      await api(`/projects/${p.id}/wiki`, "PUT", {
        path: t.wikiPath,
        content: "stale",
        version: 1,
      })
    ).error.code,
    "VERSION_CONFLICT",
  );
  checks++;
  const pg2 = await ok(`/projects/${p.id}/wiki`, "PUT", {
    path: t.wikiPath,
    content: content + "\n\n新增第二版说明。",
    version: page.version,
  });
  assert.equal(pg2.history.length, 2);
  assert.equal(
    (
      await ok(
        `/projects/${p.id}/wiki?path=${encodeURIComponent(pg2.history[1].path)}`,
      )
    ).content,
    content,
  );
  assert.equal(
    (await ok(`/projects/${p.id}/search?q=${encodeURIComponent("固定输入")}`))
      .length,
    1,
  );
  assert.equal(
    (
      await api(`/projects/${p.id}/wiki`, "PUT", {
        path: "wiki/../../escape.md",
        content,
      })
    ).error.code,
    "UNSAFE_PATH",
  );
  checks++;
  const run = await ok("/runs", "POST", {
    taskId: t.id,
    skill: "固定输入软件验收",
    skillVersion: "1.0.0",
    input: "模拟文档",
  });
  await ok(`/runs/${run.id}`, "PATCH", {
    status: "completed",
    output: "交付物已写入 Wiki",
    quality: "软件验收，非业务研究",
  });
  const blob = new FormData();
  blob.append("file", new Blob(["test artifact"]), "test.txt");
  const upload = await fetch(base + `/tasks/${t.id}/artifacts`, {
    method: "POST",
    body: blob,
    headers: { "x-actor": "agent" },
  }).then((r) => r.json());
  assert.equal(upload.ok, true);
  checks++;
  await ok(`/tasks/${t.id}/actions/submit`, "POST", {});
  assert.equal(
    (await api(`/tasks/${t.id}/actions/approve`, "POST", {})).error.code,
    "REVIEWER_REQUIRED",
  );
  checks++;
  await ok(
    `/tasks/${t.id}/actions/reject`,
    "POST",
    { reason: "验证退回流程" },
    "supervisor",
  );
  await ok(`/tasks/${t.id}/actions/submit`, "POST", {});
  await ok(`/tasks/${t.id}/actions/approve`, "POST", {}, "supervisor");
  s = await ok("/state");
  assert(
    s.notifications.some(
      (n: any) => n.taskId === next.id && n.recipient === "market",
    ),
  );
  checks++;
  assert.equal(
    (
      await api(`/tasks/${next.id}`, "PATCH", {
        version: 1,
        dependencies: [ts[6].id],
      })
    ).error.code,
    "DEPENDENCY_CYCLE",
  );
  checks++;
  assert.equal(
    (await api(`/tasks/${t.id}`, "PATCH", { version: 1, title: "stale" })).error
      .code,
    "VERSION_CONFLICT",
  );
  checks++;
  const pack = await ok(`/projects/${p.id}/export`);
  const restored = await ok("/projects/restore", "POST", pack);
  const reexport = await ok(`/projects/${restored.id}/export`);
  assert.notEqual(restored.id, p.id);
  assert.deepEqual(reexport.files[t.wikiPath], pack.files[t.wikiPath]);
  assert.equal(
    reexport.data.tasks[1].dependencies[0],
    reexport.data.tasks[0].id,
  );
  assert.equal(
    reexport.data.artifacts[0].sha256,
    pack.data.artifacts[0].sha256,
  );
  checks += 3;
  const bad = structuredClone(pack);
  bad.files["../outside.txt"] = "aGVsbG8=";
  assert.equal(
    (await api("/projects/restore", "POST", bad)).error.code,
    "UNSAFE_PATH",
  );
  checks++;
  const rev = (await ok("/state")).revision;
  const procliHome = await fs.mkdtemp(path.join(os.tmpdir(), "procli-verify-"));
  const procliConfig = path.join(procliHome, "config.json");
  execFileSync(
    process.execPath,
    [
      "packages/procli/bin/procli.mjs",
      "profile",
      "add",
      "local",
      "--url",
      "http://127.0.0.1:4318",
      "--environment",
      "development",
    ],
    { encoding: "utf8", env: { ...process.env, PROCLI_CONFIG_PATH: procliConfig } },
  );
  const dry = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "packages/procli/bin/procli.mjs",
        "--profile",
        "local",
        "project",
        "create",
        "--name",
        "dry",
        "--dry-run",
      ],
      { encoding: "utf8", env: { ...process.env, PROCLI_CONFIG_PATH: procliConfig } },
    ),
  );
  assert.equal(dry.data.dryRun, true);
  assert.equal((await ok("/state")).revision, rev);
  checks++;
  const createdByCli = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "packages/procli/bin/procli.mjs",
        "--profile",
        "local",
        "project",
        "create",
        "--name",
        `procli 验收 ${Date.now()}`,
        "--goal",
        "验证本地 Profile 创建项目",
        "--idempotency-key",
        `procli-verify-${Date.now()}`,
      ],
      { encoding: "utf8", env: { ...process.env, PROCLI_CONFIG_PATH: procliConfig } },
    ),
  );
  assert.equal(createdByCli.ok, true);
  assert.equal(createdByCli.data.target.profile, "local");
  assert.equal(createdByCli.data.tasks.count, 7);
  assert.equal(createdByCli.data.wiki.count, 8);
  await fs.rm(procliHome, { recursive: true, force: true });
  checks++;
  browser = await chromium.launch({ headless: true });
  const pageUI = await browser.newPage({
    viewport: { width: 1512, height: 982 },
  });
  const errors: string[] = [];
  pageUI.on("pageerror", (e) => errors.push(e.message));
  await pageUI.goto("http://127.0.0.1:4318");
  await pageUI
    .getByRole("button", { name: "▣ " + p.name, exact: true })
    .click();
  await pageUI.getByRole("button", { name: /完成市场与竞品调研/ }).click();
  await pageUI.getByRole("button", { name: "开始执行", exact: true }).click();
  await pageUI.getByRole("button", { name: "提交审核", exact: true }).waitFor();
  checks++;
  await pageUI.getByRole("button", { name: "关闭 ×", exact: true }).click();
  await pageUI.getByRole("button", { name: "Wiki", exact: true }).click();
  await pageUI
    .getByRole("button", { name: "▤ 确认商品目标与立项", exact: true })
    .click();
  await pageUI
    .getByRole("button", { name: "编辑 Markdown", exact: true })
    .click();
  await pageUI
    .locator("textarea.editor")
    .fill(content + "\n\n浏览器编辑已验证。");
  await pageUI.getByRole("button", { name: "保存", exact: true }).click();
  await pageUI.getByText("浏览器编辑已验证。", { exact: true }).waitFor();
  checks++;
  await pageUI.getByRole("button", { name: "看板", exact: true }).click();
  await fs.mkdir("test-results", { recursive: true });
  await pageUI.screenshot({
    path: "test-results/verification-board.png",
    fullPage: true,
  });
  await pageUI.setViewportSize({ width: 390, height: 844 });
  await pageUI.screenshot({
    path: "test-results/verification-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  checks++;
  console.log(
    JSON.stringify(
      {
        ok: true,
        checks,
        project: p.id,
        restore: restored.id,
        browserErrors: errors,
        screenshots: [
          "test-results/verification-board.png",
          "test-results/verification-mobile.png",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
