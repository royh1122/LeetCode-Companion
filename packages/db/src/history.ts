import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { effectiveDuration, toLocalDate, type LocalDate } from "@lcc/shared";
import type { Db } from "./client";
import { getAppSettings } from "./meta";
import { getNotes, listNoteRevisions } from "./notes";
import { emptyStats, getProblemBySlug, getProblemStats } from "./problems";
import { assignments, problems, reviewState, sessions, submissions, type Session, type Submission } from "./schema";

export type SessionWithSubs = Session & {
  submissions: Submission[];
  durationMs: number;
  durationApprox: boolean;
  durationSource: string;
  submitCount: number;
  runCount: number;
  finalVerdict: string | null;
  assignmentType: string | null;
};

export function decorateSessions(list: Session[], subs: Submission[], assignmentTypes: Map<number, string>, now = Date.now()): SessionWithSubs[] {
  const bySession = new Map<string, Submission[]>();
  for (const s of subs) {
    if (!s.sessionId) continue;
    const arr = bySession.get(s.sessionId) ?? [];
    arr.push(s);
    bySession.set(s.sessionId, arr);
  }
  return list.map((s) => {
    const own = (bySession.get(s.id) ?? []).sort((a, b) => a.submittedAt - b.submittedAt);
    const submits = own.filter((x) => x.kind === "submit");
    const d = effectiveDuration(s, now);
    return {
      ...s,
      submissions: own,
      durationMs: d.ms,
      durationApprox: d.approx,
      durationSource: d.source,
      submitCount: submits.length,
      runCount: own.length - submits.length,
      finalVerdict: submits.length ? submits[submits.length - 1]!.verdict : null,
      assignmentType: s.assignmentId != null ? (assignmentTypes.get(s.assignmentId) ?? null) : null,
    };
  });
}

/** Everything the question detail page needs. */
export function getProblemDetail(db: Db, slug: string, now = Date.now()) {
  const problem = getProblemBySlug(db, slug);
  if (!problem) return null;
  const settings = getAppSettings(db);
  const list = db.select().from(sessions).where(eq(sessions.problemId, problem.id)).orderBy(asc(sessions.startedAt)).all();
  const subs = db.select().from(submissions).where(eq(submissions.problemId, problem.id)).orderBy(asc(submissions.submittedAt)).all();
  const aIds = list.map((s) => s.assignmentId).filter((x): x is number => x != null);
  const aTypes = new Map(
    db
      .select({ id: assignments.id, type: assignments.type })
      .from(assignments)
      .where(inArray(assignments.id, aIds.length ? aIds : [-1]))
      .all()
      .map((a) => [a.id, a.type as string]),
  );
  const stats = getProblemStats(db, settings, [problem.id], now).get(problem.id) ?? emptyStats();
  const rs = db.select().from(reviewState).where(eq(reviewState.problemId, problem.id)).get() ?? null;
  const upcoming = db
    .select()
    .from(assignments)
    .where(and(eq(assignments.problemId, problem.id), inArray(assignments.status, ["pending", "in_progress"])))
    .orderBy(asc(assignments.scheduledDate))
    .all();
  return {
    problem,
    stats,
    reviewState: rs,
    notes: getNotes(db, problem.id),
    noteRevisions: listNoteRevisions(db, problem.id),
    sessions: decorateSessions(list, subs, aTypes, now),
    unattributed: subs.filter((s) => !s.sessionId),
    openAssignments: upcoming,
    today: toLocalDate(now, settings.timeZone),
  };
}

export interface HistoryFilters {
  q?: string;
  outcome?: string;
  type?: string;
  from?: LocalDate;
  to?: LocalDate;
  hints?: "yes" | "no";
  limit?: number;
}

/** All sessions across problems, newest first. */
export function listSessionHistory(db: Db, f: HistoryFilters = {}, now = Date.now()) {
  const conds = [inArray(sessions.status, ["completed", "abandoned", "in_progress", "paused"])];
  if (f.outcome) conds.push(eq(sessions.outcome, f.outcome as never));
  if (f.type) conds.push(eq(sessions.type, f.type as never));
  if (f.from) conds.push(gte(sessions.endedDate, f.from));
  if (f.to) conds.push(lte(sessions.endedDate, f.to));
  if (f.hints === "yes") conds.push(eq(sessions.hintsUsed, true));
  if (f.hints === "no") conds.push(eq(sessions.hintsUsed, false));
  if (f.q) {
    const q = `%${f.q.toLowerCase().replace(/^#/, "")}%`;
    conds.push(sql`(lower(${problems.title}) like ${q} or ${problems.frontendId} = ${f.q.replace(/^#/, "")} or lower(coalesce(${sessions.notes},'') || ' ' || coalesce(${sessions.mistakes},'') || ' ' || coalesce(${sessions.struggles},'') || ' ' || coalesce(${sessions.takeaway},'')) like ${q})`);
  }
  const rows = db
    .select({ s: sessions, p: problems })
    .from(sessions)
    .innerJoin(problems, eq(problems.id, sessions.problemId))
    .where(and(...conds))
    .orderBy(desc(sessions.startedAt))
    .limit(f.limit ?? 300)
    .all();
  const ids = rows.map((r) => r.s.id);
  const subs = db
    .select()
    .from(submissions)
    .where(inArray(submissions.sessionId, ids.length ? ids : ["-"]))
    .all();
  const decorated = decorateSessions(
    rows.map((r) => r.s),
    subs,
    new Map(),
    now,
  );
  return decorated.map((s, i) => ({ session: s, problem: rows[i]!.p }));
}

/** Recurring mistakes: the text of every "mistakes"/"struggles" note for a problem or overall. */
export function listMistakes(db: Db, limit = 100) {
  return db
    .select({ s: sessions, p: { id: problems.id, slug: problems.slug, title: problems.title, patterns: problems.patterns } })
    .from(sessions)
    .innerJoin(problems, eq(problems.id, sessions.problemId))
    .where(sql`coalesce(${sessions.mistakes}, '') <> '' or coalesce(${sessions.struggles}, '') <> ''`)
    .orderBy(desc(sessions.endedAt))
    .limit(limit)
    .all();
}

export function getSessionDetail(db: Db, id: string, now = Date.now()) {
  const s = db.select().from(sessions).where(eq(sessions.id, id)).get();
  if (!s) return null;
  const problem = db.select().from(problems).where(eq(problems.id, s.problemId)).get()!;
  const subs = db.select().from(submissions).where(eq(submissions.sessionId, id)).orderBy(asc(submissions.submittedAt)).all();
  const assignment = s.assignmentId != null ? (db.select().from(assignments).where(eq(assignments.id, s.assignmentId)).get() ?? null) : null;
  const [decorated] = decorateSessions([s], subs, new Map(assignment ? [[assignment.id, assignment.type]] : []), now);
  const previous = db
    .select()
    .from(sessions)
    .where(and(eq(sessions.problemId, s.problemId), eq(sessions.status, "completed")))
    .orderBy(desc(sessions.endedAt))
    .all()
    .filter((x) => x.id !== id);
  const prevIds = previous.map((p) => p.id);
  const prevSubs = db
    .select()
    .from(submissions)
    .where(inArray(submissions.sessionId, prevIds.length ? prevIds : ["-"]))
    .orderBy(desc(submissions.submittedAt))
    .all();
  const lastAccepted = prevSubs.find((x) => x.kind === "submit" && x.verdict === "Accepted" && x.code) ?? prevSubs.find((x) => x.code) ?? null;
  const unattributedForProblem = db
    .select()
    .from(submissions)
    .where(and(eq(submissions.problemId, s.problemId), sql`${submissions.sessionId} is null`))
    .orderBy(desc(submissions.submittedAt))
    .all();
  return {
    session: decorated!,
    problem,
    assignment,
    notes: getNotes(db, s.problemId),
    previousSessions: decorateSessions(previous, prevSubs, new Map(), now),
    previousCode: lastAccepted,
    unattributedForProblem,
  };
}
