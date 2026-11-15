import { describe, expect, it } from "vitest";
import { applyUndo, createPlan, finishSession, getTodayView, postponeReview, removeFromQueue, rescheduleAssignment, schema, skipAssignment, startSession, withUndo } from "../src";
import { at, freshDb, TZ } from "./helpers";

const MON = "2026-11-02";

function setup() {
  const db = freshDb(); // sample lists imported
  const plan = createPlan(db, { startDate: MON, timeZone: TZ }, at(MON, 7));
  const now = at(MON, 9);
  const item = getTodayView(db, now).sections.newQuestions[0]!;
  return { db, plan, now, item, rows: () => db.select().from(schema.assignments).all(), queue: () => db.select().from(schema.planQueue).all() };
}

describe("undo for plan changes (H3)", () => {
  it("undoes a reschedule exactly", () => {
    const { db, now, item, rows } = setup();
    const before = rows();
    const u = withUndo(db, item.problem.id, () => rescheduleAssignment(db, item.assignment.id, "2026-11-04", now));
    expect(rows()).not.toEqual(before);
    applyUndo(db, u);
    expect(rows()).toEqual(before);
  });

  it("undoes a skip: the question is back on today and out of the queue again", () => {
    const { db, item, rows, queue } = setup();
    const before = { a: rows(), q: queue() };
    const u = withUndo(db, item.problem.id, () => skipAssignment(db, item.assignment.id));
    expect(queue()).not.toEqual(before.q); // the skipped question went back to the queue
    applyUndo(db, u);
    expect({ a: rows(), q: queue() }).toEqual(before);
  });

  it("undoes removing a question from the queue", () => {
    const { db, plan, queue } = setup();
    const pending = queue().find((q) => q.status === "pending")!;
    const before = queue();
    const u = withUndo(db, pending.problemId, () => removeFromQueue(db, plan.id, pending.problemId));
    expect(queue().find((q) => q.id === pending.id)!.status).toBe("removed");
    applyUndo(db, u);
    expect(queue()).toEqual(before);
  });

  it("undoes a postponed review, review state included", () => {
    const { db, item } = setup();
    const { session } = startSession(db, { problemId: item.problem.id, assignmentId: item.assignment.id, origin: "dashboard" }, at(MON, 10));
    finishSession(db, session.id, { outcome: "struggled", hintsUsed: false }, at(MON, 10, 30));
    const state = () => db.select().from(schema.reviewState).all();
    const before = state();
    expect(before.length).toBe(1);
    const u = withUndo(db, item.problem.id, () => postponeReview(db, item.problem.id, "2026-11-12", at(MON, 11)));
    expect(state()[0]!.postponedTo).toBe("2026-11-12");
    applyUndo(db, u);
    expect(state()).toEqual(before);
  });

  it("refuses when the rows changed again since, and leaves them as they are", () => {
    const { db, now, item, rows } = setup();
    const u = withUndo(db, item.problem.id, () => rescheduleAssignment(db, item.assignment.id, "2026-11-04", now));
    rescheduleAssignment(db, item.assignment.id, "2026-11-05", now);
    const after = rows();
    expect(() => applyUndo(db, u)).toThrow(/changed again/);
    expect(rows()).toEqual(after);
  });
});
