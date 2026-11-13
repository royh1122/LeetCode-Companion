import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  ASSIGNMENT_STATUSES,
  ASSIGNMENT_TYPES,
  ATTRIBUTIONS,
  CAPTURE_SOURCES,
  DIFFICULTIES,
  OUTCOMES,
  SESSION_ORIGINS,
  SESSION_STATUSES,
  SESSION_TYPES,
  SUBMISSION_KINDS,
  VERDICTS,
  isLocalDate,
  planSettingsSchema,
} from "@lcc/shared";
import type { Db } from "./client";
import { bumpRevision, getAppSettings, getMeta, setMeta } from "./meta";
import { NOTE_FIELDS } from "./notes";
import { getProblemBySlug } from "./problems";
import {
  assignments,
  planDays,
  planLightDays,
  planQueue,
  planSkips,
  problemNoteRevisions,
  problemNotes,
  problems,
  sessions,
  studyListProblems,
  studyLists,
  studyPlans,
  submissions,
} from "./schema";
import { recomputeReviewState } from "./sessions";

export const EXPORT_FORMAT = "leetcode-companion-export";
export const EXPORT_VERSION = 1;

/**
 * Portable JSON export. Problems are referenced by slug (not internal ids),
 * so an export can be imported into any database.
 */
export function exportAll(db: Db) {
  const probs = db.select().from(problems).all();
  const slugOf = new Map(probs.map((p) => [p.id, p.slug]));
  const lists = db.select().from(studyLists).all();
  const members = db.select().from(studyListProblems).all();
  const plans = db.select().from(studyPlans).all();
  const queue = db.select().from(planQueue).all();
  const skips = db.select().from(planSkips).all();
  const lightDays = db.select().from(planLightDays).all();
  const strip = <T extends { problemId: number }>(r: T) => {
    const { problemId, ...rest } = r;
    return { ...rest, problemSlug: slugOf.get(problemId)! };
  };
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    settings: getAppSettings(db),
    problems: probs.map(({ id: _id, ...p }) => p),
    studyLists: lists.map((l) => ({
      slug: l.slug,
      name: l.name,
      description: l.description,
      source: l.source,
      problems: members
        .filter((m) => m.listId === l.id)
        .sort((a, b) => a.position - b.position)
        .map((m) => ({ problemSlug: slugOf.get(m.problemId)!, position: m.position, groupName: m.groupName })),
    })),
    plans: plans.map((p) => ({
      ...p,
      queue: queue.filter((q) => q.planId === p.id).map(({ id: _i, planId: _p, sourceListId, ...q }) => ({ ...strip(q), sourceList: lists.find((l) => l.id === sourceListId)?.slug ?? null })),
      skips: skips.filter((s) => s.planId === p.id).map((s) => s.date),
      lightDays: lightDays.filter((l) => l.planId === p.id).map((l) => ({ date: l.date, newQuota: l.newQuota })),
    })),
    assignments: db.select().from(assignments).all().map(strip),
    sessions: db.select().from(sessions).all().map(strip),
    submissions: db.select().from(submissions).all().map(({ id: _id, ...s }) => strip(s)),
    notes: db.select().from(problemNotes).all().map(strip),
    noteRevisions: db.select().from(problemNoteRevisions).all().map(({ id: _id, ...r }) => strip(r)),
  };
}
export type ExportData = ReturnType<typeof exportAll>;

// A backup file may come from someone else: check every field the app later relies on,
// so a hand-edited file can't store values that break pages (wrong JSON shapes, unknown states).
const slug = z.string().regex(/^[a-z0-9-]{1,200}$/);
const int = z.number().int();
const opt = <T extends z.ZodType>(t: T) => t.nullish();
const date = z.string().refine(isLocalDate, "expected YYYY-MM-DD");
const exportSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.number().int().max(EXPORT_VERSION),
  problems: z.array(
    z
      .object({
        slug,
        title: z.string().max(300),
        url: z.string().max(500),
        difficulty: z.enum(DIFFICULTIES),
        topics: z.array(z.object({ name: z.string(), slug: z.string() })),
        patterns: z.array(z.string()),
        platformQuestionId: opt(z.string()),
        frontendId: opt(z.string()),
        paidOnly: z.boolean(),
      })
      .passthrough(),
  ),
  studyLists: z.array(z.object({ slug: z.string().max(100), name: z.string().max(100), problems: z.array(z.object({ problemSlug: slug, position: int, groupName: opt(z.string()) }).passthrough()) }).passthrough()).default([]),
  plans: z.array(z.object({ id: int, name: z.string(), status: z.enum(["active", "paused", "archived"]), startDate: date, timeZone: z.string() }).passthrough()).default([]),
  assignments: z
    .array(z.object({ id: int, problemSlug: slug, type: z.enum(ASSIGNMENT_TYPES), status: z.enum(ASSIGNMENT_STATUSES), scheduledDate: date, originalDate: date }).passthrough())
    .default([]),
  sessions: z
    .array(
      z
        .object({
          id: z.string(),
          problemSlug: slug,
          type: z.enum(SESSION_TYPES),
          status: z.enum(SESSION_STATUSES),
          origin: z.enum(SESSION_ORIGINS),
          outcome: opt(z.enum(OUTCOMES)),
          startedAt: int,
          endedAt: opt(int),
          patterns: opt(z.array(z.string())),
        })
        .passthrough(),
    )
    .default([]),
  submissions: z
    .array(
      z
        .object({
          problemSlug: slug,
          fingerprint: z.string(),
          kind: z.enum(SUBMISSION_KINDS),
          verdict: z.enum(VERDICTS),
          captureSource: z.enum(CAPTURE_SOURCES),
          attribution: z.enum(ATTRIBUTIONS),
          submittedAt: int,
          details: opt(z.record(z.string(), z.string().nullable())),
        })
        .passthrough(),
    )
    .default([]),
  notes: z.array(z.object({ problemSlug: z.string() }).passthrough()).default([]),
  noteRevisions: z.array(z.object({ problemSlug: z.string() }).passthrough()).default([]),
});

export interface ImportReport {
  problems: { inserted: number; existing: number };
  lists: { inserted: number; existing: number };
  plans: { inserted: number; skipped: number; reason?: string };
  assignments: { inserted: number };
  sessions: { inserted: number; existing: number; conflicts: number };
  submissions: { inserted: number; existing: number };
  notes: { inserted: number; identical: number; conflictsKeptAsRevision: number };
}

/**
 * Merge an export into this database. Never overwrites existing records:
 *  - problems / lists / sessions / submissions are matched by natural key and
 *    only inserted when missing;
 *  - a differing note is stored as a revision (both texts survive);
 *  - plans + assignments are only imported into a database with no plans.
 */
export function importAll(db: Db, input: unknown): ImportReport {
  const data = exportSchema.parse(input);
  const report: ImportReport = {
    problems: { inserted: 0, existing: 0 },
    lists: { inserted: 0, existing: 0 },
    plans: { inserted: 0, skipped: 0 },
    assignments: { inserted: 0 },
    sessions: { inserted: 0, existing: 0, conflicts: 0 },
    submissions: { inserted: 0, existing: 0 },
    notes: { inserted: 0, identical: 0, conflictsKeptAsRevision: 0 },
  };
  db.transaction((tx) => {
    const pid = (slug: string) => {
      const p = getProblemBySlug(tx, slug);
      if (!p) throw new Error(`Import references unknown problem ${slug}`);
      return p.id;
    };
    for (const p of data.problems as Array<Record<string, unknown>>) {
      if (getProblemBySlug(tx, p.slug as string)) {
        report.problems.existing++;
        continue;
      }
      const { createdAt: _c, updatedAt: _u, ...rest } = p;
      tx.insert(problems).values(rest as typeof problems.$inferInsert).run();
      report.problems.inserted++;
    }
    for (const l of data.studyLists as Array<Record<string, unknown> & { slug: string; problems: { problemSlug: string; position: number; groupName?: string | null }[] }>) {
      if (tx.select().from(studyLists).where(eq(studyLists.slug, l.slug)).get()) {
        report.lists.existing++;
        continue;
      }
      const row = tx
        .insert(studyLists)
        .values({ slug: l.slug, name: String(l.name), description: (l.description as string) ?? null, source: (l.source as "leetcode" | "custom") ?? "custom" })
        .returning()
        .get();
      for (const m of l.problems) tx.insert(studyListProblems).values({ listId: row.id, problemId: pid(m.problemSlug), position: m.position, groupName: m.groupName ?? null }).run();
      report.lists.inserted++;
    }

    const assignmentIdMap = new Map<number, number>();
    const hasPlans = !!tx.select({ id: studyPlans.id }).from(studyPlans).get();
    if (hasPlans && data.plans.length) {
      report.plans.skipped = data.plans.length;
      report.plans.reason = "This database already has a study plan; plans and assignments were not imported (history was).";
    } else {
      const planIdMap = new Map<number, number>();
      for (const p of data.plans as Array<Record<string, unknown>>) {
        const row = tx
          .insert(studyPlans)
          .values({ name: String(p.name), status: p.status as "active", startDate: String(p.startDate), timeZone: String(p.timeZone), settings: planSettingsSchema.parse(p.settings), pausedAt: (p.pausedAt as number) ?? null })
          .returning()
          .get();
        planIdMap.set(p.id as number, row.id);
        for (const q of (p.queue as Array<Record<string, unknown>>) ?? []) {
          const list = q.sourceList ? tx.select().from(studyLists).where(eq(studyLists.slug, q.sourceList as string)).get() : undefined;
          tx.insert(planQueue)
            .values({ planId: row.id, problemId: pid(q.problemSlug as string), position: q.position as number, status: q.status as "pending", addedManually: !!q.addedManually, sourceListId: list?.id ?? null })
            .onConflictDoNothing()
            .run();
        }
        for (const d of (p.skips as string[]) ?? []) tx.insert(planSkips).values({ planId: row.id, date: d }).onConflictDoNothing().run();
        for (const l of (p.lightDays as Array<{ date: string; newQuota: number }>) ?? []) {
          if (isLocalDate(l?.date) && Number.isInteger(l.newQuota) && l.newQuota >= 0 && l.newQuota <= 50) {
            tx.insert(planLightDays).values({ planId: row.id, date: l.date, newQuota: l.newQuota }).onConflictDoNothing().run();
          }
        }
        report.plans.inserted++;
      }
      for (const a of data.assignments as Array<Record<string, unknown>>) {
        const { id, problemSlug, planId, createdAt: _c, updatedAt: _u, ...rest } = a;
        const dup = tx
          .select({ id: assignments.id })
          .from(assignments)
          .where(and(eq(assignments.problemId, pid(problemSlug as string)), eq(assignments.type, rest.type as "new"), eq(assignments.originalDate, rest.originalDate as string)))
          .get();
        if (dup) {
          assignmentIdMap.set(id as number, dup.id);
          continue;
        }
        const row = tx
          .insert(assignments)
          .values({ ...(rest as typeof assignments.$inferInsert), problemId: pid(problemSlug as string), planId: planId != null ? (planIdMap.get(planId as number) ?? null) : null })
          .returning()
          .get();
        assignmentIdMap.set(id as number, row.id);
        report.assignments.inserted++;
      }
      // Imported days count as already allocated.
      for (const a of tx.select().from(assignments).all()) {
        if (a.planId != null) tx.insert(planDays).values({ planId: a.planId, date: a.scheduledDate, newAllocatedAt: Date.now(), srsAllocatedAt: Date.now() }).onConflictDoNothing().run();
      }
    }

    const touched = new Set<number>();
    for (const s of data.sessions as Array<Record<string, unknown>>) {
      const existing = tx.select().from(sessions).where(eq(sessions.id, s.id as string)).get();
      if (existing) {
        report.sessions.existing++;
        if (existing.updatedAt !== s.updatedAt) report.sessions.conflicts++;
        continue;
      }
      const { problemSlug, assignmentId, ...rest } = s;
      const problemId = pid(problemSlug as string);
      let status = rest.status as string;
      // Never import a second open session for a problem.
      if (["not_started", "in_progress", "paused"].includes(status) && tx.select().from(sessions).where(and(eq(sessions.problemId, problemId), inArray(sessions.status, ["not_started", "in_progress", "paused"]))).get()) {
        status = "abandoned";
      }
      tx.insert(sessions)
        .values({ ...(rest as typeof sessions.$inferInsert), status: status as "completed", problemId, assignmentId: assignmentId != null ? (assignmentIdMap.get(assignmentId as number) ?? null) : null })
        .run();
      touched.add(problemId);
      report.sessions.inserted++;
    }
    for (const s of data.submissions as Array<Record<string, unknown>>) {
      const dup =
        (s.platformSubmissionId && tx.select().from(submissions).where(eq(submissions.platformSubmissionId, s.platformSubmissionId as string)).get()) ||
        tx.select().from(submissions).where(eq(submissions.fingerprint, s.fingerprint as string)).get();
      if (dup) {
        report.submissions.existing++;
        continue;
      }
      const { problemSlug, sessionId, ...rest } = s;
      const sessionExists = sessionId ? !!tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId as string)).get() : false;
      tx.insert(submissions)
        .values({ ...(rest as typeof submissions.$inferInsert), problemId: pid(problemSlug as string), sessionId: sessionExists ? (sessionId as string) : null })
        .run();
      report.submissions.inserted++;
    }
    for (const n of data.notes as Array<Record<string, unknown>>) {
      const problemId = pid(n.problemSlug as string);
      const incoming = Object.fromEntries(NOTE_FIELDS.map((f) => [f, typeof n[f] === "string" ? (n[f] as string) : ""]));
      const existing = tx.select().from(problemNotes).where(eq(problemNotes.problemId, problemId)).get();
      if (!existing || NOTE_FIELDS.every((f) => !existing[f])) {
        tx.insert(problemNotes).values({ problemId, ...incoming }).onConflictDoUpdate({ target: problemNotes.problemId, set: incoming }).run();
        report.notes.inserted++;
      } else if (NOTE_FIELDS.every((f) => existing[f] === incoming[f])) {
        report.notes.identical++;
      } else {
        tx.insert(problemNoteRevisions).values({ problemId, snapshot: { ...incoming, importedAt: new Date().toISOString() } }).run();
        report.notes.conflictsKeptAsRevision++;
      }
    }
    for (const r of data.noteRevisions as Array<Record<string, unknown>>) {
      const seen = r.createdAt != null && tx.select({ id: problemNoteRevisions.id }).from(problemNoteRevisions).where(and(eq(problemNoteRevisions.problemId, pid(r.problemSlug as string)), eq(problemNoteRevisions.createdAt, r.createdAt as number))).get();
      if (seen) continue;
      tx.insert(problemNoteRevisions).values({ problemId: pid(r.problemSlug as string), snapshot: r.snapshot, createdAt: (r.createdAt as number) ?? Date.now() }).run();
    }
    for (const id of touched) recomputeReviewState(tx, id);
    if (!getMeta(tx, "settings") && (input as { settings?: unknown }).settings) setMeta(tx, "settings", JSON.stringify((input as { settings: unknown }).settings));
    bumpRevision(tx);
  });
  return report;
}
