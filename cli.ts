import fs from "node:fs/promises";
import path from "node:path";
const argv = process.argv.slice(2),
  opts: any = {},
  pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) {
    const k = argv[i].slice(2);
    opts[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  } else pos.push(argv[i]);
}
const [group, cmd] = pos;
const base = String(
  opts.url || process.env.PROJECT_LAB_URL || "http://127.0.0.1:4317",
);
const help = `projectctl — 本地项目实验台 CLI 0.1.0
全部结果为 JSON；默认身份 agent。审核需 --actor <指定审核人ID>。
doctor | capabilities
project list | create --name 名称 [--goal 目标] | get|summary|risks --id ID
project export --id ID --file 新文件.json | restore --file 备份.json
task list [--project ID] | get --id ID
task create --project ID --title 标题 --stage 市场调研 --owner market
task update --id ID --json '{"title":"标题","dependencies":["前置任务ID"]}' [--version N]
task start|submit|approve|reject|block|unblock --id ID [--reason 原因]
wiki list --project ID | read|history --project ID --path wiki/文件.md
wiki search --project ID --query 关键词
wiki write --project ID --path wiki/文件.md --file 正文.md [--version N] [--run ID]
artifact add --task ID --file 文件 | artifact list [--project ID]
run start --task ID --skill 名称 [--skill-version 版本] [--input 输入]
run finish --id ID --status completed|failed [--output 结果] [--quality 质量评价]
run list|get [--project ID] [--id ID]
events list | notification list | member list|add --name 名称
measurement add --project ID --label 事项 --mode manual|agent --minutes N [--correction-minutes N]
通用：--actor ID --url URL --token TOKEN --dry-run --idempotency-key KEY
认证模式下也可使用环境变量 PROJECT_LAB_API_TOKEN，避免把 Token 写入命令历史。
写命令 --dry-run 只显示请求。export 拒绝覆盖已有文件。Wiki 写入保留版本历史。
这是执行接口，不是大模型运行器；Skill 在 Agent 宿主中执行。`;
async function req(url: string, method = "GET", body?: any) {
  if (opts["dry-run"] && method !== "GET")
    return {
      dryRun: true,
      method,
      url: base + "/api" + url,
      body: body instanceof FormData ? "[multipart file]" : body,
    };
  const res = await fetch(base + "/api" + url, {
    method,
    headers: {
      "x-actor": String(opts.actor || "agent"),
      ...(opts.token || process.env.PROJECT_LAB_API_TOKEN
        ? {
            authorization: `Bearer ${String(opts.token || process.env.PROJECT_LAB_API_TOKEN)}`,
          }
        : {}),
      ...(opts["idempotency-key"]
        ? { "idempotency-key": String(opts["idempotency-key"]) }
        : {}),
      ...(!(body instanceof FormData)
        ? { "content-type": "application/json" }
        : {}),
    },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const b = await res.json();
  if (!b.ok) throw Object.assign(Error(b.error.message), b.error);
  return b.data;
}
function need(k: string) {
  if (typeof opts[k] !== "string" || !opts[k])
    throw Object.assign(Error(`缺少 --${k}`), { code: "ARGUMENT" });
  return opts[k];
}
async function state() {
  return req("/state");
}
function find(a: any[], id: string) {
  const v = a.find((x) => x.id === id);
  if (!v) throw Error("记录不存在");
  return v;
}
async function run() {
  if (!group || opts.help || group === "help") {
    console.log(help);
    return;
  }
  let out: any;
  if (group === "doctor") out = await req("/health");
  else if (group === "capabilities") out = await req("/capabilities");
  else if (group === "project") {
    if (cmd === "create")
      out = await req("/projects", "POST", {
        name: need("name"),
        goal: opts.goal || "",
        mode: opts.mode || "agent",
      });
    else if (cmd === "restore")
      out = await req(
        "/projects/restore",
        "POST",
        JSON.parse(await fs.readFile(need("file"), "utf8")),
      );
    else if (cmd === "export") {
      const dest = path.resolve(need("file"));
      try {
        await fs.lstat(dest);
        throw Error("文件已存在，拒绝覆盖：" + dest);
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
      out = await req(`/projects/${need("id")}/export`);
      if (opts["dry-run"]) out = { dryRun: true, file: dest };
      else {
        await fs.writeFile(dest, JSON.stringify(out, null, 2), {
          flag: "wx",
          mode: 0o600,
        });
        out = { file: dest, bytes: (await fs.stat(dest)).size };
      }
    } else {
      const s = await state();
      if (cmd === "list") out = s.projects;
      else {
        const p = find(s.projects, need("id"));
        const tasks = s.tasks.filter((t: any) => t.projectId === p.id);
        const risks = tasks.filter(
          (t: any) =>
            t.status === "已阻塞" ||
            (t.dueDate &&
              t.dueDate < new Date().toISOString().slice(0, 10) &&
              t.status !== "已完成"),
        );
        if (cmd === "get") out = p;
        else if (cmd === "risks") out = risks;
        else if (cmd === "summary")
          out = {
            project: p,
            counts: Object.fromEntries(
              ["待开始", "进行中", "待审核", "已完成", "已阻塞"].map(
                (status) => [
                  status,
                  tasks.filter((t: any) => t.status === status).length,
                ],
              ),
            ),
            ready: tasks.filter(
              (t: any) =>
                t.status === "待开始" &&
                t.dependencies.every(
                  (id: string) =>
                    s.tasks.find((x: any) => x.id === id)?.status === "已完成",
                ),
            ),
            risks,
            wiki: s.pages.filter((x: any) => x.projectId === p.id),
          };
        else throw Error("未知 project 命令");
      }
    }
  } else if (group === "task") {
    if (cmd === "create")
      out = await req("/tasks", "POST", {
        projectId: need("project"),
        title: need("title"),
        stage: need("stage"),
        owner: need("owner"),
        description: opts.description || "",
      });
    else if (cmd === "list")
      out = (await state()).tasks.filter(
        (t: any) => !opts.project || t.projectId === opts.project,
      );
    else {
      const t = find((await state()).tasks, need("id"));
      if (cmd === "get") out = t;
      else if (cmd === "update")
        out = await req(`/tasks/${t.id}`, "PATCH", {
          ...JSON.parse(need("json")),
          version: opts.version ? Number(opts.version) : t.version,
        });
      else if (
        ["start", "submit", "approve", "reject", "block", "unblock"].includes(
          cmd,
        )
      )
        out = await req(`/tasks/${t.id}/actions/${cmd}`, "POST", {
          version: opts.version ? Number(opts.version) : t.version,
          reason: opts.reason || "",
        });
      else throw Error("未知 task 命令");
    }
  } else if (group === "wiki") {
    const id = need("project");
    if (cmd === "list")
      out = (await state()).pages.filter((p: any) => p.projectId === id);
    else if (cmd === "search")
      out = await req(
        `/projects/${id}/search?q=${encodeURIComponent(need("query"))}`,
      );
    else if (cmd === "read" || cmd === "history") {
      out = await req(
        `/projects/${id}/wiki?path=${encodeURIComponent(need("path"))}`,
      );
      if (cmd === "history") out = out.page?.history || [];
    } else if (cmd === "write") {
      const rel = need("path");
      const p = (await state()).pages.find(
        (x: any) => x.projectId === id && x.path === rel,
      );
      out = await req(`/projects/${id}/wiki`, "PUT", {
        path: rel,
        title: opts.title,
        content: await fs.readFile(need("file"), "utf8"),
        version: opts.version ? Number(opts.version) : p?.version,
        runId: opts.run,
      });
    } else throw Error("未知 wiki 命令");
  } else if (group === "artifact") {
    if (cmd === "list")
      out = (await state()).artifacts.filter(
        (x: any) => !opts.project || x.projectId === opts.project,
      );
    else if (cmd === "add") {
      const file = need("file"),
        buf = await fs.readFile(file);
      const form = new FormData();
      form.append("file", new Blob([buf]), path.basename(file));
      out = await req(`/tasks/${need("task")}/artifacts`, "POST", form);
    } else throw Error("未知 artifact 命令");
  } else if (group === "run") {
    if (cmd === "start")
      out = await req("/runs", "POST", {
        taskId: need("task"),
        skill: need("skill"),
        skillVersion: opts["skill-version"],
        input: opts.input,
      });
    else if (cmd === "finish")
      out = await req(`/runs/${need("id")}`, "PATCH", {
        status: need("status"),
        output: opts.output,
        quality: opts.quality,
      });
    else if (cmd === "get") out = find((await state()).runs, need("id"));
    else if (cmd === "list")
      out = (await state()).runs.filter(
        (x: any) => !opts.project || x.projectId === opts.project,
      );
    else throw Error("未知 run 命令");
  } else if (group === "measurement" && cmd === "add")
    out = await req("/measurements", "POST", {
      projectId: need("project"),
      label: need("label"),
      mode: need("mode"),
      minutes: Number(need("minutes")),
      correctionMinutes: Number(opts["correction-minutes"] || 0),
      notes: opts.notes,
    });
  else if (group === "member" && cmd === "add")
    out = await req("/members", "POST", { name: need("name") });
  else if (
    ["events", "notification", "member"].includes(group) &&
    cmd === "list"
  ) {
    const k = (
      {
        events: "events",
        notification: "notifications",
        member: "members",
      } as any
    )[group];
    out = (await state())[k].filter(
      (x: any) => !opts.project || x.projectId === opts.project,
    );
  } else throw Error("未知命令，运行 projectctl --help");
  console.log(JSON.stringify({ ok: true, data: out }, null, 2));
}
run().catch((e) => {
  console.error(
    JSON.stringify({
      ok: false,
      error: { code: e.code || "CLI_ERROR", message: e.message },
    }),
  );
  process.exitCode = 1;
});
