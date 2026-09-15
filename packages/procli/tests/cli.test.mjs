import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const bin = path.join(packageRoot, "bin", "procli.mjs");

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) =>
      resolve({ code, stdout, stderr, json: JSON.parse(stdout) }),
    );
  });
}

async function mockService(environment) {
  let creates = 0;
  let taskCreates = 0;
  let taskDeletes = 0;
  let taskRestores = 0;
  let deletes = 0;
  let deleted = false;
  let lastCreateBody;
  let lastTaskBody;
  let lastTaskResult;
  let projectVersion = 4;
  const contextToken = () => `context-${projectVersion}`;
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/health")
      return res.end(
        JSON.stringify({
          ok: true,
          data: {
            status: "ready",
            apiVersion: "1",
            environment,
            instanceId: `${environment}-test`,
            commit: "test",
          },
        }),
      );
    if (req.url === "/api/v1/directory" && req.method === "GET")
      return res.end(
        JSON.stringify({
          ok: true,
          data: {
            counts: {
              folders: 1,
              projects: 1,
              pinnedProjects: 0,
              unfiledProjects: 0,
            },
            folders: [
              {
                id: "folder-1",
                name: "新品",
                directoryOrder: 0,
                projectIds: ["project-1"],
              },
            ],
            projects: [
              {
                id: "project-1",
                name: "Test",
                folderId: "folder-1",
                folderName: "新品",
                taskCount: 2,
                completedTaskCount: 1,
                progress: 50,
              },
            ],
          },
        }),
      );
    if (req.url === "/api/v1/projects" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      return req.on("end", () => {
        creates++;
        lastCreateBody = JSON.parse(raw);
        const count = lastCreateBody.sop?.nodes?.length || 7;
        res.end(
          JSON.stringify({
            ok: true,
            data: {
              project: {
                id: "project-1",
                name: lastCreateBody.name,
                sopMode: lastCreateBody.sop ? "custom" : "default",
              },
              tasks: { count, items: [] },
              wiki: { count: count + 1, paths: [] },
              audit: { event: "project.created" },
            },
          }),
        );
      });
    }
    if (req.url === "/api/v1/projects/project-1" && req.method === "GET")
      return res.end(
        JSON.stringify({
          ok: true,
          data: {
            project: {
              id: "project-1",
              name: lastCreateBody?.name || "Test",
              sopMode: lastCreateBody?.sop ? "custom" : "default",
            },
            tasks: {
              count: lastCreateBody?.sop?.nodes?.length || 7,
              items: [],
            },
            wiki: {
              count: (lastCreateBody?.sop?.nodes?.length || 7) + 1,
              paths: [],
            },
          },
        }),
      );
    if (
      req.url?.startsWith("/api/v1/projects/resolve/by-name?") &&
      req.method === "GET"
    )
      return res.end(
        JSON.stringify({
          ok: true,
          data: {
            project: { id: "project-1", name: "Test" },
            taskCount: 7,
            wikiCount: 8,
          },
        }),
      );
    if (req.url === "/api/v1/projects/project-1/tasks" && req.method === "GET")
      return res.end(
        JSON.stringify({
          ok: true,
          data: {
            project: { id: "project-1", name: "Test" },
            count: 2,
            tasks: [
              { id: "task-1", title: "市场调研", status: "已完成" },
              { id: "task-2", title: "立项", status: "进行中" },
            ],
          },
        }),
      );
    if (
      req.url === "/api/v1/projects/project-1/task-create-context" &&
      req.method === "GET"
    )
      return res.end(
        JSON.stringify({
          ok: true,
          data: {
            project: {
              id: "project-1",
              name: "Test",
              type: "product",
              status: "active",
              projectVersion,
            },
            contextToken: contextToken(),
            nodes: [
              { name: "待立项", order: 0, taskCount: 1 },
              { name: "市场调研", order: 1, taskCount: 1 },
            ],
            tasks: [
              {
                id: "task-1",
                title: "市场调研",
                stage: "市场调研",
                status: "已完成",
                owner: "market",
                dependencies: [],
                boardOrder: 0,
                version: 1,
              },
              {
                id: "task-2",
                title: "立项",
                stage: "待立项",
                status: "进行中",
                owner: "supervisor",
                dependencies: [],
                boardOrder: 0,
                version: 1,
              },
            ],
            members: [
              { id: "supervisor", name: "主管", role: "reviewer" },
              { id: "market", name: "市场负责人", role: "member" },
            ],
            constraints: {
              priorities: ["低", "中", "高"],
              taskTitleUnique: true,
              defaultPosition: "node-end",
              automaticDependency: false,
            },
          },
        }),
      );
    if (
      req.url === "/api/v1/projects/project-1/tasks/preview" &&
      req.method === "POST"
    ) {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      return req.on("end", () => {
        const body = JSON.parse(raw);
        if (body.contextToken !== contextToken()) {
          res.statusCode = 409;
          return res.end(
            JSON.stringify({
              ok: false,
              error: {
                code: "PROJECT_STATE_CHANGED",
                message: "state changed",
              },
            }),
          );
        }
        res.end(
          JSON.stringify({
            ok: true,
            data: {
              dryRun: true,
              contextToken: body.contextToken,
              project: { id: "project-1", name: "Test", projectVersion },
              task: {
                title: body.title,
                stage: body.stage,
                owner: { id: body.owner || "supervisor", name: "主管" },
                reviewer: { id: "supervisor", name: "主管" },
                priority: "中",
                dependencies: body.dependencies,
                position: body.afterTaskId ? "after" : "append",
                positionIndex: body.afterTaskId ? 1 : 0,
              },
            },
          }),
        );
      });
    }
    if (
      req.url === "/api/v1/projects/project-1/tasks" &&
      req.method === "POST"
    ) {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      return req.on("end", () => {
        lastTaskBody = JSON.parse(raw);
        if (
          req.headers["idempotency-key"] === "task-create-key" &&
          lastTaskResult
        )
          return res.end(JSON.stringify({ ok: true, data: lastTaskResult }));
        if (lastTaskBody.contextToken !== contextToken()) {
          res.statusCode = 409;
          return res.end(
            JSON.stringify({
              ok: false,
              error: {
                code: "PROJECT_STATE_CHANGED",
                message: "state changed",
              },
            }),
          );
        }
        taskCreates++;
        projectVersion++;
        lastTaskResult = {
          project: { id: "project-1", name: "Test", projectVersion },
          task: {
            id: "task-new",
            ...lastTaskBody,
            version: 1,
            contentStatus: "empty",
          },
          audit: { event: "task.created", actor: "supervisor" },
        };
        res.end(JSON.stringify({ ok: true, data: lastTaskResult }));
      });
    }
    if (
      req.url === "/api/v1/projects/project-1/tasks/by-id/task-new" &&
      req.method === "GET"
    )
      return res.end(
        JSON.stringify({
          ok: true,
          data: {
            project: { id: "project-1", name: "Test", projectVersion },
            task: {
              id: "task-new",
              ...lastTaskBody,
              version: 1,
              contentStatus: "empty",
            },
          },
        }),
      );
    if (
      req.url?.startsWith(
        "/api/v1/projects/project-1/tasks/resolve/by-name?",
      ) &&
      req.method === "GET"
    )
      return res.end(
        JSON.stringify({
          ok: true,
          data: {
            project: { id: "project-1", name: "Test" },
            task: { id: "task-1", title: "市场调研", status: "已完成" },
            dependencies: [],
            dependents: [{ id: "task-2", title: "立项", status: "进行中" }],
            statusHistory: [
              { action: "task.approve", from: "待审核", to: "已完成" },
            ],
            records: {
              events: [{ id: "event-1", type: "task.approve" }],
              runs: [{ id: "run-1", status: "completed" }],
              artifacts: [],
              wiki: { path: "wiki/market.md", version: 2 },
              notifications: [],
            },
          },
        }),
      );
    if (
      req.url === "/api/v1/projects/project-1/tasks/task-1/delete-context" &&
      req.method === "GET"
    )
      return res.end(
        JSON.stringify({
          ok: true,
          data: {
            project: { id: "project-1", name: "Test", projectVersion },
            task: {
              id: "task-1",
              title: "市场调研",
              contentStatus: "substantive",
            },
            contextToken: contextToken(),
            permissions: { canDeleteWithContent: true },
            impactHash: "impact-1",
            impact: {
              task: { id: "task-1", title: "市场调研" },
              dependents: [],
            },
          },
        }),
      );
    if (
      req.url === "/api/v1/projects/project-1/tasks/task-1/delete-preview" &&
      req.method === "POST"
    )
      return res.end(
        JSON.stringify({
          ok: true,
          data: {
            dryRun: true,
            contextToken: contextToken(),
            impactHash: "impact-1",
            canDelete: true,
            impact: {
              task: {
                id: "task-1",
                title: "市场调研",
                contentStatus: "substantive",
              },
              dependents: [],
              files: [{ path: "wiki/market.md", sha256: "abc" }],
              retentionDays: 90,
            },
          },
        }),
      );
    if (
      req.url === "/api/v1/projects/project-1/tasks/task-1" &&
      req.method === "DELETE"
    ) {
      taskDeletes++;
      projectVersion++;
      return res.end(
        JSON.stringify({
          ok: true,
          data: {
            deletionId: "deletion-1",
            state: "completed",
            project: { id: "project-1", name: "Test", projectVersion },
            task: { id: "task-1", title: "市场调研" },
            manifestPath: "wiki/recycle/deletion-1/manifest.json",
            retentionUntil: "2026-12-14T00:00:00.000Z",
          },
        }),
      );
    }
    if (req.url === "/api/v1/trash" && req.method === "GET")
      return res.end(
        JSON.stringify({
          ok: true,
          data: [
            { id: "deletion-1", taskTitle: "市场调研", state: "completed" },
          ],
        }),
      );
    if (req.url === "/api/v1/trash/deletion-1" && req.method === "GET")
      return res.end(
        JSON.stringify({
          ok: true,
          data: {
            id: "deletion-1",
            taskTitle: "市场调研",
            state: taskRestores ? "restored" : "completed",
            manifest: { files: [{ path: "wiki/market.md", sha256: "abc" }] },
          },
        }),
      );
    if (
      req.url === "/api/v1/trash/deletion-1/restore-preview" &&
      req.method === "POST"
    )
      return res.end(
        JSON.stringify({
          ok: true,
          data: {
            dryRun: true,
            deletionId: "deletion-1",
            canRestore: true,
            conflict: null,
            files: [{ path: "wiki/market.md", sha256: "abc" }],
          },
        }),
      );
    if (
      req.url === "/api/v1/trash/deletion-1/restore" &&
      req.method === "POST"
    ) {
      taskRestores++;
      projectVersion++;
      return res.end(
        JSON.stringify({
          ok: true,
          data: {
            deletionId: "deletion-1",
            state: "restored",
            project: { id: "project-1", name: "Test", projectVersion },
            task: { id: "task-1", title: "市场调研" },
            warnings: [],
          },
        }),
      );
    }
    if (
      req.url === "/api/v1/projects/project-1/tasks/by-id/task-1" &&
      req.method === "GET"
    )
      return res.end(
        JSON.stringify({
          ok: true,
          data: {
            project: { id: "project-1", name: "Test", projectVersion },
            task: { id: "task-1", title: "市场调研" },
          },
        }),
      );
    if (req.url === "/api/v1/projects/by-name" && req.method === "DELETE") {
      deletes++;
      deleted = true;
      return res.end(
        JSON.stringify({
          ok: true,
          data: {
            projectId: "project-1",
            projectName: "Test",
            deletedAt: "2026-09-15T00:00:00.000Z",
            deletedBy: "supervisor",
            taskCount: 7,
            wikiCount: 8,
            recoverable: true,
          },
        }),
      );
    }
    if (
      req.url === "/api/v1/deleted-projects/project-1" &&
      req.method === "GET" &&
      deleted
    )
      return res.end(
        JSON.stringify({
          ok: true,
          data: {
            project: {
              id: "project-1",
              name: "Test",
              deletedAt: "2026-09-15T00:00:00.000Z",
            },
          },
        }),
      );
    res.statusCode = 404;
    res.end(
      JSON.stringify({
        ok: false,
        error: { code: "NOT_FOUND", message: "not found" },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    creates: () => creates,
    taskCreates: () => taskCreates,
    taskDeletes: () => taskDeletes,
    taskRestores: () => taskRestores,
    deletes: () => deletes,
    lastCreateBody: () => lastCreateBody,
    lastTaskBody: () => lastTaskBody,
  };
}

test("local Profile supports dry-run and verified project creation", async (t) => {
  const mock = await mockService("development");
  t.after(() => mock.server.close());
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "procli-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { PROCLI_CONFIG_PATH: path.join(home, "config.json") };
  assert.equal(
    (
      await run(
        [
          "profile",
          "add",
          "local",
          "--url",
          mock.url,
          "--environment",
          "development",
        ],
        env,
      )
    ).code,
    0,
  );
  assert.equal((await run(["profile", "use", "local"], env)).code, 0);
  const dry = await run(
    ["project", "create", "--name", "Dry", "--dry-run"],
    env,
  );
  assert.equal(dry.json.data.dryRun, true);
  assert.equal(mock.creates(), 0);
  const created = await run(
    ["project", "create", "--name", "Test", "--idempotency-key", "test-key"],
    env,
  );
  assert.equal(created.code, 0);
  assert.equal(created.json.data.target.profile, "local");
  assert.equal(created.json.data.tasks.count, 7);
  assert.equal(created.json.data.wiki.count, 8);
  assert.equal(created.json.data.verification, "write-after-readback");
  assert.equal(mock.creates(), 1);
});

test("read-only commands return directory, task list, and task records", async (t) => {
  const mock = await mockService("development");
  t.after(() => mock.server.close());
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "procli-read-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { PROCLI_CONFIG_PATH: path.join(home, "config.json") };
  await run(
    [
      "profile",
      "add",
      "local",
      "--url",
      mock.url,
      "--environment",
      "development",
    ],
    env,
  );
  await run(["profile", "use", "local"], env);

  const directory = await run(["directory", "list"], env);
  assert.equal(directory.code, 0);
  assert.equal(directory.json.data.counts.projects, 1);
  assert.equal(directory.json.data.folders[0].name, "新品");
  assert.equal(directory.json.data.projects[0].progress, 50);

  const tasks = await run(["task", "list", "--project", "Test"], env);
  assert.equal(tasks.code, 0);
  assert.equal(tasks.json.data.project.name, "Test");
  assert.equal(tasks.json.data.count, 2);
  assert.equal(tasks.json.data.tasks[0].status, "已完成");

  const detail = await run(
    ["task", "get", "--project", "Test", "--task", "市场调研"],
    env,
  );
  assert.equal(detail.code, 0);
  assert.equal(detail.json.data.task.id, "task-1");
  assert.equal(detail.json.data.statusHistory[0].to, "已完成");
  assert.equal(detail.json.data.records.runs[0].status, "completed");
  assert.equal(detail.json.data.records.wiki.version, 2);
  assert.equal(mock.creates(), 0);
  assert.equal(mock.deletes(), 0);
});

test("task creation requires a current context, previews, writes, and reads back", async (t) => {
  const mock = await mockService("development");
  t.after(() => mock.server.close());
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "procli-task-create-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { PROCLI_CONFIG_PATH: path.join(home, "config.json") };
  await run(
    [
      "profile",
      "add",
      "local",
      "--url",
      mock.url,
      "--environment",
      "development",
    ],
    env,
  );
  await run(["profile", "use", "local"], env);

  const context = await run(
    ["task", "create-context", "--project", "Test"],
    env,
  );
  assert.equal(context.code, 0);
  assert.equal(context.json.data.project.projectVersion, 4);
  assert.equal(context.json.data.contextToken, "context-4");
  assert.equal(context.json.data.constraints.automaticDependency, false);

  const missing = await run(
    [
      "task",
      "create",
      "--project",
      "Test",
      "--node",
      "市场调研",
      "--title",
      "整理价格带",
    ],
    env,
  );
  assert.equal(missing.json.error.code, "ARGUMENT");
  assert.equal(mock.taskCreates(), 0);

  const dry = await run(
    [
      "task",
      "create",
      "--project",
      "Test",
      "--node",
      "市场调研",
      "--title",
      "整理价格带",
      "--description",
      "统计前20款样本",
      "--depends-on",
      "市场调研",
      "--after-task",
      "市场调研",
      "--context-token",
      "context-4",
      "--idempotency-key",
      "task-create-key",
      "--dry-run",
    ],
    env,
  );
  assert.equal(dry.code, 0);
  assert.equal(dry.json.data.dryRun, true);
  assert.equal(dry.json.data.task.position, "after");
  assert.deepEqual(dry.json.data.task.dependencies, ["task-1"]);
  assert.equal(mock.taskCreates(), 0);

  const created = await run(
    [
      "task",
      "create",
      "--project",
      "Test",
      "--node",
      "市场调研",
      "--title",
      "整理价格带",
      "--description",
      "统计前20款样本",
      "--depends-on",
      "市场调研",
      "--after-task",
      "市场调研",
      "--context-token",
      "context-4",
      "--idempotency-key",
      "task-create-key",
    ],
    env,
  );
  assert.equal(created.code, 0);
  assert.equal(created.json.data.task.id, "task-new");
  assert.equal(created.json.data.task.stage, "市场调研");
  assert.equal(created.json.data.project.projectVersion, 5);
  assert.equal(created.json.data.verification, "write-after-readback");
  assert.equal(mock.taskCreates(), 1);
  assert.deepEqual(mock.lastTaskBody().dependencies, ["task-1"]);

  const retried = await run(
    [
      "task",
      "create",
      "--project",
      "Test",
      "--node",
      "市场调研",
      "--title",
      "整理价格带",
      "--description",
      "统计前20款样本",
      "--depends-on",
      "市场调研",
      "--after-task",
      "市场调研",
      "--context-token",
      "context-4",
      "--idempotency-key",
      "task-create-key",
    ],
    env,
  );
  assert.equal(retried.code, 0);
  assert.equal(retried.json.data.task.id, "task-new");
  assert.equal(mock.taskCreates(), 1);

  const stale = await run(
    [
      "task",
      "create",
      "--project",
      "Test",
      "--node",
      "市场调研",
      "--title",
      "使用旧快照",
      "--context-token",
      "context-4",
      "--dry-run",
    ],
    env,
  );
  assert.equal(stale.code, 1);
  assert.equal(stale.json.error.code, "PROJECT_STATE_CHANGED");
  assert.equal(mock.taskCreates(), 1);
});

test("custom SOP creation validates and sends node names with descriptions", async (t) => {
  const mock = await mockService("development");
  t.after(() => mock.server.close());
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "procli-sop-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const config = path.join(home, "config.json");
  const sop = path.join(home, "sop.json");
  await fs.writeFile(
    sop,
    JSON.stringify({
      nodes: [
        { name: "需求验证", description: "验证真实需求" },
        { name: "立项评审", description: "形成评审结论" },
      ],
    }),
  );
  const env = { PROCLI_CONFIG_PATH: config };
  await run(
    [
      "profile",
      "add",
      "local",
      "--url",
      mock.url,
      "--environment",
      "development",
    ],
    env,
  );
  await run(["profile", "use", "local"], env);
  const created = await run(
    ["project", "create", "--name", "Custom", "--sop-file", sop],
    env,
  );
  assert.equal(created.code, 0);
  assert.equal(created.json.data.tasks.count, 2);
  assert.equal(mock.lastCreateBody().sop.nodes[1].description, "形成评审结论");
});

test("task deletion previews, archives, reads trash, and restores by id", async (t) => {
  const mock = await mockService("development");
  t.after(() => mock.server.close());
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "procli-task-recycle-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { PROCLI_CONFIG_PATH: path.join(home, "config.json") };
  await run(
    [
      "profile",
      "add",
      "local",
      "--url",
      mock.url,
      "--environment",
      "development",
    ],
    env,
  );
  await run(["profile", "use", "local"], env);

  const context = await run(
    ["task", "delete-context", "--project", "Test", "--task", "市场调研"],
    env,
  );
  assert.equal(context.code, 0);
  assert.equal(context.json.data.impactHash, "impact-1");

  const preview = await run(
    [
      "task",
      "delete",
      "--project",
      "Test",
      "--task",
      "市场调研",
      "--confirm-task",
      "市场调研",
      "--dry-run",
    ],
    env,
  );
  assert.equal(preview.code, 0);
  assert.equal(preview.json.data.dryRun, true);
  assert.equal(mock.taskDeletes(), 0);

  const mismatch = await run(
    [
      "task",
      "delete",
      "--project",
      "Test",
      "--task",
      "市场调研",
      "--confirm-task",
      "市场调研x",
    ],
    env,
  );
  assert.equal(mismatch.code, 1);
  assert.equal(mismatch.json.error.code, "DELETE_CONFIRMATION_MISMATCH");
  assert.equal(mock.taskDeletes(), 0);

  const deleted = await run(
    [
      "task",
      "delete",
      "--project",
      "Test",
      "--task",
      "市场调研",
      "--confirm-task",
      "市场调研",
      "--idempotency-key",
      "delete-key",
    ],
    env,
  );
  assert.equal(deleted.code, 0);
  assert.equal(deleted.json.data.deletionId, "deletion-1");
  assert.equal(deleted.json.data.verification, "delete-after-readback");
  assert.equal(mock.taskDeletes(), 1);

  const trash = await run(["trash", "get", "--deletion-id", "deletion-1"], env);
  assert.equal(trash.code, 0);
  assert.equal(trash.json.data.manifest.files[0].path, "wiki/market.md");

  const restorePreview = await run(
    [
      "task",
      "restore",
      "--deletion-id",
      "deletion-1",
      "--confirm-task",
      "市场调研",
      "--dry-run",
    ],
    env,
  );
  assert.equal(restorePreview.code, 0);
  assert.equal(restorePreview.json.data.canRestore, true);
  assert.equal(mock.taskRestores(), 0);

  const restored = await run(
    [
      "task",
      "restore",
      "--deletion-id",
      "deletion-1",
      "--confirm-task",
      "市场调研",
      "--idempotency-key",
      "restore-key",
    ],
    env,
  );
  assert.equal(restored.code, 0);
  assert.equal(restored.json.data.task.id, "task-1");
  assert.equal(restored.json.data.verification, "restore-after-readback");
  assert.equal(mock.taskRestores(), 1);
});

test("project deletion requires exact confirmation and verifies soft deletion", async (t) => {
  const mock = await mockService("development");
  t.after(() => mock.server.close());
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "procli-delete-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { PROCLI_CONFIG_PATH: path.join(home, "config.json") };
  await run(
    [
      "profile",
      "add",
      "local",
      "--url",
      mock.url,
      "--environment",
      "development",
    ],
    env,
  );
  await run(["profile", "use", "local"], env);
  const mismatch = await run(
    ["project", "delete", "--name", "Test", "--confirm-name", "test", "--yes"],
    env,
  );
  assert.equal(mismatch.json.error.code, "DELETE_CONFIRMATION_MISMATCH");
  assert.equal(mock.deletes(), 0);
  const preview = await run(
    [
      "project",
      "delete",
      "--name",
      "Test",
      "--confirm-name",
      "Test",
      "--dry-run",
    ],
    env,
  );
  assert.equal(preview.json.data.preview.taskCount, 7);
  const removed = await run(
    ["project", "delete", "--name", "Test", "--confirm-name", "Test", "--yes"],
    env,
  );
  assert.equal(removed.code, 0);
  assert.equal(removed.json.data.verification, "soft-delete-readback");
  assert.equal(removed.json.data.recoverable, true);
  assert.equal(mock.deletes(), 1);
});

test("production writes require --yes", async (t) => {
  const mock = await mockService("production");
  t.after(() => mock.server.close());
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "procli-prod-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { PROCLI_CONFIG_PATH: path.join(home, "config.json") };
  await run(
    ["profile", "add", "nas", "--url", mock.url, "--environment", "production"],
    env,
  );
  const denied = await run(["project", "create", "--name", "Test"], env);
  assert.equal(denied.code, 1);
  assert.equal(denied.json.error.code, "CONFIRMATION_REQUIRED");
  assert.equal(mock.creates(), 0);
  const created = await run(
    ["project", "create", "--name", "Test", "--yes"],
    env,
  );
  assert.equal(created.code, 0);
  assert.equal(mock.creates(), 1);
});

test("production task creation requires --yes after authoritative preview", async (t) => {
  const mock = await mockService("production");
  t.after(() => mock.server.close());
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "procli-task-prod-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { PROCLI_CONFIG_PATH: path.join(home, "config.json") };
  await run(
    ["profile", "add", "nas", "--url", mock.url, "--environment", "production"],
    env,
  );
  const denied = await run(
    [
      "task",
      "create",
      "--project",
      "Test",
      "--node",
      "市场调研",
      "--title",
      "生产任务",
      "--context-token",
      "context-4",
      "--idempotency-key",
      "production-task-key",
    ],
    env,
  );
  assert.equal(denied.code, 1);
  assert.equal(denied.json.error.code, "CONFIRMATION_REQUIRED");
  assert.equal(mock.taskCreates(), 0);
  const created = await run(
    [
      "task",
      "create",
      "--project",
      "Test",
      "--node",
      "市场调研",
      "--title",
      "生产任务",
      "--context-token",
      "context-4",
      "--idempotency-key",
      "production-task-key",
      "--yes",
    ],
    env,
  );
  assert.equal(created.code, 0);
  assert.equal(created.json.data.verification, "write-after-readback");
  assert.equal(mock.taskCreates(), 1);
});

test("bundled Skill installs into an explicit target", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "procli-skill-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installed = await run([
    "skill",
    "install",
    "--target-dir",
    root,
    "--mode",
    "copy",
  ]);
  assert.equal(installed.code, 0);
  assert.equal(installed.json.data.current, true);
  assert.equal(
    await fs
      .readFile(path.join(root, "project-management", "SKILL.md"), "utf8")
      .then((x) => x.includes("project.service.project.create")),
    true,
  );
});
