import {
  addDays,
  diffDays,
  mondayIndex,
  startOfWeek,
  weekdayOf,
  type AssignmentStatus,
  type AssignmentType,
  type LocalDate,
  type Outcome,
  type PlanSettings,
} from "@lcc/shared";

/**
 * Daily allocation — the heart of the study plan. Pure and idempotent given its
 * inputs; the database layer applies the result in one transaction.
 * The policy is documented in docs/SCHEDULING.md.
 */

export interface OpenAssignment {
  id: number;
  problemId: number;
  type: AssignmentType;
  scheduledDate: LocalDate;
  /** First date it was scheduled for. Defaults to `scheduledDate`. */
  originalDate?: LocalDate;
  status: AssignmentStatus;
}

/** Days that change a date's share of the week's new questions. */
export interface DayAdjustments {
  /** Plan start: days before it have no share. */
  startDate?: LocalDate;
  skipDates?: ReadonlySet<LocalDate>;
  /** Light days: date → new-question count for that day (capped by the day's quota). */
  lightDays?: ReadonlyMap<LocalDate, number>;
}

/** The plan's daily quotas summed over the Monday–Sunday week of `date`, from the plan start. Skips and light days don't lower it. */
export function weeklyNewTarget(settings: PlanSettings, date: LocalDate, startDate?: LocalDate): number {
  const monday = startOfWeek(date);
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(monday, i);
    if (startDate && d < startDate) continue;
    total += settings.newPerWeekday[weekdayOf(d)] ?? 0;
  }
  return total;
}

/** A day's planned share of the week's new questions: 0 on skipped days, the light count on light days. */
export function dayNewShare(settings: PlanSettings, date: LocalDate, adj: DayAdjustments = {}): number {
  if (adj.startDate && date < adj.startDate) return 0;
  if (adj.skipDates?.has(date)) return 0;
  const base = settings.newPerWeekday[weekdayOf(date)] ?? 0;
  const light = adj.lightDays?.get(date);
  return light == null ? base : Math.max(0, Math.min(base, light));
}

/** Sum of the day shares from Monday through `date`. */
export function cumulativeNewShare(settings: PlanSettings, date: LocalDate, adj: DayAdjustments = {}): number {
  const monday = startOfWeek(date);
  let total = 0;
  for (let d = monday; d <= date; d = addDays(d, 1)) total += dayNewShare(settings, d, adj);
  return total;
}

/**
 * How many new questions a day pulls from the queue.
 * - Day cap: the day's share, minus questions already sitting on it (carried over or
 *   rescheduled in, under the "reduce" policy) and questions already added for it.
 * - Week cap: what's left of the week's shares up to this day. Work done ahead
 *   ("Do more today") was assigned on an earlier day, so it uses up the nearest
 *   upcoming days' shares first. Days are never pushed above their share, so a missed
 *   day never turns into debt.
 */
export function newQuestionPull(x: {
  share: number;
  cumShare: number;
  /** This week's new questions first scheduled before this day (not skipped). */
  weekAssignedBefore: number;
  /** New questions first scheduled for this day itself (added by hand, or by an earlier run). */
  ownToday: number;
  /** Open new questions from earlier days now sitting on this day. */
  carriedIn: number;
  carryOverReducesNew: boolean;
}): number {
  const dayCap = x.share - (x.carryOverReducesNew ? x.carriedIn : 0) - x.ownToday;
  const weekCap = x.cumShare - x.weekAssignedBefore - x.ownToday;
  return Math.max(0, Math.min(dayCap, weekCap));
}

export interface DueReview {
  problemId: number;
  nextDueDate: LocalDate;
  intervalDays: number;
  lapses: number;
  lastOutcome: Outcome | null;
  /** Local date of the first completed session for this problem. */
  firstPracticedDate: LocalDate | null;
}

export interface PlanDayInput {
  today: LocalDate;
  plan: { status: "active" | "paused" | "archived"; startDate: LocalDate; settings: PlanSettings };
  isSkipped: boolean;
  /** Whether today's new-question / SRS allocation already ran (per plan, per date). */
  allocated: { newQuestions: boolean; srs: boolean };
  /** Pending plan-queue items, in queue order. `force` = explicitly added as new (bypasses overlap policy). */
  queue: { problemId: number; force?: boolean }[];
  /** Problems with at least one completed session (for the overlap policy). */
  practicedProblemIds: ReadonlySet<number>;
  /** All open (pending / in_progress) assignments of any date. */
  openAssignments: OpenAssignment[];
  /** Problems that already got a weekend_review assignment for this week's cohort (any status). */
  weekReviewAssigned: ReadonlySet<number>;
  /** New-question assignments completed this week before today, in completion order. */
  cohort: { problemId: number; completedDate: LocalDate }[];
  /** Problems whose SRS due date ≤ today. */
  dueReviews: DueReview[];
  /**
   * Weekly-target accounting. Omitted = plain daily quota (no week cap).
   * `cumShare` is the sum of this week's day shares through today.
   */
  week?: { cumShare: number; assignedBefore: number; ownToday: number };
  /** Today is a light day: this many new questions (capped by the quota) and no automatic SRS picks. */
  lightNewQuota?: number | null;
}

export interface PlanDayResult {
  createNew: number[];
  createWeekendReview: number[];
  createSrs: number[];
  expireSrsIds: number[];
  /** Queue items to mark as already practiced (overlap policy). */
  skipPracticedQueue: number[];
  markAllocated: { newQuestions: boolean; srs: boolean };
}

export function isReviewDay(settings: PlanSettings, d: LocalDate): boolean {
  return settings.reviewDays.some((r) => r.weekday === weekdayOf(d));
}

/** Cumulative mandatory-review target for the week up to and including `today`. Infinity = "rest". */
export function weekendReviewTarget(settings: PlanSettings, today: LocalDate): number {
  const idx = mondayIndex(today);
  let total = 0;
  for (const r of settings.reviewDays) {
    const rIdx = (r.weekday + 6) % 7;
    if (rIdx <= idx) total += r.quota == null ? Number.POSITIVE_INFINITY : r.quota;
  }
  return total;
}

/** Whether a mandatory review day for the current week is still ahead of (or is) `today`. */
export function hasUpcomingReviewDay(settings: PlanSettings, today: LocalDate): boolean {
  const idx = mondayIndex(today);
  return settings.reviewDays.some((r) => (r.weekday + 6) % 7 >= idx);
}

export function srsPriority(r: DueReview, today: LocalDate): number {
  const overdue = Math.max(0, diffDays(r.nextDueDate, today));
  const weak = r.lastOutcome === "failed" || r.lastOutcome === "hints" ? 1 : r.lastOutcome === "struggled" ? 0.5 : 0;
  return overdue / Math.max(1, r.intervalDays) + weak + r.lapses * 0.25;
}

export function rankDueReviews(due: DueReview[], today: LocalDate): DueReview[] {
  return [...due].sort(
    (a, b) =>
      srsPriority(b, today) - srsPriority(a, today) ||
      (a.nextDueDate < b.nextDueDate ? -1 : a.nextDueDate > b.nextDueDate ? 1 : 0) ||
      a.problemId - b.problemId,
  );
}

export function planDay(input: PlanDayInput): PlanDayResult {
  const { today, plan } = input;
  const s = plan.settings;
  const result: PlanDayResult = {
    createNew: [],
    createWeekendReview: [],
    createSrs: [],
    expireSrsIds: [],
    skipPracticedQueue: [],
    markAllocated: { newQuestions: false, srs: false },
  };

  // Daily SRS picks that weren't done expire; the problem stays due and is re-ranked.
  for (const a of input.openAssignments) {
    if (a.type === "srs_review" && a.status === "pending" && a.scheduledDate < today) result.expireSrsIds.push(a.id);
  }
  if (plan.status !== "active" || today < plan.startDate) return result;

  const expired = new Set(result.expireSrsIds);
  const openByProblem = new Set(input.openAssignments.filter((a) => !expired.has(a.id)).map((a) => a.problemId));
  const claim = (pid: number) => openByProblem.add(pid);

  // 1. Mandatory cohort review (fixed). Idempotent via the cumulative target.
  if (isReviewDay(s, today)) {
    const target = weekendReviewTarget(s, today);
    const already = input.weekReviewAssigned.size;
    const available = input.cohort
      .filter((c) => !input.weekReviewAssigned.has(c.problemId))
      .filter((c, i, arr) => arr.findIndex((x) => x.problemId === c.problemId) === i);
    const n = Math.max(0, Math.min(available.length, target - already));
    for (const c of available.slice(0, n)) {
      if (openByProblem.has(c.problemId)) continue; // already on the list (e.g. carried over) — no duplicate
      result.createWeekendReview.push(c.problemId);
      claim(c.problemId);
    }
  }

  // 2. New questions, once per day.
  if (!input.allocated.newQuestions && !input.isSkipped) {
    const quota = s.newPerWeekday[weekdayOf(today)] ?? 0;
    const share = input.lightNewQuota == null ? quota : Math.max(0, Math.min(quota, input.lightNewQuota));
    // Carried over from earlier days, or rescheduled into today from an earlier date.
    const carried = input.openAssignments.filter(
      (a) => a.type === "new" && (a.scheduledDate < today || (a.scheduledDate === today && (a.originalDate ?? a.scheduledDate) < today)),
    ).length;
    const pull = newQuestionPull({
      share,
      cumShare: input.week?.cumShare ?? Number.POSITIVE_INFINITY,
      weekAssignedBefore: input.week?.assignedBefore ?? 0,
      ownToday: input.week?.ownToday ?? 0,
      carriedIn: carried,
      carryOverReducesNew: s.carryOverReducesNew,
    });
    for (const q of input.queue) {
      if (result.createNew.length >= pull) break;
      if (openByProblem.has(q.problemId)) continue;
      if (!q.force && s.overlapPolicy === "skip_practiced" && input.practicedProblemIds.has(q.problemId)) {
        result.skipPracticedQueue.push(q.problemId);
        continue;
      }
      result.createNew.push(q.problemId);
      claim(q.problemId);
    }
    result.markAllocated.newQuestions = true;
  }

  // 3. Adaptive SRS reviews, once per day, capped.
  if (!input.allocated.srs) {
    const weekStart = startOfWeek(today);
    const upcomingMandatory = hasUpcomingReviewDay(s, today);
    // A light day picks no reviews: they stay due (and show as overdue tomorrow), nothing is postponed.
    const cap = input.lightNewQuota != null ? 0 : isReviewDay(s, today) ? s.srsReviewDayCap : s.srsDailyCap;
    const candidates = input.dueReviews.filter((r) => {
      if (r.nextDueDate > today) return false;
      if (openByProblem.has(r.problemId)) return false;
      // This week's cohort is covered by the upcoming mandatory review — don't double-book it.
      if (upcomingMandatory && r.firstPracticedDate && r.firstPracticedDate >= weekStart) return false;
      return true;
    });
    for (const r of rankDueReviews(candidates, today).slice(0, cap)) {
      result.createSrs.push(r.problemId);
      claim(r.problemId);
    }
    result.markAllocated.srs = true;
  }
  return result;
}

export function studyWeekNumber(startDate: LocalDate, today: LocalDate): number {
  return Math.floor(diffDays(startOfWeek(startDate), startOfWeek(today)) / 7) + 1;
}

export interface ForecastDay {
  date: LocalDate;
  newProblemIds: number[];
  mandatoryReviews: number;
  skipped: boolean;
  /** Light day: its new-question count, otherwise null. */
  lightNew: number | null;
}

/**
 * Projection of upcoming days (not persisted). Assumes each day's pull is fully
 * consumed and every new question gets its mandatory review. Uses the same
 * weekly-target rule as `planDay`, so work done ahead shows up as lighter days.
 */
export function forecast(opts: {
  from: LocalDate;
  days: number;
  settings: PlanSettings;
  queue: number[];
  skipDates: ReadonlySet<LocalDate>;
  lightDays?: ReadonlyMap<LocalDate, number>;
  startDate?: LocalDate;
  /** New questions already completed this week (cohort size so far). */
  cohortSoFar: number;
  /** Mandatory reviews already assigned this week. */
  reviewsAssignedThisWeek: number;
  /** New questions first scheduled in `from`'s week before `from` (not skipped). Omitted = no week cap. */
  weekAssignedBefore?: number;
  /** Persisted future new questions per date: first scheduled for that day (`own`) or moved there from an earlier day (`inbound`). */
  persisted?: ReadonlyMap<LocalDate, { own: number; inbound: number }>;
}): ForecastDay[] {
  const out: ForecastDay[] = [];
  const adj: DayAdjustments = { startDate: opts.startDate, skipDates: opts.skipDates, lightDays: opts.lightDays };
  const weekCapped = opts.weekAssignedBefore != null;
  let qi = 0;
  let cohort = opts.cohortSoFar;
  let reviewed = opts.reviewsAssignedThisWeek;
  let assigned = opts.weekAssignedBefore ?? 0;
  for (let i = 0; i < opts.days; i++) {
    const date = addDays(opts.from, i);
    if (mondayIndex(date) === 0 && i > 0) {
      cohort = 0;
      reviewed = 0;
      assigned = 0;
    }
    const skipped = opts.skipDates.has(date);
    let mandatory = 0;
    if (isReviewDay(opts.settings, date)) {
      const target = weekendReviewTarget(opts.settings, date);
      mandatory = Math.max(0, Math.min(cohort, target) - reviewed);
      reviewed += mandatory;
    }
    const p = opts.persisted?.get(date) ?? { own: 0, inbound: 0 };
    const pull = skipped
      ? 0
      : newQuestionPull({
          share: dayNewShare(opts.settings, date, adj),
          cumShare: weekCapped ? cumulativeNewShare(opts.settings, date, adj) : Number.POSITIVE_INFINITY,
          weekAssignedBefore: assigned,
          ownToday: p.own,
          carriedIn: p.inbound,
          carryOverReducesNew: opts.settings.carryOverReducesNew,
        });
    const ids = opts.queue.slice(qi, qi + pull);
    qi += ids.length;
    cohort += ids.length;
    assigned += ids.length + p.own;
    const light = opts.lightDays?.get(date);
    out.push({ date, newProblemIds: ids, mandatoryReviews: mandatory, skipped, lightNew: light == null ? null : light });
  }
  return out;
}
