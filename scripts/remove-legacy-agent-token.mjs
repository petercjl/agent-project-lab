import { constants } from "node:fs";
import { chmod, copyFile, lstat, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const target = path.resolve(process.argv[2] || ".env");
const stat = await lstat(target);
if (!stat.isFile()) throw new Error("目标配置不是普通文件");

const original = await readFile(target, "utf8");
const sanitized = original.replace(/^AGENT_API_TOKEN=.*(?:\r?\n|$)/m, "");
if (sanitized === original) {
  console.log(JSON.stringify({ ok: true, target, changed: false }));
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = `${target}.backup-remove-agent-token-${stamp}`;
await copyFile(target, backup, constants.COPYFILE_EXCL);
await chmod(backup, 0o600);

const temporary = `${target}.tmp-remove-agent-token-${process.pid}`;
await writeFile(temporary, sanitized, { flag: "wx", mode: 0o600 });
await rename(temporary, target);
await chmod(target, 0o600);

const updated = await lstat(target);
const saved = await lstat(backup);
if ((updated.mode & 0o777) !== 0o600 || (saved.mode & 0o777) !== 0o600)
  throw new Error("目标配置或恢复备份的权限不是 600");

console.log(
  JSON.stringify({
    ok: true,
    target,
    changed: true,
    backup,
    permissions: "600",
  }),
);
