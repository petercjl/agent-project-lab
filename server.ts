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
    version: "0.1.0",
    apiVersion: "1",
    environment: process.env.APP_ENV || "development",
    instanceId: process.env.INSTANCE_ID || "local-development",
    commit: process.env.APP_COMMIT || "development",
    storage: "PostgreSQL + Markdown",
    notifications: "local",
  };
});
route("get", "/api/state", () => read());
route("get", "/api/capabilities", () => ({
  version: "1",
  actions: [
    "project.create",
    "project.export",
    "project.restore",
    "task.create",
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
  templates: [{ id: "ecommerce-v1", name: "商品全生命周期", stages }],
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
          legacyAgentToken: authConfig().agentToken
            ? "configured"
            : "not-configured",
        }
      : {
          mode: "development",
          warning: "仅用于自动测试；x-actor 是角色模拟",
        },
}));
async function createProjectRequest(req: any, detailed = false) {
  if (req.body.template && req.body.template !== "ecommerce-v1")
    throw new Fault("VALIDATION", "当前只支持模板 ecommerce-v1");
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
      `id: ${p.id}\nname: ${JSON.stringify(p.name)}\ntemplate: ecommerce-v1\n`,
    );
    audit(s, who, "project.created", p.id, { name: p.name });
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
route("post", "/api/v1/projects", (req) =>
  createProjectRequest(req, true),
);
route("get", "/api/v1/projects/:id", async (req) => {
  const s: any = await read();
  const project = get(s.projects, req.params.id, "项目");
  const tasks = s.tasks.filter((task: any) => task.projectId === project.id);
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
route("post", "/api/tasks", (req) =>
  mutate(req, (s: any, who: string) => {
    const p = get(s.projects, req.body.projectId);
    const b = req.body;
    if (!stages.includes(b.stage)) throw new Fault("VALIDATION", "无效阶段");
    get(s.members, b.owner);
    const t = {
      id: uid(),
      projectId: p.id,
      title: required(b.title, "任务标题"),
      stage: b.stage,
      status: "待开始",
      owner: b.owner,
      reviewer: "supervisor",
      priority: "中",
      description: b.description || "",
      criteria: b.criteria || "提供交付物并通过审核",
      dueDate: b.dueDate || "",
      dependencies: [],
      version: 1,
      createdAt: now(),
      requiresEvidence: true,
      wikiPath: `wiki/${uid()}.md`,
    };
    s.tasks.push(t);
    audit(s, who, "task.created", p.id, { taskId: t.id, title: t.title });
    return t;
  }),
);
route("patch", "/api/tasks/:id", (req) =>
  mutate(req, (s: any, who: string) => {
    const t = get(s.tasks, req.params.id);
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
        if (k === "title") required(req.body[k], "标题");
        if (k === "stage" && !stages.includes(req.body[k]))
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
    const t = get(s.tasks, req.params.id);
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
  get(s.projects, req.params.id);
  const rel = String(req.query.path || "wiki/index.md");
  const page = s.pages.find(
    (p: any) => p.projectId === req.params.id && p.path === rel,
  );
  return {
    content: await fs.readFile(await safeFile(req.params.id, rel), "utf8"),
    page,
  };
});
route("put", "/api/projects/:id/wiki", (req) =>
  mutate(req, async (s: any, who: string) => {
    get(s.projects, req.params.id);
    const rel = required(req.body.path, "路径");
    if (!rel.startsWith("wiki/") || !rel.endsWith(".md"))
      throw new Fault("VALIDATION", "Wiki 使用 wiki/ 下的 .md 文件");
    const content = required(req.body.content, "正文");
    let p = s.pages.find(
      (x: any) => x.projectId === req.params.id && x.path === rel,
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
  get(s.projects, req.params.id);
  const q = String(req.query.q || "").toLowerCase();
  if (!q) return [];
  const results = [];
  for (const p of s.pages.filter((x: any) => x.projectId === req.params.id)) {
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
app.post(
  "/api/tasks/:id/artifacts",
  upload.single("file"),
  async (req: any, res, next) => {
    try {
      if (!req.file) throw new Fault("VALIDATION", "请选择文件");
      const a = await mutate(req, async (s: any, who: string) => {
        const t = get(s.tasks, req.params.id);
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
    const a = get((await read()).artifacts, req.params.id);
    res.download(await safeFile(a.projectId, a.path), a.name);
  } catch (e) {
    next(e);
  }
});
route("post", "/api/runs", (req) =>
  mutate(req, (s: any, who: string) => {
    const t = get(s.tasks, req.body.taskId);
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
    audit(s, who, "run.started", t.projectId, r);
    return r;
  }),
);
route("patch", "/api/runs/:id", (req) =>
  mutate(req, (s: any, who: string) => {
    const r = get(s.runs, req.params.id);
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
    audit(s, who, "run.finished", r.projectId, r);
    return r;
  }),
);
route("post", "/api/measurements", (req) =>
  mutate(req, (s: any, who: string) => {
    get(s.projects, req.body.projectId);
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
    n.readAt = now();
    return n;
  }),
);
async function exportProject(id: string) {
  const s = await read();
  const project = get(s.projects, id);
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
