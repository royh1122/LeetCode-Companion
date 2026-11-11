import { z } from "zod";
import { OUTCOMES, SUBMISSION_KINDS, VERDICTS } from "./enums";
import { isLocalDate } from "./dates";

/**
 * Extension → local server sync protocol.
 *
 * Every event carries a client-generated UUID. The server stores each id in
 * `sync_events` and processes it at most once, so retries are always safe.
 * Events from one client carry a monotonically increasing `seq` and are sent
 * in order; the server processes a batch in array order.
 */

const uuid = z.string().regex(/^[0-9a-f-]{16,64}$/i, "expected a UUID");
const slug = z.string().regex(/^[a-z0-9-]{1,200}$/);
const ts = z.number().int().positive();
const localDate = z.string().refine(isLocalDate, "expected YYYY-MM-DD");

export const problemHintSchema = z.object({
  slug,
  title: z.string().max(300).nullish(),
  frontendId: z.string().max(20).nullish(),
  questionId: z.string().max(20).nullish(),
  difficulty: z.string().max(20).nullish(),
});
export type ProblemHint = z.infer<typeof problemHintSchema>;

const base = { id: uuid, clientId: z.string().max(64), seq: z.number().int().nonnegative(), createdAt: ts };

export const sessionStartEvent = z.object({
  ...base,
  type: z.literal("session.start"),
  payload: z.object({ sessionId: uuid, problem: problemHintSchema, startedAt: ts }),
});

export const sessionActivityEvent = z.object({
  ...base,
  type: z.literal("session.activity"),
  /** Cumulative active milliseconds measured by the extension (monotonic; server keeps the max). */
  payload: z.object({ sessionId: uuid, activeMs: z.number().int().nonnegative(), lastActivityAt: ts }),
});

export const sessionPauseEvent = z.object({
  ...base,
  type: z.literal("session.pause"),
  payload: z.object({ sessionId: uuid, at: ts }),
});
export const sessionResumeEvent = z.object({
  ...base,
  type: z.literal("session.resume"),
  payload: z.object({ sessionId: uuid, at: ts }),
});

export const sessionNotesEvent = z.object({
  ...base,
  type: z.literal("session.notes"),
  /** Cumulative snapshot of the session's free-text fields; omitted fields are left unchanged. */
  payload: z.object({
    sessionId: uuid,
    notes: z.string().max(20_000).optional(),
    timeComplexity: z.string().max(200).optional(),
    spaceComplexity: z.string().max(200).optional(),
  }),
});

export const reflectionSchema = z.object({
  outcome: z.enum(OUTCOMES),
  hintsUsed: z.boolean().default(false),
  notes: z.string().max(20_000).nullish(),
  struggles: z.string().max(5_000).nullish(),
  takeaway: z.string().max(5_000).nullish(),
  mistakes: z.string().max(5_000).nullish(),
  timeComplexity: z.string().max(200).nullish(),
  spaceComplexity: z.string().max(200).nullish(),
  patterns: z.array(z.string().max(80)).max(20).nullish(),
  difficultyRating: z.number().int().min(1).max(5).nullish(),
  /** Override of the recommended next review date. */
  nextReviewDate: localDate.nullish(),
  /** Manual duration correction. */
  durationOverrideMs: z.number().int().nonnegative().max(24 * 3_600_000).nullish(),
});
export type Reflection = z.infer<typeof reflectionSchema>;

export const sessionFinishEvent = z.object({
  ...base,
  type: z.literal("session.finish"),
  payload: z.object({ sessionId: uuid, endedAt: ts, reflection: reflectionSchema }),
});

export const sessionAbandonEvent = z.object({
  ...base,
  type: z.literal("session.abandon"),
  payload: z.object({ sessionId: uuid, at: ts }),
});

export const submissionCapturedEvent = z.object({
  ...base,
  type: z.literal("submission.captured"),
  payload: z.object({
    /** Session the tab was bound to when the user clicked Submit/Run; null = unknown. */
    sessionId: uuid.nullable(),
    problem: problemHintSchema,
    kind: z.enum(SUBMISSION_KINDS),
    platformSubmissionId: z.string().max(100).nullable(),
    lang: z.string().max(40).nullable(),
    code: z.string().max(200_000).nullable(),
    submittedAt: ts,
  }),
});

export const submissionResultEvent = z.object({
  ...base,
  type: z.literal("submission.result"),
  payload: z.object({
    sessionId: uuid.nullable(),
    problem: problemHintSchema,
    kind: z.enum(SUBMISSION_KINDS),
    platformSubmissionId: z.string().max(100),
    verdict: z.enum(VERDICTS),
    statusCode: z.number().int().nullable(),
    runtime: z.string().max(40).nullable(),
    memory: z.string().max(40).nullable(),
    totalCorrect: z.number().int().nullable(),
    totalTestcases: z.number().int().nullable(),
    lang: z.string().max(40).nullable(),
    judgedAt: ts,
    details: z.record(z.string(), z.string().max(2100).nullable()).optional(),
  }),
});

export const syncEventSchema = z.discriminatedUnion("type", [
  sessionStartEvent,
  sessionActivityEvent,
  sessionPauseEvent,
  sessionResumeEvent,
  sessionNotesEvent,
  sessionFinishEvent,
  sessionAbandonEvent,
  submissionCapturedEvent,
  submissionResultEvent,
]);
export type SyncEvent = z.infer<typeof syncEventSchema>;
export type SyncEventType = SyncEvent["type"];

export const syncBatchSchema = z.object({ events: z.array(z.unknown()).max(200) });

export type SyncEventResult = {
  id: string;
  /** processed = applied now; duplicate = already applied earlier (safe); rejected = permanent failure. */
  status: "processed" | "duplicate" | "rejected";
  error?: string;
};

/** What the extension needs to know about a problem/session from the server. */
export interface ExtensionContext {
  problem: {
    id: number;
    slug: string;
    title: string;
    frontendId: string | null;
    difficulty: string;
    patterns: string[];
    mastery: string;
    sessionCount: number;
    lastPracticedAt: number | null;
    nextReviewDate: string | null;
  } | null;
  openSession: {
    id: string;
    type: string;
    status: string;
    startedAt: number;
    activeMs: number | null;
    notes: string | null;
    timeComplexity: string | null;
    spaceComplexity: string | null;
    isReview: boolean;
  } | null;
  todayAssignment: { id: number; type: string } | null;
  settings: { idleThresholdSec: number };
  dashboardUrl: string;
}

export interface ExtensionSessionState {
  id: string;
  status: string;
  outcome: string | null;
  endedAt: number | null;
  activeMs: number | null;
  submissions: { id: number; verdict: string; kind: string; submittedAt: number; platformSubmissionId: string | null }[];
}
