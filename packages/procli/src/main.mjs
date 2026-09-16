import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import {
  CliError,
  configPath,
  deleteToken,
  normalizeUrl,
  readConfig,
  readToken,
  resolveProfile,
  saveToken,
  selectedProfileName,
  writeConfig,
} from "./config.mjs";
import { inspectTarget, request } from "./client.mjs";
import { installSkill, skillSource, skillStatus } from "./skill.mjs";

const VERSION = "0.6.0";
const help = `procli ${VERSION} — Agent-first project management CLI

Profile（默认 nas）：
  profile add NAME --url URL --environment development|production
  profile list | current | use NAME | remove NAME

认证：
  auth login [--profile NAME] [--no-open] [--timeout-ms 300000]
  auth status|logout [--profile NAME]

项目：
  directory list
  task list --project PROJECT_NAME
  task get --project PROJECT_NAME --task TASK_NAME
  node create-context --project PROJECT_NAME
  node create --project PROJECT_NAME --name NODE_NAME --context-token TOKEN
              [--before-node NODE_NAME | --after-node NODE_NAME]
              [--idempotency-key KEY] [--dry-run] [--yes]
  node delete-context --project PROJECT_NAME --node NODE_NAME
  node delete --project PROJECT_NAME --node NODE_NAME --confirm-node NODE_NAME
              [--dependency-policy block|detach]
              [--idempotency-key KEY] [--dry-run] [--yes]
  node restore --deletion-id ID --confirm-node NODE_NAME
               [--idempotency-key KEY] [--dry-run] [--yes]
  task create-context --project PROJECT_NAME
  task create --project PROJECT_NAME --node NODE_NAME --title TASK_NAME
              --context-token TOKEN [--description TEXT] [--criteria TEXT]
              [--owner MEMBER] [--reviewer MEMBER] [--priority low|medium|high|低|中|高]
              [--due-date YYYY-MM-DD] [--depends-on TASK_NAME[,TASK_NAME...]]
              [--before-task TASK_NAME | --after-task TASK_NAME]
              [--idempotency-key KEY] [--dry-run] [--yes]
  task delete-context --project PROJECT_NAME --task TASK_NAME
  task delete --project PROJECT_NAME --task TASK_NAME
              --confirm-task TASK_NAME [--dependency-policy block|detach|rewire]
              [--rewire-to TASK_NAME] [--idempotency-key KEY] [--dry-run] [--yes]
  trash list [--project PROJECT_NAME]
  trash get --deletion-id ID
  task restore --deletion-id ID --confirm-task TASK_NAME
               [--idempotency-key KEY] [--dry-run] [--yes]
  project create --name NAME [--goal TEXT] [--type product] [--sop-file FILE]
                 [--mode agent] [--idempotency-key KEY] [--dry-run] [--yes]
  project delete --name NAME --confirm-name NAME --yes
                 [--idempotency-key KEY] [--dry-run]

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
      if (
        ["json", "yes", "dry-run", "no-open", "help", "version"].includes(key)
      )
        options[key] = true;
      else {
        if (!argv[i + 1] || argv[i + 1].startsWith("--"))
          throw new CliError("ARGUMENT", `缺少 --${key} 的值`);
        options[key] = argv[++i];
      }
    } else positional.push(value);
  }
  return { options, positional };
}

function required(options, key) {
  if (typeof options[key] !== "string" || !options[key].trim())
    throw new CliError("ARGUMENT", `缺少 --${key}`);
  return options[key].trim();
}

function output(data, ok = true) {
  console.log(JSON.stringify({ ok, data }, null, 2));
  if (!ok) process.exitCode = 1;
}

async function readSopFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    throw new CliError("SOP_FILE_INVALID", `无法读取 SOP JSON：${file}`, {
      cause: error.message,
    });
  }
  const nodes = Array.isArray(parsed) ? parsed : parsed?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0)
    throw new CliError(
      "SOP_FILE_INVALID",
      "SOP 文件必须是非空节点数组，或包含 nodes 数组",
    );
  nodes.forEach((node, index) => {
    if (typeof node?.name !== "string" || !node.name.trim())
      throw new CliError(
        "SOP_NODE_INCOMPLETE",
        `SOP 第 ${index + 1} 个节点缺少 name`,
      );
    if (typeof node?.description !== "string" || !node.description.trim())
      throw new CliError(
        "SOP_NODE_INCOMPLETE",
        `SOP 节点“${node.name}”缺少 description`,
      );
  });
  return {
    nodes: nodes.map(({ name, description }) => ({
      name: name.trim(),
      description: description.trim(),
    })),
  };
}

async function openUrl(url) {
  const command =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function authLogin(profile, options) {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const verifierHash = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("hex");
  const started = await request(profile, "/api/auth/cli/start", {
    method: "POST",
    body: { verifierHash, clientName: `procli/${VERSION}` },
    token: "",
  });
  if (!options["no-open"]) await openUrl(started.data.verificationUrl);
  process.stderr.write(
    `请在浏览器完成钉钉授权：${started.data.verificationUrl}\n`,
  );
  const timeoutMs = Math.max(10000, Number(options["timeout-ms"] || 300000));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, Number(started.data.intervalMs || 1500)),
    );
    const response = await fetch(profile.url + "/api/auth/cli/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: started.data.requestId, verifier }),
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json();
    if (response.status === 202) continue;
    if (!response.ok || !payload.ok)
      throw new CliError(
        payload?.error?.code || "AUTH_FAILED",
        payload?.error?.message || "CLI 授权失败",
      );
    await saveToken(profile.name, payload.data.token);
    return {
      profile: profile.name,
      url: profile.url,
      authenticated: true,
      member: payload.data.member,
      expiresAt: payload.data.expiresAt,
    };
  }
  throw new CliError("AUTH_TIMEOUT", "等待钉钉授权超时，请重新运行 auth login");
}

async function resolveProject(profile, name) {
  return (
    await request(
      profile,
      `/api/v1/projects/resolve/by-name?name=${encodeURIComponent(name)}`,
    )
  ).data.project;
}

const exactKey = (value) =>
  String(value)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("zh-CN");

function exactNamed(items, reference, fields, code, label) {
  const key = exactKey(reference);
  const matches = items.filter((item) =>
    fields.some((field) => exactKey(item[field]) === key),
  );
  if (!matches.length) throw new CliError(code, `${label}不存在：${reference}`);
  if (matches.length > 1)
    throw new CliError(`${code}_AMBIGUOUS`, `${label}不唯一：${reference}`, {
      candidates: matches.map((item) => ({
        id: item.id,
        title: item.title,
        name: item.name,
      })),
    });
  return matches[0];
}

async function taskCreateContext(profile, project) {
  return (
    await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/task-create-context`,
    )
  ).data;
}

async function nodeCreateContext(profile, project) {
  return (
    await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/node-create-context`,
    )
  ).data;
}

function taskCreateInput(options, context) {
  const node = exactNamed(
    context.nodes,
    required(options, "node"),
    ["name"],
    "NODE_NOT_FOUND",
    "节点",
  );
  const resolveTask = (name) =>
    exactNamed(context.tasks, name, ["id", "title"], "TASK_NOT_FOUND", "任务");
  const dependencies = String(options["depends-on"] || "")
    .split(/[,，]/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((name) => resolveTask(name).id);
  const before = options["before-task"]
    ? resolveTask(options["before-task"])
    : null;
  const after = options["after-task"]
    ? resolveTask(options["after-task"])
    : null;
  if (before && after)
    throw new CliError(
      "ARGUMENT",
      "--before-task 和 --after-task 不能同时使用",
    );
  return {
    contextToken: required(options, "context-token"),
    title: required(options, "title"),
    stage: node.name,
    description: options.description || "",
    criteria: options.criteria || "",
    owner: options.owner || "",
    reviewer: options.reviewer || "",
    priority: options.priority || "medium",
    dueDate: options["due-date"] || "",
    skill: options.skill || "",
    dependencies,
    beforeTaskId: before?.id || "",
    afterTaskId: after?.id || "",
  };
}

export async function main(argv) {
  const { options, positional } = parseArgs(argv);
  const [group, command] = positional;
  if (options.version || group === "version")
    return output({ version: VERSION });
  if (!group || group === "help" || options.help) return console.log(help);
  const file = configPath();
  const config = await readConfig(file);

  if (group === "profile") {
    if (command === "add") {
      const name = positional[2];
      if (!name || !/^[a-zA-Z0-9._-]+$/.test(name))
        throw new CliError("ARGUMENT", "请提供有效 Profile 名称");
      const environment = required(options, "environment");
      if (!["development", "production"].includes(environment))
        throw new CliError(
          "ARGUMENT",
          "--environment 必须是 development 或 production",
        );
      const candidate = {
        name,
        url: normalizeUrl(required(options, "url")),
        environment,
      };
      const target = await inspectTarget(candidate);
      config.profiles[name] = {
        url: candidate.url,
        environment,
        instanceId: target.instanceId,
      };
      await writeConfig(config, file);
      return output({
        profile: name,
        ...config.profiles[name],
        verified: true,
      });
    }
    if (command === "list")
      return output({
        currentProfile: config.currentProfile || "nas",
        profiles: config.profiles,
      });
    if (command === "current") {
      const name = selectedProfileName(options, config);
      return output({
        selectedBy: options.profile
          ? "flag"
          : process.env.PROCLI_PROFILE
            ? "environment"
            : "default",
        profile: name,
        ...(config.profiles[name] || { configured: false }),
      });
    }
    if (command === "use") {
      const name = positional[2];
      if (!config.profiles[name])
        throw new CliError(
          "PROFILE_NOT_CONFIGURED",
          `Profile “${name}”尚未配置`,
        );
      config.currentProfile = name;
      await writeConfig(config, file);
      return output({ currentProfile: name, ...config.profiles[name] });
    }
    if (command === "remove") {
      const name = positional[2];
      if (!config.profiles[name])
        throw new CliError(
          "PROFILE_NOT_CONFIGURED",
          `Profile “${name}”尚未配置`,
        );
      delete config.profiles[name];
      if (config.currentProfile === name) config.currentProfile = "nas";
      await writeConfig(config, file);
      await deleteToken(name, file);
      return output({ removed: name, currentProfile: config.currentProfile });
    }
    throw new CliError("UNKNOWN_COMMAND", "未知 profile 命令");
  }

  if (group === "skill") {
    if (command === "source")
      return output({ skill: "project-management", source: skillSource });
    const agent = options.agent || "";
    if (command === "status")
      return output(await skillStatus(agent, options["target-dir"]));
    if (command === "install")
      return output(
        await installSkill({
          agent,
          customRoot: options["target-dir"],
          mode: options.mode || "auto",
        }),
      );
    if (command === "update")
      return output(
        await installSkill({
          agent,
          customRoot: options["target-dir"],
          mode: options.mode || "auto",
          update: true,
        }),
      );
    throw new CliError("UNKNOWN_COMMAND", "未知 skill 命令");
  }

  const profile = resolveProfile(options, config);
  if (group === "doctor") {
    const checks = {
      node: {
        ok: Number(process.versions.node.split(".")[0]) >= 20,
        version: process.versions.node,
      },
      config: { ok: true, path: file },
      profile: { ok: true, ...profile },
    };
    try {
      checks.server = { ok: true, ...(await inspectTarget(profile)) };
    } catch (error) {
      checks.server = { ok: false, code: error.code, message: error.message };
    }
    const token = await readToken(profile.name, file);
    if (!token) checks.auth = { ok: false, code: "AUTH_REQUIRED" };
    else {
      try {
        checks.auth = {
          ok: true,
          ...(await request(profile, "/api/auth/cli/status", { token })).data,
        };
      } catch (error) {
        checks.auth = { ok: false, code: error.code, message: error.message };
      }
    }
    const ok = Object.values(checks).every((item) => item.ok);
    return output({ checks }, ok);
  }
  if (group === "capabilities") {
    const manifest = JSON.parse(
      await fs.readFile(
        new URL("../capabilities.json", import.meta.url),
        "utf8",
      ),
    );
    let server;
    try {
      server = (await request(profile, "/api/capabilities", { token: "" }))
        .data;
    } catch (error) {
      server = { available: false, code: error.code };
    }
    return output({
      cli: manifest,
      server,
      target: await inspectTarget(profile),
    });
  }
  if (group === "auth") {
    if (command === "login") return output(await authLogin(profile, options));
    if (command === "status") {
      const token = await readToken(profile.name, file);
      if (!token)
        throw new CliError(
          "AUTH_REQUIRED",
          `Profile “${profile.name}”尚未登录`,
        );
      return output({
        profile: profile.name,
        url: profile.url,
        ...(await request(profile, "/api/auth/cli/status", { token })).data,
      });
    }
    if (command === "logout") {
      const token = await readToken(profile.name, file);
      if (token)
        await request(profile, "/api/auth/cli/revoke", {
          method: "POST",
          token,
        }).catch(() => {});
      const removed = await deleteToken(profile.name, file);
      return output({
        profile: profile.name,
        loggedOut: true,
        localCredentialRemoved: removed,
      });
    }
    throw new CliError("UNKNOWN_COMMAND", "未知 auth 命令");
  }
  if (group === "directory" && command === "list") {
    const target = await inspectTarget(profile);
    const result = await request(profile, "/api/v1/directory");
    return output({ target, ...result.data });
  }
  if (group === "task" && command === "list") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const result = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks`,
    );
    return output({ target, ...result.data });
  }
  if (group === "task" && command === "get") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const taskName = required(options, "task");
    const result = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/resolve/by-name?name=${encodeURIComponent(taskName)}`,
    );
    return output({ target, ...result.data });
  }
  if (group === "node" && command === "create-context") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const context = await nodeCreateContext(profile, project);
    return output({ target, ...context });
  }
  if (group === "node" && command === "create") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const context = await nodeCreateContext(profile, project);
    const input = {
      contextToken: required(options, "context-token"),
      name: required(options, "name"),
      beforeNode: options["before-node"] || "",
      afterNode: options["after-node"] || "",
    };
    if (input.beforeNode && input.afterNode)
      throw new CliError(
        "ARGUMENT",
        "--before-node 和 --after-node 不能同时使用",
      );
    for (const reference of [input.beforeNode, input.afterNode].filter(Boolean))
      exactNamed(context.nodes, reference, ["name"], "NODE_NOT_FOUND", "节点");
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    let preview;
    try {
      preview = await request(
        profile,
        `/api/v1/projects/${encodeURIComponent(project.id)}/nodes/preview`,
        { method: "POST", body: input },
      );
    } catch (error) {
      if (options["dry-run"] || error.code !== "PROJECT_STATE_CHANGED")
        throw error;
      preview = null;
    }
    if (options["dry-run"])
      return output({
        target,
        idempotencyKey,
        currentContext: {
          projectVersion: context.project.projectVersion,
          contextToken: context.contextToken,
        },
        ...preview.data,
      });
    if (target.environment === "production" && !options.yes)
      throw new CliError(
        "CONFIRMATION_REQUIRED",
        "目标是生产环境；确认添加节点后请增加 --yes",
        { target, preview: preview?.data || null },
      );
    const created = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/nodes`,
      { method: "POST", body: input, idempotencyKey },
    );
    const readback = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/nodes/by-name?name=${encodeURIComponent(input.name)}`,
    );
    if (
      readback.data.node.name !== created.data.node.name ||
      readback.data.node.order !== created.data.node.order ||
      Number(readback.data.project.projectVersion) <
        Number(created.data.project.projectVersion)
    )
      throw new CliError(
        "OUTPUT_CONTRACT_FAILED",
        "节点写入后的回读结果与创建结果不一致",
        { node: input.name },
      );
    return output({
      target,
      idempotencyKey,
      project: readback.data.project,
      node: readback.data.node,
      audit: created.data.audit,
      verification: "write-after-readback",
    });
  }
  if (group === "node" && command === "delete-context") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const node = required(options, "node");
    const context = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/nodes/${encodeURIComponent(node)}/delete-context`,
    );
    return output({ target, ...context.data });
  }
  if (group === "node" && command === "delete") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const node = required(options, "node");
    const context = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/nodes/${encodeURIComponent(node)}/delete-context`,
    );
    const dependencyPolicy = options["dependency-policy"] || "block";
    if (!["block", "detach"].includes(dependencyPolicy))
      throw new CliError(
        "ARGUMENT",
        "--dependency-policy 必须是 block 或 detach",
      );
    const preview = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/nodes/${encodeURIComponent(context.data.node.name)}/delete-preview`,
      {
        method: "POST",
        body: {
          contextToken: context.data.contextToken,
          dependencyPolicy,
        },
      },
    );
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    if (options["dry-run"])
      return output({ target, idempotencyKey, ...preview.data });
    const confirmedNode = required(options, "confirm-node");
    if (confirmedNode !== context.data.node.name)
      throw new CliError(
        "DELETE_CONFIRMATION_MISMATCH",
        "--confirm-node 必须与当前节点名称完全一致",
      );
    if (!preview.data.canDelete)
      throw new CliError(
        "DEPENDENTS_EXIST",
        "其他节点存在下游任务，请明确使用 --dependency-policy detach",
        { preview: preview.data },
      );
    if (
      preview.data.permissions.requiresAdmin &&
      !preview.data.permissions.canDeleteWithContent
    )
      throw new CliError(
        "ADMIN_REQUIRED",
        "节点中包含已有产出的任务，只有管理员可以删除",
        { preview: preview.data },
      );
    if (target.environment === "production" && !options.yes)
      throw new CliError(
        "CONFIRMATION_REQUIRED",
        "目标是生产环境；确认删除节点后请增加 --yes",
        { target, preview: preview.data },
      );
    const deleted = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/nodes/${encodeURIComponent(context.data.node.name)}`,
      {
        method: "DELETE",
        body: {
          contextToken: context.data.contextToken,
          impactHash: preview.data.impactHash,
          confirmNode: confirmedNode,
          dependencyPolicy,
        },
        idempotencyKey,
      },
    );
    const readback = await request(
      profile,
      `/api/v1/trash/${encodeURIComponent(deleted.data.deletionId)}`,
    );
    if (
      readback.data.id !== deleted.data.deletionId ||
      readback.data.scopeType !== "node" ||
      readback.data.state !== "completed"
    )
      throw new CliError(
        "OUTPUT_CONTRACT_FAILED",
        "节点删除后的回收记录与请求不一致",
        { deletionId: deleted.data.deletionId },
      );
    return output({
      target,
      idempotencyKey,
      ...deleted.data,
      verification: "delete-after-readback",
    });
  }
  if (group === "node" && command === "restore") {
    const target = await inspectTarget(profile);
    const deletionId = required(options, "deletion-id");
    const batch = await request(
      profile,
      `/api/v1/trash/${encodeURIComponent(deletionId)}`,
    );
    if (batch.data.scopeType !== "node")
      throw new CliError(
        "RESTORE_SCOPE_MISMATCH",
        "该回收记录不是节点删除记录",
      );
    const preview = await request(
      profile,
      `/api/v1/trash/${encodeURIComponent(deletionId)}/restore-preview`,
      { method: "POST", body: {} },
    );
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    if (options["dry-run"])
      return output({ target, idempotencyKey, ...preview.data });
    const confirmedNode = required(options, "confirm-node");
    if (confirmedNode !== batch.data.nodeName)
      throw new CliError(
        "RESTORE_CONFIRMATION_MISMATCH",
        "--confirm-node 必须与回收记录中的节点名称完全一致",
      );
    if (!preview.data.canRestore)
      throw new CliError("RESTORE_CONFLICT", "当前节点存在恢复冲突", {
        preview: preview.data,
      });
    if (target.environment === "production" && !options.yes)
      throw new CliError(
        "CONFIRMATION_REQUIRED",
        "目标是生产环境；确认恢复节点后请增加 --yes",
        { target, preview: preview.data },
      );
    const restored = await request(
      profile,
      `/api/v1/trash/${encodeURIComponent(deletionId)}/restore`,
      {
        method: "POST",
        body: { confirmNode: confirmedNode },
        idempotencyKey,
      },
    );
    const readback = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(restored.data.project.id)}/nodes/by-name?name=${encodeURIComponent(restored.data.node.name)}`,
    );
    if (readback.data.node.name !== restored.data.node.name)
      throw new CliError("OUTPUT_CONTRACT_FAILED", "恢复后的节点回读失败", {
        deletionId,
      });
    return output({
      target,
      idempotencyKey,
      ...restored.data,
      verification: "restore-after-readback",
    });
  }
  if (group === "task" && command === "create-context") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const context = await taskCreateContext(profile, project);
    return output({ target, ...context });
  }
  if (group === "task" && command === "delete-context") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const resolved = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/resolve/by-name?name=${encodeURIComponent(required(options, "task"))}`,
    );
    const context = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(resolved.data.task.id)}/delete-context`,
    );
    return output({ target, ...context.data });
  }
  if (group === "task" && command === "delete") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const requestedTask = required(options, "task");
    const resolved = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/resolve/by-name?name=${encodeURIComponent(requestedTask)}`,
    );
    const task = resolved.data.task;
    const context = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(task.id)}/delete-context`,
    );
    const dependencyPolicy = options["dependency-policy"] || "block";
    let replacementTaskId = "";
    if (dependencyPolicy === "rewire") {
      const replacement = await request(
        profile,
        `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/resolve/by-name?name=${encodeURIComponent(required(options, "rewire-to"))}`,
      );
      replacementTaskId = replacement.data.task.id;
    }
    const preview = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(task.id)}/delete-preview`,
      {
        method: "POST",
        body: {
          contextToken: context.data.contextToken,
          dependencyPolicy,
          replacementTaskId,
        },
      },
    );
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    if (options["dry-run"])
      return output({ target, idempotencyKey, ...preview.data });
    const confirmedTask = required(options, "confirm-task");
    if (confirmedTask !== task.title)
      throw new CliError(
        "DELETE_CONFIRMATION_MISMATCH",
        "--confirm-task 必须与当前任务名称完全一致",
      );
    if (!preview.data.canDelete)
      throw new CliError(
        "DEPENDENTS_EXIST",
        "存在下游任务，请明确使用 --dependency-policy detach 或 rewire",
        { preview: preview.data },
      );
    if (target.environment === "production" && !options.yes)
      throw new CliError(
        "CONFIRMATION_REQUIRED",
        "目标是生产环境；确认删除任务后请增加 --yes",
        { target, preview: preview.data },
      );
    const deleted = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(task.id)}`,
      {
        method: "DELETE",
        body: {
          contextToken: context.data.contextToken,
          impactHash: preview.data.impactHash,
          confirmTask: confirmedTask,
          dependencyPolicy,
          replacementTaskId,
        },
        idempotencyKey,
      },
    );
    const readback = await request(
      profile,
      `/api/v1/trash/${encodeURIComponent(deleted.data.deletionId)}`,
    );
    if (
      readback.data.id !== deleted.data.deletionId ||
      readback.data.state !== "completed"
    )
      throw new CliError(
        "OUTPUT_CONTRACT_FAILED",
        "删除后的回收记录与请求不一致",
        { deletionId: deleted.data.deletionId },
      );
    return output({
      target,
      idempotencyKey,
      ...deleted.data,
      verification: "delete-after-readback",
    });
  }
  if (group === "trash" && command === "list") {
    const target = await inspectTarget(profile);
    let query = "";
    if (options.project) {
      const project = await resolveProject(profile, options.project);
      query = `?projectId=${encodeURIComponent(project.id)}`;
    }
    const result = await request(profile, `/api/v1/trash${query}`);
    return output({ target, count: result.data.length, items: result.data });
  }
  if (group === "trash" && command === "get") {
    const target = await inspectTarget(profile);
    const result = await request(
      profile,
      `/api/v1/trash/${encodeURIComponent(required(options, "deletion-id"))}`,
    );
    return output({ target, ...result.data });
  }
  if (group === "task" && command === "restore") {
    const target = await inspectTarget(profile);
    const deletionId = required(options, "deletion-id");
    const batch = await request(
      profile,
      `/api/v1/trash/${encodeURIComponent(deletionId)}`,
    );
    const preview = await request(
      profile,
      `/api/v1/trash/${encodeURIComponent(deletionId)}/restore-preview`,
      { method: "POST", body: {} },
    );
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    if (options["dry-run"])
      return output({ target, idempotencyKey, ...preview.data });
    const confirmedTask = required(options, "confirm-task");
    if (confirmedTask !== batch.data.taskTitle)
      throw new CliError(
        "RESTORE_CONFIRMATION_MISMATCH",
        "--confirm-task 必须与回收记录中的任务名称完全一致",
      );
    if (!preview.data.canRestore)
      throw new CliError("RESTORE_CONFLICT", "当前任务存在恢复冲突", {
        preview: preview.data,
      });
    if (target.environment === "production" && !options.yes)
      throw new CliError(
        "CONFIRMATION_REQUIRED",
        "目标是生产环境；确认恢复任务后请增加 --yes",
        { target, preview: preview.data },
      );
    const restored = await request(
      profile,
      `/api/v1/trash/${encodeURIComponent(deletionId)}/restore`,
      {
        method: "POST",
        body: { confirmTask: confirmedTask },
        idempotencyKey,
      },
    );
    const readback = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(restored.data.project.id)}/tasks/by-id/${encodeURIComponent(restored.data.task.id)}`,
    );
    if (readback.data.task.id !== restored.data.task.id)
      throw new CliError("OUTPUT_CONTRACT_FAILED", "恢复后的任务回读失败", {
        deletionId,
      });
    return output({
      target,
      idempotencyKey,
      ...restored.data,
      verification: "restore-after-readback",
    });
  }
  if (group === "task" && command === "create") {
    const target = await inspectTarget(profile);
    const project = await resolveProject(profile, required(options, "project"));
    const context = await taskCreateContext(profile, project);
    const input = taskCreateInput(options, context);
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    let preview;
    try {
      preview = await request(
        profile,
        `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/preview`,
        { method: "POST", body: input },
      );
    } catch (error) {
      if (options["dry-run"] || error.code !== "PROJECT_STATE_CHANGED")
        throw error;
      // A retry after an unknown write result may legitimately carry the old
      // context token. The write endpoint resolves the original idempotency
      // key before evaluating that stale token; a new attempt still fails.
      preview = null;
    }
    if (options["dry-run"])
      return output({
        target,
        idempotencyKey,
        currentContext: {
          projectVersion: context.project.projectVersion,
          contextToken: context.contextToken,
        },
        ...preview.data,
      });
    if (target.environment === "production" && !options.yes)
      throw new CliError(
        "CONFIRMATION_REQUIRED",
        "目标是生产环境；确认添加任务后请增加 --yes",
        { target, preview: preview?.data || null },
      );
    const created = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks`,
      { method: "POST", body: input, idempotencyKey },
    );
    const readback = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(project.id)}/tasks/by-id/${encodeURIComponent(created.data.task.id)}`,
    );
    if (
      readback.data.task.id !== created.data.task.id ||
      readback.data.task.title !== input.title ||
      readback.data.task.stage !== input.stage ||
      Number(readback.data.project.projectVersion) <
        Number(created.data.project.projectVersion)
    )
      throw new CliError(
        "OUTPUT_CONTRACT_FAILED",
        "任务写入后的回读结果与创建结果不一致",
        { taskId: created.data.task.id },
      );
    return output({
      target,
      idempotencyKey,
      project: readback.data.project,
      task: readback.data.task,
      audit: created.data.audit,
      verification: "write-after-readback",
    });
  }
  if (group === "project" && command === "create") {
    const target = await inspectTarget(profile);
    const type = options.type || "product";
    if (type !== "product")
      throw new CliError(
        "FEATURE_UNSUPPORTED",
        `${type === "shop" ? "店铺" : type === "company" ? "企业" : "该类型"}项目尚未开放`,
      );
    const input = {
      name: required(options, "name"),
      goal: options.goal || "",
      type,
      template: options.template || "product-sop-v1",
      mode: options.mode || "agent",
    };
    if (options["sop-file"]) input.sop = await readSopFile(options["sop-file"]);
    if (!["product-sop-v1", "ecommerce-v1"].includes(input.template))
      throw new CliError("ARGUMENT", "当前只支持商品项目 SOP 模板");
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    if (options["dry-run"])
      return output({ dryRun: true, target, input, idempotencyKey });
    if (target.environment === "production" && !options.yes)
      throw new CliError(
        "CONFIRMATION_REQUIRED",
        "目标是生产环境；确认创建后请增加 --yes",
        { target, input },
      );
    const result = await request(profile, "/api/v1/projects", {
      method: "POST",
      body: input,
      idempotencyKey,
    });
    const readback = await request(
      profile,
      `/api/v1/projects/${encodeURIComponent(result.data.project.id)}`,
    );
    if (
      readback.data.project.id !== result.data.project.id ||
      readback.data.tasks.count !== result.data.tasks.count ||
      readback.data.wiki.count !== result.data.wiki.count
    )
      throw new CliError(
        "OUTPUT_CONTRACT_FAILED",
        "项目写入后的回读结果与创建结果不一致",
        {
          projectId: result.data.project.id,
        },
      );
    return output({
      target,
      idempotencyKey,
      ...readback.data,
      audit: result.data.audit,
      verification: "write-after-readback",
    });
  }
  if (group === "project" && command === "delete") {
    const target = await inspectTarget(profile);
    const name = required(options, "name");
    const confirmedName = required(options, "confirm-name");
    if (name !== confirmedName)
      throw new CliError(
        "DELETE_CONFIRMATION_MISMATCH",
        "--confirm-name 必须与 --name 完全一致",
      );
    const idempotencyKey = options["idempotency-key"] || crypto.randomUUID();
    if (options["dry-run"]) {
      const found = await request(
        profile,
        `/api/v1/projects/resolve/by-name?name=${encodeURIComponent(name)}`,
      );
      return output({
        dryRun: true,
        target,
        preview: {
          project: { id: found.data.project.id, name: found.data.project.name },
          taskCount: found.data.taskCount,
          wikiCount: found.data.wikiCount,
          recoverable: true,
        },
        idempotencyKey,
        requiresAdmin: true,
      });
    }
    if (!options.yes)
      throw new CliError(
        "CONFIRMATION_REQUIRED",
        "删除项目必须增加 --yes，并提供完全一致的 --confirm-name",
        { target, projectName: name },
      );
    const result = await request(profile, "/api/v1/projects/by-name", {
      method: "DELETE",
      body: { expectedName: name },
      idempotencyKey,
    });
    const readback = await request(
      profile,
      `/api/v1/deleted-projects/${encodeURIComponent(result.data.projectId)}`,
    );
    if (!readback.data.project.deletedAt || readback.data.project.name !== name)
      throw new CliError(
        "OUTPUT_CONTRACT_FAILED",
        "删除后的回读结果与请求不一致",
        { projectId: result.data.projectId },
      );
    return output({
      target,
      idempotencyKey,
      ...result.data,
      verification: "soft-delete-readback",
    });
  }
  throw new CliError("UNKNOWN_COMMAND", "未知命令，运行 procli help 查看用法");
}
