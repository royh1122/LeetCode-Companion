import { and, asc, desc, eq, inArray, max, ne, sql } from "drizzle-orm";
import { DEFAULT_PLAN_SETTINGS, planSettingsSchema, startOfWeek, toLocalDate, weekdayOf, type LocalDate, type PlanSettings } from "@lcc/shared";
import type { Db } from "./client";
import { bumpRevision, getAppSettings } from "./meta";
import { DomainError } from "./sessions";
import { assignments, planDays, planLightDays, planQueue, planSkips, problems, sessions, studyListProblems, studyLists, studyPlans, type StudyPlan } from "./schema";

export type ParsedPlan = Omit<StudyPlan, "settings"> & { settings: PlanSettings };

export function parsePlan(p: StudyPlan): ParsedPlan {
  return { ...p, settings: planSettingsSchema.parse(p.settings) };
}

export function getActivePlan(db: Db): ParsedPlan | null {
  const p = db
    .select()
    .from(studyPlans)
    .where(inArray(studyPlans.status, ["active", "paused"]))
    .orderBy(desc(studyPlans.id))
    .get();
  return p ? parsePlan(p) : null;
}

export function getPlan(db: Db, id: number): ParsedPlan | null {
  const p = db.select().from(studyPlans).where(eq(studyPlans.id, id)).get();
  return p ? parsePlan(p) : null;
}

/** Problem ids with at least one completed session. */
export function practicedProblemIds(db: Db): Set<number> {
  return new Set(
    db
      .selectDistinct({ id: sessions.problemId })
      .from(sessions)
      .where(eq(sessions.status, "completed"))
      .all()
      .map((r) => r.id),
  );
}

export function createPlan(
  db: Db,
  input: { name?: string; startDate?: LocalDate; timeZone?: string; settings?: Partial<PlanSettings> },
  now = Date.now(),
): ParsedPlan {
  const app = getAppSettings(db);
  const timeZone = input.timeZone ?? app.timeZone;
  // Unless the caller picks, a plan covers every imported list, in import order.
  const listSlugs = input.settings?.listSlugs ?? db.select({ slug: studyLists.slug }).from(studyLists).orderBy(asc(studyLists.id)).all().map((l) => l.slug);
  if (!listSlugs.length) throw new Error("Import a question list first.");
  const settings = planSettingsSchema.parse({ ...DEFAULT_PLAN_SETTINGS, ...input.settings, listSlugs });
  const startDate = input.startDate ?? toLocalDate(now, timeZone);
  return db.transaction((tx) => {
    // Only one plan is active at a time; older ones are archived (their history stays).
    tx.update(studyPlans).set({ status: "archived", updatedAt: now }).where(ne(studyPlans.status, "archived")).run();
    const plan = tx
      .insert(studyPlans)
      .values({ name: input.name ?? "Interview prep", startDate, timeZone, settings, status: "active" })
      .returning()
      .get();
    rebuildQueue(tx, plan.id);
    bumpRevision(tx);
    return parsePlan(plan);
  });
}

/**
 * Append any list problems not yet in the queue, in list order, de-duplicated by
 * problem. Never reorders or removes existing items. Problems already practiced
 * are added as "skipped_practiced" under the skip_practiced overlap policy.
 */
export function rebuildQueue(db: Db, planId: number) {
  const plan = getPlan(db, planId);
  if (!plan) throw new Error("Plan not found");
  const practiced = practicedProblemIds(db);
  const existing = new Set(db.select({ id: planQueue.problemId }).from(planQueue).where(eq(planQueue.planId, planId)).all().map((r) => r.id));
  let pos = (db.select({ m: max(planQueue.position) }).from(planQueue).where(eq(planQueue.planId, planId)).get()?.m ?? 0) + 1;
  let added = 0;
  for (const slug of plan.settings.listSlugs) {
    const list = db.select().from(studyLists).where(eq(studyLists.slug, slug)).get();
    if (!list) continue;
    const members = db
      .select({ problemId: studyListProblems.problemId })
      .from(studyListProblems)
      .where(eq(studyListProblems.listId, list.id))
      .orderBy(asc(studyListProblems.position))
      .all();
    for (const m of members) {
      if (existing.has(m.problemId)) continue;
      existing.add(m.problemId);
      const skip = plan.settings.overlapPolicy === "skip_practiced" && practiced.has(m.problemId);
      db.insert(planQueue)
        .values({ planId, problemId: m.problemId, position: pos++, status: skip ? "skipped_practiced" : "pending", sourceListId: list.id })
        .run();
      added++;
    }
  }
  return added;
}

export function updatePlanSettings(db: Db, planId: number, patch: Partial<PlanSettings> & { name?: string; startDate?: LocalDate; timeZone?: string }) {
  const plan = getPlan(db, planId);
  if (!plan) throw new Error("Plan not found");
  const { name, startDate, timeZone, ...settingsPatch } = patch;
  const settings = planSettingsSchema.parse({ ...plan.settings, ...settingsPatch });
  db.transaction((tx) => {
    tx.update(studyPlans)
      .set({ settings, name: name ?? plan.name, startDate: startDate ?? plan.startDate, timeZone: timeZone ?? plan.timeZone, updatedAt: Date.now() })
      .where(eq(studyPlans.id, planId))
      .run();
    rebuildQueue(tx, planId);
    bumpRevision(tx);
  });
}

export function setPlanPaused(db: Db, planId: number, paused: boolean) {
  db.update(studyPlans)
    .set({ status: paused ? "paused" : "active", pausedAt: paused ? Date.now() : null, updatedAt: Date.now() })
    .where(eq(studyPlans.id, planId))
    .run();
  bumpRevision(db);
}

export function getSkipDates(db: Db, planId: number): Set<LocalDate> {
  return new Set(db.select({ d: planSkips.date }).from(planSkips).where(eq(planSkips.planId, planId)).all().map((r) => r.d));
}

/**
 * Skip a day without losing your place: no new questions are pulled, and any
 * not-yet-started new questions already assigned for that day return to the
 * front of their queue position.
 */
export function skipDay(db: Db, planId: number, date: LocalDate) {
  db.transaction((tx) => {
    tx.insert(planSkips).values({ planId, date }).onConflictDoNothing().run();
    const toReturn = tx
      .select()
      .from(assignments)
      .where(and(eq(assignments.planId, planId), eq(assignments.type, "new"), eq(assignments.scheduledDate, date), eq(assignments.status, "pending")))
      .all();
    for (const a of toReturn) {
      tx.update(assignments).set({ status: "skipped", note: "Day skipped", updatedAt: Date.now() }).where(eq(assignments.id, a.id)).run();
      tx.update(planQueue)
        .set({ status: "pending", updatedAt: Date.now() })
        .where(and(eq(planQueue.planId, planId), eq(planQueue.problemId, a.problemId)))
        .run();
    }
    bumpRevision(tx);
  });
}

export function getLightDays(db: Db, planId: number): Map<LocalDate, number> {
  return new Map(db.select({ d: planLightDays.date, n: planLightDays.newQuota }).from(planLightDays).where(eq(planLightDays.planId, planId)).all().map((r) => [r.d, r.n]));
}

export type DayMode = { mode: "normal" } | { mode: "skip" } | { mode: "light"; newQuota: number };

/**
 * Plan around a busy day ahead: skip it, make it light (fewer new questions, no
 * automatic reviews) or set it back to normal. Only future days, and never a
 * mandatory review day (its reviews would just move onto Monday).
 */
export function setDayMode(db: Db, planId: number, date: LocalDate, mode: DayMode, now = Date.now()) {
  const plan = getPlan(db, planId);
  if (!plan) throw new Error("Plan not found");
  const today = toLocalDate(now, getAppSettings(db).timeZone);
  if (date <= today) throw new DomainError("past_day", "Only days after today can be planned ahead. Use Skip today for today.");
  if (plan.settings.reviewDays.some((r) => r.weekday === weekdayOf(date))) throw new DomainError("review_day", "Review days can't be skipped or made light: their mandatory reviews would move onto Monday.");
  db.transaction((tx) => {
    tx.delete(planLightDays).where(and(eq(planLightDays.planId, planId), eq(planLightDays.date, date))).run();
    if (mode.mode === "skip") {
      skipDay(tx, planId, date);
      return;
    }
    tx.delete(planSkips).where(and(eq(planSkips.planId, planId), eq(planSkips.date, date))).run();
    if (mode.mode === "light") {
      const n = Math.max(0, Math.min(50, Math.floor(mode.newQuota)));
      tx.insert(planLightDays).values({ planId, date, newQuota: n }).run();
    }
    bumpRevision(tx);
  });
}

export function unskipDay(db: Db, planId: number, date: LocalDate) {
  db.transaction((tx) => {
    tx.delete(planSkips).where(and(eq(planSkips.planId, planId), eq(planSkips.date, date))).run();
    // Allow today's allocation to run again.
    tx.update(planDays).set({ newAllocatedAt: null }).where(and(eq(planDays.planId, planId), eq(planDays.date, date))).run();
    bumpRevision(tx);
  });
}

export function getQueue(db: Db, planId: number) {
  return db
    .select({
      id: planQueue.id,
      problemId: planQueue.problemId,
      position: planQueue.position,
      status: planQueue.status,
      addedManually: planQueue.addedManually,
      listSlug: studyLists.slug,
      listName: studyLists.name,
      slug: problems.slug,
      title: problems.title,
      frontendId: problems.frontendId,
      difficulty: problems.difficulty,
      patterns: problems.patterns,
    })
    .from(planQueue)
    .innerJoin(problems, eq(problems.id, planQueue.problemId))
    .leftJoin(studyLists, eq(studyLists.id, planQueue.sourceListId))
    .where(eq(planQueue.planId, planId))
    .orderBy(asc(planQueue.position))
    .all();
}

export function pendingQueue(db: Db, planId: number) {
  return db
    .select({ problemId: planQueue.problemId, force: planQueue.addedManually })
    .from(planQueue)
    .where(and(eq(planQueue.planId, planId), eq(planQueue.status, "pending")))
    .orderBy(asc(planQueue.position))
    .all();
}

function renumber(db: Db, planId: number) {
  const items = db.select({ id: planQueue.id }).from(planQueue).where(eq(planQueue.planId, planId)).orderBy(asc(planQueue.position)).all();
  items.forEach((it, i) => db.update(planQueue).set({ position: i + 1 }).where(eq(planQueue.id, it.id)).run());
}

/** Move a pending queue item among the *pending* items (what you'll see next). */
export function moveQueueItem(db: Db, planId: number, problemId: number, to: "top" | "up" | "down" | "bottom") {
  db.transaction((tx) => {
    const pending = tx
      .select({ id: planQueue.id, problemId: planQueue.problemId, position: planQueue.position })
      .from(planQueue)
      .where(and(eq(planQueue.planId, planId), eq(planQueue.status, "pending")))
      .orderBy(asc(planQueue.position))
      .all();
    const i = pending.findIndex((p) => p.problemId === problemId);
    if (i < 0) return;
    const item = pending[i]!;
    let newPos: number;
    if (to === "top") newPos = (pending[0]?.position ?? 1) - 1;
    else if (to === "bottom") newPos = (pending[pending.length - 1]?.position ?? 0) + 1;
    else if (to === "up") {
      if (i === 0) return;
      const prev = pending[i - 1]!;
      const before = pending[i - 2];
      newPos = before ? (before.position + prev.position) / 2 : prev.position - 1;
    } else {
      if (i === pending.length - 1) return;
      const next = pending[i + 1]!;
      const after = pending[i + 2];
      newPos = after ? (next.position + after.position) / 2 : next.position + 1;
    }
    tx.update(planQueue).set({ position: newPos, updatedAt: Date.now() }).where(eq(planQueue.id, item.id)).run();
    renumber(tx, planId);
    bumpRevision(tx);
  });
}

/**
 * Add a problem to the plan queue (e.g. a problem outside the lists, or an
 * already-practiced overlap you explicitly want to practice as new).
 */
export function enqueueProblem(db: Db, planId: number, problemId: number, where: "front" | "end" = "end") {
  db.transaction((tx) => {
    const pending = tx
      .select({ position: planQueue.position })
      .from(planQueue)
      .where(and(eq(planQueue.planId, planId), eq(planQueue.status, "pending")))
      .orderBy(asc(planQueue.position))
      .all();
    const allMax = tx.select({ m: max(planQueue.position) }).from(planQueue).where(eq(planQueue.planId, planId)).get()?.m ?? 0;
    const pos = where === "front" ? (pending[0]?.position ?? allMax + 1) - 0.5 : allMax + 1;
    const existing = tx.select().from(planQueue).where(and(eq(planQueue.planId, planId), eq(planQueue.problemId, problemId))).get();
    if (existing) {
      tx.update(planQueue).set({ status: "pending", position: pos, addedManually: true, updatedAt: Date.now() }).where(eq(planQueue.id, existing.id)).run();
    } else {
      tx.insert(planQueue).values({ planId, problemId, position: pos, status: "pending", addedManually: true }).run();
    }
    renumber(tx, planId);
    bumpRevision(tx);
  });
}

export function removeFromQueue(db: Db, planId: number, problemId: number) {
  db.update(planQueue)
    .set({ status: "removed", updatedAt: Date.now() })
    .where(and(eq(planQueue.planId, planId), eq(planQueue.problemId, problemId), eq(planQueue.status, "pending")))
    .run();
  bumpRevision(db);
}

export function queueCounts(db: Db, planId: number) {
  const rows = db
    .select({ status: planQueue.status, c: sql<number>`count(*)` })
    .from(planQueue)
    .where(eq(planQueue.planId, planId))
    .groupBy(planQueue.status)
    .all();
  const out: Record<string, number> = { pending: 0, assigned: 0, done: 0, skipped_practiced: 0, removed: 0 };
  for (const r of rows) out[r.status] = r.c;
  return out;
}
