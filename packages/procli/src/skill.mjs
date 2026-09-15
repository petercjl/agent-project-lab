import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./config.mjs";

export const skillSource = fileURLToPath(new URL("../skill/project-management/", import.meta.url));

function targetRoot(agent) {
  const roots = {
    codex: path.join(os.homedir(), ".codex", "skills"),
    agents: path.join(os.homedir(), ".agents", "skills"),
    sealseek: path.join(os.homedir(), ".sealseek", "skill_pool"),
    openclaw: path.join(os.homedir(), ".openclaw", "skills"),
  };
  if (!roots[agent]) throw new CliError("ARGUMENT", "--agent 必须是 codex、agents、sealseek 或 openclaw");
  return roots[agent];
}

async function digest(root) {
  const hash = crypto.createHash("sha256");
  async function walk(dir) {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        hash.update(path.relative(root, full));
        hash.update(await fs.readFile(full));
      }
    }
  }
  await walk(root);
  return hash.digest("hex");
}

export async function skillStatus(agent, customRoot) {
  const root = customRoot ? path.resolve(customRoot) : targetRoot(agent);
  const destination = path.join(root, "project-management");
  const sourceDigest = await digest(skillSource);
  try {
    const stat = await fs.lstat(destination);
    if (stat.isSymbolicLink()) {
      const resolved = await fs.realpath(destination);
      return { skill: "project-management", source: skillSource, sourceDigest, targetRoot: root, destination, state: resolved === await fs.realpath(skillSource) ? "current" : "foreign-link", mode: "link", managed: resolved === await fs.realpath(skillSource), current: resolved === await fs.realpath(skillSource), resolved };
    }
    const marker = JSON.parse(await fs.readFile(path.join(destination, ".procli-managed.json"), "utf8"));
    const current = marker.sourceDigest === sourceDigest;
    return { skill: "project-management", source: skillSource, sourceDigest, targetRoot: root, destination, state: current ? "current" : "outdated", mode: "copy", managed: true, current };
  } catch (error) {
    if (error.code === "ENOENT") return { skill: "project-management", source: skillSource, sourceDigest, targetRoot: root, destination, state: "absent", managed: false, current: false };
    if (error instanceof SyntaxError) return { skill: "project-management", source: skillSource, sourceDigest, targetRoot: root, destination, state: "foreign-directory", managed: false, current: false };
    throw error;
  }
}

export async function installSkill({ agent, customRoot, mode = "auto", update = false }) {
  const status = await skillStatus(agent, customRoot);
  if (status.current) return status;
  if (status.state !== "absent" && !status.managed)
    throw new CliError("SKILL_TARGET_OCCUPIED", `目标已有非 procli 管理的 Skill：${status.destination}`);
  const selectedMode = mode === "auto" ? (process.platform === "win32" ? "copy" : "link") : mode;
  if (!['link', 'copy'].includes(selectedMode)) throw new CliError("ARGUMENT", "--mode 必须是 auto、link 或 copy");
  await fs.mkdir(status.targetRoot, { recursive: true });
  if (status.managed && update) await fs.rm(status.destination, { recursive: true, force: true });
  else if (status.state !== "absent") throw new CliError("SKILL_UPDATE_REQUIRED", "Skill 已存在，请使用 procli skill update");
  if (selectedMode === "link") await fs.symlink(skillSource, status.destination, process.platform === "win32" ? "junction" : "dir");
  else {
    await fs.cp(skillSource, status.destination, { recursive: true, errorOnExist: true });
    await fs.writeFile(path.join(status.destination, ".procli-managed.json"), JSON.stringify({ sourceDigest: status.sourceDigest, package: "@petercjl/procli" }, null, 2) + "\n");
  }
  return skillStatus(agent, customRoot);
}
