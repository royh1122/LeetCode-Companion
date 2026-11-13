"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import * as core from "@lcc/db";
import {
  OUTCOMES,
  VERDICTS,
  appSettingsSchema,
  isLocalDate,
  planSettingsSchema,
  problemUrl,
  reflectionSchema,
  toLocalDate,
  type LocalDate,
} from "@lcc/shared";
import { db, log } from "./server";

/**
 * Server actions for the dashboard. Next.js verifies the Origin header for
 * server actions, so other websites cannot invoke them.
 */

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

function wrap<T>(fn: () => T): ActionResult<T> {
  try {
    const data = fn();
    revalidatePath("/", "layout");
    return { ok: true, data };
  } catch (e) {
    if (e instanceof z.ZodError) return { ok: false, error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    const msg = e instanceof Error ? e.message : String(e);
    if (!(e instanceof core.DomainError)) log("action failed", msg);
    return { ok: false, error: msg };
  }
}

const date = z.string().refine(isLocalDate, "Invalid date");

export async function startPractice(input: { assignmentId?: number | null; problemId: number }) {
  return wrap(() => {
    const d = db();
    const { session, resumed } = core.startSession(d, { problemId: input.problemId, assignmentId: input.assignmentId ?? null, origin: "dashboard" });
    const p = core.getProblemById(d, session.problemId)!;
    return { sessionId: session.id, resumed, url: `${problemUrl(p.slug)}#lcc-session=${session.id}` };
  });
}

export async function pauseSession(id: string) {
  return wrap(() => void core.pauseSession(db(), id));
}
export async function resumeSession(id: string) {
  return wrap(() => void core.resumeSession(db(), id));
}
export async function abandonSession(id: string) {
  return wrap(() => core.abandonSession(db(), id));
}

export async function saveSessionNotes(
  id: string,
  patch: { notes?: string; struggles?: string; takeaway?: string; mistakes?: string; timeComplexity?: string; spaceComplexity?: string },
) {
  try {
    const p = z
      .object({
        notes: z.string().max(20000),
        struggles: z.string().max(5000),
        takeaway: z.string().max(5000),
        mistakes: z.string().max(5000),
        timeComplexity: z.string().max(200),
        spaceComplexity: z.string().max(200),
      })
      .partial()
      .parse(patch);
    core.updateSessionNotes(db(), id, p);
    return { ok: true as const, savedAt: Date.now() };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function revealInSession(id: string, what: "hints" | "notes" | "code") {
  return wrap(() => core.recordReveal(db(), id, z.enum(["hints", "notes", "code"]).parse(what)));
}

export async function finishSessionAction(id: string, reflection: unknown, endedAt?: number | null) {
  return wrap(() => {
    const r = reflectionSchema.parse(reflection);
    const s = core.finishSession(db(), id, r, endedAt ?? Date.now());
    return { nextReviewDate: s.nextReviewDate };
  });
}

export async function editSession(
  id: string,
  patch: {
    notes?: string;
    mistakes?: string;
    takeaway?: string;
    struggles?: string;
    timeComplexity?: string;
    spaceComplexity?: string;
    durationMin?: number | null;
    outcome?: string;
    hintsUsed?: boolean;
    difficultyRating?: number | null;
  },
) {
  return wrap(() => {
    const p = z
      .object({
        notes: z.string().max(20000),
        mistakes: z.string().max(5000),
        takeaway: z.string().max(5000),
        struggles: z.string().max(5000),
        timeComplexity: z.string().max(200),
        spaceComplexity: z.string().max(200),
        durationMin: z.number().min(0).max(1440).nullable(),
        outcome: z.enum(OUTCOMES),
        hintsUsed: z.boolean(),
        difficultyRating: z.number().int().min(1).max(5).nullable(),
      })
      .partial()
      .parse(patch);
    const { durationMin, ...rest } = p;
    core.editCompletedSession(db(), id, { ...rest, ...(durationMin !== undefined ? { durationOverrideMs: durationMin == null ? null : Math.round(durationMin * 60_000) } : {}) });
  });
}

/** Destructive: always preceded by a database backup so a mistake can be undone with db:restore. */
async function withBackup<T>(label: string, fn: () => T): Promise<ActionResult<T>> {
  try {
    await core.backupDatabase(db().$client, label);
  } catch (e) {
    return { ok: false, error: `Backup failed, nothing was deleted: ${e instanceof Error ? e.message : String(e)}` };
  }
  return wrap(fn);
}

export async function deleteSessionAction(id: string) {
  const sid = z.string().min(1).max(100).parse(id);
  return withBackup("pre-delete-session", () => {
    const r = core.deleteSession(db(), sid, toLocalDate(Date.now(), core.getAppSettings(db()).timeZone));
    const p = core.getProblemById(db(), r.problemId);
    return { ...r, slug: p?.slug ?? null };
  });
}

export async function deleteSubmissionAction(id: number) {
  const sid = z.number().int().positive().parse(id);
  return withBackup("pre-delete-submission", () => {
    core.deleteSubmission(db(), sid);
  });
}

export async function logSubmissionManually(sessionId: string, input: { verdict: string; code?: string; lang?: string }) {
  return wrap(() => {
    const d = db();
    const s = core.getSession(d, sessionId);
    if (!s) throw new Error("Session not found");
    const v = z.enum(VERDICTS).parse(input.verdict);
    core.recordSubmission(d, {
      problemId: s.problemId,
      claimedSessionId: sessionId,
      forceSessionId: sessionId,
      kind: "submit",
      platformSubmissionId: null,
      lang: input.lang?.slice(0, 40) || null,
      code: input.code?.slice(0, 200_000) || null,
      submittedAt: Date.now(),
      captureSource: "manual",
      verdict: v,
    });
  });
}

export async function linkSubmissionAction(submissionId: number, sessionId: string | null) {
  return wrap(() => core.linkSubmission(db(), submissionId, sessionId));
}

export async function saveProblemNotes(problemId: number, patch: Record<string, string>) {
  try {
    core.saveNotes(db(), problemId, patch);
    return { ok: true as const, savedAt: Date.now() };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function setProblemPatterns(problemId: number, patterns: string[]) {
  return wrap(() => core.updateProblemPatterns(db(), problemId, z.array(z.string().max(80)).max(12).parse(patterns)));
}

export async function logPastAttempt(input: { problemId: number; date: string; outcome: string; durationMin?: number | null; notes?: string; hintsUsed?: boolean }) {
  return wrap(() => {
    const p = z
      .object({ problemId: z.number().int(), date, outcome: z.enum(OUTCOMES), durationMin: z.number().min(0).max(1440).nullish(), notes: z.string().max(20000).optional(), hintsUsed: z.boolean().optional() })
      .parse(input);
    core.logManualAttempt(db(), p);
  });
}

export async function rescheduleAction(assignmentId: number, to: string) {
  return wrap(() => core.rescheduleAssignment(db(), assignmentId, date.parse(to)));
}
export async function skipAssignmentAction(assignmentId: number) {
  return wrap(() => core.skipAssignment(db(), assignmentId));
}
export async function addToDayAction(problemId: number, on: string, asNew = false) {
  return wrap(() => void core.addAssignment(db(), problemId, date.parse(on), { asNew }));
}
export async function restartProblemAction(problemId: number) {
  return wrap(() => {
    const d = db();
    const today = core.todayFor(d);
    core.addAssignment(d, problemId, today, { asNew: true, note: "Restarted — practicing as new (history kept)" });
  });
}
export async function postponeReviewAction(problemId: number, to: string) {
  return wrap(() => core.postponeReview(db(), problemId, date.parse(to)));
}
export async function pullMoreReviewsAction(n: number) {
  return wrap(() => core.pullMoreReviews(db(), z.number().int().min(1).max(50).parse(n)));
}
export async function pullEarlyReviewsAction(n: number) {
  return wrap(() => core.pullMoreReviews(db(), z.number().int().min(1).max(50).parse(n), Date.now(), { early: true }));
}
export async function doMoreTodayAction(n: number) {
  return wrap(() => core.doMoreToday(db(), z.number().int().min(1).max(50).parse(n)));
}

// ---- Lists ----
/** Import (or replace) a study list from pasted links, slugs or study-plan JSON. History is never touched. */
export async function importListAction(input: { name: string; text: string }) {
  return wrap(() => {
    const p = z.object({ name: z.string().max(100), text: z.string().min(1).max(1_000_000) }).parse(input);
    return core.importList(db(), core.parseListText(p.text, p.name));
  });
}
/** Import one of the lists that ship with the app. */
export async function importBuiltInListAction(slug: string) {
  return wrap(() => {
    const b = core.builtInLists().find((x) => x.list.slug === slug);
    if (!b) throw new core.DomainError("not_found", "Unknown list");
    return core.importList(db(), b.list);
  });
}

// ---- Plan ----
export async function createPlanAction(input: { name?: string; startDate: string; timeZone?: string; settings?: unknown }) {
  return wrap(() => {
    const settings = input.settings ? planSettingsSchema.partial().parse(input.settings) : undefined;
    return core.createPlan(db(), { name: input.name, startDate: date.parse(input.startDate), timeZone: input.timeZone, settings }).id;
  });
}
export async function updatePlanAction(planId: number, patch: unknown) {
  return wrap(() => {
    const p = planSettingsSchema
      .partial()
      .extend({ name: z.string().min(1).max(100).optional(), startDate: date.optional() })
      .parse(patch);
    core.updatePlanSettings(db(), planId, p);
  });
}
export async function setPlanPausedAction(planId: number, paused: boolean) {
  return wrap(() => core.setPlanPaused(db(), planId, paused));
}
export async function skipDayAction(planId: number, day: string, skip: boolean) {
  return wrap(() => (skip ? core.skipDay(db(), planId, date.parse(day)) : core.unskipDay(db(), planId, date.parse(day))));
}
const dayModeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("normal") }),
  z.object({ mode: z.literal("skip") }),
  z.object({ mode: z.literal("light"), newQuota: z.number().int().min(0).max(50) }),
]);
/** Plan a future day: normal, skipped, or light (fewer new questions, no automatic reviews). */
export async function setDayModeAction(planId: number, day: string, mode: unknown) {
  return wrap(() => core.setDayMode(db(), z.number().int().parse(planId), date.parse(day), dayModeSchema.parse(mode)));
}
export async function moveQueueAction(planId: number, problemId: number, to: "top" | "up" | "down" | "bottom") {
  return wrap(() => core.moveQueueItem(db(), planId, problemId, to));
}
export async function enqueueAction(planId: number, problemId: number, where: "front" | "end") {
  return wrap(() => core.enqueueProblem(db(), planId, problemId, where));
}
export async function removeFromQueueAction(planId: number, problemId: number) {
  return wrap(() => core.removeFromQueue(db(), planId, problemId));
}

/** Add a problem that isn't in any list, by slug or URL. Metadata is filled in later if the extension sees the page. */
export async function addProblemBySlug(input: string, title?: string) {
  return wrap(() => {
    const raw = input.trim();
    const m = /problems\/([a-z0-9-]+)/i.exec(raw);
    const slug = (m?.[1] ?? raw).toLowerCase();
    if (!/^[a-z0-9-]{1,200}$/.test(slug)) throw new Error("Enter a LeetCode problem URL or slug, e.g. two-sum");
    const p = core.upsertProblemFromHint(db(), { slug, title: title?.trim() || undefined });
    return { id: p.id, slug: p.slug };
  });
}

// ---- Settings / data ----
export async function updateSettingsAction(patch: unknown) {
  return wrap(() => void core.updateAppSettings(db(), appSettingsSchema.partial().parse(patch)));
}
export async function rotateTokenAction() {
  return wrap(() => core.rotateExtensionToken(db()));
}
export async function backupNowAction() {
  try {
    const file = await core.backupDatabase(db().$client, "manual");
    return { ok: true as const, data: file };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}
export async function importJsonAction(text: string) {
  try {
    const d = db();
    await core.backupDatabase(d.$client, "pre-import");
    const report = core.importAll(d, JSON.parse(text));
    revalidatePath("/", "layout");
    return { ok: true as const, data: report };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}
