import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { installAuth, authConfig } from "./auth.ts";
import {
  init,
  read,
  change,
  audit,
  writeFile,
  removeFile,
  moveFile,
  safeFile,
  root,
} from "./store.ts";
import {
  makeProject,
  transition,
  setDependencies,
  Fault,
  uid,
  now,
  required,
  stages,
  statuses,
  projectNameKey,
  promoteTaskContent,
  taskContentStatus,
  projectRenamePlan,
  renameProject,
} from "./domain.ts";
const app = express();
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: false }));
app.use("/api", (req, res, next) => {
  const origin = req.headers.origin;
  const expectedOrigin = `${req.protocol}://${req.headers.host}`;
  if (origin && origin !== expectedOrigin)
    return res.status(403).json({
      ok: false,
      error: { code: "ORIGIN", message: "仅允许本站来源" },
    });
  next();
});
const actor = (req: any) =>
  String(req.auth?.memberId || req.headers["x-actor"] || "supervisor");
const get = (arr: any[], id: string, label = "记录") => {
  const v = arr.find((x) => x.id === id);
  if (!v) throw new Fault("NOT_FOUND", `${label}不存在`, 404);
  return v;
};
const activeProject = (projects: any[], id: string) => {
  const project = get(projects, id, "项目");
  if (project.deletedAt) throw new Fault("NOT_FOUND", "项目不存在", 404);
  return project;
};
const activeProjectByName = (projects: any[], name: any) => {
  const key = projectNameKey(name);
  const project = projects.find(
    (item: any) => !item.deletedAt && projectNameKey(item.name) === key,
  );
  if (!project) throw new Fault("NOT_FOUND", "项目不存在", 404);
  return project;
};
const taskNameKey = (value: any) =>
  required(value, "任务节点")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("zh-CN");
const stageNameKey = (value: any) =>
  required(value, "节点名称")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("zh-CN");
const taskView = (state: any, task: any) => {
  const contentStatus = taskContentStatus(state, task);
  return {
    ...task,
    contentStatus,
    deletable: contentStatus === "empty",
  };
};
const activeTask = (state: any, id: string) => {
  const task = get(state.tasks, id, "任务");
  if (task.deletedAt) throw new Fault("NOT_FOUND", "任务不存在", 404);
  return task;
};
const projectTasksInBoardOrder = (state: any, project: any) =>
  state.tasks
    .filter((task: any) => task.projectId === project.id && !task.deletedAt)
    .map((task: any, index: number) => ({ task, index }))
    .sort((a: any, b: any) => {
      const stage =
        project.stages.indexOf(a.task.stage) -
        project.stages.indexOf(b.task.stage);
      if (stage) return stage;
      return (a.task.boardOrder ?? a.index) - (b.task.boardOrder ?? b.index);
    })
    .map(({ task }: any) => task);
const projectVersion = (project: any) => Number(project.version || 0);
const projectContextToken = (project: any) =>
  createHash("sha256")
    .update(`${project.id}:${projectVersion(project)}`)
    .digest("base64url");
const normalizedTextKey = (value: any, label: string) =>
  required(value, label)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("zh-CN");
const memberByReference = (state: any, value: any, fallback: string) => {
  const reference = String(value || fallback || "").trim();
  const key = normalizedTextKey(reference, "负责人");
  const matches = state.members.filter(
    (member: any) =>
      normalizedTextKey(member.id, "成员") === key ||
      normalizedTextKey(member.name, "成员") === key,
  );
  if (!matches.length)
    throw new Fault("MEMBER_NOT_FOUND", `成员不存在：${reference}`, 404);
  if (matches.length > 1)
    throw new Fault("MEMBER_AMBIGUOUS", `成员名称不唯一：${reference}`, 409);
  return matches[0];
};
const taskCreatePlan = (state: any, project: any, body: any, who: string) => {
  const title = required(body.title, "任务标题");
  const titleKey = taskNameKey(title);
  const projectTasks = projectTasksInBoardOrder(state, project);
  if (projectTasks.some((task: any) => taskNameKey(task.title) === titleKey))
    throw new Fault(
      "TASK_NAME_CONFLICT",
      `项目内任务名称已存在：${title}`,
      409,
    );
  if (projectTasks.length >= 500)
    throw new Fault("VALIDATION", "每个项目最多支持 500 个任务");
  const stageKey = stageNameKey(body.stage);
  const stage = project.stages.find(
    (item: string) => stageNameKey(item) === stageKey,
  );
  if (!stage)
    throw new Fault("NODE_NOT_FOUND", `节点不存在：${body.stage}`, 404);
  const owner = memberByReference(state, body.owner, who);
  const reviewer = memberByReference(state, body.reviewer, "supervisor");
  const priorityAliases: Record<string, string> = {
    low: "低",
    medium: "中",
    high: "高",
    低: "低",
    中: "中",
    高: "高",
  };
  const priority = priorityAliases[String(body.priority || "中").toLowerCase()];
  if (!priority) throw new Fault("VALIDATION", "无效优先级");
  const dueDate = String(body.dueDate || "").trim();
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))
    throw new Fault("VALIDATION", "截止日期必须为 YYYY-MM-DD");
  const dependencyIds = Array.isArray(body.dependencies)
    ? body.dependencies
    : [];
  if (new Set(dependencyIds).size !== dependencyIds.length)
    throw new Fault("INVALID_DEPENDENCY", "依赖任务不能重复");
  const dependencies = dependencyIds.map((id: any) => {
    const task = projectTasks.find((item: any) => item.id === id);
    if (!task)
      throw new Fault("INVALID_DEPENDENCY", `依赖任务不存在：${id}`, 409);
    return task;
  });
  if (body.beforeTaskId && body.afterTaskId)
    throw new Fault("VALIDATION", "--before-task 和 --after-task 不能同时使用");
  const stageTasks = projectTasks.filter((task: any) => task.stage === stage);
  let insertAt = stageTasks.length;
  let referenceTask: any = null;
  if (body.beforeTaskId || body.afterTaskId) {
    const referenceId = body.beforeTaskId || body.afterTaskId;
    referenceTask = stageTasks.find((task: any) => task.id === referenceId);
    if (!referenceTask)
      throw new Fault(
        "POSITION_TASK_INVALID",
        "定位任务必须存在于目标节点中",
        409,
      );
    insertAt = stageTasks.indexOf(referenceTask) + (body.afterTaskId ? 1 : 0);
  }
  return {
    title,
    stage,
    owner,
    reviewer,
    priority,
    dueDate,
    description: String(body.description || "").trim(),
    criteria: String(body.criteria || "提供交付物并通过审核").trim(),
    skill: String(body.skill || "").trim(),
    dependencies,
    insertAt,
    referenceTask,
    position: body.beforeTaskId
      ? "before"
      : body.afterTaskId
        ? "after"
        : "append",
  };
};
const taskCreatePreview = (project: any, plan: any) => ({
  project: {
    id: project.id,
    name: project.name,
    projectVersion: projectVersion(project),
  },
  task: {
    title: plan.title,
    stage: plan.stage,
    description: plan.description,
    criteria: plan.criteria,
    owner: { id: plan.owner.id, name: plan.owner.name },
    reviewer: { id: plan.reviewer.id, name: plan.reviewer.name },
    priority: plan.priority,
    dueDate: plan.dueDate,
    dependencies: plan.dependencies.map((task: any) => ({
      id: task.id,
      title: task.title,
    })),
    position: plan.position,
    positionIndex: plan.insertAt,
    referenceTask: plan.referenceTask
      ? { id: plan.referenceTask.id, title: plan.referenceTask.title }
      : null,
  },
});
const requireProjectContext = (project: any, token: any) => {
  if (typeof token !== "string" || !token)
    throw new Fault("CONTEXT_TOKEN_REQUIRED", "缺少写前状态令牌", 409);
  if (token !== projectContextToken(project))
    throw new Fault(
      "PROJECT_STATE_CHANGED",
      "项目状态已发生变化，请重新读取写前快照",
      409,
    );
};
const stableValue = (value: any): any =>
  Array.isArray(value)
    ? value.map(stableValue)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stableValue(value[key])]),
        )
      : value;
const impactHash = (value: any) =>
  createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
const taskFiles = async (state: any, task: any) => {
  const page = state.pages.find(
    (item: any) =>
      !item.deletedAt &&
      item.projectId === task.projectId &&
      item.path === task.wikiPath,
  );
  const paths = [
    ...(page ? [page.path] : []),
    ...(page?.history || []).map((item: any) => item.path),
    ...state.artifacts
      .filter((item: any) => !item.deletedAt && item.taskId === task.id)
      .map((item: any) => item.path),
  ];
  return Promise.all(
    [...new Set(paths)].sort().map(async (relative) => {
      try {
        const content = await fs.readFile(
          await safeFile(task.projectId, relative),
        );
        return {
          path: relative,
          size: content.length,
          sha256: createHash("sha256").update(content).digest("hex"),
        };
      } catch (error: any) {
        if (error.code === "ENOENT") return { path: relative, missing: true };
        throw error;
      }
    }),
  );
};
const taskDeleteImpact = async (
  state: any,
  project: any,
  task: any,
  dependencyPolicy = "block",
  replacementTaskId = "",
) => {
  if (!["block", "detach", "rewire"].includes(dependencyPolicy))
    throw new Fault("VALIDATION", "无效的下游依赖处理策略");
  const tasks = projectTasksInBoardOrder(state, project);
  const dependents = tasks.filter((item: any) =>
    item.dependencies.includes(task.id),
  );
  let replacement: any = null;
  if (dependencyPolicy === "rewire") {
    replacement = tasks.find((item: any) => item.id === replacementTaskId);
    if (!replacement || replacement.id === task.id)
      throw new Fault(
        "INVALID_DEPENDENCY",
        "重连目标必须是本项目其他活动任务",
        409,
      );
  }
  const records = {
    events: state.events.filter(
      (item: any) => item.details?.taskId === task.id,
    ),
    runs: state.runs.filter(
      (item: any) => !item.deletedAt && item.taskId === task.id,
    ),
    artifacts: state.artifacts.filter(
      (item: any) => !item.deletedAt && item.taskId === task.id,
    ),
    notifications: state.notifications.filter(
      (item: any) => !item.deletedAt && item.taskId === task.id,
    ),
    measurements: state.measurements.filter(
      (item: any) => !item.deletedAt && item.taskId === task.id,
    ),
    pages: state.pages.filter(
      (item: any) =>
        !item.deletedAt &&
        item.projectId === project.id &&
        item.path === task.wikiPath,
    ),
  };
  const files = await taskFiles(state, task);
  const previous = tasks[tasks.indexOf(task) - 1] || null;
  const next = tasks[tasks.indexOf(task) + 1] || null;
  const impact = {
    project: { id: project.id, name: project.name },
    task: {
      id: task.id,
      title: task.title,
      stage: task.stage,
      status: task.status,
      contentStatus: taskContentStatus(state, task),
      boardOrder: task.boardOrder ?? 0,
      version: task.version,
    },
    anchors: {
      previousTaskId: previous?.id || null,
      nextTaskId: next?.id || null,
    },
    dependencies: [...task.dependencies],
    dependents: dependents.map((item: any) => ({
      id: item.id,
      title: item.title,
      dependencies: [...item.dependencies],
    })),
    dependencyPolicy,
    replacement: replacement
      ? { id: replacement.id, title: replacement.title }
      : null,
    records: Object.fromEntries(
      Object.entries(records).map(([key, items]: any) => [key, items.length]),
    ),
    files,
    knowledge: {
      provider: "local-markdown",
      recoverable: true,
      exclusive: records.pages.length + records.artifacts.length,
      shared: 0,
      external: 0,
    },
    retentionDays: 90,
  };
  return { impact, records, dependents, hash: impactHash(impact) };
};
async function rebuildWikiIndex(state: any, project: any) {
  await writeFile(
    project.id,
    "wiki/index.md",
    `# ${project.name}\n\n${project.goal || ""}\n\n` +
      state.pages
        .filter((page: any) => page.projectId === project.id && !page.deletedAt)
        .map((page: any) => `- [${page.title}](${path.basename(page.path)})`)
        .join("\n"),
  );
}
async function createTaskFromPlan(
  state: any,
  project: any,
  plan: any,
  who: string,
  source: string,
) {
  const createdAt = now();
  const stageTasks = projectTasksInBoardOrder(state, project).filter(
    (task: any) => task.stage === plan.stage,
  );
  for (const task of stageTasks) {
    const order = task.boardOrder ?? stageTasks.indexOf(task);
    if (order >= plan.insertAt) {
      task.boardOrder = order + 1;
      task.version = Number(task.version || 0) + 1;
      task.updatedAt = createdAt;
    }
  }
  const task = {
    id: uid(),
    projectId: project.id,
    title: plan.title,
    stage: plan.stage,
    status: "待开始",
    contentStatus: "empty",
    boardOrder: plan.insertAt,
    owner: plan.owner.id,
    reviewer: plan.reviewer.id,
    priority: plan.priority,
    description: plan.description,
    criteria: plan.criteria,
    dueDate: plan.dueDate,
    skill: plan.skill,
    dependencies: plan.dependencies.map((item: any) => item.id),
    version: 1,
    createdAt,
    updatedAt: createdAt,
    requiresEvidence: true,
    wikiPath: `wiki/${uid()}.md`,
  };
  state.tasks.push(task);
  await writeFile(
    project.id,
    task.wikiPath,
    `# ${task.title}\n\n## 目标\n\n${task.description}\n\n## 输入与依据\n\n## 分析结论\n\n## 下一步\n`,
  );
  state.pages.push({
    id: uid(),
    projectId: project.id,
    path: task.wikiPath,
    title: task.title,
    version: 1,
    substantive: false,
    updatedAt: createdAt,
    history: [],
  });
  await writeFile(
    project.id,
    "wiki/index.md",
    `# ${project.name}\n\n${project.goal || ""}\n\n` +
      state.pages
        .filter((page: any) => page.projectId === project.id)
        .map((page: any) => `- [${page.title}](${path.basename(page.path)})`)
        .join("\n"),
  );
  audit(state, who, "task.created", project.id, {
    taskId: task.id,
    title: task.title,
    stage: task.stage,
    boardOrder: task.boardOrder,
    source,
  });
  return task;
}
async function removeEmptyTasks(state: any, tasks: any[], who: string) {
  const blocked = tasks.filter(
    (task: any) => taskContentStatus(state, task) !== "empty",
  );
  if (blocked.length)
    throw new Fault(
      "TASK_HAS_CONTENT",
      `已有 Agent 执行记录或实质产出，不能删除：${blocked
        .map((task: any) => task.title)
        .join("、")}`,
      409,
    );
  const ids = new Set(tasks.map((task: any) => task.id));
  const wikiPaths = new Set(tasks.map((task: any) => task.wikiPath));
  for (const task of tasks) await removeFile(task.projectId, task.wikiPath);
  state.tasks = state.tasks.filter((task: any) => !ids.has(task.id));
  state.pages = state.pages.filter(
    (page: any) =>
      !tasks.some(
        (task: any) =>
          page.projectId === task.projectId && wikiPaths.has(page.path),
      ),
  );
  state.notifications = state.notifications.filter(
    (notification: any) => !ids.has(notification.taskId),
  );
  for (const task of state.tasks) {
    const next = task.dependencies.filter((id: string) => !ids.has(id));
    if (next.length !== task.dependencies.length) {
      task.dependencies = next;
      task.version++;
      task.updatedAt = now();
    }
  }
  return tasks.map((task: any) => ({
    id: task.id,
    title: task.title,
    deletedBy: who,
  }));
}
const requireAdmin = (req: any) => {
  if (req.auth?.systemRole !== "admin")
    throw new Fault(
      "ADMIN_REQUIRED",
      "只有系统管理员可以删除项目，请联系管理员处理",
      403,
    );
};
const requestSource = (req: any) =>
  req.auth?.kind === "cli"
    ? "cli"
    : req.auth?.kind === "development"
      ? "development"
      : "web";
async function mutate(req: any, fn: any) {
  const who = actor(req);
  return change(
    who,
    String(req.headers["idempotency-key"] || ""),
    who +
      req.method +
      req.originalUrl +
      JSON.stringify(req.body || {}) +
      (req.file
        ? createHash("sha256").update(req.file.buffer).digest("hex") +
          req.file.originalname
        : ""),
    async (s: any) => {
      get(s.members, who, "操作身份");
      return fn(s, who);
    },
  );
}
const route = (method: string, url: string, fn: any) =>
  (app as any)[method](url, async (req: any, res: any, next: any) => {
    try {
      res.json({ ok: true, data: await fn(req, res) });
    } catch (e) {
      next(e);
    }
  });
installAuth(app);
route("get", "/api/health", async () => {
  await read();
  return {
    status: "ready",
    version: "0.2.0",
    apiVersion: "1",
    environment: process.env.APP_ENV || "development",
    instanceId: process.env.INSTANCE_ID || "local-development",
    commit: process.env.APP_COMMIT || "development",
    storage: "PostgreSQL + Markdown",
    notifications: "local",
  };
});
route("get", "/api/state", async () => {
  const state: any = await read();
  const activeIds = new Set(
    state.projects
      .filter((project: any) => !project.deletedAt)
      .map((project: any) => project.id),
  );
  return {
    ...state,
    folders: state.folders || [],
    projects: state.projects.filter((project: any) =>
      activeIds.has(project.id),
    ),
    tasks: state.tasks
      .filter((item: any) => activeIds.has(item.projectId) && !item.deletedAt)
      .map((item: any) => taskView(state, item)),
    pages: state.pages.filter(
      (item: any) => activeIds.has(item.projectId) && !item.deletedAt,
    ),
    artifacts: state.artifacts.filter(
      (item: any) => activeIds.has(item.projectId) && !item.deletedAt,
    ),
    runs: state.runs.filter(
      (item: any) => activeIds.has(item.projectId) && !item.deletedAt,
    ),
    events: state.events.filter(
      (item: any) => !item.projectId || activeIds.has(item.projectId),
    ),
    notifications: state.notifications.filter(
      (item: any) => activeIds.has(item.projectId) && !item.deletedAt,
    ),
    measurements: state.measurements.filter(
      (item: any) => activeIds.has(item.projectId) && !item.deletedAt,
    ),
    deletionBatches: state.deletionBatches || [],
  };
});
route("get", "/api/capabilities", () => ({
  version: "1",
  actions: [
    "directory.list",
    "project.task.list",
    "project.task.read",
    "project.task.create-context",
    "project.task.create-preview",
    "project.create",
    "project.folder.create",
    "project.folder.move",
    "project.rename",
    "project.directory.reorder",
    "project.pin",
    "project.icon.upload",
    "project.delete",
    "project.export",
    "project.restore",
    "project.node.create",
    "project.node.delete-empty",
    "project.board.reorder",
    "task.create",
    "task.delete-context",
    "task.delete-preview",
    "task.delete-recoverable",
    "task.restore",
    "trash.list",
    "trash.read",
    "task.update",
    "task.start",
    "task.submit",
    "task.approve",
    "task.reject",
    "task.block",
    "task.unblock",
    "wiki.read",
    "wiki.write",
    "wiki.history",
    "artifact.upload",
    "run.start",
    "run.finish",
    "measurement.add",
  ],
  projectTypes: [
    { id: "product", name: "商品项目", available: true },
    { id: "shop", name: "店铺项目", available: false, status: "TODO" },
    { id: "company", name: "企业项目", available: false, status: "TODO" },
  ],
  templates: [
    {
      id: "product-sop-v1",
      legacyId: "ecommerce-v1",
      name: "商品全生命周期",
      stages,
      customSop: true,
    },
  ],
  auth:
    authConfig().mode === "dingtalk"
      ? {
          mode: "dingtalk",
          configured: Boolean(
            authConfig().clientId &&
            authConfig().clientSecret &&
            authConfig().corpId,
          ),
          browser: "DingTalk OAuth 2.0 authorization code",
          agent: "personal-cli-token",
        }
      : {
          mode: "development",
          warning: "仅用于自动测试；x-actor 是角色模拟",
        },
}));
route("post", "/api/project-folders", (req) =>
  mutate(req, (s: any, who: string) => {
    s.folders ||= [];
    const name = required(req.body.name, "文件夹名称");
    const key = name
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .toLocaleLowerCase("zh-CN");
    if (
      s.folders.some(
        (folder: any) =>
          folder.nameKey === key ||
          folder.name
            .normalize("NFKC")
            .replace(/\s+/g, " ")
            .toLocaleLowerCase("zh-CN") === key,
      )
    )
      throw new Fault("FOLDER_NAME_CONFLICT", `文件夹名称已存在：${name}`, 409);
    const folder = {
      id: uid(),
      name,
      nameKey: key,
      createdAt: now(),
      updatedAt: now(),
      createdBy: who,
      directoryOrder:
        Math.max(
          -1,
          ...s.folders.map((item: any) => item.directoryOrder ?? -1),
        ) + 1,
    };
    s.folders.push(folder);
    audit(s, who, "folder.created", "", {
      folderId: folder.id,
      name: folder.name,
      source: requestSource(req),
    });
    return folder;
  }),
);
route("patch", "/api/v1/projects/:id/folder", (req) =>
  mutate(req, (s: any, who: string) => {
    s.folders ||= [];
    const project = activeProject(s.projects, req.params.id);
    const folderId =
      req.body.folderId === null || req.body.folderId === ""
        ? null
        : required(req.body.folderId, "文件夹");
    const folder = folderId ? get(s.folders, folderId, "文件夹") : null;
    const previousFolderId = project.folderId || null;
    const wasPinned = Boolean(project.pinned);
    project.pinned = false;
    delete project.pinnedFromFolderId;
    project.folderId = folder?.id || null;
    project.directoryOrder =
      Math.max(
        -1,
        ...s.projects
          .filter(
            (item: any) =>
              !item.deletedAt &&
              !item.pinned &&
              (item.folderId || null) === project.folderId,
          )
          .map((item: any) => item.directoryOrder ?? -1),
      ) + 1;
    audit(s, who, "project.moved", project.id, {
      name: project.name,
      fromFolderId: previousFolderId,
      toFolderId: project.folderId,
      toFolderName: folder?.name || "未归档",
      wasPinned,
      source: requestSource(req),
    });
    return project;
  }),
);
route("get", "/api/v1/projects/:id/rename-context", async (req) => {
  const s: any = await read();
  const project = activeProject(s.projects, req.params.id);
  return {
    project: {
      id: project.id,
      name: project.name,
      projectVersion: projectVersion(project),
    },
    contextToken: projectContextToken(project),
  };
});
route("post", "/api/v1/projects/:id/rename-preview", async (req) => {
  const s: any = await read();
  const project = activeProject(s.projects, req.params.id);
  requireProjectContext(project, req.body.contextToken);
  const plan = projectRenamePlan(s, project, req.body.name);
  const impact = {
    projectId: project.id,
    previousName: plan.previousName,
    name: plan.name,
  };
  return {
    dryRun: true,
    contextToken: req.body.contextToken,
    impact,
    impactHash: impactHash(impact),
  };
});
route("patch", "/api/v1/projects/:id/name", (req) =>
  mutate(req, (s: any, who: string) => {
    const project = activeProject(s.projects, req.params.id);
    requireProjectContext(project, req.body.contextToken);
    const plan = projectRenamePlan(s, project, req.body.name);
    const impact = {
      projectId: project.id,
      previousName: plan.previousName,
      name: plan.name,
    };
    if (req.body.impactHash !== impactHash(impact))
      throw new Fault(
        "RENAME_SCOPE_CHANGED",
        "项目名称状态已变化，请重新预演",
        409,
      );
    renameProject(s, project, plan.name);
    audit(s, who, "project.renamed", project.id, {
      previousName: plan.previousName,
      name: plan.name,
      source: requestSource(req),
    });
    return {
      project: {
        id: project.id,
        name: project.name,
        projectVersion: projectVersion(project),
      },
      verification: "rename-after-readback",
    };
  }),
);
route("patch", "/api/v1/projects/:id/pin", (req) =>
  mutate(req, (s: any, who: string) => {
    s.folders ||= [];
    const project = activeProject(s.projects, req.params.id);
    const pinned = Boolean(req.body.pinned);
    if (Boolean(project.pinned) === pinned) return project;
    if (pinned) {
      project.pinnedFromFolderId = project.folderId || null;
      project.folderId = null;
      project.pinned = true;
    } else {
      const returnFolderId = project.pinnedFromFolderId || null;
      project.folderId = s.folders.some(
        (folder: any) => folder.id === returnFolderId,
      )
        ? returnFolderId
        : null;
      project.pinned = false;
      delete project.pinnedFromFolderId;
    }
    project.directoryOrder =
      Math.max(
        -1,
        ...s.projects
          .filter(
            (item: any) =>
              !item.deletedAt &&
              item.id !== project.id &&
              Boolean(item.pinned) === pinned &&
              (pinned || (item.folderId || null) === project.folderId),
          )
          .map((item: any) => item.directoryOrder ?? -1),
      ) + 1;
    audit(s, who, pinned ? "project.pinned" : "project.unpinned", project.id, {
      name: project.name,
      folderId: project.folderId,
      source: requestSource(req),
    });
    return project;
  }),
);
route("put", "/api/project-directory/order", (req) =>
  mutate(req, (s: any, who: string) => {
    s.folders ||= [];
    const folderIds = req.body.folderIds;
    const layout = req.body.projects;
    if (!Array.isArray(folderIds) || !Array.isArray(layout))
      throw new Fault("VALIDATION", "目录排序数据无效");
    const activeProjects = s.projects.filter((item: any) => !item.deletedAt);
    const exactIds = (actual: any[], expected: string[]) =>
      actual.length === expected.length &&
      new Set(actual).size === actual.length &&
      actual.every(
        (id: any) => typeof id === "string" && expected.includes(id),
      );
    if (
      !exactIds(
        folderIds,
        s.folders.map((folder: any) => folder.id),
      )
    )
      throw new Fault(
        "DIRECTORY_CONFLICT",
        "目录清单已变化，请刷新后重试",
        409,
      );
    const projectIds = layout.map((item: any) => item?.id);
    if (
      !exactIds(
        projectIds,
        activeProjects.map((project: any) => project.id),
      )
    )
      throw new Fault(
        "DIRECTORY_CONFLICT",
        "项目清单已变化，请刷新后重试",
        409,
      );
    folderIds.forEach((id: string, index: number) => {
      const folder = s.folders.find((item: any) => item.id === id);
      folder.directoryOrder = index;
      folder.updatedAt = now();
    });
    layout.forEach((item: any, index: number) => {
      const project = activeProjects.find((entry: any) => entry.id === item.id);
      const pinned = Boolean(item.pinned);
      const folderId = pinned || !item.folderId ? null : item.folderId;
      if (folderId && !s.folders.some((folder: any) => folder.id === folderId))
        throw new Fault("NOT_FOUND", "目录不存在", 404);
      if (pinned && !project.pinned)
        project.pinnedFromFolderId = project.folderId || null;
      if (!pinned && project.pinned) delete project.pinnedFromFolderId;
      project.pinned = pinned;
      project.folderId = folderId;
      project.directoryOrder = index;
    });
    audit(s, who, "directory.reordered", "", {
      folderCount: folderIds.length,
      projectCount: layout.length,
      source: requestSource(req),
    });
    return { folders: s.folders, projects: activeProjects };
  }),
);
route("get", "/api/v1/directory", async () => {
  const s: any = await read();
  const folders = [...(s.folders || [])].sort(
    (a: any, b: any) =>
      (a.directoryOrder ?? Number.MAX_SAFE_INTEGER) -
      (b.directoryOrder ?? Number.MAX_SAFE_INTEGER),
  );
  const projects = s.projects
    .filter((project: any) => !project.deletedAt)
    .sort(
      (a: any, b: any) =>
        (a.directoryOrder ?? Number.MAX_SAFE_INTEGER) -
        (b.directoryOrder ?? Number.MAX_SAFE_INTEGER),
    )
    .map((project: any) => {
      const tasks = s.tasks.filter(
        (task: any) => task.projectId === project.id,
      );
      const completedTasks = tasks.filter(
        (task: any) => task.status === "已完成",
      ).length;
      return {
        id: project.id,
        name: project.name,
        type: project.type,
        status: project.status,
        goal: project.goal,
        folderId: project.folderId || null,
        folderName:
          folders.find((folder: any) => folder.id === project.folderId)?.name ||
          null,
        pinned: Boolean(project.pinned),
        directoryOrder: project.directoryOrder ?? null,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt || project.createdAt,
        taskCount: tasks.length,
        completedTaskCount: completedTasks,
        progress: tasks.length
          ? Math.round((completedTasks / tasks.length) * 100)
          : 0,
      };
    });
  return {
    counts: {
      folders: folders.length,
      projects: projects.length,
      pinnedProjects: projects.filter((project: any) => project.pinned).length,
      unfiledProjects: projects.filter(
        (project: any) => !project.pinned && !project.folderId,
      ).length,
    },
    folders: folders.map((folder: any) => ({
      id: folder.id,
      name: folder.name,
      directoryOrder: folder.directoryOrder ?? null,
      createdAt: folder.createdAt,
      updatedAt: folder.updatedAt,
      projectIds: projects
        .filter((project: any) => project.folderId === folder.id)
        .map((project: any) => project.id),
    })),
    projects,
  };
});
async function createProjectRequest(req: any, detailed = false) {
  if (
    req.body.template &&
    !["ecommerce-v1", "product-sop-v1"].includes(req.body.template)
  )
    throw new Fault("VALIDATION", "当前只支持商品项目 SOP 模板");
  return mutate(req, async (s: any, who: string) => {
    const p = makeProject(s, req.body);
    const tasks = s.tasks.filter((x: any) => x.projectId === p.id);
    for (const t of tasks) {
      const content = `# ${t.title}\n\n## 目标\n\n${p.goal}\n\n## 输入与依据\n\n## 分析结论\n\n## 下一步\n`;
      await writeFile(p.id, t.wikiPath, content);
      s.pages.push({
        id: uid(),
        projectId: p.id,
        path: t.wikiPath,
        title: t.title,
        version: 1,
        substantive: false,
        updatedAt: now(),
        history: [],
      });
    }
    await writeFile(
      p.id,
      "wiki/index.md",
      `# ${p.name}\n\n${p.goal}\n\n` +
        s.pages
          .filter((x: any) => x.projectId === p.id)
          .map((x: any) => `- [${x.title}](${path.basename(x.path)})`)
          .join("\n"),
    );
    await writeFile(
      p.id,
      "project.yaml",
      `id: ${p.id}\nname: ${JSON.stringify(p.name)}\ntype: ${p.type}\ntemplate: ${p.template}\nsopMode: ${p.sopMode}\n`,
    );
    audit(s, who, "project.created", p.id, {
      name: p.name,
      type: p.type,
      sopMode: p.sopMode,
      taskCount: tasks.length,
      source: requestSource(req),
    });
    if (!detailed) return p;
    return {
      project: p,
      tasks: {
        count: tasks.length,
        items: tasks.map((task: any) => ({
          id: task.id,
          title: task.title,
          stage: task.stage,
          owner: task.owner,
          status: task.status,
          dependencies: task.dependencies,
          wikiPath: task.wikiPath,
        })),
      },
      wiki: {
        count: tasks.length + 1,
        paths: ["wiki/index.md", ...tasks.map((task: any) => task.wikiPath)],
      },
      audit: { event: "project.created", actor: who },
    };
  });
}
route("post", "/api/projects", (req) => createProjectRequest(req));
route("post", "/api/v1/projects", (req) => createProjectRequest(req, true));
route("get", "/api/v1/projects/:id", async (req) => {
  const s: any = await read();
  const project = activeProject(s.projects, req.params.id);
  const tasks = projectTasksInBoardOrder(s, project);
  return {
    project,
    tasks: {
      count: tasks.length,
      items: tasks.map((task: any) => ({
        id: task.id,
        title: task.title,
        stage: task.stage,
        owner: task.owner,
        status: task.status,
        dependencies: task.dependencies,
        wikiPath: task.wikiPath,
      })),
    },
    wiki: {
      count: tasks.length + 1,
      paths: ["wiki/index.md", ...tasks.map((task: any) => task.wikiPath)],
    },
  };
});
route("get", "/api/v1/projects/resolve/by-name", async (req) => {
  const s: any = await read();
  const project = activeProjectByName(s.projects, req.query.name);
  return {
    project,
    taskCount: s.tasks.filter(
      (item: any) => item.projectId === project.id && !item.deletedAt,
    ).length,
    wikiCount:
      s.pages.filter(
        (item: any) => item.projectId === project.id && !item.deletedAt,
      ).length + 1,
  };
});
route("delete", "/api/v1/projects/by-name", (req) => {
  requireAdmin(req);
  return mutate(req, (s: any, who: string) => {
    const expectedName = required(req.body.expectedName, "确认项目名称");
    const key = projectNameKey(expectedName);
    const project = s.projects.find(
      (item: any) => !item.deletedAt && projectNameKey(item.name) === key,
    );
    if (!project) throw new Fault("NOT_FOUND", "项目不存在", 404);
    if (project.name !== expectedName)
      throw new Fault(
        "DELETE_CONFIRMATION_MISMATCH",
        "确认名称必须与项目名称完全一致",
        409,
      );
    project.deletedAt = now();
    project.deletedBy = who;
    project.status = "deleted";
    const taskCount = s.tasks.filter(
      (item: any) => item.projectId === project.id,
    ).length;
    const wikiCount =
      s.pages.filter((item: any) => item.projectId === project.id).length + 1;
    audit(s, who, "project.deleted", project.id, {
      name: project.name,
      taskCount,
      wikiCount,
      recoverable: true,
      source: requestSource(req),
    });
    return {
      projectId: project.id,
      projectName: project.name,
      deletedAt: project.deletedAt,
      deletedBy: who,
      taskCount,
      wikiCount,
      recoverable: true,
    };
  });
});
route("get", "/api/v1/deleted-projects/:id", async (req) => {
  requireAdmin(req);
  const s: any = await read();
  const project = get(s.projects, req.params.id, "已删除项目");
  if (!project.deletedAt) throw new Fault("NOT_FOUND", "已删除项目不存在", 404);
  return { project };
});
route("post", "/api/members", (req) =>
  mutate(req, (s: any, who: string) => {
    const m = {
      id: uid(),
      name: required(req.body.name, "姓名"),
      role: "member",
    };
    s.members.push(m);
    audit(s, who, "member.created", "", m);
    return m;
  }),
);
route("get", "/api/v1/projects/:id/tasks", async (req) => {
  const s: any = await read();
  const project = activeProject(s.projects, req.params.id);
  const tasks = projectTasksInBoardOrder(s, project);
  return {
    project: {
      id: project.id,
      name: project.name,
      type: project.type,
      status: project.status,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt || project.createdAt,
    },
    count: tasks.length,
    tasks: tasks.map((task: any) => ({
      ...taskView(s, task),
      dependencyStates: task.dependencies.map((id: string) => {
        const dependency = tasks.find((item: any) => item.id === id);
        return dependency
          ? {
              id: dependency.id,
              title: dependency.title,
              status: dependency.status,
            }
          : { id, missing: true };
      }),
    })),
  };
});
route("get", "/api/v1/projects/:id/task-create-context", async (req) => {
  const s: any = await read();
  const project = activeProject(s.projects, req.params.id);
  const tasks = projectTasksInBoardOrder(s, project);
  return {
    project: {
      id: project.id,
      name: project.name,
      type: project.type,
      status: project.status,
      projectVersion: projectVersion(project),
      updatedAt: project.updatedAt || project.createdAt,
    },
    contextToken: projectContextToken(project),
    nodes: project.stages.map((name: string, order: number) => ({
      name,
      order,
      taskCount: tasks.filter((task: any) => task.stage === name).length,
    })),
    tasks: tasks.map((task: any) => ({
      id: task.id,
      title: task.title,
      stage: task.stage,
      status: task.status,
      contentStatus: taskContentStatus(s, task),
      owner: task.owner,
      dependencies: task.dependencies,
      boardOrder: task.boardOrder ?? 0,
      version: task.version,
    })),
    members: s.members.map((member: any) => ({
      id: member.id,
      name: member.name,
      role: member.role,
    })),
    constraints: {
      priorities: ["低", "中", "高"],
      maxTasks: 500,
      taskTitleScope: "project",
      taskTitleUnique: true,
      defaultPosition: "node-end",
      automaticDependency: false,
    },
  };
});
route("post", "/api/v1/projects/:id/tasks/preview", async (req) => {
  const s: any = await read();
  const project = activeProject(s.projects, req.params.id);
  requireProjectContext(project, req.body.contextToken);
  const plan = taskCreatePlan(s, project, req.body, actor(req));
  return {
    dryRun: true,
    contextToken: req.body.contextToken,
    ...taskCreatePreview(project, plan),
  };
});
route("post", "/api/v1/projects/:id/tasks", (req) =>
  mutate(req, async (s: any, who: string) => {
    const project = activeProject(s.projects, req.params.id);
    requireProjectContext(project, req.body.contextToken);
    const plan = taskCreatePlan(s, project, req.body, who);
    const preview = taskCreatePreview(project, plan);
    const task = await createTaskFromPlan(
      s,
      project,
      plan,
      who,
      requestSource(req),
    );
    return {
      project: {
        id: project.id,
        name: project.name,
        projectVersion: projectVersion(project),
      },
      task: taskView(s, task),
      preview,
      audit: { event: "task.created", actor: who },
    };
  }),
);
route("get", "/api/v1/projects/:id/tasks/by-id/:taskId", async (req) => {
  const s: any = await read();
  const project = activeProject(s.projects, req.params.id);
  const task = activeTask(s, req.params.taskId);
  if (task.projectId !== project.id)
    throw new Fault("NOT_FOUND", "任务不存在", 404);
  return {
    project: {
      id: project.id,
      name: project.name,
      projectVersion: projectVersion(project),
    },
    task: taskView(s, task),
  };
});
route("get", "/api/v1/projects/:id/tasks/resolve/by-name", async (req) => {
  const s: any = await read();
  const project = activeProject(s.projects, req.params.id);
  const key = taskNameKey(req.query.name);
  const projectTasks = projectTasksInBoardOrder(s, project);
  const matches = projectTasks.filter(
    (task: any) => taskNameKey(task.title) === key,
  );
  if (!matches.length) throw new Fault("NOT_FOUND", "任务节点不存在", 404);
  if (matches.length > 1)
    throw new Fault(
      "TASK_NAME_AMBIGUOUS",
      `任务节点名称不唯一，匹配到 ${matches.length} 条记录：${matches
        .map((task: any) => task.id)
        .join("、")}`,
      409,
    );
  const task = matches[0];
  const relatedEvents = s.events
    .filter((event: any) => event.details?.taskId === task.id)
    .sort((a: any, b: any) => a.createdAt.localeCompare(b.createdAt));
  return {
    project: { id: project.id, name: project.name },
    task: taskView(s, task),
    dependencies: task.dependencies.map((id: string) => {
      const dependency = projectTasks.find((item: any) => item.id === id);
      return dependency
        ? {
            id: dependency.id,
            title: dependency.title,
            status: dependency.status,
          }
        : { id, missing: true };
    }),
    dependents: projectTasks
      .filter((item: any) => item.dependencies.includes(task.id))
      .map((item: any) => ({
        id: item.id,
        title: item.title,
        status: item.status,
      })),
    statusHistory: relatedEvents
      .filter(
        (event: any) =>
          event.details?.before?.status || event.details?.after?.status,
      )
      .map((event: any) => ({
        eventId: event.id,
        action: event.type,
        actor: event.actor,
        from: event.details?.before?.status || null,
        to: event.details?.after?.status || null,
        reason: event.details?.reason || null,
        createdAt: event.createdAt,
      })),
    records: {
      events: relatedEvents,
      runs: s.runs.filter((run: any) => run.taskId === task.id),
      artifacts: s.artifacts
        .filter((artifact: any) => artifact.taskId === task.id)
        .map(({ path: _path, ...artifact }: any) => artifact),
      wiki:
        s.pages.find(
          (page: any) =>
            page.projectId === project.id && page.path === task.wikiPath,
        ) || null,
      notifications: s.notifications.filter(
        (notification: any) => notification.taskId === task.id,
      ),
    },
  };
});
route(
  "get",
  "/api/v1/projects/:id/tasks/:taskId/delete-context",
  async (req) => {
    const s: any = await read();
    const project = activeProject(s.projects, req.params.id);
    const task = activeTask(s, req.params.taskId);
    if (task.projectId !== project.id)
      throw new Fault("NOT_FOUND", "任务不存在", 404);
    const planned = await taskDeleteImpact(s, project, task);
    return {
      project: {
        id: project.id,
        name: project.name,
        projectVersion: projectVersion(project),
      },
      task: planned.impact.task,
      contextToken: projectContextToken(project),
      permissions: {
        canDeleteEmpty: true,
        canDeleteWithContent: req.auth?.systemRole === "admin",
        systemRole: req.auth?.systemRole || "member",
      },
      impact: planned.impact,
      impactHash: planned.hash,
    };
  },
);
route(
  "post",
  "/api/v1/projects/:id/tasks/:taskId/delete-preview",
  async (req) => {
    const s: any = await read();
    const project = activeProject(s.projects, req.params.id);
    requireProjectContext(project, req.body.contextToken);
    const task = activeTask(s, req.params.taskId);
    if (task.projectId !== project.id)
      throw new Fault("NOT_FOUND", "任务不存在", 404);
    const planned = await taskDeleteImpact(
      s,
      project,
      task,
      req.body.dependencyPolicy || "block",
      req.body.replacementTaskId || "",
    );
    return {
      dryRun: true,
      contextToken: req.body.contextToken,
      impactHash: planned.hash,
      canDelete:
        !planned.dependents.length || req.body.dependencyPolicy !== "block",
      impact: planned.impact,
    };
  },
);
route("delete", "/api/v1/projects/:id/tasks/:taskId", (req) =>
  mutate(req, async (s: any, who: string) => {
    const project = activeProject(s.projects, req.params.id);
    requireProjectContext(project, req.body.contextToken);
    const task = activeTask(s, req.params.taskId);
    if (task.projectId !== project.id)
      throw new Fault("NOT_FOUND", "任务不存在", 404);
    if (req.body.confirmTask !== task.title)
      throw new Fault(
        "DELETE_CONFIRMATION_MISMATCH",
        "确认任务名称必须与当前任务名称完全一致",
        409,
      );
    const policy = req.body.dependencyPolicy || "block";
    const planned = await taskDeleteImpact(
      s,
      project,
      task,
      policy,
      req.body.replacementTaskId || "",
    );
    if (req.body.impactHash !== planned.hash)
      throw new Fault(
        "DELETE_SCOPE_CHANGED",
        "删除影响范围已变化，请重新预演并确认",
        409,
      );
    if (planned.impact.task.contentStatus !== "empty") requireAdmin(req);
    if (planned.dependents.length && policy === "block")
      throw new Fault(
        "DEPENDENTS_EXIST",
        "存在依赖该任务的下游任务，请明确选择 detach 或 rewire",
        409,
      );
    const deletionId = uid();
    const deletedAt = now();
    const retentionUntil = new Date(
      Date.parse(deletedAt) + 90 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const dependentSnapshots = planned.dependents.map((item: any) => ({
      id: item.id,
      dependencies: [...item.dependencies],
    }));
    for (const dependent of planned.dependents) {
      const dependencies = dependent.dependencies.filter(
        (id: string) => id !== task.id,
      );
      if (policy === "rewire") dependencies.push(req.body.replacementTaskId);
      setDependencies(s, dependent, [...new Set(dependencies)]);
      dependent.version++;
      dependent.updatedAt = deletedAt;
    }
    const movedFiles = [];
    for (const file of planned.impact.files) {
      if (file.missing) continue;
      const destination = `wiki/recycle/${deletionId}/files/${file.path}`;
      await moveFile(project.id, file.path, destination);
      movedFiles.push({ ...file, destination });
    }
    const snapshot = JSON.parse(JSON.stringify(task));
    task.deletedAt = deletedAt;
    task.deletedBy = who;
    task.deletionId = deletionId;
    task.deletionState = "completed";
    const recordIds: any = {};
    for (const [key, records] of Object.entries(planned.records) as any) {
      recordIds[key] = records.map((record: any) => record.id);
      if (key === "events") continue;
      for (const record of records) {
        record.deletedAt = deletedAt;
        record.deletionId = deletionId;
      }
    }
    const manifest = {
      version: 1,
      deletionId,
      projectId: project.id,
      task: snapshot,
      impact: planned.impact,
      impactHash: planned.hash,
      dependentSnapshots,
      recordIds,
      files: movedFiles,
      requestedBy: who,
      deletedAt,
      retentionUntil,
    };
    await writeFile(
      project.id,
      `wiki/recycle/${deletionId}/manifest.json`,
      JSON.stringify(manifest, null, 2),
    );
    const batch = {
      id: deletionId,
      projectId: project.id,
      scopeType: "task",
      scopeId: task.id,
      taskTitle: task.title,
      state: "completed",
      impactHash: planned.hash,
      manifestPath: `wiki/recycle/${deletionId}/manifest.json`,
      manifest,
      requestedBy: who,
      createdAt: deletedAt,
      updatedAt: deletedAt,
      retentionUntil,
    };
    s.deletionBatches ||= [];
    s.deletionBatches.push(batch);
    await rebuildWikiIndex(s, project);
    audit(s, who, "task.deleted", project.id, {
      taskId: task.id,
      title: task.title,
      deletionId,
      dependencyPolicy: policy,
    });
    return {
      deletionId,
      state: batch.state,
      project: {
        id: project.id,
        name: project.name,
        projectVersion: projectVersion(project),
      },
      task: { id: task.id, title: task.title, deletedAt },
      manifestPath: batch.manifestPath,
      retentionUntil,
      verification: "delete-after-readback",
    };
  }),
);
route("get", "/api/v1/trash", async (req: any) => {
  const s: any = await read();
  const projectId = String(req.query.projectId || "");
  return (s.deletionBatches || [])
    .filter((item: any) => !projectId || item.projectId === projectId)
    .map((item: any) => {
      const project = s.projects.find(
        (candidate: any) => candidate.id === item.projectId,
      );
      const requestedBy = s.members.find(
        (candidate: any) => candidate.id === item.requestedBy,
      );
      const task = item.manifest?.task || {};
      const impact = item.manifest?.impact || {};
      return {
        id: item.id,
        projectId: item.projectId,
        projectName: project?.name || item.projectId,
        scopeType: item.scopeType,
        scopeId: item.scopeId,
        taskTitle: item.taskTitle,
        taskStage: task.stage || impact.task?.stage || "",
        taskStatus: task.status || impact.task?.status || "",
        contentStatus:
          impact.task?.contentStatus || task.contentStatus || "empty",
        state: item.state,
        requestedBy: item.requestedBy,
        requestedByName: requestedBy?.name || item.requestedBy,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        restoredAt: item.restoredAt || null,
        restoredBy: item.restoredBy || null,
        retentionUntil: item.retentionUntil,
        impact: {
          files: (item.manifest?.files || []).length,
          runs: impact.records?.runs || 0,
          artifacts: impact.records?.artifacts || 0,
          events: impact.records?.events || 0,
          notifications: impact.records?.notifications || 0,
          measurements: impact.records?.measurements || 0,
          dependents: (impact.dependents || []).length,
        },
      };
    })
    .sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt));
});
route("get", "/api/v1/trash/:deletionId", async (req) => {
  const s: any = await read();
  return get(s.deletionBatches || [], req.params.deletionId, "回收记录");
});
route("post", "/api/v1/trash/:deletionId/restore-preview", async (req) => {
  const s: any = await read();
  const batch = get(s.deletionBatches || [], req.params.deletionId, "回收记录");
  if (batch.state !== "completed")
    throw new Fault("INVALID_RESTORE_STATE", "当前回收记录不能恢复", 409);
  const project = activeProject(s.projects, batch.projectId);
  const conflict = projectTasksInBoardOrder(s, project).find(
    (item: any) => taskNameKey(item.title) === taskNameKey(batch.taskTitle),
  );
  return {
    dryRun: true,
    deletionId: batch.id,
    project: { id: project.id, name: project.name },
    task: { id: batch.scopeId, title: batch.taskTitle },
    canRestore: !conflict,
    conflict: conflict ? { id: conflict.id, title: conflict.title } : null,
    files: batch.manifest.files,
  };
});
route("post", "/api/v1/trash/:deletionId/restore", (req) =>
  mutate(req, async (s: any, who: string) => {
    const batch = get(
      s.deletionBatches || [],
      req.params.deletionId,
      "回收记录",
    );
    if (batch.state === "restored") return batch.restoreResult;
    if (batch.state !== "completed")
      throw new Fault("INVALID_RESTORE_STATE", "当前回收记录不能恢复", 409);
    if (req.body.confirmTask !== batch.taskTitle)
      throw new Fault(
        "RESTORE_CONFIRMATION_MISMATCH",
        "确认任务名称必须与回收记录完全一致",
        409,
      );
    const project = activeProject(s.projects, batch.projectId);
    const conflict = projectTasksInBoardOrder(s, project).find(
      (item: any) => taskNameKey(item.title) === taskNameKey(batch.taskTitle),
    );
    if (conflict)
      throw new Fault("RESTORE_CONFLICT", "项目中已存在同名活动任务", 409);
    const task = get(s.tasks, batch.scopeId, "回收任务");
    for (const file of batch.manifest.files) {
      try {
        await fs.access(await safeFile(project.id, file.path));
        throw new Fault(
          "RESTORE_CONFLICT",
          `恢复目标已存在：${file.path}`,
          409,
        );
      } catch (error: any) {
        if (error instanceof Fault) throw error;
        if (error.code !== "ENOENT") throw error;
      }
      await moveFile(project.id, file.destination, file.path);
      const content = await fs.readFile(await safeFile(project.id, file.path));
      if (createHash("sha256").update(content).digest("hex") !== file.sha256)
        throw new Fault(
          "FILE_INTEGRITY",
          `恢复文件校验失败：${file.path}`,
          409,
        );
    }
    Object.assign(task, batch.manifest.task);
    delete task.deletedAt;
    delete task.deletedBy;
    delete task.deletionId;
    delete task.deletionState;
    for (const [key, ids] of Object.entries(batch.manifest.recordIds) as any) {
      if (key === "events") continue;
      for (const id of ids) {
        const record = s[key].find((item: any) => item.id === id);
        if (record) {
          delete record.deletedAt;
          delete record.deletionId;
        }
      }
    }
    const warnings = [];
    for (const saved of batch.manifest.dependentSnapshots) {
      const dependent = s.tasks.find(
        (item: any) => item.id === saved.id && !item.deletedAt,
      );
      if (!dependent) {
        warnings.push(`下游任务已不存在：${saved.id}`);
        continue;
      }
      dependent.dependencies = saved.dependencies.filter((id: string) =>
        s.tasks.some((item: any) => item.id === id && !item.deletedAt),
      );
      dependent.version++;
      dependent.updatedAt = now();
    }
    if (!project.stages.includes(task.stage)) {
      project.stages.push("待整理");
      task.stage = "待整理";
      warnings.push("原节点已不存在，任务已恢复到待整理");
    }
    batch.state = "restored";
    batch.restoredAt = now();
    batch.restoredBy = who;
    batch.updatedAt = batch.restoredAt;
    await rebuildWikiIndex(s, project);
    audit(s, who, "task.restored", project.id, {
      taskId: task.id,
      title: task.title,
      deletionId: batch.id,
      warnings,
    });
    batch.restoreResult = {
      deletionId: batch.id,
      state: batch.state,
      project: {
        id: project.id,
        name: project.name,
        projectVersion: projectVersion(project),
      },
      task: taskView(s, task),
      warnings,
      verification: "restore-after-readback",
    };
    return batch.restoreResult;
  }),
);
route("post", "/api/projects/:id/nodes", (req) =>
  mutate(req, (s: any, who: string) => {
    const project = activeProject(s.projects, req.params.id);
    const name = required(req.body.name, "节点名称");
    const key = stageNameKey(name);
    if (project.stages.some((stage: string) => stageNameKey(stage) === key))
      throw new Fault("STAGE_NAME_CONFLICT", `节点名称已存在：${name}`, 409);
    if (project.stages.length >= 50)
      throw new Fault("VALIDATION", "每个项目最多支持 50 个节点");
    project.stages.push(name);
    audit(s, who, "node.created", project.id, { name });
    return { projectId: project.id, name, taskCount: 0 };
  }),
);
route("delete", "/api/projects/:id/nodes/:stage", (req) =>
  mutate(req, async (s: any, who: string) => {
    const project = activeProject(s.projects, req.params.id);
    const key = stageNameKey(req.params.stage);
    const stage = project.stages.find(
      (item: string) => stageNameKey(item) === key,
    );
    if (!stage) throw new Fault("NOT_FOUND", "节点不存在", 404);
    const tasks = s.tasks.filter(
      (task: any) => task.projectId === project.id && task.stage === stage,
    );
    const deletedTasks = await removeEmptyTasks(s, tasks, who);
    project.stages = project.stages.filter((item: string) => item !== stage);
    audit(s, who, "node.deleted", project.id, {
      name: stage,
      deletedTasks,
    });
    return {
      projectId: project.id,
      name: stage,
      deletedTaskCount: deletedTasks.length,
    };
  }),
);
route("put", "/api/projects/:id/board/order", (req) =>
  mutate(req, (s: any, who: string) => {
    const project = activeProject(s.projects, req.params.id);
    const nodeOrder = req.body.nodeOrder;
    const placements = req.body.tasks;
    if (
      !Array.isArray(nodeOrder) ||
      nodeOrder.some((item: any) => typeof item !== "string") ||
      nodeOrder.length !== project.stages.length ||
      new Set(nodeOrder).size !== nodeOrder.length ||
      nodeOrder.some((item: string) => !project.stages.includes(item))
    )
      throw new Fault(
        "INVALID_BOARD_ORDER",
        "节点顺序必须完整包含当前项目的全部节点",
      );
    const projectTasks = s.tasks.filter(
      (task: any) => task.projectId === project.id,
    );
    if (
      !Array.isArray(placements) ||
      placements.length !== projectTasks.length ||
      placements.some(
        (item: any) =>
          !item ||
          typeof item.id !== "string" ||
          typeof item.stage !== "string" ||
          !nodeOrder.includes(item.stage),
      ) ||
      new Set(placements.map((item: any) => item.id)).size !==
        placements.length ||
      placements.some(
        (item: any) => !projectTasks.some((task: any) => task.id === item.id),
      )
    )
      throw new Fault(
        "INVALID_BOARD_ORDER",
        "任务顺序必须完整包含当前项目的全部任务",
      );
    const beforeNodes = [...project.stages];
    project.stages = [...nodeOrder];
    const nextOrder = new Map<string, number>();
    for (const placement of placements) {
      const task = projectTasks.find((item: any) => item.id === placement.id);
      const boardOrder = nextOrder.get(placement.stage) || 0;
      nextOrder.set(placement.stage, boardOrder + 1);
      if (task.stage !== placement.stage || task.boardOrder !== boardOrder) {
        task.stage = placement.stage;
        task.boardOrder = boardOrder;
        task.version++;
        task.updatedAt = now();
      }
    }
    audit(s, who, "board.reordered", project.id, {
      beforeNodes,
      nodeOrder: project.stages,
      tasks: placements,
    });
    return {
      projectId: project.id,
      nodeOrder: project.stages,
      tasks: placements.map((item: any) => ({
        ...item,
        boardOrder: projectTasks.find((task: any) => task.id === item.id)
          .boardOrder,
      })),
    };
  }),
);
route("post", "/api/tasks", (req) =>
  mutate(req, async (s: any, who: string) => {
    const p = activeProject(s.projects, req.body.projectId);
    const plan = taskCreatePlan(s, p, req.body, who);
    return createTaskFromPlan(s, p, plan, who, requestSource(req));
  }),
);
route("delete", "/api/tasks/:id", () => {
  throw new Fault(
    "RECOVERABLE_DELETE_REQUIRED",
    "请先通过 v1 删除预演接口确认影响范围，再执行可恢复删除",
    409,
  );
});
route("patch", "/api/tasks/:id", (req) =>
  mutate(req, (s: any, who: string) => {
    const t = activeTask(s, req.params.id);
    const project = activeProject(s.projects, t.projectId);
    if (req.body.version !== t.version)
      throw new Fault("VERSION_CONFLICT", "任务已更新，请刷新后重试", 409);
    const before = { ...t };
    for (const k of [
      "title",
      "description",
      "criteria",
      "dueDate",
      "priority",
      "owner",
      "reviewer",
      "skill",
      "stage",
    ])
      if (k in req.body) {
        if (["owner", "reviewer"].includes(k)) get(s.members, req.body[k]);
        if (k === "title") {
          const title = required(req.body[k], "标题");
          const key = taskNameKey(title);
          if (
            s.tasks.some(
              (item: any) =>
                item.projectId === project.id &&
                !item.deletedAt &&
                item.id !== t.id &&
                taskNameKey(item.title) === key,
            )
          )
            throw new Fault(
              "TASK_NAME_CONFLICT",
              `项目内任务名称已存在：${title}`,
              409,
            );
        }
        if (k === "stage" && !project.stages.includes(req.body[k]))
          throw new Fault("VALIDATION", "无效阶段");
        if (k === "priority" && !["低", "中", "高"].includes(req.body[k]))
          throw new Fault("VALIDATION", "无效优先级");
        if (typeof req.body[k] !== "string")
          throw new Fault("VALIDATION", "任务字段需要字符串");
        t[k] = req.body[k];
      }
    if ("dependencies" in req.body)
      setDependencies(s, t, req.body.dependencies);
    t.version++;
    audit(s, who, "task.updated", t.projectId, {
      taskId: t.id,
      before,
      after: t,
    });
    return t;
  }),
);
route("post", "/api/tasks/:id/actions/:action", (req) =>
  mutate(req, (s: any, who: string) => {
    const t = activeTask(s, req.params.id);
    activeProject(s.projects, t.projectId);
    if (req.body.version !== undefined && req.body.version !== t.version)
      throw new Fault("VERSION_CONFLICT", "任务已更新，请刷新", 409);
    const before = { ...t };
    transition(s, t, req.params.action, who, req.body.reason);
    audit(s, who, `task.${req.params.action}`, t.projectId, {
      taskId: t.id,
      title: t.title,
      before,
      after: t,
      reason: req.body.reason,
    });
    return t;
  }),
);
route("get", "/api/projects/:id/wiki", async (req: any) => {
  const s = await read();
  activeProject(s.projects, req.params.id);
  const rel = String(req.query.path || "wiki/index.md");
  const page = s.pages.find(
    (p: any) => !p.deletedAt && p.projectId === req.params.id && p.path === rel,
  );
  return {
    content: await fs.readFile(await safeFile(req.params.id, rel), "utf8"),
    page,
  };
});
route("put", "/api/projects/:id/wiki", (req) =>
  mutate(req, async (s: any, who: string) => {
    activeProject(s.projects, req.params.id);
    const rel = required(req.body.path, "路径");
    if (!rel.startsWith("wiki/") || !rel.endsWith(".md"))
      throw new Fault("VALIDATION", "Wiki 使用 wiki/ 下的 .md 文件");
    const content = required(req.body.content, "正文");
    let p = s.pages.find(
      (x: any) =>
        !x.deletedAt && x.projectId === req.params.id && x.path === rel,
    );
    if (p && req.body.version !== p.version)
      throw new Fault("VERSION_CONFLICT", "Wiki 已被修改，请刷新后重试", 409);
    let old = "";
    try {
      old = await fs.readFile(await safeFile(req.params.id, rel), "utf8");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    if (!p) {
      p = {
        id: uid(),
        projectId: req.params.id,
        path: rel,
        title: req.body.title || path.basename(rel, ".md"),
        version: 0,
        history: [],
      };
      s.pages.push(p);
    }
    if (old) {
      const backup = `history/${p.id}/${p.version}-${uid()}.md`;
      await writeFile(req.params.id, backup, old);
      p.history.push({
        version: p.version,
        path: backup,
        at: p.updatedAt || now(),
      });
    }
    await writeFile(req.params.id, rel, content);
    p.version++;
    p.substantive = content.trim().length >= 40;
    p.updatedAt = now();
    p.updatedBy = who;
    p.runId = req.body.runId || null;
    if (p.substantive) {
      const task = s.tasks.find(
        (item: any) =>
          !item.deletedAt &&
          item.projectId === req.params.id &&
          item.wikiPath === rel,
      );
      if (task) promoteTaskContent(task, "substantive");
    }
    audit(s, who, "wiki.updated", req.params.id, {
      path: rel,
      version: p.version,
      runId: p.runId,
    });
    return p;
  }),
);
route("get", "/api/projects/:id/search", async (req: any) => {
  const s = await read();
  activeProject(s.projects, req.params.id);
  const q = String(req.query.q || "").toLowerCase();
  if (!q) return [];
  const results = [];
  for (const p of s.pages.filter(
    (x: any) => !x.deletedAt && x.projectId === req.params.id,
  )) {
    const content = await fs.readFile(
      await safeFile(p.projectId, p.path),
      "utf8",
    );
    const i = content.toLowerCase().indexOf(q);
    if (i >= 0)
      results.push({
        ...p,
        excerpt: content.slice(Math.max(0, i - 60), i + 180),
      });
  }
  return results;
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});
const projectImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});
const imageType = (buffer: Buffer) => {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  )
    return { extension: "png", mimeType: "image/png" };
  if (
    buffer.length >= 3 &&
    buffer.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))
  )
    return { extension: "jpg", mimeType: "image/jpeg" };
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return { extension: "webp", mimeType: "image/webp" };
  if (
    buffer.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))
  )
    return { extension: "gif", mimeType: "image/gif" };
  throw new Fault("INVALID_IMAGE", "仅支持 PNG、JPEG、WebP 或 GIF 图片", 415);
};
app.post(
  "/api/v1/projects/:id/icon",
  projectImageUpload.single("file"),
  async (req: any, res, next) => {
    try {
      if (!req.file) throw new Fault("VALIDATION", "请选择项目图片");
      const type = imageType(req.file.buffer);
      const result = await mutate(req, async (s: any, who: string) => {
        const project = activeProject(s.projects, req.params.id);
        const icon = {
          path: `project-assets/icon-${uid()}.${type.extension}`,
          mimeType: type.mimeType,
          size: req.file.size,
          sha256: createHash("sha256").update(req.file.buffer).digest("hex"),
          updatedAt: now(),
        };
        await writeFile(project.id, icon.path, req.file.buffer);
        project.icon = icon;
        audit(s, who, "project.icon.updated", project.id, {
          size: icon.size,
          mimeType: icon.mimeType,
          sha256: icon.sha256,
          source: requestSource(req),
        });
        return icon;
      });
      res.json({ ok: true, data: result });
    } catch (e) {
      next(e);
    }
  },
);
app.get("/api/v1/projects/:id/icon", async (req, res, next) => {
  try {
    const s: any = await read();
    const project = activeProject(s.projects, req.params.id);
    if (!project.icon?.path)
      throw new Fault("NOT_FOUND", "项目图片不存在", 404);
    const content = await fs.readFile(
      await safeFile(project.id, project.icon.path),
    );
    if (
      createHash("sha256").update(content).digest("hex") !== project.icon.sha256
    )
      throw new Fault("FILE_INTEGRITY", "项目图片校验失败", 409);
    res.setHeader("Content-Type", project.icon.mimeType);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(content);
  } catch (e) {
    next(e);
  }
});
app.post(
  "/api/tasks/:id/artifacts",
  upload.single("file"),
  async (req: any, res, next) => {
    try {
      if (!req.file) throw new Fault("VALIDATION", "请选择文件");
      const a = await mutate(req, async (s: any, who: string) => {
        const t = activeTask(s, req.params.id);
        activeProject(s.projects, t.projectId);
        const id = uid();
        const name = Buffer.from(req.file.originalname, "latin1")
          .toString("utf8")
          .replace(/[\\/]/g, "_");
        const rel = `deliverables/${id}-${name}`;
        await writeFile(t.projectId, rel, req.file.buffer);
        const a = {
          id,
          taskId: t.id,
          projectId: t.projectId,
          name,
          path: rel,
          size: req.file.size,
          sha256: createHash("sha256").update(req.file.buffer).digest("hex"),
          createdAt: now(),
        };
        s.artifacts.push(a);
        promoteTaskContent(t, "substantive");
        audit(s, who, "artifact.added", t.projectId, a);
        return a;
      });
      res.json({ ok: true, data: a });
    } catch (e) {
      next(e);
    }
  },
);
app.get("/api/artifacts/:id/download", async (req, res, next) => {
  try {
    const s: any = await read();
    const a = get(s.artifacts, req.params.id);
    if (a.deletedAt) throw new Fault("NOT_FOUND", "附件不存在", 404);
    activeProject(s.projects, a.projectId);
    res.download(await safeFile(a.projectId, a.path), a.name);
  } catch (e) {
    next(e);
  }
});
route("post", "/api/runs", (req) =>
  mutate(req, (s: any, who: string) => {
    const t = activeTask(s, req.body.taskId);
    activeProject(s.projects, t.projectId);
    const r = {
      id: uid(),
      projectId: t.projectId,
      taskId: t.id,
      actor: who,
      skill: required(req.body.skill, "Skill"),
      skillVersion: req.body.skillVersion || "unspecified",
      input: req.body.input || "",
      status: "running",
      startedAt: now(),
    };
    s.runs.push(r);
    promoteTaskContent(t, "executed");
    audit(s, who, "run.started", t.projectId, r);
    return r;
  }),
);
route("patch", "/api/runs/:id", (req) =>
  mutate(req, (s: any, who: string) => {
    const r = get(s.runs, req.params.id);
    if (r.deletedAt) throw new Fault("NOT_FOUND", "运行不存在", 404);
    activeProject(s.projects, r.projectId);
    if (r.status !== "running")
      throw new Fault("INVALID_STATE", "运行已经结束", 409);
    if (!["completed", "failed"].includes(req.body.status))
      throw new Fault("VALIDATION", "状态必须是 completed 或 failed");
    Object.assign(r, {
      status: req.body.status,
      output: req.body.output || "",
      quality: req.body.quality || "",
      endedAt: now(),
    });
    if (String(r.output || "").trim()) {
      const task = activeTask(s, r.taskId);
      promoteTaskContent(task, "substantive");
    }
    audit(s, who, "run.finished", r.projectId, r);
    return r;
  }),
);
route("post", "/api/measurements", (req) =>
  mutate(req, (s: any, who: string) => {
    activeProject(s.projects, req.body.projectId);
    const b = req.body;
    if (
      !["manual", "agent"].includes(b.mode) ||
      !Number.isFinite(Number(b.minutes)) ||
      Number(b.minutes) < 0 ||
      !Number.isFinite(Number(b.correctionMinutes || 0)) ||
      Number(b.correctionMinutes || 0) < 0
    )
      throw new Fault("VALIDATION", "模式或时间无效");
    const row = {
      id: uid(),
      projectId: b.projectId,
      mode: b.mode,
      label: required(b.label, "测量事项"),
      minutes: Number(b.minutes),
      correctionMinutes: Number(b.correctionMinutes || 0),
      notes: b.notes || "",
      createdAt: now(),
    };
    s.measurements.push(row);
    audit(s, who, "measurement.added", b.projectId, row);
    return row;
  }),
);
route("post", "/api/notifications/:id/read", (req) =>
  mutate(req, (s: any) => {
    const n = get(s.notifications, req.params.id);
    activeProject(s.projects, n.projectId);
    n.readAt = now();
    return n;
  }),
);
async function exportProject(id: string) {
  const s = await read();
  const project = activeProject(s.projects, id);
  const subset: any = { project, members: s.members };
  for (const k of [
    "tasks",
    "pages",
    "artifacts",
    "runs",
    "events",
    "notifications",
    "measurements",
  ])
    subset[k] = s[k].filter((x: any) => x.projectId === id);
  const files: any = {};
  async function walk(dir: string, rel = "") {
    for (const d of await fs.readdir(dir, { withFileTypes: true })) {
      if (d.isSymbolicLink())
        throw new Fault("UNSAFE_PATH", "无法导出符号链接");
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) await walk(path.join(dir, d.name), r);
      else
        files[r] = (await fs.readFile(await safeFile(id, r))).toString(
          "base64",
        );
    }
  }
  await walk(path.join(root, "projects", id));
  return { format: "project-lab/1", exportedAt: now(), data: subset, files };
}
route("get", "/api/projects/:id/export", (req) => exportProject(req.params.id));
route("post", "/api/projects/restore", (req) =>
  mutate(req, async (s: any, who: string) => {
    const pack = req.body;
    if (pack.format !== "project-lab/1" || !pack.data?.project || !pack.files)
      throw new Fault("INVALID_EXPORT", "不支持的导出文件");
    const d = pack.data;
    required(d.project.name, "项目名称");
    if (
      !Array.isArray(d.project.stages) ||
      !d.project.stages.every((x: any) => typeof x === "string")
    )
      throw new Fault("INVALID_EXPORT", "项目阶段数据无效");
    const fields = [
      "tasks",
      "pages",
      "artifacts",
      "runs",
      "events",
      "notifications",
      "measurements",
    ];
    const ids = new Set<string>();
    for (const k of fields) {
      if (!Array.isArray(d[k]))
        throw new Fault("INVALID_EXPORT", `缺少 ${k} 数组`);
      for (const x of d[k]) {
        if (
          !x ||
          typeof x.id !== "string" ||
          ids.has(x.id) ||
          x.projectId !== d.project.id
        )
          throw new Fault("INVALID_EXPORT", "记录标识或项目归属错误");
        ids.add(x.id);
      }
    }
    if (!Array.isArray(d.members))
      throw new Fault("INVALID_EXPORT", "缺少成员数组");
    for (const t of d.tasks) {
      if (
        !statuses.includes(t.status) ||
        !Array.isArray(t.dependencies) ||
        !d.project.stages.includes(t.stage) ||
        !d.members.some((m: any) => m.id === t.owner) ||
        !d.members.some((m: any) => m.id === t.reviewer)
      )
        throw new Fault("INVALID_EXPORT", "任务字段无效");
      setDependencies({ tasks: d.tasks }, t, t.dependencies);
    }
    for (const [rel, b] of Object.entries(pack.files)) {
      if (
        typeof b !== "string" ||
        !/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b)
      )
        throw new Fault("INVALID_EXPORT", "文件编码无效");
    }
    for (const page of d.pages) {
      if (!(page.path in pack.files) || !Array.isArray(page.history))
        throw new Fault("INVALID_EXPORT", "Wiki 或版本记录缺失");
      for (const h of page.history)
        if (!(h.path in pack.files))
          throw new Fault("INVALID_EXPORT", "历史文件缺失");
    }
    for (const a of d.artifacts) {
      if (
        !(a.path in pack.files) ||
        createHash("sha256")
          .update(Buffer.from(pack.files[a.path], "base64"))
          .digest("hex") !== a.sha256
      )
        throw new Fault("INVALID_EXPORT", "附件校验失败");
    }
    const oldId = d.project.id;
    const id = uid();
    const map = new Map<string, string>([[oldId, id]]);
    for (const k of [
      "tasks",
      "pages",
      "artifacts",
      "runs",
      "events",
      "notifications",
      "measurements",
    ])
      for (const x of d[k] || []) map.set(x.id, uid());
    const remap = (v: any): any =>
      typeof v === "string"
        ? map.get(v) || v
        : Array.isArray(v)
          ? v.map(remap)
          : v && typeof v === "object"
            ? Object.fromEntries(
                Object.entries(v).map(([k, val]) => [k, remap(val)]),
              )
            : v;
    for (const rel of Object.keys(pack.files)) await safeFile(id, rel);
    for (const [rel, b] of Object.entries(pack.files))
      await writeFile(id, rel, Buffer.from(String(b), "base64"));
    const project = remap(d.project);
    project.name += "（恢复副本）";
    project.folderId = null;
    project.pinned = false;
    delete project.pinnedFromFolderId;
    project.directoryOrder =
      Math.max(
        -1,
        ...s.projects.map((item: any) => item.directoryOrder ?? -1),
      ) + 1;
    project.createdAt = now();
    s.projects.push(project);
    for (const k of [
      "tasks",
      "pages",
      "artifacts",
      "runs",
      "events",
      "notifications",
      "measurements",
    ])
      s[k].push(...remap(d[k] || []));
    for (const member of d.members || [])
      if (!s.members.some((x: any) => x.id === member.id))
        s.members.push(member);
    await writeFile(
      id,
      "project.yaml",
      `id: ${id}\nname: ${JSON.stringify(project.name)}\ntemplate: ecommerce-v1\n`,
    );
    audit(s, who, "project.restored", id, { source: oldId });
    return project;
  }),
);
app.use("/api", (req, res) =>
  res
    .status(404)
    .json({ ok: false, error: { code: "NOT_FOUND", message: "接口不存在" } }),
);
app.use((e: any, req: any, res: any, next: any) => {
  console.error(e.code || "ERROR", e.message);
  res.status(e.status || 400).json({
    ok: false,
    error: {
      code: e.code || "INTERNAL",
      message: e instanceof Fault ? e.message : "操作失败，请检查服务日志",
    },
  });
});
if (process.env.NODE_ENV === "development") {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static("dist"));
  app.get("/{*path}", (req, res) =>
    res.sendFile(path.resolve("dist/index.html")),
  );
}
await init();
const port = Number(process.env.PORT || 4317);
app.listen(port, process.env.HOST || "127.0.0.1", () =>
  console.log(`Project Lab ready: http://127.0.0.1:${port}`),
);
