import { asc, eq, inArray } from "drizzle-orm";
import type { Db } from "./client";
import { bumpRevision } from "./meta";
import { assignments, planQueue, reviewState } from "./schema";
import { DomainError } from "./sessions";

/**
 * Undo for small plan changes (reschedule, skip, postpone, remove from the queue). Each of them
 * touches one problem's assignments, review state and queue rows, so an undo record is simply
 * those rows before and after the change. Undoing puts the "before" rows back and removes rows
 * the change inserted, but only if nothing changed them since: otherwise it refuses, rather than
 * overwrite something newer.
 */
type Assignment = typeof assignments.$inferSelect;
type ReviewState = typeof reviewState.$inferSelect;
type QueueRow = typeof planQueue.$inferSelect;
interface Rows {
  assignments: Assignment[];
  review: ReviewState | null;
  queue: QueueRow[];
}
export interface UndoRecord {
  problemId: number;
  before: Rows;
  after: Rows;
}

function rowsFor(db: Db, problemId: number): Rows {
  return {
    assignments: db.select().from(assignments).where(eq(assignments.problemId, problemId)).orderBy(asc(assignments.id)).all(),
    review: db.select().from(reviewState).where(eq(reviewState.problemId, problemId)).get() ?? null,
    queue: db.select().from(planQueue).where(eq(planQueue.problemId, problemId)).orderBy(asc(planQueue.id)).all(),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function assignmentProblemId(db: Db, assignmentId: number): number | null {
  return db.select({ p: assignments.problemId }).from(assignments).where(eq(assignments.id, assignmentId)).get()?.p ?? null;
}

/** Run a change to one problem's plan rows and return how to undo it. */
export function withUndo(db: Db, problemId: number, change: () => void): UndoRecord {
  const before = rowsFor(db, problemId);
  change();
  return { problemId, before, after: rowsFor(db, problemId) };
}

/** Reverse a change recorded by `withUndo`. Throws `changed_since` if those rows were changed again meanwhile. */
export function applyUndo(db: Db, u: UndoRecord) {
  db.transaction((tx) => {
    const now = rowsFor(tx, u.problemId);
    if (!same(now, u.after)) throw new DomainError("changed_since", "This was changed again since, so it can't be undone here.");
    const beforeIds = new Set(u.before.assignments.map((a) => a.id));
    const inserted = u.after.assignments.filter((a) => !beforeIds.has(a.id)).map((a) => a.id);
    if (inserted.length) tx.delete(assignments).where(inArray(assignments.id, inserted)).run();
    for (const a of u.before.assignments) {
      const { id, ...rest } = a;
      tx.update(assignments).set(rest).where(eq(assignments.id, id)).run();
    }
    if (u.before.review) {
      const { problemId, ...rest } = u.before.review;
      tx.update(reviewState).set(rest).where(eq(reviewState.problemId, problemId)).run();
    }
    for (const q of u.before.queue) {
      const { id, ...rest } = q;
      tx.update(planQueue).set(rest).where(eq(planQueue.id, id)).run();
    }
    bumpRevision(tx);
  });
}
