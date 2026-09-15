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
  const iconBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const iconBody = new FormData();
  iconBody.append(
    "file",
    new Blob([iconBytes], { type: "image/png" }),
    "project.png",
  );
  const iconUpload = await fetch(base + `/v1/projects/${p.id}/icon`, {
    method: "POST",
    headers: { "x-actor": "agent", "idempotency-key": `icon-${Date.now()}` },
    body: iconBody,
  }).then((response) => response.json());
  assert.equal(iconUpload.ok, true, JSON.stringify(iconUpload));
  assert.equal(iconUpload.data.mimeType, "image/png");
  const iconDownload = await fetch(base + `/v1/projects/${p.id}/icon`, {
    headers: { "x-actor": "agent" },
  });
  assert.equal(iconDownload.status, 200);
  assert.equal(iconDownload.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await iconDownload.arrayBuffer()), iconBytes);
  checks += 5;
  const folderName = `自动验收归档 ${key}`;
  const folder = await ok(
    "/project-folders",
    "POST",
    { name: folderName },
    "agent",
    `folder-${Date.now()}`,
  );
  const secondFolder = await ok(
    "/project-folders",
    "POST",
    { name: `自动验收目录 B ${key}` },
    "agent",
    `folder-b-${Date.now()}`,
  );
  assert.equal(
    (
      await api(
        "/project-folders",
        "POST",
        { name: ` ${folderName} ` },
        "agent",
        `folder-duplicate-${Date.now()}`,
      )
    ).error.code,
    "FOLDER_NAME_CONFLICT",
  );
  const moved = await ok(
    `/v1/projects/${p.id}/folder`,
    "PATCH",
    { folderId: folder.id },
    "agent",
    `move-${Date.now()}`,
  );
  assert.equal(moved.folderId, folder.id);
  assert(
    new Date(moved.updatedAt).getTime() >= new Date(moved.createdAt).getTime(),
  );
  checks += 3;
  const pinned = await ok(
    `/v1/projects/${p.id}/pin`,
    "PATCH",
    { pinned: true },
    "agent",
    `pin-${Date.now()}`,
  );
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.pinnedFromFolderId, folder.id);
  const unpinned = await ok(
    `/v1/projects/${p.id}/pin`,
    "PATCH",
    { pinned: false },
    "agent",
    `unpin-${Date.now()}`,
  );
  assert.equal(unpinned.pinned, false);
  assert.equal(unpinned.folderId, folder.id);
  checks += 4;
  let s = await ok("/state");
  const folderOrder = [...s.folders].reverse().map((item: any) => item.id);
  const projectOrder = [
    s.projects.find((item: any) => item.id === p.id),
    ...s.projects.filter((item: any) => item.id !== p.id),
  ];
  await ok(
    "/project-directory/order",
    "PUT",
    {
      folderIds: folderOrder,
      projects: projectOrder.map((item: any) => ({
        id: item.id,
        pinned: Boolean(item.pinned),
        folderId: item.folderId || null,
      })),
    },
    "agent",
    `directory-order-${Date.now()}`,
  );
  s = await ok("/state");
  assert.equal(
    s.folders.find((item: any) => item.id === folderOrder[0]).directoryOrder,
    0,
  );
  assert.equal(
    s.projects.find((item: any) => item.id === p.id).directoryOrder,
    0,
  );
  checks += 2;
  assert.equal(
    s.folders.some((item: any) => item.id === folder.id),
    true,
  );
  assert.equal(
    s.projects.find((item: any) => item.id === p.id).folderId,
    folder.id,
  );
  assert.equal(
    s.events.some(
      (event: any) =>
        event.projectId === p.id && event.type === "project.moved",
    ),
    true,
  );
  checks += 3;
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
  const directoryRead = await ok("/v1/directory");
  assert.equal(
    directoryRead.projects.some((project: any) => project.id === p.id),
    true,
  );
  assert.equal(
    directoryRead.folders.some((item: any) => item.id === folder.id),
    true,
  );
  const taskListRead = await ok(`/v1/projects/${p.id}/tasks`);
  assert.equal(taskListRead.count, 7);
  assert.equal(taskListRead.tasks[0].id, t.id);
  const taskDetailRead = await ok(
    `/v1/projects/${p.id}/tasks/resolve/by-name?name=${encodeURIComponent(t.title)}`,
  );
  assert.equal(taskDetailRead.task.status, "已完成");
  assert.equal(taskDetailRead.statusHistory.at(-1).to, "已完成");
  assert.equal(taskDetailRead.records.runs[0].status, "completed");
  assert.equal(taskDetailRead.records.artifacts[0].name, "test.txt");
  assert.equal(taskDetailRead.records.wiki.version, 3);
  checks += 9;
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
    {
      encoding: "utf8",
      env: { ...process.env, PROCLI_CONFIG_PATH: procliConfig },
    },
  );
  const revisionBeforeCliReads = (await ok("/state")).revision;
  const cliDirectory = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "packages/procli/bin/procli.mjs",
        "--profile",
        "local",
        "directory",
        "list",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PROCLI_CONFIG_PATH: procliConfig },
      },
    ),
  );
  assert.equal(
    cliDirectory.data.projects.some((project: any) => project.id === p.id),
    true,
  );
  const cliTaskList = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "packages/procli/bin/procli.mjs",
        "--profile",
        "local",
        "task",
        "list",
        "--project",
        p.name,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PROCLI_CONFIG_PATH: procliConfig },
      },
    ),
  );
  assert.equal(cliTaskList.data.count, 7);
  const cliTaskDetail = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "packages/procli/bin/procli.mjs",
        "--profile",
        "local",
        "task",
        "get",
        "--project",
        p.name,
        "--task",
        t.title,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PROCLI_CONFIG_PATH: procliConfig },
      },
    ),
  );
  assert.equal(cliTaskDetail.data.task.id, t.id);
  assert.equal(cliTaskDetail.data.records.runs[0].status, "completed");
  assert.equal((await ok("/state")).revision, revisionBeforeCliReads);
  checks += 5;
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
      {
        encoding: "utf8",
        env: { ...process.env, PROCLI_CONFIG_PATH: procliConfig },
      },
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
      {
        encoding: "utf8",
        env: { ...process.env, PROCLI_CONFIG_PATH: procliConfig },
      },
    ),
  );
  assert.equal(createdByCli.ok, true);
  assert.equal(createdByCli.data.target.profile, "local");
  assert.equal(createdByCli.data.tasks.count, 7);
  assert.equal(createdByCli.data.wiki.count, 8);
  const customName = `自定义 SOP 验收 ${Date.now()}`;
  const custom = await ok(
    "/v1/projects",
    "POST",
    {
      name: customName,
      type: "product",
      sop: {
        nodes: [
          { name: "验证需求", description: "验证真实用户需求" },
          { name: "立项评审", description: "汇总证据并形成结论" },
        ],
      },
    },
    "agent",
    `custom-${Date.now()}`,
  );
  assert.equal(custom.project.sopMode, "custom");
  assert.equal(custom.tasks.count, 2);
  const customTask = await ok("/tasks", "POST", {
    projectId: custom.project.id,
    title: "补充验证",
    stage: custom.project.stages[0],
    owner: "agent",
  });
  assert.equal(
    (
      await api(
        "/v1/projects",
        "POST",
        { name: ` ${customName} ` },
        "agent",
        `duplicate-${Date.now()}`,
      )
    ).error.code,
    "PROJECT_NAME_CONFLICT",
  );
  assert.equal(
    (
      await api(
        "/v1/projects/by-name",
        "DELETE",
        { expectedName: customName },
        "agent",
        `denied-${Date.now()}`,
      )
    ).error.code,
    "ADMIN_REQUIRED",
  );
  assert.equal(
    (
      await api(
        "/v1/projects/by-name",
        "DELETE",
        { expectedName: customName.toLowerCase() },
        "supervisor",
        `mismatch-${Date.now()}`,
      )
    ).error.code,
    "DELETE_CONFIRMATION_MISMATCH",
  );
  const removed = await ok(
    "/v1/projects/by-name",
    "DELETE",
    { expectedName: customName },
    "supervisor",
    `delete-${Date.now()}`,
  );
  assert.equal(removed.recoverable, true);
  assert.equal(
    (
      await ok(
        `/v1/deleted-projects/${removed.projectId}`,
        "GET",
        undefined,
        "supervisor",
      )
    ).project.name,
    customName,
  );
  assert.equal(
    (await api(`/v1/projects/${removed.projectId}`)).error.code,
    "NOT_FOUND",
  );
  assert.equal(
    (
      await api(`/tasks/${customTask.id}`, "PATCH", {
        version: 1,
        title: "不可修改",
      })
    ).error.code,
    "NOT_FOUND",
  );
  assert.equal(
    (await ok("/state")).projects.some(
      (item: any) => item.id === removed.projectId,
    ),
    false,
  );
  checks += 10;
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
    .getByRole("heading", { name: "项目首页", exact: true })
    .waitFor();
  await pageUI.getByRole("button", { name: "卡片视图" }).waitFor();
  const homeProject = pageUI
    .locator(".home-project")
    .filter({
      has: pageUI.getByRole("heading", { name: p.name, exact: true }),
    });
  await homeProject.getByText(/创建/).waitFor();
  await homeProject.getByText(/更新/).waitFor();
  await homeProject.getByText(/项目进度/).waitFor();
  await homeProject.locator("img").waitFor();
  assert.equal(
    await homeProject
      .locator("img")
      .evaluate((image: HTMLImageElement) => image.naturalWidth > 0),
    true,
  );
  await pageUI.getByRole("button", { name: "列表视图" }).click();
  assert.equal(await pageUI.locator(".home-projects.list").count(), 1);
  await pageUI.getByRole("button", { name: "卡片视图" }).click();
  await fs.mkdir("test-results", { recursive: true });
  await pageUI.screenshot({
    path: "test-results/verification-home.png",
    fullPage: true,
  });
  checks += 8;
  const projectButton = pageUI.getByRole("button", {
    name: "▣ " + p.name,
    exact: true,
  });
  await projectButton.click();
  assert.equal(
    await pageUI
      .locator(".identity")
      .getByRole("button", { name: "删除项目" })
      .count(),
    0,
  );
  checks++;
  await projectButton.hover();
  const hoverColors = await projectButton.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor };
  });
  assert.notEqual(hoverColors.color, hoverColors.background);
  assert.notEqual(hoverColors.background, "rgba(0, 0, 0, 0)");
  checks += 2;
  const resizeHandle = pageUI.getByRole("separator", {
    name: "调整项目目录宽度",
  });
  const originalWidth = (await pageUI.locator("aside").boundingBox())!.width;
  await resizeHandle.focus();
  await resizeHandle.press("ArrowRight");
  await pageUI.waitForTimeout(200);
  const resizedWidth = (await pageUI.locator("aside").boundingBox())!.width;
  assert.equal(resizedWidth, originalWidth + 10);
  await pageUI.getByRole("button", { name: "收起项目目录" }).click();
  await pageUI.waitForTimeout(200);
  assert.equal(await pageUI.locator(".app.sidebar-collapsed").count(), 1);
  assert.equal((await pageUI.locator("aside").boundingBox())!.width, 64);
  await pageUI.getByRole("button", { name: "展开项目目录" }).click();
  await pageUI.waitForTimeout(200);
  assert.equal(
    (await pageUI.locator("aside").boundingBox())!.width,
    resizedWidth,
  );
  checks += 4;
  await pageUI.getByRole("button", { name: "收起项目树" }).click();
  assert.equal(await pageUI.locator(".project-list").count(), 0);
  await pageUI.getByRole("button", { name: "展开项目树" }).click();
  assert.equal(await pageUI.locator(".project-list").count(), 1);
  const folderToggle = pageUI.getByRole("button", {
    name: `收起目录 ${folderName}`,
    exact: true,
  });
  await folderToggle.click();
  assert.equal(await projectButton.isVisible(), false);
  await pageUI
    .getByRole("button", { name: `展开目录 ${folderName}`, exact: true })
    .click();
  assert.equal(await projectButton.isVisible(), true);
  checks += 4;
  assert.equal(await pageUI.getByLabel("项目排序字段").count(), 0);
  assert.equal(await pageUI.getByLabel("切换排序方向").count(), 0);
  checks += 2;
  await pageUI
    .locator(".folder-title")
    .filter({ hasText: folderName })
    .first()
    .waitFor();
  await projectButton.click({ button: "right" });
  const contextMenu = pageUI.getByRole("menu", {
    name: `管理项目 ${p.name}`,
  });
  await contextMenu.waitFor();
  await contextMenu.getByRole("menuitem", { name: /移动到目录/ }).hover();
  await pageUI
    .locator(".context-submenu-panel")
    .getByRole("menuitem", { name: folderName })
    .waitFor();
  await contextMenu.getByRole("menuitem", { name: /删除项目/ }).waitFor();
  await contextMenu.getByRole("menuitem", { name: /置顶/ }).waitFor();
  await fs.mkdir("test-results", { recursive: true });
  await pageUI.screenshot({
    path: "test-results/verification-context-menu.png",
    fullPage: true,
  });
  assert.equal(await pageUI.locator(".project-menu").count(), 0);
  checks += 3;
  await pageUI.mouse.click(800, 160);
  const unfiledGroup = pageUI
    .locator(".project-group")
    .filter({ has: pageUI.locator(".folder-title", { hasText: "未归档" }) });
  await Promise.all([
    pageUI.waitForResponse(
      (response) =>
        response.url().includes("/api/project-directory/order") &&
        response.request().method() === "PUT",
    ),
    projectButton.evaluate((source) => {
      const target = [
        ...document.querySelectorAll<HTMLElement>(".folder-title"),
      ].find((element) => element.textContent?.includes("未归档"));
      if (!target) throw new Error("找不到未归档目录");
      const data = new DataTransfer();
      source.dispatchEvent(
        new DragEvent("dragstart", { bubbles: true, dataTransfer: data }),
      );
      target.dispatchEvent(
        new DragEvent("dragover", { bubbles: true, dataTransfer: data }),
      );
      target.dispatchEvent(
        new DragEvent("drop", { bubbles: true, dataTransfer: data }),
      );
    }),
  ]);
  await unfiledGroup.getByRole("button", { name: "▣ " + p.name }).waitFor();
  assert.equal(
    (await ok("/state")).projects.find((item: any) => item.id === p.id)
      .folderId,
    null,
  );
  checks += 2;
  const sourceFolderTitle = pageUI
    .locator(".folder-title")
    .filter({ hasText: folderName })
    .first();
  const targetFolderTitle = pageUI
    .locator(".folder-title")
    .filter({ hasText: secondFolder.name })
    .first();
  await Promise.all([
    pageUI.waitForResponse(
      (response) =>
        response.url().includes("/api/project-directory/order") &&
        response.request().method() === "PUT",
    ),
    sourceFolderTitle.evaluate((source, targetName) => {
      const target = [
        ...document.querySelectorAll<HTMLElement>(".folder-title"),
      ].find((element) => element.textContent?.includes(targetName));
      if (!target) throw new Error("找不到目标目录");
      const data = new DataTransfer();
      source.dispatchEvent(
        new DragEvent("dragstart", { bubbles: true, dataTransfer: data }),
      );
      target.dispatchEvent(
        new DragEvent("drop", { bubbles: true, dataTransfer: data }),
      );
    }, secondFolder.name),
  ]);
  const reorderedState = await ok("/state");
  assert(
    reorderedState.folders.find((item: any) => item.id === folder.id)
      .directoryOrder <
      reorderedState.folders.find((item: any) => item.id === secondFolder.id)
        .directoryOrder,
  );
  checks += 2;
  await pageUI
    .getByRole("button", { name: "＋ 创建目录", exact: true })
    .click();
  await pageUI
    .getByRole("heading", { name: "创建目录", exact: true })
    .waitFor();
  await pageUI.getByRole("button", { name: "×", exact: true }).click();
  checks++;
  const createProjectButton = pageUI.getByRole("button", {
    name: "＋ 创建项目",
    exact: true,
  });
  await createProjectButton.hover();
  const createButtonColors = await createProjectButton.evaluate((element) => {
    const style = getComputedStyle(element);
    return { foreground: style.color, background: style.backgroundColor };
  });
  const colorLuminance = (value: string) => {
    const channels = (value.match(/[\d.]+/g) || [])
      .slice(0, 3)
      .map(Number)
      .map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.03928
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const foreground = colorLuminance(createButtonColors.foreground);
  const background = colorLuminance(createButtonColors.background);
  const createButtonContrast =
    (Math.max(foreground, background) + 0.05) /
    (Math.min(foreground, background) + 0.05);
  assert(
    createButtonContrast >= 4.5,
    `创建项目按钮对比度不足：${createButtonContrast}`,
  );
  checks++;
  await createProjectButton.click();
  await pageUI
    .getByRole("heading", { name: "创建项目", exact: true })
    .waitFor();
  assert.equal(
    await pageUI.getByRole("button", { name: /店铺项目/ }).isDisabled(),
    true,
  );
  assert.equal(
    await pageUI.getByRole("button", { name: /企业项目/ }).isDisabled(),
    true,
  );
  await pageUI.getByRole("button", { name: "×", exact: true }).click();
  checks++;
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
          "test-results/verification-context-menu.png",
          "test-results/verification-home.png",
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
