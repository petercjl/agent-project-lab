import React, { useState as useS, useEffect as useE } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import DOMPurify from "dompurify";
import "./style.css";
function App() {
  const [auth, AUTH] = useS<any>(null),
    [s, S] = useS<any>(null),
    [pid, P] = useS(""),
    [tab, T] = useS("看板"),
    [actor, A] = useS(localStorage.getItem("actor") || "supervisor"),
    [error, E] = useS(""),
    [task, D] = useS<any>(null),
    [page, W] = useS("wiki/index.md"),
    [doc, B] = useS<any>(null),
    [editing, ED] = useS(false),
    [dirty, DIR] = useS(false),
    [query, Q] = useS(""),
    [results, R] = useS<any[]>([]),
    [busy, BUS] = useS(false),
    [filter, F] = useS("全部");
  async function api(url: string, method = "GET", body?: any) {
    const r = await fetch("/api" + url, {
      method,
      headers: {
        "x-actor": actor,
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
    });
    const j = await r.json();
    if (r.status === 401)
      AUTH({ authenticated: false, mode: "dingtalk", configured: true });
    if (!j.ok) throw Error(j.error.message);
    return j.data;
  }
  async function refresh() {
    const d = await api("/state");
    S(d);
    P((p) => p || d.projects[0]?.id || "");
    D((t: any) => (t ? d.tasks.find((x: any) => x.id === t.id) : null));
  }
  async function act(fn: () => Promise<any>) {
    BUS(true);
    E("");
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      E(e.message);
    } finally {
      BUS(false);
    }
  }
  useE(() => {
    fetch("/api/auth/session", { headers: { "x-actor": actor } })
      .then(async (response) => {
        const result = await response.json();
        if (!result.ok) throw Error(result.error.message);
        AUTH(result.data);
        if (result.data.authenticated) {
          if (result.data.memberId) A(result.data.memberId);
          await refresh();
        }
      })
      .catch((e) => E(e.message));
  }, []);
  useE(() => {
    if (!auth?.authenticated || task || editing) return;
    const timer = setInterval(() => refresh().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [auth?.authenticated, task, editing]);
  useE(() => {
    localStorage.setItem("actor", actor);
  }, [actor]);
  useE(() => {
    if (pid && tab === "Wiki")
      api(`/projects/${pid}/wiki?path=${encodeURIComponent(page)}`)
        .then((d) => {
          B(d);
          DIR(false);
          ED(false);
        })
        .catch((e) => {
          B(null);
          E(e.message);
        });
  }, [pid, tab, page]);
  const p = s?.projects.find((x: any) => x.id === pid),
    tasks = s?.tasks.filter((t: any) => t.projectId === pid) || [],
    pages = s?.pages.filter((x: any) => x.projectId === pid) || [],
    member = (id: string) =>
      s?.members.find((m: any) => m.id === id)?.name || id;
  const local = (v: string) =>
    v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "—";
  const ready = (t: any) =>
    t.dependencies.every(
      (id: string) =>
        s.tasks.find((x: any) => x.id === id)?.status === "已完成",
    );
  function nav(t: string) {
    if (dirty && !confirm("正文尚未保存，确认离开？")) return;
    DIR(false);
    T(t);
  }
  async function create() {
    const name = prompt("项目名称", "新的商品项目");
    if (name)
      await act(async () => {
        const n = await api("/projects", "POST", {
          name,
          goal: prompt("项目目标") || "",
          mode: "agent",
        });
        P(n.id);
        T("看板");
        W("wiki/index.md");
      });
  }
  function download(name: string, data: any) {
    const u = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = u;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
  }
  async function openPage(rel: string) {
    if (dirty && !confirm("正文尚未保存，确认切换？")) return;
    DIR(false);
    W(rel);
    T("Wiki");
    D(null);
  }
  const actions: any = {
    待开始: [
      ["start", "开始执行"],
      ["block", "标记阻塞"],
    ],
    进行中: [
      ["submit", "提交审核"],
      ["block", "标记阻塞"],
    ],
    待审核: [
      ["approve", "审核通过"],
      ["reject", "退回修改"],
      ["block", "标记阻塞"],
    ],
    已阻塞: [["unblock", "解除阻塞"]],
    已完成: [],
  };
  if (auth === null)
    return <div className="loading">项目实验台 · 正在连接本地服务…{error}</div>;
  if (!auth.authenticated)
    return (
      <div className="login-page">
        <section className="login-card">
          <div className="hero-icon">◈</div>
          <small>AGENT PROJECT LAB</small>
          <h1>登录项目实验台</h1>
          <p>
            使用企业钉钉账号完成身份验证。项目负责人、审核权限和任务通知将绑定到同一个员工身份。
          </p>
          {new URLSearchParams(location.search).get("authError") && (
            <div className="error">
              {new URLSearchParams(location.search).get("authError")}
            </div>
          )}
          {auth.configured ? (
            <button
              className="dingtalk-login"
              onClick={() => location.assign("/api/auth/dingtalk/start")}
            >
              使用钉钉账号登录
            </button>
          ) : (
            <div className="auth-setup">
              钉钉应用尚未配置。请先在本机 <code>.env</code> 中填写 Client
              ID、Client Secret、Corp ID 和回调地址。
            </div>
          )}
          <p className="login-note">
            授权仅用于确认企业身份；浏览器不会接触应用密钥。
          </p>
        </section>
      </div>
    );
  if (!s)
    return <div className="loading">身份已验证 · 正在读取项目…{error}</div>;
  return (
    <div className="app">
      <aside>
        <div className="brand">
          <b>◈</b>
          <span>
            项目实验台<small>AGENT PROJECT LAB</small>
          </span>
        </div>
        <div className="side-label">
          工作空间 <span>{auth.mode === "dingtalk" ? "DINGTALK" : "DEV"}</span>
        </div>
        <button className="new-project" onClick={create}>
          ＋ 创建商品项目
        </button>
        <div className="project-list">
          {s.projects.map((x: any) => (
            <button
              key={x.id}
              className={pid === x.id ? "selected" : ""}
              onClick={() => {
                if (dirty && !confirm("有未保存内容，确认切换？")) return;
                P(x.id);
                W("wiki/index.md");
                D(null);
                DIR(false);
              }}
            >
              ▣ <span>{x.name}</span>
            </button>
          ))}
        </div>
        <label className="import">
          ↥ 从备份恢复项目
          <input
            type="file"
            accept=".json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f)
                act(async () => {
                  const n = await api(
                    "/projects/restore",
                    "POST",
                    JSON.parse(await f.text()),
                  );
                  P(n.id);
                });
              e.target.value = "";
            }}
          />
        </label>
        <div className="side-bottom">
          <i /> {auth.mode === "dingtalk" ? "钉钉身份已验证" : "开发认证模式"}
          <small>
            PostgreSQL · Markdown 文件库
            <br />
            {auth.mode === "dingtalk" ? auth.name : "数据保存在此电脑"}
          </small>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <span className="breadcrumb">工作空间 / 商品项目</span>
            <h1>{p?.name || "开始你的第一个项目"}</h1>
            <p>{p?.goal || "让 Agent 执行工作，让项目沉淀知识。"}</p>
          </div>
          <div className="identity">
            {auth.mode === "development" ? (
              <>
                <small>开发角色模拟</small>
                <select value={actor} onChange={(e) => A(e.target.value)}>
                  {s.members.map((m: any) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <>
                <span className="signed-user">
                  {auth.avatarUrl && <img src={auth.avatarUrl} alt="" />}
                  {auth.name}
                </span>
                <button
                  onClick={async () => {
                    try {
                      await api("/auth/logout", "POST", {});
                    } finally {
                      location.assign("/");
                    }
                  }}
                >
                  退出登录
                </button>
              </>
            )}
            <button onClick={() => act(refresh)}>↻ 刷新</button>
          </div>
        </header>
        {error && (
          <div role="alert" className="error">
            {error}
            <button onClick={() => E("")}>×</button>
          </div>
        )}
        {!p ? (
          <section className="welcome">
            <div className="hero-icon">◈</div>
            <h2>从一个商品，开始验证 AI 协作</h2>
            <p>基于商品生命周期生成任务，用 Wiki 保存依据与交付物。</p>
            <button className="primary" onClick={create}>
              创建第一个项目
            </button>
          </section>
        ) : (
          <>
            <nav>
              {[
                "看板",
                "Wiki",
                "Agent 运行",
                "活动记录",
                "消息",
                "提效验证",
              ].map((x) => (
                <button
                  key={x}
                  className={tab === x ? "active" : ""}
                  onClick={() => nav(x)}
                >
                  {x}
                  {x === "消息" &&
                    s.notifications.filter(
                      (n: any) => n.projectId === pid && !n.readAt,
                    ).length > 0 && (
                      <em>
                        {
                          s.notifications.filter(
                            (n: any) => n.projectId === pid && !n.readAt,
                          ).length
                        }
                      </em>
                    )}
                </button>
              ))}
              <button
                className="export"
                onClick={() =>
                  act(async () =>
                    download(
                      p.name + ".json",
                      await api(`/projects/${pid}/export`),
                    ),
                  )
                }
              >
                导出项目 ↗
              </button>
            </nav>
            {tab === "看板" && (
              <>
                <section className="stats">
                  {[
                    ["任务总数", tasks.length],
                    [
                      "执行中",
                      tasks.filter((t: any) => t.status === "进行中").length,
                    ],
                    [
                      "等待审核",
                      tasks.filter((t: any) => t.status === "待审核").length,
                    ],
                    [
                      "已完成",
                      tasks.filter((t: any) => t.status === "已完成").length,
                    ],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <small>{k}</small>
                      <strong>
                        {v}
                        <span>
                          {k === "已完成" ? ` / ${tasks.length}` : ""}
                        </span>
                      </strong>
                    </div>
                  ))}
                  <div className="progress-box">
                    <small>项目进度</small>
                    <strong>
                      {Math.round(
                        (tasks.filter((t: any) => t.status === "已完成")
                          .length /
                          Math.max(tasks.length, 1)) *
                          100,
                      )}
                      %
                    </strong>
                    <progress
                      max={tasks.length || 1}
                      value={
                        tasks.filter((t: any) => t.status === "已完成").length
                      }
                    />
                  </div>
                </section>
                <div className="toolbar">
                  <div>
                    <b>商品生命周期</b>
                    <span>依赖驱动交接 · 交付后人工审核</span>
                  </div>
                  <select value={filter} onChange={(e) => F(e.target.value)}>
                    {["全部", "我的任务", "待审核", "已阻塞"].map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                  <button
                    onClick={() =>
                      act(async () => {
                        const title = prompt("任务名称");
                        if (title)
                          await api("/tasks", "POST", {
                            projectId: pid,
                            title,
                            stage: p.stages[0],
                            owner: actor,
                          });
                      })
                    }
                  >
                    ＋ 新任务
                  </button>
                </div>
                <section className="board">
                  {p.stages.map((stage: string, i: number) => {
                    const ts = tasks.filter(
                      (t: any) =>
                        t.stage === stage &&
                        (filter === "全部" ||
                          (filter === "我的任务" && t.owner === actor) ||
                          filter === t.status),
                    );
                    return (
                      <div className="column" key={stage}>
                        <div className="column-title">
                          <i
                            style={{
                              background: [
                                "#8a98b2",
                                "#5c8fea",
                                "#a184dd",
                                "#d19451",
                                "#49a49c",
                                "#728ca5",
                                "#65a575",
                              ][i],
                            }}
                          />
                          {stage}
                          <span>{ts.length}</span>
                        </div>
                        {ts.map((t: any) => (
                          <button
                            key={t.id}
                            className="card"
                            onClick={() => D(t)}
                          >
                            <div className="card-top">
                              <span className={"badge status-" + t.status}>
                                {t.status}
                              </span>
                              <small>{t.priority}优先级</small>
                            </div>
                            <h3>{t.title}</h3>
                            <div className="card-note">
                              {t.status === "待开始"
                                ? ready(t)
                                  ? "● 前置就绪，可以开始"
                                  : "↳ 等待前置任务完成"
                                : t.status === "已阻塞"
                                  ? t.blockReason
                                  : t.skill
                                    ? `✧ ${t.skill}`
                                    : "人工 / Agent 协作"}
                            </div>
                            <div className="card-footer">
                              <span>
                                <i className="avatar">
                                  {member(t.owner).slice(0, 1)}
                                </i>
                                {member(t.owner)}
                              </span>
                              <small>{t.dueDate || "未设日期"}</small>
                            </div>
                          </button>
                        ))}
                        <button
                          className="add-card"
                          onClick={() =>
                            act(async () => {
                              const title = prompt(`在「${stage}」创建任务`);
                              if (title)
                                await api("/tasks", "POST", {
                                  projectId: pid,
                                  title,
                                  stage,
                                  owner: actor,
                                });
                            })
                          }
                        >
                          ＋ 添加任务
                        </button>
                      </div>
                    );
                  })}
                </section>
              </>
            )}
            {tab === "Wiki" && (
              <section className="wiki">
                <div className="wiki-tree">
                  <h3>
                    项目知识库{" "}
                    <button
                      onClick={() =>
                        act(async () => {
                          const title = prompt("新文档标题");
                          if (!title) return;
                          const rel = `wiki/${Date.now()}-${title.replace(/[\\/]/g, "-")}.md`;
                          await api(`/projects/${pid}/wiki`, "PUT", {
                            path: rel,
                            title,
                            content: `# ${title}\n\n待补充。`,
                          });
                          W(rel);
                        })
                      }
                    >
                      ＋
                    </button>
                  </h3>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      act(async () =>
                        R(
                          await api(
                            `/projects/${pid}/search?q=${encodeURIComponent(query)}`,
                          ),
                        ),
                      );
                    }}
                  >
                    <input
                      placeholder="搜索正文，回车检索"
                      value={query}
                      onChange={(e) => Q(e.target.value)}
                    />
                  </form>
                  <button
                    className={page === "wiki/index.md" ? "current" : ""}
                    onClick={() => openPage("wiki/index.md")}
                  >
                    ⌂ 项目首页
                  </button>
                  {pages
                    .filter((x: any) => x.path !== "wiki/index.md")
                    .map((x: any) => (
                      <button
                        className={page === x.path ? "current" : ""}
                        key={x.id}
                        onClick={() => openPage(x.path)}
                      >
                        ▤ {x.title}
                      </button>
                    ))}
                  {results.length > 0 && (
                    <div className="search-results">
                      <h4>检索结果</h4>
                      {results.map((x: any) => (
                        <button key={x.id} onClick={() => openPage(x.path)}>
                          {x.title}
                          <small>{x.excerpt}</small>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <article className="wiki-content">
                  <div className="wiki-top">
                    <span>
                      {page}
                      <small>
                        版本 {doc?.page?.version || 1} ·{" "}
                        {doc?.page?.updatedBy
                          ? member(doc.page.updatedBy)
                          : "项目模板"}
                      </small>
                    </span>
                    <button disabled={!doc} onClick={() => ED(!editing)}>
                      {editing ? "预览" : "编辑 Markdown"}
                    </button>
                    {editing && (
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() =>
                          act(async () => {
                            const r = await api(
                              `/projects/${pid}/wiki`,
                              "PUT",
                              {
                                path: page,
                                content: doc.content,
                                version: doc.page?.version,
                              },
                            );
                            B({ ...doc, page: r });
                            DIR(false);
                            ED(false);
                          })
                        }
                      >
                        保存
                      </button>
                    )}
                  </div>
                  {doc &&
                    (editing ? (
                      <textarea
                        className="editor"
                        value={doc.content}
                        onChange={(e) => {
                          B({ ...doc, content: e.target.value });
                          DIR(true);
                        }}
                      />
                    ) : (
                      <div
                        className="markdown"
                        onClick={(e) => {
                          const a = (e.target as HTMLElement).closest("a");
                          if (a) {
                            const href = a.getAttribute("href");
                            if (href && !/^(https?:|mailto:|#)/.test(href)) {
                              e.preventDefault();
                              const rel = href.startsWith("wiki/")
                                ? href
                                : "wiki/" + href.replace(/^\.\//, "");
                              openPage(rel);
                            }
                          }
                        }}
                        dangerouslySetInnerHTML={{
                          __html: DOMPurify.sanitize(
                            marked.parse(doc.content) as string,
                          ),
                        }}
                      />
                    ))}
                  {doc?.page?.history?.length > 0 && (
                    <details>
                      <summary>历史版本（{doc.page.history.length}）</summary>
                      {[...doc.page.history].reverse().map((h: any) => (
                        <button
                          key={h.path}
                          onClick={() =>
                            act(async () => {
                              const old = await api(
                                `/projects/${pid}/wiki?path=${encodeURIComponent(h.path)}`,
                              );
                              alert(old.content);
                            })
                          }
                        >
                          v{h.version} · {local(h.at)} · 查看
                        </button>
                      ))}
                    </details>
                  )}
                </article>
              </section>
            )}
            {tab === "Agent 运行" && (
              <section className="content">
                <div className="callout">
                  <h3>Agent 与人共用同一套项目数据</h3>
                  <p>
                    通过 projectctl 查询任务、读取
                    Wiki、登记运行、写入交付物并提交审核。此页面记录真实调用，不会自动启动大模型。
                  </p>
                  <code>projectctl capabilities</code>
                  <code>projectctl project summary --id {pid}</code>
                </div>
                <h2>执行记录</h2>
                {s.runs
                  .filter((x: any) => x.projectId === pid)
                  .reverse()
                  .map((r: any) => (
                    <div className="record" key={r.id}>
                      <span className="badge">{r.status}</span>
                      <h3>
                        {r.skill} <small>{r.skillVersion}</small>
                      </h3>
                      <p>{tasks.find((t: any) => t.id === r.taskId)?.title}</p>
                      <p>输入：{r.input || "—"}</p>
                      <p>输出：{r.output || "尚未完成"}</p>
                      <small>
                        {local(r.startedAt)} → {local(r.endedAt)}
                      </small>
                    </div>
                  ))}
                {!s.runs.some((x: any) => x.projectId === pid) && (
                  <p className="empty">
                    尚无运行记录。用 CLI 执行第一项工作后会显示在这里。
                  </p>
                )}
              </section>
            )}
            {tab === "活动记录" && (
              <section className="content timeline">
                <h2>可追溯的每一次变更</h2>
                {s.events
                  .filter((x: any) => x.projectId === pid)
                  .reverse()
                  .map((e: any) => (
                    <details className="record" key={e.id}>
                      <summary>
                        <span className="event-dot" />
                        {member(e.actor)} · {e.type}
                        <small>{local(e.createdAt)}</small>
                      </summary>
                      <pre>{JSON.stringify(e.details, null, 2)}</pre>
                    </details>
                  ))}
              </section>
            )}
            {tab === "消息" && (
              <section className="content">
                <h2>交接与审核消息</h2>
                <p className="muted">
                  节点提交或审核通过时自动生成本地通知。钉钉消息出口需单独配置与验证。
                </p>
                {s.notifications
                  .filter((n: any) => n.projectId === pid)
                  .reverse()
                  .map((n: any) => (
                    <div key={n.id} className="record">
                      <span className="badge">
                        {n.readAt ? "已读" : "未读"}
                      </span>
                      <h3>{n.message}</h3>
                      <p>
                        接收人：
                        {member(n.recipient || n.owner || n.recipientId)} ·{" "}
                        {local(n.createdAt)}
                      </p>
                      <button
                        onClick={() =>
                          act(() =>
                            api(`/notifications/${n.id}/read`, "POST", {}),
                          )
                        }
                      >
                        标为已读
                      </button>
                    </div>
                  ))}
              </section>
            )}
            {tab === "提效验证" && (
              <section className="content">
                <h2>记录实际耗时，再判断是否提效</h2>
                <p className="muted">
                  建议使用相同事项、相同交付标准作对比；Agent
                  总耗时包含人工纠正时间。
                </p>
                <form
                  className="measure-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = e.currentTarget;
                    const b = Object.fromEntries(new FormData(f));
                    act(async () => {
                      await api("/measurements", "POST", {
                        ...b,
                        projectId: pid,
                      });
                      f.reset();
                    });
                  }}
                >
                  <input
                    name="label"
                    required
                    placeholder="对比事项，例如市场调研"
                  />
                  <select name="mode">
                    <option value="manual">人工基线</option>
                    <option value="agent">Agent 协作</option>
                  </select>
                  <input
                    name="minutes"
                    type="number"
                    min="0"
                    step="0.1"
                    required
                    placeholder="执行分钟"
                  />
                  <input
                    name="correctionMinutes"
                    type="number"
                    min="0"
                    step="0.1"
                    placeholder="纠正分钟"
                  />
                  <input name="notes" placeholder="质量评价 / 说明" />
                  <button className="primary">记录</button>
                </form>
                <table>
                  <thead>
                    <tr>
                      <th>事项</th>
                      <th>方式</th>
                      <th>执行</th>
                      <th>纠正</th>
                      <th>合计（分钟）</th>
                      <th>说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.measurements
                      .filter((m: any) => m.projectId === pid)
                      .map((m: any) => (
                        <tr key={m.id}>
                          <td>{m.label}</td>
                          <td>
                            {m.mode === "agent" ? "Agent 协作" : "人工基线"}
                          </td>
                          <td>{m.minutes}</td>
                          <td>{m.correctionMinutes}</td>
                          <td>{m.minutes + m.correctionMinutes}</td>
                          <td>{m.notes}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                <div className="callout">
                  相同事项配对比较
                  {Array.from(
                    new Set(
                      s.measurements
                        .filter((m: any) => m.projectId === pid)
                        .map((m: any) => m.label),
                    ),
                  ).map((label: any) => {
                    const rows = s.measurements.filter(
                      (m: any) => m.projectId === pid && m.label === label,
                    );
                    const avg = (mode: string) => {
                      const a = rows.filter((m: any) => m.mode === mode);
                      return a.length
                        ? a.reduce(
                            (n: number, m: any) =>
                              n + m.minutes + m.correctionMinutes,
                            0,
                          ) / a.length
                        : null;
                    };
                    const a = avg("manual"),
                      b = avg("agent");
                    return (
                      <p key={label}>
                        {label}：
                        {a && b !== null
                          ? `人工平均 ${a.toFixed(1)} 分钟 → Agent 平均 ${b.toFixed(1)} 分钟，耗时变化 ${((b / a - 1) * 100).toFixed(1)}%`
                          : "待补充两组数据"}
                      </p>
                    );
                  })}
                </div>
              </section>
            )}
          </>
        )}
        <footer>本地预演环境 · 角色切换用于验证流程，不代表生产权限认证</footer>
      </main>
      {task && (
        <div className="overlay" onClick={() => D(null)}>
          <section className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <span>{task.stage} / 任务详情</span>
              <button onClick={() => D(null)}>关闭 ×</button>
            </div>
            <span className={"badge status-" + task.status}>{task.status}</span>
            <h2>{task.title}</h2>
            <p className="muted">
              版本 {task.version} · {task.id}
            </p>
            <form
              key={task.id + "-" + task.version}
              onSubmit={(e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                act(() =>
                  api(`/tasks/${task.id}`, "PATCH", {
                    ...Object.fromEntries(form),
                    dependencies: form.getAll("dependencies"),
                    version: task.version,
                  }),
                );
              }}
            >
              <label>
                任务标题
                <input name="title" defaultValue={task.title} required />
              </label>
              <div className="two">
                <label>
                  负责人
                  <select name="owner" defaultValue={task.owner}>
                    {s.members.map((m: any) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  审核人
                  <select name="reviewer" defaultValue={task.reviewer}>
                    {s.members.map((m: any) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="two">
                <label>
                  截止日期
                  <input
                    type="date"
                    name="dueDate"
                    defaultValue={task.dueDate}
                  />
                </label>
                <label>
                  优先级
                  <select name="priority" defaultValue={task.priority}>
                    {["低", "中", "高"].map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                工作说明
                <textarea name="description" defaultValue={task.description} />
              </label>
              <label>
                验收标准
                <textarea name="criteria" defaultValue={task.criteria} />
              </label>
              <label>
                关联 Skill
                <input name="skill" defaultValue={task.skill} />
              </label>
              <label>
                所属阶段
                <select name="stage" defaultValue={task.stage}>
                  {p.stages.map((x: string) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
              <label>
                前置依赖（可多选）
                <select
                  name="dependencies"
                  multiple
                  defaultValue={task.dependencies}
                >
                  {tasks
                    .filter((x: any) => x.id !== task.id)
                    .map((x: any) => (
                      <option key={x.id} value={x.id}>
                        {x.title}
                      </option>
                    ))}
                </select>
              </label>
              <button disabled={busy}>保存任务信息</button>
            </form>
            <h3>前置依赖</h3>
            {task.dependencies.length ? (
              task.dependencies.map((id: string) => {
                const t = s.tasks.find((x: any) => x.id === id);
                return (
                  <p key={id}>
                    {t?.status === "已完成" ? "✓" : "○"} {t?.title}
                  </p>
                );
              })
            ) : (
              <p className="muted">无前置依赖</p>
            )}
            <h3>知识与交付物</h3>
            <button
              onClick={() => {
                if (pages.some((x: any) => x.path === task.wikiPath))
                  openPage(task.wikiPath);
                else
                  act(async () => {
                    await api(`/projects/${pid}/wiki`, "PUT", {
                      path: task.wikiPath,
                      title: task.title,
                      content: `# ${task.title}\n\n待补充工作结论。`,
                    });
                    openPage(task.wikiPath);
                  });
              }}
            >
              ▤ 打开任务 Wiki
            </button>
            <label className="upload">
              ＋ 上传交付物（20 MB 以内）
              <input
                type="file"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f)
                    act(async () => {
                      const b = new FormData();
                      b.append("file", f);
                      await api(`/tasks/${task.id}/artifacts`, "POST", b);
                    });
                  e.target.value = "";
                }}
              />
            </label>
            {s.artifacts
              .filter((a: any) => a.taskId === task.id)
              .map((a: any) => (
                <p key={a.id}>
                  <a href={`/api/artifacts/${a.id}/download`}>{a.name}</a> ·{" "}
                  {(a.size / 1024).toFixed(1)} KB
                </p>
              ))}
            {task.reviewNote && (
              <div className="callout">审核意见：{task.reviewNote}</div>
            )}
            {task.blockReason && task.status === "已阻塞" && (
              <div className="error">阻塞原因：{task.blockReason}</div>
            )}
            <div className="task-actions">
              {(actions[task.status] || []).map(([action, label]: string[]) => (
                <button
                  className={
                    ["start", "submit", "approve"].includes(action)
                      ? "primary"
                      : ""
                  }
                  key={action}
                  disabled={
                    busy ||
                    (["approve", "reject"].includes(action) &&
                      actor !== task.reviewer)
                  }
                  onClick={() =>
                    act(async () => {
                      let reason = "";
                      if (["reject", "block"].includes(action)) {
                        reason = prompt("请填写原因") || "";
                        if (!reason) return;
                      }
                      await api(`/tasks/${task.id}/actions/${action}`, "POST", {
                        version: task.version,
                        reason,
                      });
                    })
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            <small className="muted">
              提交审核需有正文交付或附件；审核通过后，系统向下一节点负责人生成消息。
            </small>
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
