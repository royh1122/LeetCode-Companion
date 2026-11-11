/**
 * Shared vocabulary. Problem ≠ Session ≠ Submission — see docs/ARCHITECTURE.md.
 */

export const DIFFICULTIES = ["Easy", "Medium", "Hard", "Unknown"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** Why a question appears on a given day. */
export const ASSIGNMENT_TYPES = [
  "new", // first encounter, pulled from the plan queue
  "weekend_review", // fixed, mandatory review of the week's cohort
  "srs_review", // adaptive spaced-repetition review
  "manual", // added by hand ("practice today")
] as const;
export type AssignmentType = (typeof ASSIGNMENT_TYPES)[number];

export const ASSIGNMENT_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "skipped", // user skipped (new questions return to the queue)
  "postponed", // moved to a later date (a new assignment/due date replaces it)
  "expired", // daily SRS pick that was not done; the problem stays due
  "cancelled",
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
export const SESSION_TYPES = [
  "first_attempt",
  "repeat_new", // explicitly practicing an already-seen problem as new
  "weekend_review",
  "srs_review",
  "free_practice",
] as const;
export type SessionType = (typeof SESSION_TYPES)[number];

export const SESSION_STATUSES = ["not_started", "in_progress", "paused", "completed", "abandoned"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export const OPEN_SESSION_STATUSES: readonly SessionStatus[] = ["not_started", "in_progress", "paused"];

/** Self-reported reflection outcome. Ordered best → worst. */
export const OUTCOMES = ["easy", "independent", "struggled", "hints", "failed"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const OUTCOME_LABELS: Record<Outcome, { label: string; description: string; key: string }> = {
  easy: { label: "Easy", description: "Solved quickly and confidently", key: "1" },
  independent: { label: "Independent", description: "Solved without hints", key: "2" },
  struggled: { label: "Struggled", description: "Solved, with significant effort", key: "3" },
  hints: { label: "Needed hints", description: "Needed hints or the solution", key: "4" },
  failed: { label: "Failed", description: "Could not solve", key: "5" },
};

export function isIndependentOutcome(o: Outcome | null | undefined): boolean {
  return o === "easy" || o === "independent";
}
export function isSuccessOutcome(o: Outcome | null | undefined): boolean {
  return o === "easy" || o === "independent" || o === "struggled";
}

export const VERDICTS = [
  "Accepted",
  "Wrong Answer",
  "Time Limit Exceeded",
  "Memory Limit Exceeded",
  "Output Limit Exceeded",
  "Runtime Error",
  "Compile Error",
  "Pending",
  "Unknown",
] as const;
export type Verdict = (typeof VERDICTS)[number];

export const SUBMISSION_KINDS = ["submit", "run"] as const;
export type SubmissionKind = (typeof SUBMISSION_KINDS)[number];

export const CAPTURE_SOURCES = ["extension_network", "manual", "import"] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

/** How a submission got linked to a session. */
export const ATTRIBUTIONS = ["bound", "inferred", "manual", "none"] as const;
export type Attribution = (typeof ATTRIBUTIONS)[number];

export const MASTERY_STATES = ["not_started", "learning", "needs_review", "improving", "mastered"] as const;
export type Mastery = (typeof MASTERY_STATES)[number];
export const MASTERY_LABELS: Record<Mastery, string> = {
  not_started: "Not started",
  learning: "Learning",
  needs_review: "Needs review",
  improving: "Improving",
  mastered: "Mastered",
};

export const REVIEW_STAGES = ["learning", "review", "relearning"] as const;
export type ReviewStage = (typeof REVIEW_STAGES)[number];

export const SESSION_ORIGINS = ["dashboard", "extension", "manual_log", "import"] as const;
export type SessionOrigin = (typeof SESSION_ORIGINS)[number];
