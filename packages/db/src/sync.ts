import { desc, eq } from "drizzle-orm";
import { syncEventSchema, type SyncEvent, type SyncEventResult } from "@lcc/shared";
import type { Db } from "./client";
import { getMeta, setMeta } from "./meta";
import { upsertProblemFromHint } from "./problems";
import { syncEvents } from "./schema";
import {
  DomainError,
  abandonSession,
  finishSession,
  getSession,
  pauseSession,
  recordActivity,
  resumeSession,
  startSession,
  updateSessionNotes,
} from "./sessions";
import { applyJudgeResult, recordSubmission } from "./submissions";

/**
 * If the extension created a session offline while another one was already
 * open for the same problem, we keep the existing session and alias the
 * extension's id to it; later events for the alias land on the real session.
 */
function resolveSessionId(db: Db, id: string | null): string | null {
  if (!id) return null;
  return getMeta(db, `session_alias:${id}`) ?? id;
}

export type ProcessResult = SyncEventResult & { sessionId?: string };

function apply(db: Db, ev: SyncEvent): { sessionId?: string } {
  switch (ev.type) {
    case "session.start": {
      const problem = upsertProblemFromHint(db, ev.payload.problem);
      const { session } = startSession(db, { id: ev.payload.sessionId, problemId: problem.id, origin: "extension", startedAt: ev.payload.startedAt });
      if (session.id !== ev.payload.sessionId) setMeta(db, `session_alias:${ev.payload.sessionId}`, session.id);
      return { sessionId: session.id };
    }
    case "session.activity": {
      const id = resolveSessionId(db, ev.payload.sessionId)!;
      recordActivity(db, id, ev.payload.activeMs, ev.payload.lastActivityAt);
      return { sessionId: id };
    }
    case "session.pause": {
      const id = resolveSessionId(db, ev.payload.sessionId)!;
      pauseSession(db, id, ev.payload.at);
      return { sessionId: id };
    }
    case "session.resume": {
      const id = resolveSessionId(db, ev.payload.sessionId)!;
      resumeSession(db, id, ev.payload.at);
      return { sessionId: id };
    }
    case "session.notes": {
      const id = resolveSessionId(db, ev.payload.sessionId)!;
      const { notes, timeComplexity, spaceComplexity } = ev.payload;
      updateSessionNotes(db, id, {
        ...(notes !== undefined ? { notes } : {}),
        ...(timeComplexity !== undefined ? { timeComplexity } : {}),
        ...(spaceComplexity !== undefined ? { spaceComplexity } : {}),
      });
      return { sessionId: id };
    }
    case "session.finish": {
      const id = resolveSessionId(db, ev.payload.sessionId)!;
      finishSession(db, id, ev.payload.reflection, ev.payload.endedAt);
      return { sessionId: id };
    }
    case "session.abandon": {
      const id = resolveSessionId(db, ev.payload.sessionId)!;
      abandonSession(db, id, ev.payload.at);
      return { sessionId: id };
    }
    case "submission.captured": {
      const problem = upsertProblemFromHint(db, ev.payload.problem);
      const claimed = resolveSessionId(db, ev.payload.sessionId);
      const { submission } = recordSubmission(db, {
        problemId: problem.id,
        claimedSessionId: claimed,
        kind: ev.payload.kind,
        platformSubmissionId: ev.payload.platformSubmissionId,
        lang: ev.payload.lang,
        code: ev.payload.code,
        submittedAt: ev.payload.submittedAt,
        captureSource: "extension_network",
        syncEventId: ev.id,
      });
      return { sessionId: submission.sessionId ?? undefined };
    }
    case "submission.result": {
      const problem = upsertProblemFromHint(db, ev.payload.problem);
      const claimed = resolveSessionId(db, ev.payload.sessionId);
      const sub = applyJudgeResult(db, {
        problemId: problem.id,
        claimedSessionId: claimed,
        kind: ev.payload.kind,
        platformSubmissionId: ev.payload.platformSubmissionId,
        verdict: ev.payload.verdict,
        statusCode: ev.payload.statusCode,
        runtime: ev.payload.runtime,
        memory: ev.payload.memory,
        totalCorrect: ev.payload.totalCorrect,
        totalTestcases: ev.payload.totalTestcases,
        lang: ev.payload.lang,
        judgedAt: ev.payload.judgedAt,
        details: ev.payload.details,
        syncEventId: ev.id,
      });
      return { sessionId: sub.sessionId ?? undefined };
    }
  }
}

function sessionIdOf(ev: SyncEvent): string | null {
  return "sessionId" in ev.payload ? (ev.payload.sessionId ?? null) : null;
}

/**
 * Process a batch in order. Each event is applied at most once (keyed by its
 * UUID). Permanent failures are stored and reported as "rejected" so the
 * client can stop retrying; nothing is silently dropped.
 */
export function processSyncEvents(db: Db, raw: unknown[], log: (msg: string, extra?: unknown) => void = () => {}): ProcessResult[] {
  const results: ProcessResult[] = [];
  for (const item of raw) {
    const parsed = syncEventSchema.safeParse(item);
    if (!parsed.success) {
      const id = typeof (item as { id?: unknown })?.id === "string" ? (item as { id: string }).id : "unknown";
      const error = `invalid event: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`.slice(0, 500);
      log("sync: rejected invalid event", { id, error });
      results.push({ id, status: "rejected", error });
      continue;
    }
    const ev = parsed.data;
    const existing = db.select().from(syncEvents).where(eq(syncEvents.id, ev.id)).get();
    if (existing) {
      results.push({ id: ev.id, status: existing.status === "rejected" ? "rejected" : "duplicate", error: existing.error ?? undefined });
      continue;
    }
    try {
      const out = db.transaction((tx) => {
        const r = apply(tx, ev);
        tx.insert(syncEvents)
          .values({ id: ev.id, clientId: ev.clientId, seq: ev.seq, type: ev.type, sessionId: r.sessionId ?? sessionIdOf(ev), payload: redact(ev), status: "processed", clientCreatedAt: ev.createdAt })
          .run();
        return r;
      });
      results.push({ id: ev.id, status: "processed", sessionId: out.sessionId });
    } catch (e) {
      const error = e instanceof DomainError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
      log("sync: event failed", { id: ev.id, type: ev.type, error });
      if (!(e instanceof DomainError)) throw e; // unexpected → 500, client retries later
      db.insert(syncEvents)
        .values({ id: ev.id, clientId: ev.clientId, seq: ev.seq, type: ev.type, sessionId: sessionIdOf(ev), payload: redact(ev), status: "rejected", error, clientCreatedAt: ev.createdAt })
        .onConflictDoNothing()
        .run();
      results.push({ id: ev.id, status: "rejected", error });
    }
  }
  return results;
}

/** Event log keeps metadata for debugging, not a second copy of source code. */
function redact(ev: SyncEvent) {
  if (ev.type === "submission.captured") return { ...ev, payload: { ...ev.payload, code: ev.payload.code ? `[${ev.payload.code.length} chars]` : null } };
  return ev;
}

export function recentSyncEvents(db: Db, limit = 50) {
  return db.select().from(syncEvents).orderBy(desc(syncEvents.receivedAt)).limit(limit).all();
}

export { getSession };
