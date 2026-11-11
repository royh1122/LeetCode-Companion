import { and, eq, inArray, lte } from "drizzle-orm";
import { toLocalDate, type ExtensionContext, type ExtensionSessionState } from "@lcc/shared";
import type { Db } from "./client";
import { getAppSettings } from "./meta";
import { emptyStats, getProblemBySlug, getProblemStats } from "./problems";
import { assignments, sessions, submissions } from "./schema";
import { getOpenSessionForProblem, getSession, isReviewSessionType } from "./sessions";
import { getMeta } from "./meta";

/** What the extension shows when you land on a problem page. Read-only. */
export function getExtensionContext(db: Db, slug: string, dashboardUrl: string, now = Date.now()): ExtensionContext {
  const settings = getAppSettings(db);
  const problem = getProblemBySlug(db, slug);
  if (!problem) return { problem: null, openSession: null, todayAssignment: null, settings: { idleThresholdSec: settings.idleThresholdSec }, dashboardUrl };
  const stats = getProblemStats(db, settings, [problem.id], now).get(problem.id) ?? emptyStats();
  const open = getOpenSessionForProblem(db, problem.id);
  const today = toLocalDate(now, settings.timeZone);
  const a = db
    .select()
    .from(assignments)
    .where(and(eq(assignments.problemId, problem.id), inArray(assignments.status, ["pending", "in_progress"]), lte(assignments.scheduledDate, today)))
    .get();
  return {
    problem: {
      id: problem.id,
      slug: problem.slug,
      title: problem.title,
      frontendId: problem.frontendId,
      difficulty: problem.difficulty,
      patterns: problem.patterns,
      mastery: stats.mastery,
      sessionCount: stats.completedCount,
      lastPracticedAt: stats.lastPracticedAt,
      nextReviewDate: stats.nextDueDate,
    },
    openSession: open
      ? { id: open.id, type: open.type, status: open.status, startedAt: open.startedAt, activeMs: open.activeMs, notes: open.notes, timeComplexity: open.timeComplexity, spaceComplexity: open.spaceComplexity, isReview: isReviewSessionType(open.type) }
      : null,
    todayAssignment: a ? { id: a.id, type: a.type } : null,
    settings: { idleThresholdSec: settings.idleThresholdSec },
    dashboardUrl,
  };
}

export function getExtensionSessionState(db: Db, id: string): ExtensionSessionState | null {
  const real = getMeta(db, `session_alias:${id}`) ?? id;
  const s = getSession(db, real);
  if (!s) return null;
  const subs = db.select().from(submissions).where(eq(submissions.sessionId, s.id)).all();
  return {
    id: s.id,
    status: s.status,
    outcome: s.outcome,
    endedAt: s.endedAt,
    activeMs: s.activeMs,
    submissions: subs.map((x) => ({ id: x.id, verdict: x.verdict, kind: x.kind, submittedAt: x.submittedAt, platformSubmissionId: x.platformSubmissionId })),
  };
}

export { sessions };
