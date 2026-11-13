import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type {
  AssignmentStatus,
  AssignmentType,
  Attribution,
  CaptureSource,
  Difficulty,
  Outcome,
  ReviewStage,
  SessionOrigin,
  SessionStatus,
  SessionType,
  SubmissionKind,
  Verdict,
} from "@lcc/shared";

/** All timestamps are UTC epoch milliseconds. Calendar dates are "YYYY-MM-DD" in the plan's time zone. */
const now = sql`(cast(unixepoch('subsec') * 1000 as integer))`;
const timestamps = {
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
};

/** One row per unique LeetCode problem, regardless of how many lists contain it. */
export const problems = sqliteTable(
  "problems",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    platform: text("platform").notNull().default("leetcode"),
    /** LeetCode's internal question id (stable). */
    platformQuestionId: text("platform_question_id"),
    /** The number shown on the site ("1768"). */
    frontendId: text("frontend_id"),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    difficulty: text("difficulty").$type<Difficulty>().notNull().default("Unknown"),
    url: text("url").notNull(),
    /** LeetCode topic tags: [{ name, slug }] */
    topics: text("topics", { mode: "json" }).$type<{ name: string; slug: string }[]>().notNull().default(sql`'[]'`),
    /** Study patterns (from list groups like "Sliding Window", editable). First = primary. */
    patterns: text("patterns", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    paidOnly: integer("paid_only", { mode: "boolean" }).notNull().default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("problems_platform_slug_uq").on(t.platform, t.slug),
    uniqueIndex("problems_platform_qid_uq").on(t.platform, t.platformQuestionId).where(sql`platform_question_id is not null`),
    index("problems_frontend_idx").on(t.frontendId),
  ],
);

export const studyLists = sqliteTable("study_lists", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  source: text("source").$type<"leetcode" | "custom">().notNull().default("leetcode"),
  ...timestamps,
});

export const studyListProblems = sqliteTable(
  "study_list_problems",
  {
    listId: integer("list_id")
      .notNull()
      .references(() => studyLists.id, { onDelete: "cascade" }),
    problemId: integer("problem_id")
      .notNull()
      .references(() => problems.id, { onDelete: "restrict" }),
    position: integer("position").notNull(),
    groupName: text("group_name"),
  },
  (t) => [primaryKey({ columns: [t.listId, t.problemId] }), uniqueIndex("slp_list_position_uq").on(t.listId, t.position)],
);

export const studyPlans = sqliteTable("study_plans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  status: text("status").$type<"active" | "paused" | "archived">().notNull().default("active"),
  startDate: text("start_date").notNull(),
  timeZone: text("time_zone").notNull(),
  /** Validated by planSettingsSchema (@lcc/shared). */
  settings: text("settings", { mode: "json" }).notNull(),
  pausedAt: integer("paused_at"),
  ...timestamps,
});

/** Ordered queue of problems a plan will introduce as new questions. */
export const planQueue = sqliteTable(
  "plan_queue",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    planId: integer("plan_id")
      .notNull()
      .references(() => studyPlans.id, { onDelete: "cascade" }),
    problemId: integer("problem_id")
      .notNull()
      .references(() => problems.id, { onDelete: "restrict" }),
    position: real("position").notNull(),
    status: text("status").$type<"pending" | "assigned" | "done" | "skipped_practiced" | "removed">().notNull().default("pending"),
    sourceListId: integer("source_list_id").references(() => studyLists.id, { onDelete: "set null" }),
    addedManually: integer("added_manually", { mode: "boolean" }).notNull().default(false),
    ...timestamps,
  },
  (t) => [uniqueIndex("plan_queue_plan_problem_uq").on(t.planId, t.problemId), index("plan_queue_order_idx").on(t.planId, t.status, t.position)],
);

/** Days the user chose to skip (no new questions; the queue does not advance). */
export const planSkips = sqliteTable(
  "plan_skips",
  {
    planId: integer("plan_id")
      .notNull()
      .references(() => studyPlans.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.planId, t.date] })],
);

/** Days the user marked as light: fewer new questions and no automatic SRS picks (reviews stay due). */
export const planLightDays = sqliteTable(
  "plan_light_days",
  {
    planId: integer("plan_id")
      .notNull()
      .references(() => studyPlans.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    newQuota: integer("new_quota").notNull().default(1),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.planId, t.date] })],
);

/** Records that a day's automatic allocation already ran, so it never runs twice. */
export const planDays = sqliteTable(
  "plan_days",
  {
    planId: integer("plan_id")
      .notNull()
      .references(() => studyPlans.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    newAllocatedAt: integer("new_allocated_at"),
    srsAllocatedAt: integer("srs_allocated_at"),
  },
  (t) => [primaryKey({ columns: [t.planId, t.date] })],
);

/** A planned task. Not the same as a practice session. */
export const assignments = sqliteTable(
  "assignments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Null for manual assignments or if the plan was deleted (history is preserved). */
    planId: integer("plan_id").references(() => studyPlans.id, { onDelete: "set null" }),
    problemId: integer("problem_id")
      .notNull()
      .references(() => problems.id, { onDelete: "restrict" }),
    type: text("type").$type<AssignmentType>().notNull(),
    scheduledDate: text("scheduled_date").notNull(),
    /** First date it was scheduled for (carry-over / reschedule keeps this). */
    originalDate: text("original_date").notNull(),
    /** Monday of the cohort week (weekend reviews + new questions). */
    cohortWeek: text("cohort_week"),
    position: integer("position").notNull().default(0),
    status: text("status").$type<AssignmentStatus>().notNull().default("pending"),
    completedAt: integer("completed_at"),
    completedDate: text("completed_date"),
    completedSessionId: text("completed_session_id"),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    index("assignments_date_idx").on(t.scheduledDate, t.status),
    index("assignments_problem_idx").on(t.problemId),
    // A problem can have at most one weekend review per cohort week.
    uniqueIndex("assignments_weekend_uq").on(t.problemId, t.cohortWeek).where(sql`type = 'weekend_review'`),
    // At most one *open* assignment of each type per problem.
    uniqueIndex("assignments_open_uq").on(t.problemId, t.type).where(sql`status in ('pending','in_progress')`),
  ],
);

/** One period of practicing or reviewing a problem. */
export const sessions = sqliteTable(
  "sessions",
  {
    /** UUID — may be generated by the extension while offline. */
    id: text("id").primaryKey(),
    problemId: integer("problem_id")
      .notNull()
      .references(() => problems.id, { onDelete: "restrict" }),
    assignmentId: integer("assignment_id").references(() => assignments.id, { onDelete: "set null" }),
    type: text("type").$type<SessionType>().notNull(),
    status: text("status").$type<SessionStatus>().notNull(),
    origin: text("origin").$type<SessionOrigin>().notNull(),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    /** Local calendar date the session ended (for daily/weekly grouping). */
    endedDate: text("ended_date"),
    pausedAt: integer("paused_at"),
    pausedMs: integer("paused_ms").notNull().default(0),
    /** Active time estimated by the extension (cumulative). */
    activeMs: integer("active_ms"),
    durationOverrideMs: integer("duration_override_ms"),
    lastActivityAt: integer("last_activity_at"),
    firstAcceptedAt: integer("first_accepted_at"),
    outcome: text("outcome").$type<Outcome>(),
    hintsUsed: integer("hints_used", { mode: "boolean" }).notNull().default(false),
    revealedHints: integer("revealed_hints", { mode: "boolean" }).notNull().default(false),
    revealedNotes: integer("revealed_notes", { mode: "boolean" }).notNull().default(false),
    revealedCode: integer("revealed_code", { mode: "boolean" }).notNull().default(false),
    difficultyRating: integer("difficulty_rating"),
    notes: text("notes"),
    struggles: text("struggles"),
    takeaway: text("takeaway"),
    mistakes: text("mistakes"),
    /** Complexity of this attempt's solution, e.g. "O(n log n)". The problem's permanent notes have their own. */
    timeComplexity: text("time_complexity"),
    spaceComplexity: text("space_complexity"),
    patterns: text("patterns", { mode: "json" }).$type<string[]>(),
    /** Recommended next review at completion time, and the final decision. */
    recommendedReviewDate: text("recommended_review_date"),
    nextReviewDate: text("next_review_date"),
    nextReviewOverridden: integer("next_review_overridden", { mode: "boolean" }).notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index("sessions_problem_idx").on(t.problemId, t.startedAt),
    index("sessions_ended_idx").on(t.endedDate),
    // No duplicate open sessions for the same problem (refresh / multiple tabs).
    uniqueIndex("sessions_one_open_uq").on(t.problemId).where(sql`status in ('not_started','in_progress','paused')`),
  ],
);

/** One code version evaluated by LeetCode (or a Run, kept separate via `kind`). */
export const submissions = sqliteTable(
  "submissions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    problemId: integer("problem_id")
      .notNull()
      .references(() => problems.id, { onDelete: "restrict" }),
    kind: text("kind").$type<SubmissionKind>().notNull().default("submit"),
    platformSubmissionId: text("platform_submission_id"),
    /** Fallback identity when there's no platform id: sha256(problem|lang|code|minute). */
    fingerprint: text("fingerprint").notNull(),
    code: text("code"),
    language: text("language"),
    verdict: text("verdict").$type<Verdict>().notNull().default("Unknown"),
    statusCode: integer("status_code"),
    runtime: text("runtime"),
    memory: text("memory"),
    totalCorrect: integer("total_correct"),
    totalTestcases: integer("total_testcases"),
    details: text("details", { mode: "json" }).$type<Record<string, string | null>>(),
    submittedAt: integer("submitted_at").notNull(),
    judgedAt: integer("judged_at"),
    captureSource: text("capture_source").$type<CaptureSource>().notNull(),
    attribution: text("attribution").$type<Attribution>().notNull().default("none"),
    syncEventId: text("sync_event_id"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("submissions_platform_uq").on(t.platformSubmissionId).where(sql`platform_submission_id is not null`),
    uniqueIndex("submissions_fingerprint_uq").on(t.fingerprint),
    index("submissions_session_idx").on(t.sessionId),
    index("submissions_problem_idx").on(t.problemId, t.submittedAt),
  ],
);

/** Permanent, concept-level notes. One per problem; not copied per session. */
export const problemNotes = sqliteTable("problem_notes", {
  problemId: integer("problem_id")
    .primaryKey()
    .references(() => problems.id, { onDelete: "cascade" }),
  insight: text("insight").notNull().default(""),
  recognition: text("recognition").notNull().default(""),
  timeComplexity: text("time_complexity").notNull().default(""),
  spaceComplexity: text("space_complexity").notNull().default(""),
  edgeCases: text("edge_cases").notNull().default(""),
  pitfalls: text("pitfalls").notNull().default(""),
  related: text("related").notNull().default(""),
  body: text("body").notNull().default(""),
  ...timestamps,
});

/** Previous versions of permanent notes, so an edit never destroys text. */
export const problemNoteRevisions = sqliteTable("problem_note_revisions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  problemId: integer("problem_id")
    .notNull()
    .references(() => problems.id, { onDelete: "cascade" }),
  snapshot: text("snapshot", { mode: "json" }).notNull(),
  createdAt: integer("created_at").notNull().default(now),
});

/** Spaced-repetition state per problem (derived from sessions; kept materialized). */
export const reviewState = sqliteTable(
  "review_state",
  {
    problemId: integer("problem_id")
      .primaryKey()
      .references(() => problems.id, { onDelete: "cascade" }),
    stage: text("stage").$type<ReviewStage>().notNull().default("learning"),
    intervalDays: integer("interval_days").notNull().default(0),
    nextDueDate: text("next_due_date"),
    lastReviewedDate: text("last_reviewed_date"),
    lastOutcome: text("last_outcome").$type<Outcome>(),
    successStreak: integer("success_streak").notNull().default(0),
    lapses: integer("lapses").notNull().default(0),
    reviewCount: integer("review_count").notNull().default(0),
    firstPracticedDate: text("first_practiced_date"),
    /** Set when the user postponed the review; a later completed session clears it. */
    postponedTo: text("postponed_to"),
    ...timestamps,
  },
  (t) => [index("review_state_due_idx").on(t.nextDueDate)],
);

/** Every incoming extension event, processed at most once. */
export const syncEvents = sqliteTable(
  "sync_events",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    sessionId: text("session_id"),
    payload: text("payload", { mode: "json" }).notNull(),
    status: text("status").$type<"processed" | "rejected">().notNull(),
    error: text("error"),
    clientCreatedAt: integer("client_created_at").notNull(),
    receivedAt: integer("received_at").notNull().default(now),
  },
  (t) => [index("sync_events_received_idx").on(t.receivedAt)],
);

/** Daily snapshot for backlog / mastery trend charts. */
export const dailySnapshots = sqliteTable("daily_snapshots", {
  date: text("date").primaryKey(),
  dueCount: integer("due_count").notNull(),
  overdueCount: integer("overdue_count").notNull(),
  mastery: text("mastery", { mode: "json" }).$type<Record<string, number>>().notNull(),
  createdAt: integer("created_at").notNull().default(now),
});

export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull().default(now),
});

export type Problem = typeof problems.$inferSelect;
export type StudyList = typeof studyLists.$inferSelect;
export type StudyPlan = typeof studyPlans.$inferSelect;
export type Assignment = typeof assignments.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Submission = typeof submissions.$inferSelect;
export type ProblemNotes = typeof problemNotes.$inferSelect;
export type ReviewState = typeof reviewState.$inferSelect;
export type PlanQueueItem = typeof planQueue.$inferSelect;
