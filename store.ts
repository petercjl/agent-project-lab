import pg from "pg";
import fs from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { initial, Fault, uid, now } from "./domain.ts";
export const root = path.resolve(process.env.DATA_DIR || "data");
export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL || "postgresql://localhost:55432/project_lab",
});
const fileChanges = new AsyncLocalStorage<Map<string, Buffer | null>>();
export async function init() {
  await fs.mkdir(root, { recursive: true });
  await pool.query(
    "CREATE TABLE IF NOT EXISTS lab_state (id integer PRIMARY KEY CHECK(id=1), body jsonb NOT NULL)",
  );
  await pool.query(
    "INSERT INTO lab_state VALUES (1,$1) ON CONFLICT DO NOTHING",
    [JSON.stringify(initial())],
  );
}
export async function read() {
  return (await pool.query("SELECT body FROM lab_state WHERE id=1")).rows[0]
    .body;
}
export async function change(
  actor: string,
  key: string,
  operation: string,
  fn: (s: any) => Promise<any> | any,
) {
  const c = await pool.connect();
  const files = new Map<string, Buffer | null>();
  try {
    await c.query("BEGIN");
    const s = (
      await c.query("SELECT body FROM lab_state WHERE id=1 FOR UPDATE")
    ).rows[0].body;
    if (key && s.idempotency[key]) {
      const old = s.idempotency[key];
      if (old.operation !== operation)
        throw new Fault("IDEMPOTENCY_CONFLICT", "幂等键已被其他请求使用", 409);
      await c.query("COMMIT");
      return old.result;
    }
    const result = await fileChanges.run(files, () => fn(s));
    s.revision++;
    if (key) s.idempotency[key] = { operation, result };
    await c.query("UPDATE lab_state SET body=$1 WHERE id=1", [
      JSON.stringify(s),
    ]);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    for (const [dest, old] of [...files].reverse()) {
      if (old === null) await fs.unlink(dest).catch(() => {});
      else {
        const temp = dest + ".rollback-" + uid();
        await fs.writeFile(temp, old, { flag: "wx" });
        await fs.rename(temp, dest);
      }
    }
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export function audit(
  s: any,
  actor: string,
  type: string,
  projectId: string,
  details: any,
) {
  s.events.push({
    id: uid(),
    actor,
    type,
    projectId,
    details,
    createdAt: now(),
  });
}
export function filePath(projectId: string, relative: string) {
  if (
    !/^[a-f0-9-]{36}$/.test(projectId) ||
    !relative ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).some((x) => x === ".." || x === ".git") ||
    relative.includes("\\")
  )
    throw new Fault("UNSAFE_PATH", "无效项目文件路径");
  const p = path.resolve(root, "projects", projectId, relative);
  if (!p.startsWith(path.resolve(root, "projects", projectId) + path.sep))
    throw new Fault("UNSAFE_PATH", "文件超出项目目录");
  return p;
}
export async function safeFile(projectId: string, relative: string) {
  const dest = filePath(projectId, relative);
  let cur = root;
  for (const part of path.relative(root, dest).split(path.sep)) {
    cur = path.join(cur, part);
    try {
      if ((await fs.lstat(cur)).isSymbolicLink())
        throw new Fault("UNSAFE_PATH", "项目文件不能是符号链接");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return dest;
}
export async function writeFile(
  projectId: string,
  relative: string,
  content: string | Buffer,
) {
  const dest = await safeFile(projectId, relative);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const changes = fileChanges.getStore();
  if (changes && !changes.has(dest)) {
    try {
      changes.set(dest, await fs.readFile(dest));
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      changes.set(dest, null);
    }
  }
  const temp = dest + "." + uid() + ".tmp";
  await fs.writeFile(temp, content, { flag: "wx" });
  await fs.rename(temp, dest);
}
