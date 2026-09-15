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
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr, json: JSON.parse(stdout) }));
  });
}

async function mockService(environment) {
  let creates = 0;
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/health")
      return res.end(JSON.stringify({ ok: true, data: { status: "ready", apiVersion: "1", environment, instanceId: `${environment}-test`, commit: "test" } }));
    if (req.url === "/api/v1/projects" && req.method === "POST") {
      creates++;
      return res.end(JSON.stringify({ ok: true, data: { project: { id: "project-1", name: "Test" }, tasks: { count: 7, items: [] }, wiki: { count: 8, paths: [] }, audit: { event: "project.created" } } }));
    }
    if (req.url === "/api/v1/projects/project-1" && req.method === "GET")
      return res.end(JSON.stringify({ ok: true, data: { project: { id: "project-1", name: "Test" }, tasks: { count: 7, items: [] }, wiki: { count: 8, paths: [] } } }));
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, creates: () => creates };
}

test("local Profile supports dry-run and verified project creation", async (t) => {
  const mock = await mockService("development");
  t.after(() => mock.server.close());
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "procli-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { PROCLI_CONFIG_PATH: path.join(home, "config.json") };
  assert.equal((await run(["profile", "add", "local", "--url", mock.url, "--environment", "development"], env)).code, 0);
  assert.equal((await run(["profile", "use", "local"], env)).code, 0);
  const dry = await run(["project", "create", "--name", "Dry", "--dry-run"], env);
  assert.equal(dry.json.data.dryRun, true);
  assert.equal(mock.creates(), 0);
  const created = await run(["project", "create", "--name", "Test", "--idempotency-key", "test-key"], env);
  assert.equal(created.code, 0);
  assert.equal(created.json.data.target.profile, "local");
  assert.equal(created.json.data.tasks.count, 7);
  assert.equal(created.json.data.wiki.count, 8);
  assert.equal(created.json.data.verification, "write-after-readback");
  assert.equal(mock.creates(), 1);
});

test("production writes require --yes", async (t) => {
  const mock = await mockService("production");
  t.after(() => mock.server.close());
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "procli-prod-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { PROCLI_CONFIG_PATH: path.join(home, "config.json") };
  await run(["profile", "add", "nas", "--url", mock.url, "--environment", "production"], env);
  const denied = await run(["project", "create", "--name", "Test"], env);
  assert.equal(denied.code, 1);
  assert.equal(denied.json.error.code, "CONFIRMATION_REQUIRED");
  assert.equal(mock.creates(), 0);
  const created = await run(["project", "create", "--name", "Test", "--yes"], env);
  assert.equal(created.code, 0);
  assert.equal(mock.creates(), 1);
});

test("bundled Skill installs into an explicit target", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "procli-skill-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installed = await run(["skill", "install", "--target-dir", root, "--mode", "copy"]);
  assert.equal(installed.code, 0);
  assert.equal(installed.json.data.current, true);
  assert.equal(await fs.readFile(path.join(root, "project-management", "SKILL.md"), "utf8").then((x) => x.includes("project.service.project.create")), true);
});
