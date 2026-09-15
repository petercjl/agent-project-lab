import { execFileSync } from "node:child_process";
import {
  copyFile,
  chmod,
  lstat,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((value, index, all) =>
      value.startsWith("--") ? [value.slice(2), all[index + 1]] : null,
    )
    .filter(Boolean) as [string, string][],
);
const unifiedAppId = args["unified-app-id"];
if (!unifiedAppId) throw new Error("缺少 --unified-app-id");

const envPath = path.resolve(args.env || ".env");
const info = await lstat(envPath);
if (!info.isFile()) throw new Error("目标 .env 不是普通文件");

const dws = process.env.DWS_PATH || "/Users/pechen/.local/bin/dws";
const output = execFileSync(
  dws,
  [
    "devapp",
    "+credentials-get",
    "--unified-app-id",
    unifiedAppId,
    "--format",
    "json",
  ],
  {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
  },
);
const response = JSON.parse(output);
if (!response.ok || response.outcome !== "success")
  throw new Error("官方 CLI 未返回成功的应用凭据结果");
const credentials = response.data || {};
const clientId = credentials.clientId || credentials.appKey;
const clientSecret =
  credentials.clientSecret || credentials.appSecret || credentials.secret;
if (!clientId || !clientSecret)
  throw new Error("官方 CLI 返回的应用凭据不完整");
if (credentials.unifiedAppId !== unifiedAppId)
  throw new Error("官方 CLI 返回了其他应用的凭据，已拒绝写入");

let content = await readFile(envPath, "utf8");
const replace = (key: string, value: string) => {
  const line = new RegExp(`^${key}=.*$`, "m");
  content = line.test(content)
    ? content.replace(line, `${key}=${value}`)
    : `${content.trimEnd()}\n${key}=${value}\n`;
};
replace("DINGTALK_CLIENT_ID", clientId);
replace("DINGTALK_CLIENT_SECRET", clientSecret);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = `${envPath}.backup-${stamp}`;
await copyFile(envPath, backupPath, constants.COPYFILE_EXCL);
await chmod(backupPath, 0o600);
const temporaryPath = `${envPath}.tmp-${process.pid}`;
await writeFile(temporaryPath, content, { flag: "wx", mode: 0o600 });
await rename(temporaryPath, envPath);
await chmod(envPath, 0o600);
const written = await lstat(envPath);
const backup = await lstat(backupPath);
if ((written.mode & 0o777) !== 0o600 || (backup.mode & 0o777) !== 0o600)
  throw new Error("凭据文件或备份的权限不是 600");

console.log(
  JSON.stringify(
    {
      ok: true,
      unifiedAppId,
      clientId,
      configured: [
        "DINGTALK_CLIENT_ID",
        "DINGTALK_CLIENT_SECRET",
      ],
      env: envPath,
      backup: backupPath,
      permissions: "600",
      secretsPrinted: false,
    },
    null,
    2,
  ),
);
