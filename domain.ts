import { randomUUID } from "node:crypto";
export const uid = () => randomUUID();
export const now = () => new Date().toISOString();
export const stages = [
  "待立项",
  "市场调研",
  "需求人群调研",
  "商品视觉",
  "运营推广",
  "售前售后",
  "项目完成",
];
export const statuses = ["待开始", "进行中", "待审核", "已完成", "已阻塞"];
export class Fault extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function required(v: any, label: string) {
  if (typeof v !== "string" || !v.trim())
    throw new Fault("VALIDATION", `${label}不能为空`);
  return v.trim();
}
export function initial() {
  return {
    schemaVersion: 1,
    revision: 0,
    projects: [],
    tasks: [],
    pages: [],
    artifacts: [],
    runs: [],
    events: [],
    notifications: [],
    measurements: [],
    idempotency: {},
    members: [
      { id: "supervisor", name: "主管", role: "reviewer" },
      { id: "market", name: "市场负责人", role: "member" },
      { id: "design", name: "视觉负责人", role: "member" },
      { id: "operations", name: "运营负责人", role: "member" },
      { id: "agent", name: "项目 Agent", role: "agent" },
    ],
  };
}
export function makeProject(s: any, input: any) {
  const p = {
    id: uid(),
    name: required(input.name, "项目名称"),
    goal: input.goal || "",
    createdAt: now(),
    template: "ecommerce-v1",
    mode: input.mode || "agent",
    stages,
  };
  s.projects.push(p);
  const titles = [
    "确认商品目标与立项",
    "完成市场与竞品调研",
    "明确需求人群与使用场景",
    "制定商品视觉方案",
    "制定推广计划与指标",
    "汇总售前售后反馈",
    "完成项目复盘",
  ];
  const owners = [
    "supervisor",
    "market",
    "market",
    "design",
    "operations",
    "operations",
    "supervisor",
  ];
  let prev = "";
  titles.forEach((title, i) => {
    const id = uid();
    s.tasks.push({
      id,
      projectId: p.id,
      title,
      stage: stages[i],
      status: "待开始",
      owner: owners[i],
      reviewer: "supervisor",
      priority: "中",
      dueDate: "",
      description: title,
      criteria: "提交有依据的结论、项目 Wiki 页面与交付物，由审核人确认。",
      skill: [
        "项目立项",
        "市场调研",
        "人群调研",
        "视觉策略",
        "推广计划",
        "售后分析",
        "项目复盘",
      ][i],
      dependencies: prev ? [prev] : [],
      wikiPath: `wiki/0${i + 1}-${stages[i]}.md`,
      version: 1,
      createdAt: now(),
      required: true,
      requiresEvidence: true,
    });
    prev = id;
  });
  return p;
}
export function transition(
  s: any,
  t: any,
  action: string,
  actor: string,
  reason = "",
) {
  const dependency = s.tasks.filter(
    (x: any) => t.dependencies.includes(x.id) && x.status !== "已完成",
  );
  if (["start", "submit", "approve"].includes(action) && dependency.length)
    throw new Fault(
      "DEPENDENCY_BLOCKED",
      `请先完成：${dependency.map((x: any) => x.title).join("、")}`,
      409,
    );
  const rules: any = {
    start: ["待开始"],
    submit: ["进行中"],
    approve: ["待审核"],
    reject: ["待审核"],
    block: ["待开始", "进行中", "待审核"],
    unblock: ["已阻塞"],
  };
  if (!rules[action]?.includes(t.status))
    throw new Fault(
      "INVALID_TRANSITION",
      `当前“${t.status}”无法执行 ${action}`,
      409,
    );
  if (["approve", "reject"].includes(action) && actor !== t.reviewer)
    throw new Fault("REVIEWER_REQUIRED", "请由指定审核人执行", 403);
  if (["reject", "block"].includes(action)) required(reason, "原因");
  if (
    action === "submit" &&
    t.requiresEvidence &&
    !s.pages.some(
      (x: any) =>
        x.projectId === t.projectId && x.path === t.wikiPath && x.substantive,
    ) &&
    !s.artifacts.some((a: any) => a.taskId === t.id)
  )
    throw new Fault("EVIDENCE_REQUIRED", "请先填写关联 Wiki 或上传交付物", 409);
  if (action === "block") {
    t.previousStatus = t.status;
    t.blockReason = reason;
    t.status = "已阻塞";
  } else if (action === "unblock") {
    t.status = t.previousStatus || "待开始";
    t.blockReason = "";
  } else {
    t.status = (
      {
        start: "进行中",
        submit: "待审核",
        approve: "已完成",
        reject: "进行中",
      } as any
    )[action];
  }
  if (action === "start") t.startedAt = now();
  if (action === "approve") t.completedAt = now();
  if (action === "reject") t.reviewNote = reason;
  t.version++;
  t.updatedAt = now();
  if (action === "submit")
    s.notifications.push({
      id: uid(),
      projectId: t.projectId,
      taskId: t.id,
      recipient: t.reviewer,
      message: `待审核：${t.title}`,
      status: "pending",
      createdAt: now(),
    });
  if (action === "approve")
    for (const next of s.tasks.filter(
      (n: any) =>
        n.dependencies.includes(t.id) &&
        n.status === "待开始" &&
        n.dependencies.every(
          (id: string) =>
            s.tasks.find((x: any) => x.id === id)?.status === "已完成",
        ),
    )) {
      s.notifications.push({
        id: uid(),
        projectId: t.projectId,
        taskId: next.id,
        recipient: next.owner,
        message: `前置工作已完成，可以开始：${next.title}`,
        status: "pending",
        createdAt: now(),
      });
    }
  return t;
}
export function setDependencies(s: any, t: any, ids: any) {
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string"))
    throw new Fault("VALIDATION", "dependencies 必须是任务 ID 数组");
  const unique = [...new Set(ids)];
  for (const id of unique) {
    const other = s.tasks.find((x: any) => x.id === id);
    if (!other || other.projectId !== t.projectId || id === t.id)
      throw new Fault("INVALID_DEPENDENCY", "依赖必须是本项目的其他任务");
  }
  const visit = (id: string, seen: Set<string>): boolean => {
    if (id === t.id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (
      s.tasks
        .find((x: any) => x.id === id)
        ?.dependencies.some((d: string) => visit(d, seen)) || false
    );
  };
  if (unique.some((id: string) => visit(id, new Set())))
    throw new Fault("DEPENDENCY_CYCLE", "依赖关系形成循环");
  if (
    t.status !== "待开始" &&
    unique.some(
      (id) => s.tasks.find((x: any) => x.id === id)?.status !== "已完成",
    )
  )
    throw new Fault(
      "DEPENDENCY_BLOCKED",
      "已开始的任务只能关联已完成的前置任务",
    );
  t.dependencies = unique;
}
