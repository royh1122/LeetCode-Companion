import { z } from "zod";
import { isValidTimeZone } from "./dates";

/**
 * Plan configuration. Quotas are indexed by JS weekday (0 = Sunday … 6 = Saturday).
 * Review days hold the mandatory cohort review: `quota: null` means "the rest of the cohort".
 */
export const reviewDaySchema = z.object({
  weekday: z.number().int().min(0).max(6),
  quota: z.number().int().min(0).max(200).nullable(),
});

export const planSettingsSchema = z.object({
  /** Ordered study-list slugs. The queue is built in this order, de-duplicated by problem. */
  listSlugs: z.array(z.string()).min(1),
  /** New questions per JS weekday. */
  newPerWeekday: z.array(z.number().int().min(0).max(50)).length(7),
  /** Mandatory review of the current week's cohort. */
  reviewDays: z.array(reviewDaySchema),
  /** Max adaptive (SRS) reviews auto-picked per day. Extra due reviews wait in the Review Queue. */
  srsDailyCap: z.number().int().min(0).max(100),
  /** SRS cap on days that also carry mandatory reviews. */
  srsReviewDayCap: z.number().int().min(0).max(100),
  /**
   * Backlog policy for unfinished new questions: today's new pull is reduced by the
   * number of carried-over new questions, so the open new-question list never exceeds
   * the day's quota (unless you add questions manually).
   */
  carryOverReducesNew: z.boolean(),
  /** "skip": problems you already practiced (e.g. from an earlier list) don't consume new-question quota. */
  overlapPolicy: z.enum(["skip_practiced", "include_all"]),
});
export type PlanSettings = z.infer<typeof planSettingsSchema>;

export const DEFAULT_PLAN_SETTINGS: PlanSettings = {
  listSlugs: [], // filled in from the imported lists when a plan is created
  newPerWeekday: [0, 5, 5, 5, 5, 5, 0],
  reviewDays: [
    { weekday: 6, quota: 12 },
    { weekday: 0, quota: null },
  ],
  srsDailyCap: 5,
  srsReviewDayCap: 3,
  carryOverReducesNew: true,
  overlapPolicy: "skip_practiced",
};

/** Spaced-repetition configuration (global, not per plan). */
export const srsSettingsSchema = z.object({
  baseIntervals: z.object({
    failed: z.number().int().min(1).max(365),
    hints: z.number().int().min(1).max(365),
    struggled: z.number().int().min(1).max(365),
    independent: z.number().int().min(1).max(365),
    easy: z.number().int().min(1).max(365),
  }),
  /** After a successful review, interval grows: prev × multiplier (never below the base). */
  independentMultiplier: z.number().min(1).max(5),
  easyMultiplier: z.number().min(1).max(6),
  /** "Struggled" after a long interval shrinks it: prev × factor (never below base, never above prev). */
  struggledFactor: z.number().min(0.1).max(1),
  maxIntervalDays: z.number().int().min(7).max(3650),
});
export type SrsSettings = z.infer<typeof srsSettingsSchema>;

export const DEFAULT_SRS_SETTINGS: SrsSettings = {
  baseIntervals: { failed: 1, hints: 1, struggled: 3, independent: 7, easy: 21 },
  independentMultiplier: 2,
  easyMultiplier: 2.5,
  struggledFactor: 0.5,
  maxIntervalDays: 180,
};

export const masterySettingsSchema = z.object({
  /** Consecutive independent/easy sessions required for "Mastered". */
  masteryStreak: z.number().int().min(1).max(10),
  /** …and the last of them must come after a gap of at least this many days. */
  masteryMinGapDays: z.number().int().min(0).max(365),
  /** Overdue by more than this many days → "Needs review". */
  overdueGraceDays: z.number().int().min(0).max(60),
});
export type MasterySettings = z.infer<typeof masterySettingsSchema>;
export const DEFAULT_MASTERY_SETTINGS: MasterySettings = { masteryStreak: 3, masteryMinGapDays: 14, overdueGraceDays: 3 };

export const appSettingsSchema = z.object({
  timeZone: z.string().min(1).refine(isValidTimeZone, "Unknown time zone"),
  srs: srsSettingsSchema,
  mastery: masterySettingsSchema,
  /** Extension: no input for this long → not counted as active time. */
  idleThresholdSec: z.number().int().min(30).max(3600),
  /** Open sessions with no activity for this long are flagged "interrupted". */
  staleSessionHours: z.number().int().min(1).max(168),
  /** Show a problem's pattern/topic in lists (Today, Plan, Reviews, Library). Off by default: it's a hint. */
  showPatterns: z.boolean(),
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

export function defaultAppSettings(timeZone?: string): AppSettings {
  return {
    timeZone: timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    srs: DEFAULT_SRS_SETTINGS,
    mastery: DEFAULT_MASTERY_SETTINGS,
    idleThresholdSec: 300,
    staleSessionHours: 6,
    showPatterns: false,
  };
}
