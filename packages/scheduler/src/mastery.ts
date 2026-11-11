import { diffDays, isIndependentOutcome, type LocalDate, type Mastery, type MasterySettings, type Outcome } from "@lcc/shared";

export interface MasterySessionInput {
  date: LocalDate; // local date the session ended
  outcome: Outcome;
}

/**
 * Deterministic, explainable mastery. An Accepted submission alone never makes
 * a problem "Mastered" — only repeated independent recall over time does.
 *
 *  1. No completed session                                   → Not started
 *  2. Last session failed / needed hints:
 *       never solved independently                           → Learning
 *       otherwise                                            → Needs review
 *  3. Overdue by more than `overdueGraceDays`                → Needs review
 *  4. ≥ masteryStreak consecutive independent/easy sessions,
 *     the last one ≥ masteryMinGapDays after the previous   → Mastered
 *  5. Last session independent/easy                          → Improving
 *  6. Last session struggled: ever independent ? Improving : Learning
 */
export function computeMastery(
  sessions: MasterySessionInput[],
  nextDueDate: LocalDate | null,
  today: LocalDate,
  cfg: MasterySettings,
): { state: Mastery; reason: string } {
  if (sessions.length === 0) return { state: "not_started", reason: "No completed sessions yet" };
  const sorted = [...sessions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const last = sorted[sorted.length - 1]!;
  const everIndependent = sorted.some((s) => isIndependentOutcome(s.outcome));

  if (last.outcome === "failed" || last.outcome === "hints") {
    return everIndependent
      ? { state: "needs_review", reason: "Most recent session needed help" }
      : { state: "learning", reason: "Not yet solved independently" };
  }
  if (nextDueDate && diffDays(nextDueDate, today) > cfg.overdueGraceDays) {
    return { state: "needs_review", reason: `Review overdue by ${diffDays(nextDueDate, today)} days` };
  }
  let streak = 0;
  for (let i = sorted.length - 1; i >= 0 && isIndependentOutcome(sorted[i]!.outcome); i--) streak++;
  if (streak >= cfg.masteryStreak) {
    const prev = sorted[sorted.length - 2];
    const gap = prev ? diffDays(prev.date, last.date) : 0;
    if (gap >= cfg.masteryMinGapDays) {
      return { state: "mastered", reason: `${streak} independent solves in a row, last after a ${gap}-day gap` };
    }
    return { state: "improving", reason: `${streak} independent solves; needs one after a ≥${cfg.masteryMinGapDays}-day gap` };
  }
  if (isIndependentOutcome(last.outcome)) return { state: "improving", reason: `Independent streak of ${streak}` };
  return everIndependent
    ? { state: "improving", reason: "Solved with effort; previously solved independently" }
    : { state: "learning", reason: "Solved with significant effort" };
}
