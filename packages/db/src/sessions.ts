import { and, asc, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { computeNextReview, overrideNextReview, type ReviewStateCore } from "@lcc/scheduler";
import {
  OPEN_SESSION_STATUSES,
  localDateBounds,
  toLocalDate,
  type AppSettings,
  type LocalDate,
  type Outcome,
  type Reflection,
  type SessionOrigin,
  type SessionType,
} from "@lcc/shared";
import type { Db } from "./client";
import { bumpRevision, getAppSettings } from "./meta";
import { getNotes, saveNotes } from "./notes";
import { appMeta, assignments, planQueue, reviewState, sessions, submissions, type Assignment, type ReviewState, type Session } from "./schema";

export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const openStatuses = [...OPEN_SESSION_STATUSES];

export function getSession(db: Db, id: string): Session | null {
  return db.select().from(sessions).where(eq(sessions.id, id)).get() ?? null;
}

export function getOpenSessionForProblem(db: Db, problemId: number): Session | null {
  return (
    db
      .select()
      .from(sessions)
      .where(and(eq(sessions.problemId, problemId), inArray(sessions.status, openStatuses)))
      .get() ?? null
  );
}

export function listOpenSessions(db: Db): Session[] {
  return db.select().from(sessions).where(inArray(sessions.status, openStatuses)).orderBy(desc(sessions.startedAt)).all();
}

function hasCompletedHistory(db: Db, problemId: number, excludeSessionId?: string): boolean {
  const r = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.problemId, problemId), eq(sessions.status, "completed"), excludeSessionId ? ne(sessions.id, excludeSessionId) : undefined))
    .get();
  return !!r;
}

const TYPE_PRIORITY: Record<string, number> = { new: 0, weekend_review: 1, srs_review: 2, manual: 3 };

/** The open assignment a session for this problem should count toward (if any, due today or earlier). */
function findAssignmentFor(db: Db, problemId: number, today: LocalDate): Assignment | null {
  const open = db
    .select()
    .from(assignments)
    .where(and(eq(assignments.problemId, problemId), inArray(assignments.status, ["pending", "in_progress"]), lte(assignments.scheduledDate, today)))
    .all();
  open.sort((a, b) => (TYPE_PRIORITY[a.type] ?? 9) - (TYPE_PRIORITY[b.type] ?? 9));
  return open[0] ?? null;
}

function sessionTypeFor(assignment: Assignment | null, hasHistory: boolean): SessionType {
  switch (assignment?.type) {
    case "new":
      return hasHistory ? "repeat_new" : "first_attempt";
    case "weekend_review":
      return "weekend_review";
    case "srs_review":
      return "srs_review";
    default:
      return hasHistory ? "free_practice" : "first_attempt";
  }
}

export function isReviewSessionType(t: SessionType) {
  return t === "weekend_review" || t === "srs_review" || t === "free_practice" || t === "repeat_new";
}

export interface StartResult {
  session: Session;
  resumed: boolean;
}

/**
 * Start (or resume) practice. If the problem already has an open session it is
 * returned instead of creating a duplicate — a page refresh or a second tab
 * never creates a second session.
 */
export function startSession(
  db: Db,
  input: { id?: string; problemId: number; assignmentId?: number | null; origin: SessionOrigin; startedAt?: number },
  now = Date.now(),
): StartResult {
  return db.transaction((tx) => {
    const open = getOpenSessionForProblem(tx, input.problemId);
    if (open) {
      if (open.status === "paused") resumeSessionTx(tx, open, now);
      return { session: getSession(tx, open.id)!, resumed: true };
    }
    if (input.id) {
      const existing = getSession(tx, input.id);
      if (existing) return { session: existing, resumed: true };
    }
    const settings = getAppSettings(tx);
    const today = toLocalDate(input.startedAt ?? now, settings.timeZone);
    let assignment: Assignment | null = null;
    if (input.assignmentId != null) {
      assignment = tx.select().from(assignments).where(eq(assignments.id, input.assignmentId)).get() ?? null;
      if (assignment && assignment.problemId !== input.problemId) throw new DomainError("assignment_mismatch", "Assignment is for a different problem");
      if (assignment && !["pending", "in_progress"].includes(assignment.status)) assignment = null;
    } else {
      assignment = findAssignmentFor(tx, input.problemId, today);
    }
    const type = sessionTypeFor(assignment, hasCompletedHistory(tx, input.problemId));
    const startedAt = input.startedAt ?? now;
    const session = tx
      .insert(sessions)
      .values({
        id: input.id ?? randomUUID(),
        problemId: input.problemId,
        assignmentId: assignment?.id ?? null,
        type,
        status: "in_progress",
        origin: input.origin,
        startedAt,
        lastActivityAt: startedAt,
      })
      .returning()
      .get();
    if (assignment) {
      tx.update(assignments).set({ status: "in_progress", updatedAt: now }).where(eq(assignments.id, assignment.id)).run();
    }
    bumpRevision(tx);
    return { session, resumed: false };
  });
}

function requireOpen(db: Db, id: string): Session {
  const s = getSession(db, id);
  if (!s) throw new DomainError("not_found", "Session not found");
  if (!openStatuses.includes(s.status)) throw new DomainError("not_open", `Session is already ${s.status}`);
  return s;
}

export function pauseSession(db: Db, id: string, at = Date.now()) {
  const s = requireOpen(db, id);
  if (s.status === "paused") return s;
  db.update(sessions).set({ status: "paused", pausedAt: at, updatedAt: Date.now() }).where(eq(sessions.id, id)).run();
  bumpRevision(db);
  return getSession(db, id)!;
}

function resumeSessionTx(db: Db, s: Session, at: number) {
  const add = s.pausedAt != null ? Math.max(0, at - s.pausedAt) : 0;
  db.update(sessions)
    .set({ status: "in_progress", pausedAt: null, pausedMs: s.pausedMs + add, lastActivityAt: at, updatedAt: Date.now() })
    .where(eq(sessions.id, s.id))
    .run();
}

export function resumeSession(db: Db, id: string, at = Date.now()) {
  const s = requireOpen(db, id);
  if (s.status !== "paused") return s;
  resumeSessionTx(db, s, at);
  bumpRevision(db);
  return getSession(db, id)!;
}

export function updateSessionNotes(
  db: Db,
  id: string,
  patch: { notes?: string | null; struggles?: string | null; takeaway?: string | null; mistakes?: string | null; timeComplexity?: string | null; spaceComplexity?: string | null },
) {
  const s = getSession(db, id);
  if (!s) throw new DomainError("not_found", "Session not found");
  const isOpen = openStatuses.includes(s.status);
  db.update(sessions)
    .set({ ...patch, ...(isOpen ? { lastActivityAt: Date.now() } : {}), updatedAt: Date.now() })
    .where(eq(sessions.id, id))
    .run();
}

export function recordActivity(db: Db, id: string, activeMs: number, lastActivityAt: number) {
  const s = getSession(db, id);
  if (!s) throw new DomainError("not_found", "Session not found");
  if (!openStatuses.includes(s.status)) return; // ignore late activity after finishing
  db.update(sessions)
    .set({
      activeMs: Math.max(s.activeMs ?? 0, activeMs),
      lastActivityAt: Math.max(s.lastActivityAt ?? 0, lastActivityAt),
      updatedAt: Date.now(),
    })
    .where(eq(sessions.id, id))
    .run();
  bumpRevision(db);
}

/** Track voluntary reveals during a review (hints, previous notes, previous code). */
export function recordReveal(db: Db, id: string, what: "hints" | "notes" | "code") {
  const col = what === "hints" ? { revealedHints: true } : what === "notes" ? { revealedNotes: true } : { revealedCode: true };
  db.update(sessions).set({ ...col, updatedAt: Date.now() }).where(eq(sessions.id, id)).run();
  bumpRevision(db);
}

function toCore(r: ReviewState | null | undefined): ReviewStateCore | null {
  if (!r) return null;
  return {
    intervalDays: r.intervalDays,
    successStreak: r.successStreak,
    lapses: r.lapses,
    reviewCount: r.reviewCount,
    stage: r.stage,
    lastOutcome: r.lastOutcome,
    lastReviewedDate: r.lastReviewedDate,
    nextDueDate: r.nextDueDate,
  };
}

/**
 * Review state is *derived*: replay every completed session in order, applying
 * the per-session override where the user picked a date. A postponement is kept
 * unless a later session superseded it.
 */
export function recomputeReviewState(
  db: Db,
  problemId: number,
  settings: AppSettings = getAppSettings(db),
  /** Re-derive this session's own recommended date too (used after its outcome is edited). */
  refreshSessionId?: string,
): ReviewState | null {
  const done = db
    .select()
    .from(sessions)
    .where(and(eq(sessions.problemId, problemId), eq(sessions.status, "completed")))
    .orderBy(asc(sessions.endedAt), asc(sessions.startedAt))
    .all()
    .filter((s) => s.outcome);
  const existing = db.select().from(reviewState).where(eq(reviewState.problemId, problemId)).get();
  if (done.length === 0) {
    if (existing) db.delete(reviewState).where(eq(reviewState.problemId, problemId)).run();
    return null;
  }
  let st: ReviewStateCore | null = null;
  for (const s of done) {
    const date = s.endedDate ?? toLocalDate(s.endedAt ?? s.startedAt, settings.timeZone);
    st = computeNextReview(st, s.outcome as Outcome, date, settings.srs);
    if (s.id === refreshSessionId && st.nextDueDate) {
      db.update(sessions)
        .set({ recommendedReviewDate: st.nextDueDate, ...(s.nextReviewOverridden ? {} : { nextReviewDate: st.nextDueDate }) })
        .where(eq(sessions.id, s.id))
        .run();
    }
    if (s.nextReviewOverridden && s.nextReviewDate) st = overrideNextReview(st, s.nextReviewDate, date);
  }
  const final = st!;
  const first = done[0]!;
  const postponedTo = existing?.postponedTo && final.nextDueDate && existing.postponedTo > final.nextDueDate ? existing.postponedTo : null;
  const values = {
    problemId,
    stage: final.stage,
    intervalDays: final.intervalDays,
    nextDueDate: postponedTo ?? final.nextDueDate,
    lastReviewedDate: final.lastReviewedDate,
    lastOutcome: final.lastOutcome,
    successStreak: final.successStreak,
    lapses: final.lapses,
    reviewCount: final.reviewCount,
    firstPracticedDate: first.endedDate ?? toLocalDate(first.endedAt ?? first.startedAt, settings.timeZone),
    postponedTo,
    updatedAt: Date.now(),
  };
  db.insert(reviewState).values(values).onConflictDoUpdate({ target: reviewState.problemId, set: values }).run();
  return db.select().from(reviewState).where(eq(reviewState.problemId, problemId)).get() ?? null;
}

/** What the scheduler would recommend if this session ended now with `outcome`. */
export function recommendNextReview(db: Db, problemId: number, outcome: Outcome, today: LocalDate): { date: LocalDate; intervalDays: number } {
  const settings = getAppSettings(db);
  const prev = db.select().from(reviewState).where(eq(reviewState.problemId, problemId)).get();
  const next = computeNextReview(toCore(prev), outcome, today, settings.srs);
  return { date: next.nextDueDate!, intervalDays: next.intervalDays };
}

function completeAssignmentsFor(db: Db, session: Session, endedAt: number, endedDate: LocalDate) {
  const ids: number[] = [];
  if (session.assignmentId != null) ids.push(session.assignmentId);
  // Other open *review* tasks for this problem due by today are covered by this session.
  const others = db
    .select()
    .from(assignments)
    .where(
      and(
        eq(assignments.problemId, session.problemId),
        inArray(assignments.status, ["pending", "in_progress"]),
        inArray(assignments.type, ["weekend_review", "srs_review", "manual"]),
        lte(assignments.scheduledDate, endedDate),
      ),
    )
    .all();
  for (const o of others) if (!ids.includes(o.id)) ids.push(o.id);
  for (const id of ids) {
    const a = db.select().from(assignments).where(eq(assignments.id, id)).get();
    if (!a || !["pending", "in_progress"].includes(a.status)) continue;
    db.update(assignments)
      .set({
        status: "completed",
        completedAt: endedAt,
        completedDate: endedDate,
        completedSessionId: session.id,
        note: id === session.assignmentId ? a.note : `Covered by a ${session.type.replace("_", " ")} session`,
        updatedAt: Date.now(),
      })
      .where(eq(assignments.id, id))
      .run();
    if (a.type === "new" && a.planId != null) {
      db.update(planQueue)
        .set({ status: "done", updatedAt: Date.now() })
        .where(and(eq(planQueue.planId, a.planId), eq(planQueue.problemId, a.problemId)))
        .run();
    }
  }
}

/**
 * The problem's permanent notes have time/space complexity fields. When a session records its
 * complexity and the permanent field is still empty, copy it there. Never overwrites.
 */
function fillEmptyProblemComplexity(db: Db, s: Session) {
  const t = s.timeComplexity?.trim();
  const sp = s.spaceComplexity?.trim();
  if (!t && !sp) return;
  const existing = getNotes(db, s.problemId);
  const patch: { timeComplexity?: string; spaceComplexity?: string } = {};
  if (t && !existing?.timeComplexity?.trim()) patch.timeComplexity = t;
  if (sp && !existing?.spaceComplexity?.trim()) patch.spaceComplexity = sp;
  if (patch.timeComplexity || patch.spaceComplexity) saveNotes(db, s.problemId, patch);
}

/**
 * Finish a session with a reflection. Records the recommended review date and
 * the (possibly overridden) decision, then re-derives the review state.
 */
export function finishSession(db: Db, id: string, reflection: Reflection, endedAt = Date.now()): Session {
  return db.transaction((tx) => {
    const s = requireOpen(tx, id);
    const settings = getAppSettings(tx);
    const end = Math.max(endedAt, s.startedAt);
    const endedDate = toLocalDate(end, settings.timeZone);
    const extraPause = s.status === "paused" && s.pausedAt != null ? Math.max(0, end - s.pausedAt) : 0;
    const rec = recommendNextReview(tx, s.problemId, reflection.outcome, endedDate);
    const overridden = !!reflection.nextReviewDate && reflection.nextReviewDate !== rec.date;
    tx.update(sessions)
      .set({
        status: "completed",
        endedAt: end,
        endedDate,
        pausedAt: null,
        pausedMs: s.pausedMs + extraPause,
        outcome: reflection.outcome,
        hintsUsed: reflection.hintsUsed || s.revealedHints || s.revealedCode,
        notes: reflection.notes ?? s.notes,
        struggles: reflection.struggles ?? s.struggles,
        takeaway: reflection.takeaway ?? s.takeaway,
        mistakes: reflection.mistakes ?? s.mistakes,
        timeComplexity: reflection.timeComplexity ?? s.timeComplexity,
        spaceComplexity: reflection.spaceComplexity ?? s.spaceComplexity,
        patterns: reflection.patterns ?? s.patterns,
        difficultyRating: reflection.difficultyRating ?? s.difficultyRating,
        durationOverrideMs: reflection.durationOverrideMs ?? s.durationOverrideMs,
        recommendedReviewDate: rec.date,
        nextReviewDate: overridden ? reflection.nextReviewDate! : rec.date,
        nextReviewOverridden: overridden,
        updatedAt: Date.now(),
      })
      .where(eq(sessions.id, id))
      .run();
    // A new session supersedes any earlier postponement.
    tx.update(reviewState).set({ postponedTo: null }).where(eq(reviewState.problemId, s.problemId)).run();
    const fresh = getSession(tx, id)!;
    fillEmptyProblemComplexity(tx, fresh);
    completeAssignmentsFor(tx, fresh, end, endedDate);
    recomputeReviewState(tx, s.problemId, settings);
    bumpRevision(tx);
    return fresh;
  });
}

/** Abandon: history is kept; the linked assignment goes back to "pending". */
export function abandonSession(db: Db, id: string, at = Date.now()) {
  db.transaction((tx) => {
    const s = requireOpen(tx, id);
    const settings = getAppSettings(tx);
    tx.update(sessions)
      .set({ status: "abandoned", endedAt: at, endedDate: toLocalDate(at, settings.timeZone), pausedAt: null, updatedAt: Date.now() })
      .where(eq(sessions.id, id))
      .run();
    if (s.assignmentId != null) {
      tx.update(assignments)
        .set({ status: "pending", updatedAt: Date.now() })
        .where(and(eq(assignments.id, s.assignmentId), eq(assignments.status, "in_progress")))
        .run();
    }
    bumpRevision(tx);
  });
}

/** Edit a completed session after the fact (notes, duration). Outcome edits re-derive the schedule. */
export function editCompletedSession(
  db: Db,
  id: string,
  patch: Partial<Pick<Session, "notes" | "struggles" | "takeaway" | "mistakes" | "timeComplexity" | "spaceComplexity" | "durationOverrideMs" | "hintsUsed" | "difficultyRating">> & {
    outcome?: Outcome;
  },
) {
  db.transaction((tx) => {
    const s = getSession(tx, id);
    if (!s) throw new DomainError("not_found", "Session not found");
    tx.update(sessions).set({ ...patch, updatedAt: Date.now() }).where(eq(sessions.id, id)).run();
    if (patch.outcome && s.status === "completed" && patch.outcome !== s.outcome) recomputeReviewState(tx, s.problemId, getAppSettings(tx), id);
    bumpRevision(tx);
  });
}

/**
 * Permanently delete a finished (completed or abandoned) session, e.g. a test
 * run. This is the only destructive operation on history, and it is always an
 * explicit user action (the dashboard takes a backup first). Effects:
 * - its submissions are deleted with it;
 * - tasks it completed are reopened (a past SRS pick expires instead, since the
 *   problem simply becomes due again; a task whose slot is already taken by
 *   another open task is cancelled);
 * - a "new" question it completed goes back to "assigned" in the plan queue;
 * - review state and mastery are re-derived from the remaining sessions.
 * Open sessions must be finished or abandoned first, so the extension never
 * holds a binding to a session that no longer exists.
 */
export function deleteSession(db: Db, id: string, today?: LocalDate): { problemId: number; deletedSubmissions: number; reopenedAssignments: number } {
  return db.transaction((tx) => {
    const s = getSession(tx, id);
    if (!s) throw new DomainError("not_found", "Session not found");
    if (openStatuses.includes(s.status)) throw new DomainError("open", "Finish or abandon this session before deleting it");
    const day = today ?? toLocalDate(Date.now(), getAppSettings(tx).timeZone);
    let reopened = 0;
    const completed = tx.select().from(assignments).where(eq(assignments.completedSessionId, id)).all();
    for (const a of completed) {
      const slotTaken = tx
        .select()
        .from(assignments)
        .where(and(eq(assignments.problemId, a.problemId), eq(assignments.type, a.type), inArray(assignments.status, ["pending", "in_progress"]), ne(assignments.id, a.id)))
        .get();
      const status = slotTaken ? "cancelled" : a.type === "srs_review" && a.scheduledDate < day ? "expired" : "pending";
      tx.update(assignments)
        .set({ status, completedAt: null, completedDate: null, completedSessionId: null, note: status === "cancelled" ? "Completing session was deleted" : a.note, updatedAt: Date.now() })
        .where(eq(assignments.id, a.id))
        .run();
      if (status === "pending") reopened++;
      if (a.type === "new" && a.planId != null) {
        tx.update(planQueue)
          .set({ status: "assigned", updatedAt: Date.now() })
          .where(and(eq(planQueue.planId, a.planId), eq(planQueue.problemId, a.problemId), eq(planQueue.status, "done")))
          .run();
      }
    }
    const subs = tx.delete(submissions).where(eq(submissions.sessionId, id)).run();
    tx.delete(appMeta).where(and(sql`${appMeta.key} like 'session_alias:%'`, eq(appMeta.value, id))).run();
    tx.delete(sessions).where(eq(sessions.id, id)).run();
    recomputeReviewState(tx, s.problemId);
    bumpRevision(tx);
    return { problemId: s.problemId, deletedSubmissions: subs.changes, reopenedAssignments: reopened };
  });
}

/**
 * Log an attempt after the fact (or mark a problem as previously completed).
 * Creates a completed session flagged origin=manual_log — never a fake capture.
 */
export function logManualAttempt(
  db: Db,
  input: {
    problemId: number;
    date: LocalDate;
    outcome: Outcome;
    durationMin?: number | null;
    notes?: string | null;
    hintsUsed?: boolean;
    assignmentId?: number | null;
    type?: SessionType;
  },
): Session {
  return db.transaction((tx) => {
    const settings = getAppSettings(tx);
    const { start } = localDateBounds(input.date, settings.timeZone);
    const startedAt = start + 12 * 3_600_000;
    const durationMs = input.durationMin != null ? Math.round(input.durationMin * 60_000) : null;
    const endedAt = startedAt + (durationMs ?? 0);
    const type = input.type ?? (hasCompletedHistory(tx, input.problemId) ? "free_practice" : "first_attempt");
    const session = tx
      .insert(sessions)
      .values({
        id: randomUUID(),
        problemId: input.problemId,
        assignmentId: input.assignmentId ?? null,
        type,
        status: "completed",
        origin: "manual_log",
        startedAt,
        endedAt,
        endedDate: input.date,
        durationOverrideMs: durationMs,
        outcome: input.outcome,
        hintsUsed: !!input.hintsUsed,
        notes: input.notes ?? null,
      })
      .returning()
      .get();
    const rec = recommendNextReview(tx, input.problemId, input.outcome, input.date);
    tx.update(sessions).set({ recommendedReviewDate: rec.date, nextReviewDate: rec.date }).where(eq(sessions.id, session.id)).run();
    tx.update(reviewState).set({ postponedTo: null }).where(eq(reviewState.problemId, input.problemId)).run();
    completeAssignmentsFor(tx, { ...session }, endedAt, input.date);
    recomputeReviewState(tx, input.problemId, settings);
    bumpRevision(tx);
    return getSession(tx, session.id)!;
  });
}

/** Postpone a problem's next review (keeps history; a later session supersedes it). */
export function postponeReview(db: Db, problemId: number, to: LocalDate) {
  db.transaction((tx) => {
    const rs = tx.select().from(reviewState).where(eq(reviewState.problemId, problemId)).get();
    if (!rs) throw new DomainError("no_review_state", "Problem has no review history yet");
    tx.update(reviewState).set({ nextDueDate: to, postponedTo: to, updatedAt: Date.now() }).where(eq(reviewState.problemId, problemId)).run();
    tx.update(assignments)
      .set({ status: "postponed", note: `Postponed to ${to}`, updatedAt: Date.now() })
      .where(and(eq(assignments.problemId, problemId), eq(assignments.type, "srs_review"), eq(assignments.status, "pending")))
      .run();
    bumpRevision(tx);
  });
}
