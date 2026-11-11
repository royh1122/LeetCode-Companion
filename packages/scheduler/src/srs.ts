import { addDays, type LocalDate, type Outcome, type ReviewStage, type SrsSettings } from "@lcc/shared";

export interface ReviewStateCore {
  intervalDays: number;
  /** Consecutive independent/easy sessions. */
  successStreak: number;
  /** Failures (failed / needed hints) after the problem had reached the review stage. */
  lapses: number;
  reviewCount: number;
  stage: ReviewStage;
  lastOutcome: Outcome | null;
  lastReviewedDate: LocalDate | null;
  nextDueDate: LocalDate | null;
}

/**
 * Compute the recommended next interval after a completed session.
 *
 * Policy (all numbers configurable in Settings):
 *  - failed / needed hints → base interval (1 day). Streak resets; history is kept.
 *    A lapse is only counted if the problem had previously been solved independently.
 *  - struggled → base (3 days) on first sight; after a long interval it shrinks to
 *    prev × struggledFactor, but never below the base and never above prev.
 *  - independent → base (7) the first time, then grows prev × independentMultiplier.
 *  - easy → base (21) the first time, then grows prev × easyMultiplier.
 *  - Growth only happens on top of an existing independent streak, so one lucky
 *    "easy" after a series of struggles doesn't jump straight to months.
 */
export function computeNextReview(
  prev: ReviewStateCore | null,
  outcome: Outcome,
  today: LocalDate,
  cfg: SrsSettings,
): ReviewStateCore {
  const base = cfg.baseIntervals[outcome];
  const prevInterval = prev?.intervalDays ?? 0;
  const prevStreak = prev?.successStreak ?? 0;
  let interval: number;
  let streak: number;
  let lapses = prev?.lapses ?? 0;
  let stage: ReviewStage;

  switch (outcome) {
    case "failed":
    case "hints": {
      interval = base;
      streak = 0;
      if (prev && (prev.stage === "review" || prevStreak > 0)) lapses += 1;
      stage = prev && (prev.stage === "review" || prev.stage === "relearning") ? "relearning" : "learning";
      break;
    }
    case "struggled": {
      interval = prevInterval > base ? Math.max(base, Math.min(prevInterval, Math.round(prevInterval * cfg.struggledFactor))) : base;
      streak = 0;
      stage = prev?.stage === "review" ? "review" : "learning";
      break;
    }
    case "independent":
    case "easy": {
      const mult = outcome === "easy" ? cfg.easyMultiplier : cfg.independentMultiplier;
      interval = prevStreak > 0 && prevInterval > 0 ? Math.max(base, Math.round(prevInterval * mult)) : base;
      streak = prevStreak + 1;
      stage = "review";
      break;
    }
  }
  interval = Math.min(Math.max(1, interval), cfg.maxIntervalDays);
  return {
    intervalDays: interval,
    successStreak: streak,
    lapses,
    reviewCount: (prev?.reviewCount ?? 0) + 1,
    stage,
    lastOutcome: outcome,
    lastReviewedDate: today,
    nextDueDate: addDays(today, interval),
  };
}

/** Explicit override of the next review date (user picked a date). */
export function overrideNextReview(state: ReviewStateCore, nextDue: LocalDate, today: LocalDate): ReviewStateCore {
  const d = Math.max(1, Math.round((Date.parse(`${nextDue}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000));
  return { ...state, nextDueDate: nextDue, intervalDays: d };
}
