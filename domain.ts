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
const defaultProductSop = [
  [
    "待立项",
    "确认商品目标与立项",
    "明确商品项目目标、范围和立项依据。",
    "supervisor",
    "项目立项",
  ],
  [
    "市场调研",
    "完成市场与竞品调研",
    "收集市场与竞品证据，形成可执行的市场判断。",
    "market",
    "市场调研",
  ],
  [
    "需求人群调研",
    "明确需求人群与使用场景",
    "识别目标人群、核心需求和关键使用场景。",
    "market",
    "人群调研",
  ],
  [
    "商品视觉",
    "制定商品视觉方案",
    "形成符合目标人群与渠道要求的商品视觉方案。",
    "design",
    "视觉策略",
  ],
  [
    "运营推广",
    "制定推广计划与指标",
    "制定推广动作、预算假设和可衡量指标。",
    "operations",
    "推广计划",
  ],
  [
    "售前售后",
    "汇总售前售后反馈",
    "沉淀售前售后问题、反馈和改进建议。",
    "operations",
    "售后分析",
  ],
  [
    "项目完成",
    "完成项目复盘",
    "汇总项目结果、经验与后续行动。",
    "supervisor",
    "项目复盘",
  ],
];
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
export function projectNameKey(value: any) {
  return required(value, "项目名称")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("zh-CN");
}

const contentRanks: Record<string, number> = {
  empty: 0,
  executed: 1,
  substantive: 2,
};

export function promoteTaskContent(task: any, status: string) {
  if (!(status in contentRanks))
    throw new Fault("VALIDATION", "无效任务内容状态");
  const current = task.contentStatus || "empty";
  if ((contentRanks[status] || 0) > (contentRanks[current] || 0))
    task.contentStatus = status;
  else task.contentStatus = current;
  return task.contentStatus;
}

export function taskContentStatus(state: any, task: any) {
  let status = task.contentStatus || "empty";
  const runs = state.runs.filter((run: any) => run.taskId === task.id);
  if (runs.length && contentRanks[status] < contentRanks.executed)
    status = "executed";
  if (
    state.pages.some(
      (page: any) =>
        page.projectId === task.projectId &&
        page.path === task.wikiPath &&
        page.substantive,
    ) ||
    state.artifacts.some((artifact: any) => artifact.taskId === task.id) ||
    runs.some(
      (run: any) =>
        run.status === "completed" && String(run.output || "").trim(),
    )
  )
    status = "substantive";
  return status;
}

function safeWikiName(value: string, index: number) {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 48);
  return `${String(index + 1).padStart(2, "0")}-${cleaned || `节点-${index + 1}`}.md`;
}

function productSop(input: any) {
  if (!input.sop) {
    return {
      mode: "default",
      nodes: defaultProductSop.map(
        ([stage, name, description, owner, skill]) => ({
          stage,
          name,
          description,
          owner,
          skill,
        }),
      ),
    };
  }
  const raw = Array.isArray(input.sop) ? input.sop : input.sop.nodes;
  if (!Array.isArray(raw) || raw.length === 0)
    throw new Fault("VALIDATION", "自定义 SOP 至少需要一个节点");
  if (raw.length > 50)
    throw new Fault("VALIDATION", "自定义 SOP 最多支持 50 个节点");
  const names = new Set<string>();
  const nodes = raw.map((node: any, index: number) => {
    if (!node || typeof node !== "object")
      throw new Fault("VALIDATION", `SOP 第 ${index + 1} 个节点格式无效`);
    const name = required(node.name, `SOP 第 ${index + 1} 个节点名称`);
    const description = required(node.description, `SOP 节点“${name}”说明`);
    const key = name
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .toLocaleLowerCase("zh-CN");
    if (names.has(key))
      throw new Fault("VALIDATION", `SOP 节点名称重复：${name}`);
    names.add(key);
    return { stage: name, name, description, owner: "agent", skill: name };
  });
  return { mode: "custom", nodes };
}
export function initial() {
  return {
    schemaVersion: 1,
    revision: 0,
    projects: [],
    folders: [],
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
  const type = input.type || "product";
  if (type !== "product")
    throw new Fault(
      "FEATURE_UNSUPPORTED",
      `${type === "shop" ? "店铺" : type === "company" ? "企业" : "该类型"}项目尚未开放`,
      501,
    );
  const name = required(input.name, "项目名称");
  const nameKey = projectNameKey(name);
  if (
    s.projects.some(
      (item: any) => !item.deletedAt && projectNameKey(item.name) === nameKey,
    )
  )
    throw new Fault("PROJECT_NAME_CONFLICT", `项目名称已存在：${name}`, 409);
  const sop = productSop(input);
  const p = {
    id: uid(),
    name,
    nameKey,
    type,
    status: "active",
    version: 0,
    goal: input.goal || "",
    createdAt: now(),
    updatedAt: now(),
    directoryOrder:
      Math.max(
        -1,
        ...s.projects.map((item: any) => item.directoryOrder ?? -1),
      ) + 1,
    template: "product-sop-v1",
    sopMode: sop.mode,
    sopVersion: 1,
    mode: input.mode || "agent",
    stages: sop.nodes.map((node) => node.stage),
  };
  s.projects.push(p);
  let prev = "";
  sop.nodes.forEach((node, i) => {
    const id = uid();
    s.tasks.push({
      id,
      projectId: p.id,
      title: node.name,
      stage: node.stage,
      status: "待开始",
      contentStatus: "empty",
      boardOrder: 0,
      owner: node.owner,
      reviewer: "supervisor",
      priority: "中",
      dueDate: "",
      description: node.description,
      criteria: "提交有依据的结论、项目 Wiki 页面与交付物，由审核人确认。",
      skill: node.skill,
      dependencies: prev ? [prev] : [],
      wikiPath: `wiki/${safeWikiName(node.name, i)}`,
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
