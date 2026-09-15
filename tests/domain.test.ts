import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initial,
  makeProject,
  transition,
  setDependencies,
} from "../domain.ts";
function fixture() {
  const s: any = initial();
  makeProject(s, { name: "test" });
  return s;
}
test("dependency edit prevents cycles and foreign IDs", () => {
  const s = fixture();
  assert.throws(() => setDependencies(s, s.tasks[0], [s.tasks[6].id]), {
    code: "DEPENDENCY_CYCLE",
  });
  assert.throws(() => setDependencies(s, s.tasks[0], ["missing"]), {
    code: "INVALID_DEPENDENCY",
  });
  setDependencies(s, s.tasks[2], [s.tasks[0].id]);
  assert.equal(s.tasks[2].dependencies.length, 1);
});
test("SOP generates seven sequential tasks", () => {
  const s = fixture();
  assert.equal(s.tasks.length, 7);
  assert.deepEqual(s.tasks[1].dependencies, [s.tasks[0].id]);
});
test("dependency blocks early start", () => {
  const s = fixture();
  assert.throws(() => transition(s, s.tasks[1], "start", "agent"), {
    code: "DEPENDENCY_BLOCKED",
  });
});
test("evidence and reviewer gates, ready notification", () => {
  const s = fixture(),
    t = s.tasks[0];
  transition(s, t, "start", "agent");
  assert.throws(() => transition(s, t, "submit", "agent"), {
    code: "EVIDENCE_REQUIRED",
  });
  s.pages.push({ projectId: t.projectId, path: t.wikiPath, substantive: true });
  transition(s, t, "submit", "agent");
  assert.throws(() => transition(s, t, "approve", "agent"), {
    code: "REVIEWER_REQUIRED",
  });
  transition(s, t, "approve", "supervisor");
  assert.equal(t.status, "已完成");
  assert.equal(s.notifications.length, 2);
  transition(s, s.tasks[1], "start", "agent");
});
test("reject requires reason and returns execution", () => {
  const s = fixture(),
    t = s.tasks[0];
  t.status = "待审核";
  assert.throws(() => transition(s, t, "reject", "supervisor"), {
    code: "VALIDATION",
  });
  transition(s, t, "reject", "supervisor", "补充依据");
  assert.equal(t.status, "进行中");
  assert.equal(t.reviewNote, "补充依据");
});
test("unblock preserves prior state", () => {
  const s = fixture(),
    t = s.tasks[0];
  t.status = "待审核";
  transition(s, t, "block", "agent", "等待数据");
  transition(s, t, "unblock", "agent");
  assert.equal(t.status, "待审核");
  assert.throws(() => transition(s, t, "start", "agent"), {
    code: "INVALID_TRANSITION",
  });
});
