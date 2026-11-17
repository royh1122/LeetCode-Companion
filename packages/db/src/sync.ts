import { desc, eq } from "drizzle-orm";
import { SESSION_TEXT_FIELDS, syncEventSchema, type SessionText, type SyncEvent, type SyncEventResult } from "@lcc/shared";
import type { Db } from "./client";
import { bumpRevision, getMeta, setMeta } from "./meta";
import { upsertProblemFromHint } from "./problems";
import { syncEvents } from "./schema";
import {
  DomainError,
  abandonSession,
  finishSession,
  getSession,
  isOpenSession,
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

/** Heads the extension's text when it was kept next to newer dashboard text instead of replacing it. */
export const EXTENSION_CONFLICT_MARK = "--- Typed in the extension at the same time (kept, not merged) ---";

type Applied = { sessionId?: string; stored?: SessionText; conflict?: boolean };

function apply(db: Db, ev: SyncEvent): Applied {
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
      const patch: SessionText = {};
      for (const f of SESSION_TEXT_FIELDS) if (ev.payload[f] !== undefined) patch[f] = ev.payload[f];
      const s = getSession(db, id);
      let conflict = false;
      if (s && !isOpenSession(s)) {
        // A snapshot that arrives after the session ended (e.g. it was finished in the dashboard
        // first) must not replace the final text: it only fills fields that were left empty.
        for (const f of SESSION_TEXT_FIELDS) if (s[f]?.trim()) delete patch[f];
      } else if (s && ev.payload.base) {
        // The dashboard's text changed since the extension last saw it (typed there meanwhile):
        // keep it, and keep the extension's text below the notes instead of replacing it.
        const refused = SESSION_TEXT_FIELDS.filter((f) => {
          const base = ev.payload.base![f];
          const stored = s[f] ?? "";
          return patch[f] !== undefined && base !== undefined && stored !== base && stored !== patch[f];
        });
        if (refused.length) {
          conflict = true;
          const kept = refused.map((f) => (f === "notes" ? patch.notes! : `${f === "timeComplexity" ? "Time" : "Space"} complexity: ${patch[f]}`));
          const notes = patch.notes !== undefined && !refused.includes("notes") ? patch.notes : (s.notes ?? "");
          for (const f of refused) delete patch[f];
          patch.notes = `${notes}${notes ? "\n\n" : ""}${EXTENSION_CONFLICT_MARK}\n${kept.join("\n")}`;
        }
      }
      updateSessionNotes(db, id, patch);
      // The dashboard polls this to pick up text typed in the extension.
      bumpRevision(db);
      const after = getSession(db, id);
      const stored: SessionText = {};
      if (after) for (const f of SESSION_TEXT_FIELDS) stored[f] = after[f] ?? "";
      return { sessionId: id, stored, conflict };
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
export function processSyncEvents(db: Db, raw: unknown[], log: (msg: string, extra?: unknown) => void = () => {}, deviceId: string | null = null): ProcessResult[] {
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
          .values({ id: ev.id, clientId: ev.clientId, seq: ev.seq, type: ev.type, sessionId: r.sessionId ?? sessionIdOf(ev), payload: redact(ev), status: "processed", clientCreatedAt: ev.createdAt, deviceId })
          .run();
        return r;
      });
      results.push({ id: ev.id, status: "processed", sessionId: out.sessionId, ...(out.stored ? { stored: out.stored, conflict: !!out.conflict } : {}) });
    } catch (e) {
      const error = e instanceof DomainError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
      log("sync: event failed", { id: ev.id, type: ev.type, error });
      if (!(e instanceof DomainError)) throw e; // unexpected → 500, client retries later
      db.insert(syncEvents)
        .values({ id: ev.id, clientId: ev.clientId, seq: ev.seq, type: ev.type, sessionId: sessionIdOf(ev), payload: redact(ev), status: "rejected", error, clientCreatedAt: ev.createdAt, deviceId })
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
  // The base is only for the conflict check: no need for another copy of the notes.
  if (ev.type === "session.notes" && ev.payload.base) return { ...ev, payload: { ...ev.payload, base: undefined } };
  return ev;
}

export function recentSyncEvents(db: Db, limit = 50) {
  return db.select().from(syncEvents).orderBy(desc(syncEvents.receivedAt)).limit(limit).all();
}

export { getSession };
