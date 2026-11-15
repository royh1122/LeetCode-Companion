import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { addDays, type Outcome } from "@lcc/shared";
import {
  addAssignment,
  createPlan,
  ensureSchedule,
  finishSession,
  getActivePlan,
  getProblemDetail,
  getQueue,
  getReviewQueue,
  getTodayView,
  logManualAttempt,
  pendingQueue,
  processSyncEvents,
  pullMoreReviews,
  rescheduleAssignment,
  schema,
  skipDay,
  startSession,
  unskipDay,
  type Db,
} from "../src";
import { at, freshDb, TZ } from "./helpers";

// G5: scheduling behaviours not covered by db.test.ts. The week of 2026-11-09 (Monday).
const MON = "2026-11-09";
const TUE = addDays(MON, 1);
const WED = addDays(MON, 2);
const THU = addDays(MON, 3);
const FRI = addDays(MON, 4);
const SAT = addDays(MON, 5);
const SUN = addDays(MON, 6);
const NEXT_MON = addDays(MON, 7);

type View = ReturnType<typeof getTodayView>;
type Item = View["sections"]["newQuestions"][number];

const isOpen = (i: Item) => i.assignment.status === "pending" || i.assignment.status === "in_progress";
const openNew = (v: View) => v.sections.newQuestions.filter(isOpen);
const ids = (xs: Item[]) => xs.map((i) => i.problem.id);

function solve(db: Db, items: Item[], date: string, outcome: Outcome = "independent", hour = 10) {
  let minute = 0;
  for (const it of items) {
    const { session } = startSession(db, { problemId: it.problem.id, assignmentId: it.assignment.id, origin: "dashboard", startedAt: at(date, hour, minute) }, at(date, hour, minute));
    finishSession(db, session.id, { outcome, hintsUsed: false }, at(date, hour, minute + 1));
    minute += 2;
  }
}

function assignmentsOf(db: Db, problemId: number) {
  return db.select().from(schema.assignments).where(eq(schema.assignments.problemId, problemId)).all();
}

function newPlan(db: Db, settings: Parameters<typeof createPlan>[1]["settings"] = undefined) {
  return createPlan(db, { startDate: MON, timeZone: TZ, ...(settings ? { settings } : {}) }, at(MON, 7));
}

/** A problem far down the queue, practised once on `date` with `outcome` (not part of any cohort). */
function practisedOutsidePlan(db: Db, planId: number, fromEnd: number, date: string, outcome: Outcome) {
  const q = pendingQueue(db, planId);
  const pid = q[q.length - 1 - fromEnd]!.problemId;
  logManualAttempt(db, { problemId: pid, date, outcome }, at(date, 23));
  return pid;
}

describe("a finished session completes the problem's other open tasks", () => {
  it("finishing a weekend review also completes an older open manual task for that problem, but not a task on a later day", () => {
    const db = freshDb();
    newPlan(db);
    solve(db, getTodayView(db, at(MON, 8)).sections.newQuestions, MON);
    const sat = getTodayView(db, at(SAT, 8));
    expect(sat.sections.mandatory).toHaveLength(5);
    const review = sat.sections.mandatory[0]!;
    const pid = review.problem.id;
    // Two more tasks for the same problem: one from yesterday (still open), one for tomorrow.
    const manual = addAssignment(db, pid, FRI);
    const later = addAssignment(db, pid, SUN, { asNew: true });

    const { session } = startSession(db, { problemId: pid, assignmentId: review.assignment.id, origin: "dashboard" }, at(SAT, 10));
    expect(session.type).toBe("weekend_review");
    finishSession(db, session.id, { outcome: "independent", hintsUsed: false }, at(SAT, 10, 20));

    const byId = new Map(assignmentsOf(db, pid).map((a) => [a.id, a]));
    expect(byId.get(review.assignment.id)).toMatchObject({ status: "completed", completedSessionId: session.id, completedDate: SAT });
    expect(byId.get(manual.id)).toMatchObject({ status: "completed", completedSessionId: session.id, completedDate: SAT, note: "Covered by a weekend review session" });
    // Only tasks due by the day the session ended are covered.
    expect(byId.get(later.id)!.status).toBe("pending");
    // The covered task no longer shows as an open carried-over item on Saturday.
    const after = getTodayView(db, at(SAT, 11));
    expect(after.sections.newQuestions.filter((i) => i.problem.id === pid && isOpen(i))).toHaveLength(0);
    // One sitting = one session in the history.
    expect(getProblemDetail(db, review.problem.slug, at(SAT, 11))!.sessions).toHaveLength(2); // Monday's first attempt + this review
  });

  it("finishing a spaced-repetition pick also completes an open manual task for that problem from an earlier day", () => {
    const db = freshDb();
    const plan = newPlan(db);
    const pid = practisedOutsidePlan(db, plan.id, 0, MON, "failed"); // due Tuesday
    const pick = getTodayView(db, at(TUE, 8)).sections.srs.find((i) => i.problem.id === pid)!;
    expect(pick.assignment.type).toBe("srs_review");
    const manual = addAssignment(db, pid, MON);

    const { session } = startSession(db, { problemId: pid, assignmentId: pick.assignment.id, origin: "dashboard" }, at(TUE, 10));
    expect(session.type).toBe("srs_review");
    finishSession(db, session.id, { outcome: "independent", hintsUsed: false }, at(TUE, 10, 15));

    const byId = new Map(assignmentsOf(db, pid).map((a) => [a.id, a]));
    expect(byId.get(pick.assignment.id)).toMatchObject({ status: "completed", completedSessionId: session.id });
    expect(byId.get(manual.id)).toMatchObject({ status: "completed", completedSessionId: session.id, note: "Covered by a srs review session" });
  });
});

describe("postponements and rescheduling", () => {
  it("a postponed review pick moves the due date to the chosen day and is not picked again before it", () => {
    const db = freshDb();
    const plan = newPlan(db);
    const pid = practisedOutsidePlan(db, plan.id, 0, MON, "failed"); // due Tuesday
    const pick = getTodayView(db, at(TUE, 8)).sections.srs.find((i) => i.problem.id === pid)!;
    rescheduleAssignment(db, pick.assignment.id, FRI, at(TUE, 9));

    expect(assignmentsOf(db, pid).find((a) => a.id === pick.assignment.id)).toMatchObject({ status: "postponed", note: `Postponed to ${FRI}` });
    const slug = pick.problem.slug;
    expect(getProblemDetail(db, slug, at(TUE, 9))!.reviewState).toMatchObject({ nextDueDate: FRI, postponedTo: FRI });
    expect(getReviewQueue(db, at(TUE, 9)).dueNow.map((r) => r.problem.id)).not.toContain(pid);
    // Wednesday and Thursday: no task at all for it, and it isn't due.
    for (const d of [WED, THU]) {
      const v = getTodayView(db, at(d, 8));
      expect(v.sections.srs.map((i) => i.problem.id)).not.toContain(pid);
      expect(getReviewQueue(db, at(d, 8)).dueNow.map((r) => r.problem.id)).not.toContain(pid);
    }
    // Friday: due again, and picked once.
    const fri = getTodayView(db, at(FRI, 8)).sections.srs.filter((i) => i.problem.id === pid);
    expect(fri).toHaveLength(1);
    expect(fri[0]!.assignment).toMatchObject({ status: "pending", scheduledDate: FRI });
  });

  it("a rescheduled new question is not shown on the days before its new date", () => {
    const db = freshDb();
    newPlan(db);
    const moved = getTodayView(db, at(MON, 8)).sections.newQuestions[0]!;
    rescheduleAssignment(db, moved.assignment.id, WED, at(MON, 9));
    expect(ids(openNew(getTodayView(db, at(MON, 9))))).not.toContain(moved.problem.id);
    expect(ids(getTodayView(db, at(TUE, 8)).sections.newQuestions)).not.toContain(moved.problem.id);
    expect(ids(openNew(getTodayView(db, at(WED, 8))))).toContain(moved.problem.id);
  });

  it("a weekend review moved from Saturday to Sunday leaves Saturday and is not duplicated on Sunday", () => {
    const db = freshDb();
    newPlan(db);
    solve(db, getTodayView(db, at(MON, 8)).sections.newQuestions, MON);
    solve(db, getTodayView(db, at(TUE, 8)).sections.newQuestions, TUE);
    const sat = getTodayView(db, at(SAT, 8));
    expect(sat.sections.mandatory).toHaveLength(10); // the whole cohort fits in Saturday's 12
    const moved = sat.sections.mandatory[0]!;
    rescheduleAssignment(db, moved.assignment.id, SUN, at(SAT, 9));
    const sat2 = getTodayView(db, at(SAT, 10)).sections.mandatory;
    expect(sat2).toHaveLength(9);
    expect(ids(sat2)).not.toContain(moved.problem.id);
    const sun = getTodayView(db, at(SUN, 8)).sections.mandatory;
    expect(sun.filter((i) => i.problem.id === moved.problem.id)).toHaveLength(1);
    expect(sun.find((i) => i.problem.id === moved.problem.id)!.assignment.id).toBe(moved.assignment.id);
  });
});

describe("skip today, then un-skip the same day", () => {
  it("un-skipping brings back the same new questions (no extra ones, no duplicates, week count unchanged)", () => {
    const db = freshDb();
    const plan = newPlan(db);
    const before = openNew(getTodayView(db, at(MON, 8)));
    expect(before).toHaveLength(5);
    // One is already started; the other four are not.
    const started = before[0]!;
    startSession(db, { problemId: started.problem.id, assignmentId: started.assignment.id, origin: "dashboard" }, at(MON, 8, 30));

    skipDay(db, plan.id, MON);
    const skipped = getTodayView(db, at(MON, 9));
    expect(skipped.isSkipped).toBe(true);
    expect(ids(openNew(skipped))).toEqual([started.problem.id]); // a started question stays
    expect(skipped.weekNew!.assigned).toBe(1);

    unskipDay(db, plan.id, MON);
    const back = getTodayView(db, at(MON, 10));
    expect(back.isSkipped).toBe(false);
    expect(new Set(ids(openNew(back)))).toEqual(new Set(ids(before)));
    expect(openNew(back)).toHaveLength(5);
    expect(back.weekNew!.assigned).toBe(5);
    // The returned four come back in their queue order.
    expect(ids(openNew(back).filter((i) => i.problem.id !== started.problem.id))).toEqual(ids(before.slice(1)));
    // Opening the dashboard again the same day doesn't add more.
    expect(openNew(getTodayView(db, at(MON, 20)))).toHaveLength(5);
    // The un-skipped questions are Monday's for good: still open on Tuesday, they take its slots.
    const tue = openNew(getTodayView(db, at(TUE, 8)));
    expect(tue.filter((i) => i.carriedOver)).toHaveLength(5);
    expect(tue.filter((i) => !i.carriedOver)).toHaveLength(0);
  });
});

describe("stale spaced-repetition picks", () => {
  it("an unstarted pick from an earlier day expires and the problem is picked again once; a started one stays", () => {
    const db = freshDb();
    const plan = newPlan(db);
    const idle = practisedOutsidePlan(db, plan.id, 0, MON, "failed");
    const begun = practisedOutsidePlan(db, plan.id, 1, MON, "failed");
    const tue = getTodayView(db, at(TUE, 8)).sections.srs;
    const idlePick = tue.find((i) => i.problem.id === idle)!;
    const begunPick = tue.find((i) => i.problem.id === begun)!;
    startSession(db, { problemId: begun, assignmentId: begunPick.assignment.id, origin: "dashboard" }, at(TUE, 9));

    const wed = getTodayView(db, at(WED, 8));
    const idleRows = assignmentsOf(db, idle).filter((a) => a.type === "srs_review");
    expect(idleRows.find((a) => a.id === idlePick.assignment.id)).toMatchObject({ status: "expired", note: "Not done that day — still due" });
    // Re-ranked today: exactly one open pick, dated today.
    const idleWed = wed.sections.srs.filter((i) => i.problem.id === idle);
    expect(idleWed).toHaveLength(1);
    expect(idleWed[0]!.assignment).toMatchObject({ status: "pending", scheduledDate: WED });
    expect(idleRows.filter((a) => a.status === "pending" || a.status === "in_progress")).toHaveLength(1);
    // The started pick is not expired, shows as carried over, and gets no second pick.
    const begunWed = wed.sections.srs.filter((i) => i.problem.id === begun);
    expect(begunWed).toHaveLength(1);
    expect(begunWed[0]!).toMatchObject({ carriedOver: true, assignment: { id: begunPick.assignment.id, status: "in_progress" } });
  });

  it("stale picks expire even without a plan", () => {
    const db = freshDb();
    const p = db.select().from(schema.problems).all()[0]!;
    logManualAttempt(db, { problemId: p.id, date: MON, outcome: "failed" }, at(MON, 23));
    expect(pullMoreReviews(db, 1, at(TUE, 9))).toBe(1);
    const pick = assignmentsOf(db, p.id)[0]!;
    expect(pick).toMatchObject({ type: "srs_review", status: "pending", scheduledDate: TUE });
    ensureSchedule(db, at(WED, 8));
    expect(assignmentsOf(db, p.id)[0]!.status).toBe("expired");
  });
});

describe("weekend carry-over and the cohort", () => {
  it("unfinished weekday questions carry into the weekend outside the cohort; finished on Saturday they join Sunday's review", () => {
    const db = freshDb();
    newPlan(db);
    const done: number[] = [];
    for (const d of [MON, TUE, WED, THU]) {
      const v = getTodayView(db, at(d, 8)).sections.newQuestions;
      done.push(...ids(v));
      solve(db, v, d);
    }
    const fri = ids(getTodayView(db, at(FRI, 8)).sections.newQuestions); // left undone

    const sat = getTodayView(db, at(SAT, 8));
    expect(ids(openNew(sat))).toEqual(fri);
    expect(openNew(sat).every((i) => i.carriedOver)).toBe(true);
    expect(sat.sections.mandatory).toHaveLength(12);
    for (const pid of ids(sat.sections.mandatory)) expect(done).toContain(pid);

    solve(db, sat.sections.mandatory, SAT, "independent", 9);
    solve(db, openNew(sat).slice(0, 2), SAT, "independent", 12);

    const sun = getTodayView(db, at(SUN, 8));
    const sunIds = ids(sun.sections.mandatory);
    // The rest of Monday–Thursday (8) plus the two finished on Saturday.
    expect(sunIds).toHaveLength(10);
    expect(sunIds).toEqual(expect.arrayContaining(fri.slice(0, 2)));
    for (const pid of fri.slice(2)) expect(sunIds).not.toContain(pid);
    expect(ids(openNew(sun))).toEqual(fri.slice(2));
    // Every finished question is reviewed exactly once this weekend.
    const reviews = db.select().from(schema.assignments).where(eq(schema.assignments.type, "weekend_review")).all();
    expect(reviews.filter((r) => r.cohortWeek === MON)).toHaveLength(22);
    expect(new Set(reviews.map((r) => r.problemId)).size).toBe(22);

    // Next Monday: the three still open take three of its five slots.
    const nextMon = openNew(getTodayView(db, at(NEXT_MON, 8)));
    expect(nextMon).toHaveLength(5);
    expect(ids(nextMon.filter((i) => i.carriedOver))).toEqual(fri.slice(2));
  });

  it("a question finished on Sunday gets no weekend review (that week or the next) and is reviewed by spaced repetition instead", () => {
    const db = freshDb();
    newPlan(db);
    const fri = getTodayView(db, at(FRI, 8)).sections.newQuestions;
    expect(fri).toHaveLength(5);
    const onSat = fri[0]!;
    const onSun = fri[1]!;
    getTodayView(db, at(SAT, 8)); // nothing finished yet: no reviews
    solve(db, [onSat], SAT, "failed", 12);
    const sun = getTodayView(db, at(SUN, 8));
    expect(ids(sun.sections.mandatory)).toEqual([onSat.problem.id]); // finished before Sunday → reviewed Sunday
    const sunNew = sun.sections.newQuestions.find((i) => i.problem.id === onSun.problem.id)!;
    solve(db, [sunNew], SUN, "failed", 12); // due Monday
    solve(db, sun.sections.mandatory, SUN, "independent", 13);
    // Re-opening on Sunday (the weekend review re-runs on every load) still leaves it out.
    expect(ids(getTodayView(db, at(SUN, 20)).sections.mandatory)).not.toContain(onSun.problem.id);
    expect(db.select().from(schema.assignments).where(eq(schema.assignments.type, "weekend_review")).all().map((a) => a.problemId)).toEqual([onSat.problem.id]);
    // Monday: a normal spaced-repetition pick, not held back for next weekend's review.
    const mon = getTodayView(db, at(NEXT_MON, 8));
    expect(ids(mon.sections.srs)).toContain(onSun.problem.id);
    // And next weekend's cohort doesn't include it.
    for (let d = 1; d <= 4; d++) getTodayView(db, at(addDays(NEXT_MON, d), 8));
    expect(ids(getTodayView(db, at(addDays(NEXT_MON, 5), 8)).sections.mandatory)).not.toContain(onSun.problem.id);
  });
});

describe("plan options through the daily allocation", () => {
  it("overlap policy include_all assigns already-practised queue questions as new; skip_practiced passes over them", () => {
    const run = (overlapPolicy: "include_all" | "skip_practiced") => {
      const db = freshDb();
      const plan = newPlan(db, { overlapPolicy });
      const q = pendingQueue(db, plan.id).map((x) => x.problemId);
      // Practised after the plan was made (so the daily allocation, not the queue build, decides).
      for (const pid of [q[0]!, q[2]!]) logManualAttempt(db, { problemId: pid, date: addDays(MON, -10), outcome: "independent" }, at(MON, 7, 30));
      const mon = getTodayView(db, at(MON, 8)).sections.newQuestions;
      const status = new Map(getQueue(db, plan.id).map((x) => [x.problemId, x.status]));
      return { db, q, mon, status };
    };
    const all = run("include_all");
    expect(ids(all.mon)).toEqual(all.q.slice(0, 5));
    expect(all.status.get(all.q[0]!)).toBe("assigned");
    const first = all.mon[0]!;
    expect(startSession(all.db, { problemId: first.problem.id, assignmentId: first.assignment.id, origin: "dashboard" }, at(MON, 9)).session.type).toBe("repeat_new");

    const skip = run("skip_practiced");
    expect(ids(skip.mon)).toEqual([skip.q[1]!, skip.q[3]!, skip.q[4]!, skip.q[5]!, skip.q[6]!]);
    expect(skip.status.get(skip.q[0]!)).toBe("skipped_practiced");
    expect(skip.status.get(skip.q[2]!)).toBe("skipped_practiced");
  });

  it("carryOverReducesNew: false — carried-over and rescheduled-in questions don't take today's slots, but the week target still caps", () => {
    const db = freshDb();
    newPlan(db, { carryOverReducesNew: false });
    const mon = getTodayView(db, at(MON, 8)).sections.newQuestions;
    const moved = mon[0]!;
    rescheduleAssignment(db, moved.assignment.id, TUE, at(MON, 9)); // moved in, not done

    const tue = getTodayView(db, at(TUE, 8));
    const tueOpen = openNew(tue);
    // 4 carried from Monday + the moved one + a full 5 of Tuesday's own.
    expect(tueOpen).toHaveLength(10);
    expect(tueOpen.filter((i) => i.carriedOver)).toHaveLength(4);
    expect(tueOpen.filter((i) => i.assignment.originalDate === TUE)).toHaveLength(5);
    expect(tue.weekNew).toMatchObject({ assigned: 10, remaining: 15 });

    // Nothing done all week: every weekday still pulls its 5, and the week stops at 25.
    for (const d of [WED, THU, FRI]) getTodayView(db, at(d, 8));
    const fri = getTodayView(db, at(FRI, 9));
    expect(openNew(fri)).toHaveLength(25);
    expect(fri.weekNew).toMatchObject({ assigned: 25, remaining: 0 });
    expect(getActivePlan(db)!.settings.carryOverReducesNew).toBe(false);
  });
});

describe("duplicate finish: dashboard first, then the extension's session.finish", () => {
  const client = "ext-client";
  let seq = 0;
  const ev = (type: string, payload: unknown, createdAt: number) => ({ id: randomUUID(), clientId: client, seq: seq++, createdAt, type, payload });

  function snapshot(db: Db, pid: number, slug: string, now: number) {
    const d = getProblemDetail(db, slug, now)!;
    return {
      sessions: d.sessions.map(({ id, status, outcome, endedAt, hintsUsed, notes, nextReviewDate }) => ({ id, status, outcome, endedAt, hintsUsed, notes, nextReviewDate })),
      review: d.reviewState,
      assignments: assignmentsOf(db, pid).map(({ id, status, completedAt, completedSessionId }) => ({ id, status, completedAt, completedSessionId })),
      weekNewDone: getTodayView(db, now).progress.weekNewDone,
    };
  }

  it("a late finish for a session the dashboard already finished is rejected and changes nothing (same id, and an aliased id)", () => {
    const db = freshDb();
    newPlan(db);
    const mon = getTodayView(db, at(MON, 8)).sections.newQuestions;

    // 1) Started in the extension, finished in the dashboard.
    const a = mon[0]!;
    const sid = randomUUID();
    const start = processSyncEvents(db, [ev("session.start", { sessionId: sid, problem: { slug: a.problem.slug }, startedAt: at(MON, 10) }, at(MON, 10))]);
    expect(start[0]).toMatchObject({ status: "processed", sessionId: sid });
    finishSession(db, sid, { outcome: "independent", hintsUsed: false, notes: "dashboard" }, at(MON, 10, 20));
    const before = snapshot(db, a.problem.id, a.problem.slug, at(MON, 10, 30));
    expect(before.assignments).toEqual([expect.objectContaining({ status: "completed", completedSessionId: sid })]);
    expect(before.weekNewDone).toBe(1);

    const fin = ev("session.finish", { sessionId: sid, endedAt: at(MON, 10, 25), reflection: { outcome: "failed", hintsUsed: true, notes: "extension" } }, at(MON, 10, 25));
    const r = processSyncEvents(db, [fin]);
    expect(r[0]!.status).toBe("rejected");
    expect(r[0]!.error).toMatch(/not_open/);
    expect(snapshot(db, a.problem.id, a.problem.slug, at(MON, 10, 30))).toEqual(before);
    // A retry of the same event is answered from the log, still without effect.
    expect(processSyncEvents(db, [fin])[0]!.status).toBe("rejected");
    expect(snapshot(db, a.problem.id, a.problem.slug, at(MON, 10, 30))).toEqual(before);

    // 2) Started in the dashboard; the extension's own start was aliased to it.
    const b = mon[1]!;
    const dash = startSession(db, { problemId: b.problem.id, assignmentId: b.assignment.id, origin: "dashboard" }, at(MON, 11)).session;
    const extId = randomUUID();
    expect(processSyncEvents(db, [ev("session.start", { sessionId: extId, problem: { slug: b.problem.slug }, startedAt: at(MON, 11, 1) }, at(MON, 11, 1))])[0]!.sessionId).toBe(dash.id);
    finishSession(db, dash.id, { outcome: "easy", hintsUsed: false }, at(MON, 11, 20));
    const before2 = snapshot(db, b.problem.id, b.problem.slug, at(MON, 11, 30));
    const r2 = processSyncEvents(db, [ev("session.finish", { sessionId: extId, endedAt: at(MON, 11, 25), reflection: { outcome: "failed", hintsUsed: false } }, at(MON, 11, 25))]);
    expect(r2[0]!.status).toBe("rejected");
    expect(snapshot(db, b.problem.id, b.problem.slug, at(MON, 11, 30))).toEqual(before2);
    expect(before2.sessions).toHaveLength(1);
    expect(getTodayView(db, at(MON, 12)).progress.weekNewDone).toBe(2);
  });
});
