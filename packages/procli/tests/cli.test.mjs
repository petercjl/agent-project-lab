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
  let deletes = 0;
  let deleted = false;
  let lastCreateBody;
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
    deletes: () => deletes,
    lastCreateBody: () => lastCreateBody,
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
