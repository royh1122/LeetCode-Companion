import { and, asc, eq, gte, inArray, isNotNull, lt, lte, max, ne, sql } from "drizzle-orm";
import { forecast, isReviewDay, planDay, rankDueReviews, srsPriority, studyWeekNumber, type DueReview } from "@lcc/scheduler";
import {
  addDays,
  diffDays,
  startOfWeek,
  toLocalDate,
  weekdayOf,
  type AssignmentType,
  type LocalDate,
} from "@lcc/shared";
import type { Db } from "./client";
import { bumpRevision, getAppSettings } from "./meta";
import { getActivePlan, getSkipDates, pendingQueue, practicedProblemIds, type ParsedPlan } from "./plans";
import { emptyStats, getProblemStats } from "./problems";
import { assignments, dailySnapshots, planDays, planQueue, planSkips, problems, reviewState, sessions, type Assignment, type Problem } from "./schema";
import { DomainError, listOpenSessions } from "./sessions";

export function todayFor(db: Db, now = Date.now()): LocalDate {
  return toLocalDate(now, getAppSettings(db).timeZone);
}

function nextPosition(db: Db, date: LocalDate, type: AssignmentType) {
  return (
    (db
      .select({ m: max(assignments.position) })
      .from(assignments)
      .where(and(eq(assignments.scheduledDate, date), eq(assignments.type, type)))
      .get()?.m ?? -1) + 1
  );
}

function dueReviewsAsOf(db: Db, today: LocalDate): DueReview[] {
  return db
    .select()
    .from(reviewState)
    .where(and(isNotNull(reviewState.nextDueDate), lte(reviewState.nextDueDate, today)))
    .all()
    .map((r) => ({
      problemId: r.problemId,
      nextDueDate: r.nextDueDate!,
      intervalDays: r.intervalDays,
      lapses: r.lapses,
      lastOutcome: r.lastOutcome,
      firstPracticedDate: r.firstPracticedDate,
    }));
}

/**
 * Idempotent daily materialization for the active plan. Safe to call on every
 * page load: allocation for a given day runs once (plan_days), weekend reviews
 * use a cumulative target, and unique indexes back up the no-duplicates rule.
 */
export function ensureSchedule(db: Db, now = Date.now()): { changed: boolean; today: LocalDate } {
  const settings = getAppSettings(db);
  const today = toLocalDate(now, settings.timeZone);
  const plan = getActivePlan(db);
  let changed = false;
  db.transaction((tx) => {
    const open = tx
      .select()
      .from(assignments)
      .where(inArray(assignments.status, ["pending", "in_progress"]))
      .all();
    if (!plan) {
      // Without a plan, still expire stale daily SRS picks.
      for (const a of open) {
        if (a.type === "srs_review" && a.status === "pending" && a.scheduledDate < today) {
          tx.update(assignments).set({ status: "expired", updatedAt: Date.now() }).where(eq(assignments.id, a.id)).run();
          changed = true;
        }
      }
      return;
    }
    const day = tx.select().from(planDays).where(and(eq(planDays.planId, plan.id), eq(planDays.date, today))).get();
    const weekStart = startOfWeek(today);
    const weekReviewAssigned = new Set(
      tx
        .select({ pid: assignments.problemId })
        .from(assignments)
        .where(and(eq(assignments.type, "weekend_review"), eq(assignments.cohortWeek, weekStart)))
        .all()
        .map((r) => r.pid),
    );
    const cohort = tx
      .select({ problemId: assignments.problemId, completedDate: assignments.completedDate })
      .from(assignments)
      .where(
        and(
          eq(assignments.type, "new"),
          eq(assignments.status, "completed"),
          gte(assignments.completedDate, weekStart),
          lt(assignments.completedDate, today),
        ),
      )
      .orderBy(asc(assignments.completedAt))
      .all()
      .map((r) => ({ problemId: r.problemId, completedDate: r.completedDate! }));
    const result = planDay({
      today,
      plan: { status: plan.status as "active" | "paused" | "archived", startDate: plan.startDate, settings: plan.settings },
      isSkipped: getSkipDates(tx, plan.id).has(today),
      allocated: { newQuestions: day?.newAllocatedAt != null, srs: day?.srsAllocatedAt != null },
      queue: pendingQueue(tx, plan.id),
      practicedProblemIds: practicedProblemIds(tx),
      openAssignments: open.map((a) => ({ id: a.id, problemId: a.problemId, type: a.type, scheduledDate: a.scheduledDate, status: a.status })),
      weekReviewAssigned,
      cohort,
      dueReviews: dueReviewsAsOf(tx, today),
    });

    const ts = Date.now();
    for (const id of result.expireSrsIds) {
      tx.update(assignments).set({ status: "expired", note: "Not done that day — still due", updatedAt: ts }).where(eq(assignments.id, id)).run();
    }
    for (const pid of result.skipPracticedQueue) {
      tx.update(planQueue)
        .set({ status: "skipped_practiced", updatedAt: ts })
        .where(and(eq(planQueue.planId, plan.id), eq(planQueue.problemId, pid)))
        .run();
    }
    const create = (pids: number[], type: AssignmentType, cohortWeek: string | null, note: string | null) => {
      let pos = nextPosition(tx, today, type);
      for (const pid of pids) {
        tx.insert(assignments)
          .values({ planId: plan.id, problemId: pid, type, scheduledDate: today, originalDate: today, cohortWeek, position: pos++, note })
          .run();
      }
    };
    create(result.createWeekendReview, "weekend_review", weekStart, null);
    create(result.createNew, "new", weekStart, null);
    create(result.createSrs, "srs_review", null, null);
    for (const pid of result.createNew) {
      tx.update(planQueue)
        .set({ status: "assigned", updatedAt: ts })
        .where(and(eq(planQueue.planId, plan.id), eq(planQueue.problemId, pid)))
        .run();
    }
    if (result.markAllocated.newQuestions || result.markAllocated.srs) {
      tx.insert(planDays)
        .values({
          planId: plan.id,
          date: today,
          newAllocatedAt: result.markAllocated.newQuestions ? ts : null,
          srsAllocatedAt: result.markAllocated.srs ? ts : null,
        })
        .onConflictDoUpdate({
          target: [planDays.planId, planDays.date],
          set: {
            ...(result.markAllocated.newQuestions ? { newAllocatedAt: ts } : {}),
            ...(result.markAllocated.srs ? { srsAllocatedAt: ts } : {}),
          },
        })
        .run();
    }
    changed =
      result.expireSrsIds.length + result.skipPracticedQueue.length + result.createNew.length + result.createSrs.length + result.createWeekendReview.length > 0;
  });
  writeDailySnapshot(db, today, now);
  if (changed) bumpRevision(db);
  return { changed, today };
}

function writeDailySnapshot(db: Db, today: LocalDate, now: number) {
  const exists = db.select({ d: dailySnapshots.date }).from(dailySnapshots).where(eq(dailySnapshots.date, today)).get();
  if (exists) return;
  const settings = getAppSettings(db);
  const due = db
    .select({ d: reviewState.nextDueDate })
    .from(reviewState)
    .where(and(isNotNull(reviewState.nextDueDate), lte(reviewState.nextDueDate, today)))
    .all();
  const overdue = due.filter((r) => r.d! < today).length;
  const stats = getProblemStats(db, settings, undefined, now);
  const mastery: Record<string, number> = {};
  for (const s of stats.values()) if (s.completedCount > 0) mastery[s.mastery] = (mastery[s.mastery] ?? 0) + 1;
  db.insert(dailySnapshots).values({ date: today, dueCount: due.length, overdueCount: overdue, mastery }).onConflictDoNothing().run();
}

export interface TodayItem {
  assignment: Assignment;
  problem: Problem;
  stats: ReturnType<typeof emptyStats>;
  openSessionId: string | null;
  carriedOver: boolean;
  daysOverdue: number;
  urgency: "mandatory" | "overdue" | "due" | null;
}

export function getTodayView(db: Db, now = Date.now()) {
  const { today } = ensureSchedule(db, now);
  const settings = getAppSettings(db);
  const plan = getActivePlan(db);
  const rows = db
    .select({ a: assignments, p: problems })
    .from(assignments)
    .innerJoin(problems, eq(problems.id, assignments.problemId))
    .where(
      sql`(${assignments.scheduledDate} = ${today}) or (${assignments.scheduledDate} < ${today} and ${assignments.status} in ('pending','in_progress'))`,
    )
    .orderBy(asc(assignments.scheduledDate), asc(assignments.position))
    .all()
    .filter((r) => !(r.a.status === "expired" || r.a.status === "cancelled"));
  const openSessions = listOpenSessions(db);
  const openByProblem = new Map(openSessions.map((s) => [s.problemId, s.id]));
  const stats = getProblemStats(db, settings, rows.map((r) => r.p.id), now);
  const due = new Map(db.select().from(reviewState).all().map((r) => [r.problemId, r]));

  const items: TodayItem[] = rows.map(({ a, p }) => {
    const rs = due.get(p.id);
    const overdueDays = rs?.nextDueDate ? Math.max(0, diffDays(rs.nextDueDate, today)) : 0;
    return {
      assignment: a,
      problem: p,
      stats: stats.get(p.id) ?? emptyStats(),
      openSessionId: openByProblem.get(p.id) ?? null,
      carriedOver: a.scheduledDate < today,
      daysOverdue: a.type === "srs_review" ? overdueDays : a.scheduledDate < today ? diffDays(a.scheduledDate, today) : 0,
      urgency: a.type === "weekend_review" ? "mandatory" : a.type === "srs_review" ? (overdueDays > 0 ? "overdue" : "due") : null,
    };
  });
  const sections = {
    newQuestions: items.filter((i) => i.assignment.type === "new" || i.assignment.type === "manual"),
    mandatory: items.filter((i) => i.assignment.type === "weekend_review"),
    srs: items.filter((i) => i.assignment.type === "srs_review"),
  };
  const done = (xs: TodayItem[]) => xs.filter((i) => i.assignment.status === "completed").length;
  const todayItems = items.filter((i) => !["skipped", "postponed"].includes(i.assignment.status));

  // Weekly progress: new questions completed this week vs. weekly quota; reviews done vs. assigned.
  const weekStart = startOfWeek(today);
  const weekEnd = addDays(weekStart, 6);
  const weekAssignments = db
    .select({ type: assignments.type, status: assignments.status })
    .from(assignments)
    .where(and(gte(assignments.scheduledDate, weekStart), lte(assignments.scheduledDate, weekEnd), ne(assignments.status, "expired")))
    .all();
  const weekNewDone = db
    .select({ c: sql<number>`count(*)` })
    .from(assignments)
    .where(and(eq(assignments.type, "new"), eq(assignments.status, "completed"), gte(assignments.completedDate, weekStart), lte(assignments.completedDate, weekEnd)))
    .get()?.c ?? 0;
  const weeklyNewQuota = plan ? plan.settings.newPerWeekday.reduce((a, b) => a + b, 0) : 0;
  const weekReviews = weekAssignments.filter((a) => a.type === "weekend_review" || a.type === "srs_review");

  const backlog = db
    .select({ c: sql<number>`count(*)` })
    .from(reviewState)
    .where(and(isNotNull(reviewState.nextDueDate), lte(reviewState.nextDueDate, today)))
    .get()?.c ?? 0;
  const overdue = db
    .select({ c: sql<number>`count(*)` })
    .from(reviewState)
    .where(and(isNotNull(reviewState.nextDueDate), lt(reviewState.nextDueDate, today)))
    .get()?.c ?? 0;
  const staleMs = settings.staleSessionHours * 3_600_000;
  const interrupted = openSessions.filter((s) => now - (s.lastActivityAt ?? s.startedAt) > staleMs);
  const isSkipped = plan ? getSkipDates(db, plan.id).has(today) : false;

  return {
    today,
    timeZone: settings.timeZone,
    plan,
    weekNumber: plan ? studyWeekNumber(plan.startDate, today) : null,
    isReviewDay: plan ? isReviewDay(plan.settings, today) : false,
    isSkipped,
    notStartedYet: plan ? today < plan.startDate : false,
    sections,
    progress: {
      todayDone: done(todayItems),
      todayTotal: todayItems.length,
      weekNewDone,
      weeklyNewQuota,
      weekReviewsDone: weekReviews.filter((a) => a.status === "completed").length,
      weekReviewsTotal: weekReviews.length,
    },
    backlog: { due: backlog, overdue },
    openSessions,
    interrupted,
  };
}

/** Move an assignment to another date. New questions keep their queue identity. */
export function rescheduleAssignment(db: Db, id: number, to: LocalDate, now = Date.now()) {
  db.transaction((tx) => {
    const a = tx.select().from(assignments).where(eq(assignments.id, id)).get();
    if (!a) throw new DomainError("not_found", "Assignment not found");
    if (!["pending", "in_progress"].includes(a.status)) throw new DomainError("not_open", "Only open assignments can be rescheduled");
    const today = todayFor(tx, now);
    if (a.type === "srs_review") {
      // An SRS pick is just "due"; postponing moves the due date and frees today's slot.
      tx.update(reviewState).set({ nextDueDate: to, postponedTo: to, updatedAt: Date.now() }).where(eq(reviewState.problemId, a.problemId)).run();
      tx.update(assignments).set({ status: "postponed", note: `Postponed to ${to}`, updatedAt: Date.now() }).where(eq(assignments.id, id)).run();
      if (to <= today) {
        tx.insert(assignments)
          .values({ planId: a.planId, problemId: a.problemId, type: "srs_review", scheduledDate: to, originalDate: a.originalDate, position: nextPosition(tx, to, "srs_review") })
          .run();
      }
    } else {
      tx.update(assignments)
        .set({ scheduledDate: to, note: `Rescheduled from ${a.scheduledDate}`, position: nextPosition(tx, to, a.type), updatedAt: Date.now() })
        .where(eq(assignments.id, id))
        .run();
    }
    bumpRevision(tx);
  });
}

/** Skip one assignment. A skipped new question returns to its place in the queue. */
export function skipAssignment(db: Db, id: number) {
  db.transaction((tx) => {
    const a = tx.select().from(assignments).where(eq(assignments.id, id)).get();
    if (!a || a.status !== "pending") throw new DomainError("not_open", "Only pending assignments can be skipped");
    tx.update(assignments).set({ status: "skipped", updatedAt: Date.now() }).where(eq(assignments.id, id)).run();
    if (a.type === "new" && a.planId != null) {
      tx.update(planQueue)
        .set({ status: "pending", updatedAt: Date.now() })
        .where(and(eq(planQueue.planId, a.planId), eq(planQueue.problemId, a.problemId)))
        .run();
    }
    bumpRevision(tx);
  });
}

/**
 * Add a problem to a day by hand. `asNew` = practice it as a new question
 * (also used for "restart this problem" — history is never deleted).
 */
export function addAssignment(db: Db, problemId: number, date: LocalDate, opts: { asNew?: boolean; note?: string } = {}) {
  const plan = getActivePlan(db);
  const type: AssignmentType = opts.asNew ? "new" : "manual";
  return db.transaction((tx) => {
    const open = tx
      .select()
      .from(assignments)
      .where(and(eq(assignments.problemId, problemId), inArray(assignments.status, ["pending", "in_progress"])))
      .all();
    const dup = open.find((a) => a.type === type || a.scheduledDate === date);
    if (dup) throw new DomainError("duplicate", `Already scheduled for ${dup.scheduledDate}`);
    const row = tx
      .insert(assignments)
      .values({
        planId: plan?.id ?? null,
        problemId,
        type,
        scheduledDate: date,
        originalDate: date,
        cohortWeek: startOfWeek(date),
        position: nextPosition(tx, date, type),
        note: opts.note ?? (opts.asNew ? "Added as new" : "Added manually"),
      })
      .returning()
      .get();
    if (plan && opts.asNew) {
      tx.update(planQueue)
        .set({ status: "assigned", updatedAt: Date.now() })
        .where(and(eq(planQueue.planId, plan.id), eq(planQueue.problemId, problemId)))
        .run();
    }
    bumpRevision(tx);
    return row;
  });
}

/** The full due-review backlog, ranked (weakest + most overdue first). */
export function getReviewQueue(db: Db, now = Date.now()) {
  const settings = getAppSettings(db);
  const today = toLocalDate(now, settings.timeZone);
  const all = db.select().from(reviewState).where(isNotNull(reviewState.nextDueDate)).all();
  const due: DueReview[] = all
    .filter((r) => r.nextDueDate! <= addDays(today, 14))
    .map((r) => ({
      problemId: r.problemId,
      nextDueDate: r.nextDueDate!,
      intervalDays: r.intervalDays,
      lapses: r.lapses,
      lastOutcome: r.lastOutcome,
      firstPracticedDate: r.firstPracticedDate,
    }));
  const ids = due.map((d) => d.problemId);
  const probs = new Map(
    db
      .select()
      .from(problems)
      .where(inArray(problems.id, ids.length ? ids : [-1]))
      .all()
      .map((p) => [p.id, p]),
  );
  const stats = getProblemStats(db, settings, ids, now);
  const openAssign = new Map(
    db
      .select()
      .from(assignments)
      .where(and(inArray(assignments.status, ["pending", "in_progress"]), inArray(assignments.problemId, ids.length ? ids : [-1])))
      .all()
      .map((a) => [a.problemId, a]),
  );
  const rank = (xs: DueReview[]) =>
    rankDueReviews(xs, today).map((d) => ({
      due: d,
      priority: srsPriority(d, today),
      daysOverdue: Math.max(0, diffDays(d.nextDueDate, today)),
      problem: probs.get(d.problemId)!,
      stats: stats.get(d.problemId) ?? emptyStats(),
      openAssignment: openAssign.get(d.problemId) ?? null,
    }));
  return {
    today,
    dueNow: rank(due.filter((d) => d.nextDueDate <= today)),
    upcoming: due
      .filter((d) => d.nextDueDate > today)
      .sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate))
      .map((d) => ({ due: d, problem: probs.get(d.problemId)!, stats: stats.get(d.problemId) ?? emptyStats() })),
  };
}

/** Pull extra SRS reviews into today beyond the daily cap. */
export function pullMoreReviews(db: Db, n: number, now = Date.now()) {
  const q = getReviewQueue(db, now);
  const plan = getActivePlan(db);
  const picks = q.dueNow.filter((r) => !r.openAssignment).slice(0, Math.max(0, n));
  db.transaction((tx) => {
    let pos = nextPosition(tx, q.today, "srs_review");
    for (const p of picks) {
      tx.insert(assignments)
        .values({ planId: plan?.id ?? null, problemId: p.problem.id, type: "srs_review", scheduledDate: q.today, originalDate: q.today, position: pos++, note: "Pulled from backlog" })
        .run();
    }
    bumpRevision(tx);
  });
  return picks.length;
}

/** Upcoming days: persisted future assignments + a projection from the queue. */
export function getUpcoming(db: Db, days = 14, now = Date.now()) {
  const settings = getAppSettings(db);
  const today = toLocalDate(now, settings.timeZone);
  const plan = getActivePlan(db);
  const future = db
    .select({ a: assignments, p: problems })
    .from(assignments)
    .innerJoin(problems, eq(problems.id, assignments.problemId))
    .where(and(gte(assignments.scheduledDate, addDays(today, 1)), inArray(assignments.status, ["pending"])))
    .orderBy(asc(assignments.scheduledDate))
    .all();
  if (!plan) return { today, days: [], future };
  const weekStart = startOfWeek(today);
  const cohortSoFar =
    db
      .select({ c: sql<number>`count(*)` })
      .from(assignments)
      .where(and(eq(assignments.type, "new"), gte(assignments.scheduledDate, weekStart), ne(assignments.status, "skipped"), ne(assignments.status, "cancelled")))
      .get()?.c ?? 0;
  const reviewsAssigned =
    db
      .select({ c: sql<number>`count(*)` })
      .from(assignments)
      .where(and(eq(assignments.type, "weekend_review"), eq(assignments.cohortWeek, weekStart)))
      .get()?.c ?? 0;
  const queue = pendingQueue(db, plan.id).map((q) => q.problemId);
  const practiced = practicedProblemIds(db);
  const effectiveQueue =
    plan.settings.overlapPolicy === "skip_practiced"
      ? pendingQueue(db, plan.id)
          .filter((q) => q.force || !practiced.has(q.problemId))
          .map((q) => q.problemId)
      : queue;
  const startFrom = addDays(today, 1);
  const fc = plan.status === "active" ? forecast({
    from: startFrom,
    days,
    settings: plan.settings,
    queue: effectiveQueue,
    skipDates: getSkipDates(db, plan.id),
    cohortSoFar: weekdayOf(startFrom) === 1 ? 0 : cohortSoFar,
    reviewsAssignedThisWeek: weekdayOf(startFrom) === 1 ? 0 : reviewsAssigned,
  }) : [];
  const ids = [...new Set(fc.flatMap((d) => d.newProblemIds))];
  const probs = new Map(
    db
      .select()
      .from(problems)
      .where(inArray(problems.id, ids.length ? ids : [-1]))
      .all()
      .map((p) => [p.id, p]),
  );
  const dueByDate = new Map<string, number>();
  for (const r of db.select({ d: reviewState.nextDueDate }).from(reviewState).where(isNotNull(reviewState.nextDueDate)).all()) {
    if (r.d! > today) dueByDate.set(r.d!, (dueByDate.get(r.d!) ?? 0) + 1);
  }
  return {
    today,
    future,
    days: fc.map((d) => ({
      ...d,
      newProblems: d.newProblemIds.map((id) => probs.get(id)!).filter(Boolean),
      srsDue: dueByDate.get(d.date) ?? 0,
    })),
  };
}

export function listSkipDates(db: Db, plan: ParsedPlan) {
  return db.select().from(planSkips).where(eq(planSkips.planId, plan.id)).orderBy(asc(planSkips.date)).all();
}
