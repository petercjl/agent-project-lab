import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { CliError, configPath, deleteToken, normalizeUrl, readConfig, readToken, resolveProfile, saveToken, selectedProfileName, writeConfig } from "./config.mjs";
import { inspectTarget, request } from "./client.mjs";
import { installSkill, skillSource, skillStatus } from "./skill.mjs";

const VERSION = "0.1.0";
const help = `procli ${VERSION} — Agent-first project management CLI

Profile（默认 nas）：
  profile add NAME --url URL --environment development|production
  profile list | current | use NAME | remove NAME

认证：
  auth login [--profile NAME] [--no-open] [--timeout-ms 300000]
  auth status|logout [--profile NAME]

项目：
  project create --name NAME [--goal TEXT] [--template ecommerce-v1]
                 [--mode agent] [--idempotency-key KEY] [--dry-run] [--yes]

发现与安装：
  capabilities [--profile NAME]
  doctor [--profile NAME]
  skill source
  skill status|install|update --agent codex|agents|sealseek|openclaw [--mode auto|link|copy]

全局：--profile NAME --json
Profile 选择顺序：--profile > PROCLI_PROFILE > profile use > nas。`;

export function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value.startsWith("--")) {
      const key = value.slice(2);
      if (["json", "yes", "dry-run", "no-open", "help", "version"].includes(key)) options[key] = true;
      else {
        if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new CliError("ARGUMENT", `缺少 --${key} 的值`);
        options[key] = argv[++i];
      }
    } else positional.push(value);
  }
  return { options, positional };
}

function required(options, key) {
  if (typeof options[key] !== "string" || !options[key].trim()) throw new CliError("ARGUMENT", `缺少 --${key}`);
  return options[key].trim();
}

function output(data, ok = true) {
  console.log(JSON.stringify({ ok, data }, null, 2));
  if (!ok) process.exitCode = 1;
}

async function openUrl(url) {
  const command = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: "ignore" });
  child.unref();
}

async function authLogin(profile, options) {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const verifierHash = crypto.createHash("sha256").update(verifier).digest("hex");
  const started = await request(profile, "/api/auth/cli/start", { method: "POST", body: { verifierHash, clientName: `procli/${VERSION}` }, token: "" });
  if (!options["no-open"]) await openUrl(started.data.verificationUrl);
  process.stderr.write(`请在浏览器完成钉钉授权：${started.data.verificationUrl}\n`);
  const timeoutMs = Math.max(10000, Number(options["timeout-ms"] || 300000));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Number(started.data.intervalMs || 1500)));
    const response = await fetch(profile.url + "/api/auth/cli/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: started.data.requestId, verifier }),
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json();
    if (response.status === 202) continue;
    if (!response.ok || !payload.ok) throw new CliError(payload?.error?.code || "AUTH_FAILED", payload?.error?.message || "CLI 授权失败");
    await saveToken(profile.name, payload.data.token);
    return { profile: profile.name, url: profile.url, authenticated: true, member: payload.data.member, expiresAt: payload.data.expiresAt };
  }
  throw new CliError("AUTH_TIMEOUT", "等待钉钉授权超时，请重新运行 auth login");
}

export async function main(argv) {
  const { options, positional } = parseArgs(argv);
  const [group, command] = positional;
  if (options.version || group === "version") return output({ version: VERSION });
  if (!group || group === "help" || options.help) return console.log(help);
  const file = configPath();
  const config = await readConfig(file);

  if (group === "profile") {
    if (command === "add") {
      const name = positional[2];
      if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) throw new CliError("ARGUMENT", "请提供有效 Profile 名称");
      const environment = required(options, "environment");
      if (!['development', 'production'].includes(environment)) throw new CliError("ARGUMENT", "--environment 必须是 development 或 production");
      const candidate = { name, url: normalizeUrl(required(options, "url")), environment };
      const target = await inspectTarget(candidate);
      config.profiles[name] = { url: candidate.url, environment, instanceId: target.instanceId };
      await writeConfig(config, file);
      return output({ profile: name, ...config.profiles[name], verified: true });
    }
    if (command === "list") return output({ currentProfile: config.currentProfile || "nas", profiles: config.profiles });
    if (command === "current") {
      const name = selectedProfileName(options, config);
      return output({ selectedBy: options.profile ? "flag" : process.env.PROCLI_PROFILE ? "environment" : "default", profile: name, ...(config.profiles[name] || { configured: false }) });
    }
    if (command === "use") {
      const name = positional[2];
      if (!config.profiles[name]) throw new CliError("PROFILE_NOT_CONFIGURED", `Profile “${name}”尚未配置`);
      config.currentProfile = name;
      await writeConfig(config, file);
      return output({ currentProfile: name, ...config.profiles[name] });
    }
    if (command === "remove") {
      const name = positional[2];
      if (!config.profiles[name]) throw new CliError("PROFILE_NOT_CONFIGURED", `Profile “${name}”尚未配置`);
      delete config.profiles[name];
      if (config.currentProfile === name) config.currentProfile = "nas";
      await writeConfig(config, file);
      await deleteToken(name, file);
      return output({ removed: name, currentProfile: config.currentProfile });
    }
    throw new CliError("UNKNOWN_COMMAND", "未知 profile 命令");
  }

  if (group === "skill") {
    if (command === "source") return output({ skill: "project-management", source: skillSource });
    const agent = options.agent || "";
    if (command === "status") return output(await skillStatus(agent, options["target-dir"]));
    if (command === "install") return output(await installSkill({ agent, customRoot: options["target-dir"], mode: options.mode || "auto" }));
    if (command === "update") return output(await installSkill({ agent, customRoot: options["target-dir"], mode: options.mode || "auto", update: true }));
    throw new CliError("UNKNOWN_COMMAND", "未知 skill 命令");
  }

  const profile = resolveProfile(options, config);
  if (group === "doctor") {
    const checks = { node: { ok: Number(process.versions.node.split('.')[0]) >= 20, version: process.versions.node }, config: { ok: true, path: file }, profile: { ok: true, ...profile } };
    try { checks.server = { ok: true, ...(await inspectTarget(profile)) }; } catch (error) { checks.server = { ok: false, code: error.code, message: error.message }; }
    const token = await readToken(profile.name, file);
    if (!token) checks.auth = { ok: false, code: "AUTH_REQUIRED" };
    else {
      try { checks.auth = { ok: true, ...(await request(profile, "/api/auth/cli/status", { token })).data }; }
      catch (error) { checks.auth = { ok: false, code: error.code, message: error.message }; }
    }
    const ok = Object.values(checks).every((item) => item.ok);
    return output({ checks }, ok);
  }
  if (group === "capabilities") {
    const manifest = JSON.parse(await fs.readFile(new URL("../capabilities.json", import.meta.url), "utf8"));
    let server;
    try { server = (await request(profile, "/api/capabilities", { token: "" })).data; } catch (error) { server = { available: false, code: error.code }; }
    return output({ cli: manifest, server, target: await inspectTarget(profile) });
  }
  if (group === "auth") {
    if (command === "login") return output(await authLogin(profile, options));
    if (command === "status") {
      const token = await readToken(profile.name, file);
      if (!token) throw new CliError("AUTH_REQUIRED", `Profile “${profile.name}”尚未登录`);
      return output({ profile: profile.name, url: profile.url, ...(await request(profile, "/api/auth/cli/status", { token })).data });
    }
    if (command === "logout") {
      const token = await readToken(profile.name, file);
      if (token) await request(profile, "/api/auth/cli/revoke", { method: "POST", token }).catch(() => {});
      const removed = await deleteToken(profile.name, file);
      return output({ profile: profile.name, loggedOut: true, localCredentialRemoved: removed });
    }
    throw new CliError("UNKNOWN_COMMAND", "未知 auth 命令");
  }
  if (group === "project" && command === "create") {
    const target = await inspectTarget(profile);
    const input = { name: required(options, "name"), goal: options.goal || "", template: options.template || "ecommerce-v1", mode: options.mode || "agent" };
    if (input.template !== "ecommerce-v1") throw new CliError("ARGUMENT", "当前只支持模板 ecommerce-v1");
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    if (options["dry-run"]) return output({ dryRun: true, target, input, idempotencyKey });
    if (target.environment === "production" && !options.yes)
      throw new CliError("CONFIRMATION_REQUIRED", "目标是生产环境；确认创建后请增加 --yes", { target, input });
    const result = await request(profile, "/api/v1/projects", { method: "POST", body: input, idempotencyKey });
    const readback = await request(profile, `/api/v1/projects/${encodeURIComponent(result.data.project.id)}`);
    if (
      readback.data.project.id !== result.data.project.id ||
      readback.data.tasks.count !== result.data.tasks.count ||
      readback.data.wiki.count !== result.data.wiki.count
    )
      throw new CliError("OUTPUT_CONTRACT_FAILED", "项目写入后的回读结果与创建结果不一致", {
        projectId: result.data.project.id,
      });
    return output({
      target,
      idempotencyKey,
      ...readback.data,
      audit: result.data.audit,
      verification: "write-after-readback",
    });
  }
  throw new CliError("UNKNOWN_COMMAND", "未知命令，运行 procli help 查看用法");
}
