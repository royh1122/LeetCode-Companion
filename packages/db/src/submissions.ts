import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { OPEN_SESSION_STATUSES, type Attribution, type CaptureSource, type SubmissionKind, type Verdict } from "@lcc/shared";
import type { Db } from "./client";
import { bumpRevision } from "./meta";
import { problems, sessions, submissions, type Submission } from "./schema";
import { DomainError, getSession } from "./sessions";

/**
 * Identity: LeetCode's submission id when we have one (unique index).
 * Fallback (manual entries / missing id): sha256 of problem, kind, language,
 * code and the submission minute — the same code logged twice in the same
 * minute is treated as one submission. Documented in docs/LEETCODE_INTEGRATION.md.
 */
export function submissionFingerprint(i: { problemId: number; kind: SubmissionKind; platformSubmissionId: string | null; lang: string | null; code: string | null; submittedAt: number }) {
  const identity = i.platformSubmissionId ? `pid:${i.platformSubmissionId}` : `min:${Math.floor(i.submittedAt / 60_000)}|${i.lang ?? ""}|${i.code ?? ""}`;
  return createHash("sha256").update(`${i.problemId}|${i.kind}|${identity}`).digest("hex");
}

/**
 * Decide which session a submission belongs to.
 *  - "bound": the extension tab was bound to that session and it is for the same problem.
 *  - "inferred": no binding, but exactly one session for this problem was open at
 *    submission time.
 *  - otherwise unattributed ("none") — shown in the inbox for manual linking.
 */
export function attributeSubmission(db: Db, problemId: number, claimedSessionId: string | null, submittedAt: number): { sessionId: string | null; attribution: Attribution } {
  if (claimedSessionId) {
    const s = getSession(db, claimedSessionId);
    if (s && s.problemId === problemId && s.startedAt <= submittedAt + 60_000 && (s.endedAt == null || s.endedAt + 5 * 60_000 >= submittedAt)) {
      return { sessionId: s.id, attribution: "bound" };
    }
  }
  const candidates = db
    .select()
    .from(sessions)
    .where(and(eq(sessions.problemId, problemId), lte(sessions.startedAt, submittedAt + 60_000)))
    .all()
    .filter((s) => (OPEN_SESSION_STATUSES as readonly string[]).includes(s.status) || (s.endedAt != null && s.endedAt + 60_000 >= submittedAt));
  if (candidates.length === 1) return { sessionId: candidates[0]!.id, attribution: "inferred" };
  return { sessionId: null, attribution: "none" };
}

function markFirstAccepted(db: Db, sessionId: string | null, at: number) {
  if (!sessionId) return;
  const s = getSession(db, sessionId);
  if (s && (s.firstAcceptedAt == null || at < s.firstAcceptedAt)) {
    db.update(sessions).set({ firstAcceptedAt: at }).where(eq(sessions.id, sessionId)).run();
  }
}

export interface RecordSubmissionInput {
  problemId: number;
  claimedSessionId: string | null;
  kind: SubmissionKind;
  platformSubmissionId: string | null;
  lang: string | null;
  code: string | null;
  submittedAt: number;
  captureSource: CaptureSource;
  verdict?: Verdict;
  syncEventId?: string | null;
  /** For manual entries the user picks the session; skip inference. */
  forceSessionId?: string | null;
}

/** Insert a submission once. Never overwrites existing code. Returns {submission, created}. */
export function recordSubmission(db: Db, input: RecordSubmissionInput): { submission: Submission; created: boolean } {
  const fingerprint = submissionFingerprint({ ...input });
  const byPlatform = input.platformSubmissionId
    ? db.select().from(submissions).where(eq(submissions.platformSubmissionId, input.platformSubmissionId)).get()
    : undefined;
  const existing = byPlatform ?? db.select().from(submissions).where(eq(submissions.fingerprint, fingerprint)).get();
  if (existing) {
    // A result may have created the row before the code arrived — fill code in, never replace it.
    if (existing.code == null && input.code != null) {
      db.update(submissions).set({ code: input.code, language: existing.language ?? input.lang, updatedAt: Date.now() }).where(eq(submissions.id, existing.id)).run();
      bumpRevision(db);
      return { submission: db.select().from(submissions).where(eq(submissions.id, existing.id)).get()!, created: false };
    }
    return { submission: existing, created: false };
  }
  const attr =
    input.forceSessionId !== undefined
      ? { sessionId: input.forceSessionId, attribution: (input.forceSessionId ? "manual" : "none") as Attribution }
      : attributeSubmission(db, input.problemId, input.claimedSessionId, input.submittedAt);
  const submission = db
    .insert(submissions)
    .values({
      sessionId: attr.sessionId,
      problemId: input.problemId,
      kind: input.kind,
      platformSubmissionId: input.platformSubmissionId,
      fingerprint,
      code: input.code,
      language: input.lang,
      verdict: input.verdict ?? "Pending",
      submittedAt: input.submittedAt,
      captureSource: input.captureSource,
      attribution: attr.attribution,
      syncEventId: input.syncEventId ?? null,
    })
    .returning()
    .get();
  if (submission.verdict === "Accepted" && submission.kind === "submit") markFirstAccepted(db, submission.sessionId, submission.submittedAt);
  if (attr.sessionId) db.update(sessions).set({ lastActivityAt: sql`max(coalesce(${sessions.lastActivityAt}, 0), ${input.submittedAt})` }).where(eq(sessions.id, attr.sessionId)).run();
  bumpRevision(db);
  return { submission, created: true };
}

export interface JudgeResultInput {
  problemId: number;
  claimedSessionId: string | null;
  kind: SubmissionKind;
  platformSubmissionId: string;
  verdict: Verdict;
  statusCode: number | null;
  runtime: string | null;
  memory: string | null;
  totalCorrect: number | null;
  totalTestcases: number | null;
  lang: string | null;
  judgedAt: number;
  details?: Record<string, string | null>;
  syncEventId?: string | null;
}

/** Apply a judge result. If the submit request wasn't observed, a row without code is created (honestly marked). */
export function applyJudgeResult(db: Db, r: JudgeResultInput): Submission {
  let row = db.select().from(submissions).where(eq(submissions.platformSubmissionId, r.platformSubmissionId)).get();
  if (!row) {
    row = recordSubmission(db, {
      problemId: r.problemId,
      claimedSessionId: r.claimedSessionId,
      kind: r.kind,
      platformSubmissionId: r.platformSubmissionId,
      lang: r.lang,
      code: null,
      submittedAt: r.judgedAt,
      captureSource: "extension_network",
      syncEventId: r.syncEventId,
    }).submission;
  }
  if (row.verdict === "Pending" || row.verdict === "Unknown") {
    db.update(submissions)
      .set({
        verdict: r.verdict,
        statusCode: r.statusCode,
        runtime: r.runtime,
        memory: r.memory,
        totalCorrect: r.totalCorrect,
        totalTestcases: r.totalTestcases,
        details: r.details ?? null,
        judgedAt: r.judgedAt,
        language: row.language ?? r.lang,
        updatedAt: Date.now(),
      })
      .where(eq(submissions.id, row.id))
      .run();
    if (r.verdict === "Accepted" && row.kind === "submit") markFirstAccepted(db, row.sessionId, row.submittedAt);
    bumpRevision(db);
  }
  return db.select().from(submissions).where(eq(submissions.id, row.id)).get()!;
}

function rederiveFirstAccepted(db: Db, sessionId: string | null) {
  if (!sessionId) return;
  const first = db
    .select()
    .from(submissions)
    .where(and(eq(submissions.sessionId, sessionId), eq(submissions.kind, "submit"), eq(submissions.verdict, "Accepted")))
    .orderBy(asc(submissions.submittedAt))
    .get();
  db.update(sessions).set({ firstAcceptedAt: first?.submittedAt ?? null, updatedAt: Date.now() }).where(eq(sessions.id, sessionId)).run();
}

/**
 * Permanently delete one submission (e.g. a stray test submit). Explicit user
 * action only; the session's "first Accepted" time is re-derived.
 */
export function deleteSubmission(db: Db, id: number): Submission {
  return db.transaction((tx) => {
    const sub = tx.select().from(submissions).where(eq(submissions.id, id)).get();
    if (!sub) throw new DomainError("not_found", "Submission not found");
    tx.delete(submissions).where(eq(submissions.id, id)).run();
    rederiveFirstAccepted(tx, sub.sessionId);
    bumpRevision(tx);
    return sub;
  });
}

/** Manually (re)link a submission to a session of the same problem, or unlink it. */
export function linkSubmission(db: Db, submissionId: number, sessionId: string | null) {
  const sub = db.select().from(submissions).where(eq(submissions.id, submissionId)).get();
  if (!sub) throw new DomainError("not_found", "Submission not found");
  if (sessionId) {
    const s = getSession(db, sessionId);
    if (!s || s.problemId !== sub.problemId) throw new DomainError("mismatch", "Session is for a different problem");
  }
  db.update(submissions)
    .set({ sessionId, attribution: sessionId ? "manual" : "none", updatedAt: Date.now() })
    .where(eq(submissions.id, submissionId))
    .run();
  rederiveFirstAccepted(db, sub.sessionId); // the session it left
  rederiveFirstAccepted(db, sessionId);
  bumpRevision(db);
}

export function listUnattributed(db: Db) {
  return db
    .select({ submission: submissions, problem: { id: problems.id, slug: problems.slug, title: problems.title, frontendId: problems.frontendId } })
    .from(submissions)
    .innerJoin(problems, eq(problems.id, submissions.problemId))
    .where(and(isNull(submissions.sessionId), eq(submissions.kind, "submit")))
    .orderBy(desc(submissions.submittedAt))
    .all();
}
