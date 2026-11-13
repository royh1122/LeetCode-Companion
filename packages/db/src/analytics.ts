import { asc, eq } from "drizzle-orm";
import { weeklyNewTarget } from "@lcc/scheduler";
import { addDays, effectiveDuration, isIndependentOutcome, isSuccessOutcome, startOfWeek, toLocalDate, type LocalDate } from "@lcc/shared";
import type { Db } from "./client";
import { getAppSettings } from "./meta";
import { getActivePlan } from "./plans";
import { getProblemStats } from "./problems";
import { assignments, dailySnapshots, problems, reviewState, sessions, submissions } from "./schema";

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/**
 * Metrics are explicitly split into unique-problem metrics and session-level
 * metrics. Topic rule: a problem with several patterns counts once toward
 * *each* of its patterns (so topic rows can sum to more than the total).
 */
export function getAnalytics(db: Db, opts: { groupBy?: "pattern" | "tag"; weeks?: number } = {}, now = Date.now()) {
  const settings = getAppSettings(db);
  const today = toLocalDate(now, settings.timeZone);
  const allSessions = db.select().from(sessions).orderBy(asc(sessions.startedAt)).all();
  const completed = allSessions.filter((s) => s.status === "completed" && s.outcome);
  const subs = db.select({ verdict: submissions.verdict, kind: submissions.kind, sessionId: submissions.sessionId, submittedAt: submissions.submittedAt }).from(submissions).all();
  const officialSubs = subs.filter((s) => s.kind === "submit" && s.verdict !== "Pending");
  const probs = db.select().from(problems).all();
  const stats = getProblemStats(db, settings, undefined, now);
  const rs = db.select().from(reviewState).all();

  const practiced = new Set(completed.map((s) => s.problemId));
  const solvedOnce = new Set(completed.filter((s) => isSuccessOutcome(s.outcome)).map((s) => s.problemId));
  const independentOnce = new Set(completed.filter((s) => isIndependentOutcome(s.outcome)).map((s) => s.problemId));
  const masteryCounts: Record<string, number> = { not_started: 0, learning: 0, needs_review: 0, improving: 0, mastered: 0 };
  for (const p of probs) masteryCounts[stats.get(p.id)?.mastery ?? "not_started"]!++;

  const durations = completed.map((s) => effectiveDuration(s, now).ms).filter((d) => d > 0);
  const firstAttempts = completed.filter((s) => s.type === "first_attempt" || s.type === "repeat_new");
  const reviews = completed.filter((s) => s.type === "weekend_review" || s.type === "srs_review" || s.type === "free_practice");
  const accepted = officialSubs.filter((s) => s.verdict === "Accepted").length;
  const overdue = rs.filter((r) => r.nextDueDate && r.nextDueDate < today).length;
  const dueNow = rs.filter((r) => r.nextDueDate && r.nextDueDate <= today).length;

  // Weekly adherence: completed vs assigned (new + mandatory) per week.
  const allAssign = db.select().from(assignments).all();
  // Weekly new-question target (current plan's quotas, from its start week). Adherence alone
  // can't show a missed day, because nothing was assigned for it; this can.
  const plan = getActivePlan(db);

  const unique = {
    encountered: practiced.size,
    solvedAtLeastOnce: solvedOnce.size,
    solvedIndependently: independentOnce.size,
    mastered: masteryCounts.mastered!,
    totalProblems: probs.length,
  };
  const sessionLevel = {
    sessions: completed.length,
    abandoned: allSessions.filter((s) => s.status === "abandoned").length,
    firstAttempts: firstAttempts.length,
    reviewsCompleted: reviews.length,
    submissions: officialSubs.length,
    runs: subs.filter((s) => s.kind === "run").length,
    acceptanceRate: officialSubs.length ? accepted / officialSubs.length : null,
    independentRate: completed.length ? completed.filter((s) => isIndependentOutcome(s.outcome)).length / completed.length : null,
    hintRate: completed.length ? completed.filter((s) => s.hintsUsed || s.outcome === "hints").length / completed.length : null,
    avgDurationMs: mean(durations),
    medianDurationMs: median(durations),
    overdueReviews: overdue,
    dueReviews: dueNow,
  };

  // ---- Weekly series ----
  const weeks = opts.weeks ?? 12;
  const thisWeek = startOfWeek(today);
  const weekKeys: LocalDate[] = [];
  for (let i = weeks - 1; i >= 0; i--) weekKeys.push(addDays(thisWeek, -7 * i));
  const wk = (d: LocalDate | null) => (d ? startOfWeek(d) : null);
  const weekly = weekKeys.map((w) => {
    const inWeek = completed.filter((s) => wk(s.endedDate) === w);
    const firsts = inWeek.filter((s) => s.type === "first_attempt" || s.type === "repeat_new");
    const revs = inWeek.filter((s) => s.type !== "first_attempt" && s.type !== "repeat_new");
    const activeMs = inWeek.reduce((a, s) => a + effectiveDuration(s, now).ms, 0);
    const assigned = allAssign.filter((a) => wk(a.scheduledDate) === w && a.scheduledDate < today && (a.type === "new" || a.type === "weekend_review") && !["skipped", "cancelled", "expired", "postponed"].includes(a.status));
    const done = assigned.filter((a) => a.status === "completed").length;
    const newDone = allAssign.filter((a) => a.type === "new" && a.status === "completed" && wk(a.completedDate) === w).length;
    const newTarget = plan && addDays(w, 6) >= plan.startDate ? weeklyNewTarget(plan.settings, w, plan.startDate) : null;
    const firstAcceptedDur = firsts
      .filter((s) => s.firstAcceptedAt)
      .map((s) => s.firstAcceptedAt! - s.startedAt - s.pausedMs)
      .filter((x) => x > 0);
    return {
      week: w,
      newQuestions: firsts.length,
      reviews: revs.length,
      studyMinutes: Math.round(activeMs / 60_000),
      independentRate: inWeek.length ? inWeek.filter((s) => isIndependentOutcome(s.outcome)).length / inWeek.length : null,
      medianFirstAcceptedMin: firstAcceptedDur.length ? Math.round(median(firstAcceptedDur)! / 60_000) : null,
      medianSessionMin: inWeek.length ? Math.round(median(inWeek.map((s) => effectiveDuration(s, now).ms))! / 60_000) : null,
      adherence: assigned.length ? done / assigned.length : null,
      assigned: assigned.length,
      completed: done,
      newDone,
      newTarget,
    };
  });

  const snapshots = db.select().from(dailySnapshots).orderBy(asc(dailySnapshots.date)).all().slice(-120);

  // ---- Topic analytics ----
  const groupBy = opts.groupBy ?? "pattern";
  const keysOf = (p: (typeof probs)[number]) => (groupBy === "pattern" ? (p.patterns.length ? p.patterns : ["Unassigned"]) : p.topics.length ? p.topics.map((t) => t.name) : ["Untagged"]);
  const probById = new Map(probs.map((p) => [p.id, p]));
  const rsById = new Map(rs.map((r) => [r.problemId, r]));
  type Row = {
    topic: string;
    problems: number;
    practiced: number;
    sessions: number;
    independent: number;
    failures: number;
    durations: number[];
    overdue: number;
    mastery: Record<string, number>;
  };
  const topics = new Map<string, Row>();
  const row = (k: string) => {
    let r = topics.get(k);
    if (!r) {
      r = { topic: k, problems: 0, practiced: 0, sessions: 0, independent: 0, failures: 0, durations: [], overdue: 0, mastery: {} };
      topics.set(k, r);
    }
    return r;
  };
  for (const p of probs) {
    const st = stats.get(p.id);
    const inLists = (st?.lists.length ?? 0) > 0 || practiced.has(p.id);
    if (!inLists) continue;
    for (const k of keysOf(p)) {
      const r = row(k);
      r.problems++;
      if (practiced.has(p.id)) r.practiced++;
      const m = st?.mastery ?? "not_started";
      r.mastery[m] = (r.mastery[m] ?? 0) + 1;
      const due = rsById.get(p.id)?.nextDueDate;
      if (due && due < today) r.overdue++;
    }
  }
  for (const s of completed) {
    const p = probById.get(s.problemId);
    if (!p) continue;
    for (const k of keysOf(p)) {
      const r = row(k);
      r.sessions++;
      if (isIndependentOutcome(s.outcome)) r.independent++;
      if (s.outcome === "failed" || s.outcome === "hints") r.failures++;
      r.durations.push(effectiveDuration(s, now).ms);
    }
  }
  const topicRows = [...topics.values()]
    .map((r) => ({
      topic: r.topic,
      problems: r.problems,
      practiced: r.practiced,
      sessions: r.sessions,
      independentRate: r.sessions ? r.independent / r.sessions : null,
      failures: r.failures,
      avgDurationMs: mean(r.durations),
      overdue: r.overdue,
      mastery: r.mastery,
    }))
    .sort((a, b) => b.problems - a.problems);

  return { today, unique, sessionLevel, masteryCounts, weekly, snapshots, topics: topicRows, groupBy };
}

/** Per-problem performance series for the detail page charts. */
export function problemPerformanceSeries(sessionsForProblem: ReturnType<typeof import("./history").decorateSessions>) {
  return sessionsForProblem
    .filter((s) => s.status === "completed")
    .map((s, i) => ({
      n: i + 1,
      date: s.endedDate ?? "",
      minutes: Math.round((s.durationMs / 60_000) * 10) / 10,
      submissions: s.submitCount,
      outcome: s.outcome,
      confidence: s.outcome ? { easy: 5, independent: 4, struggled: 3, hints: 2, failed: 1 }[s.outcome] : null,
      interval: s.nextReviewDate && s.endedDate ? Math.round((Date.parse(s.nextReviewDate) - Date.parse(s.endedDate)) / 86_400_000) : null,
    }));
}
