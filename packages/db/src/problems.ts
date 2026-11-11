import { and, eq, inArray, sql } from "drizzle-orm";
import { computeMastery, type MasterySessionInput } from "@lcc/scheduler";
import {
  normalizeDifficulty,
  problemUrl,
  toLocalDate,
  type AppSettings,
  type Mastery,
  type Outcome,
  type ProblemHint,
} from "@lcc/shared";
import type { Db } from "./client";
import { bumpRevision } from "./meta";
import { problems, reviewState, sessions, studyListProblems, studyLists, type Problem } from "./schema";

export function titleFromSlug(slug: string) {
  return slug
    .split("-")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Find-or-create a problem by slug. Only fills in missing metadata; never overwrites what we have. */
export function upsertProblemFromHint(db: Db, hint: ProblemHint): Problem {
  const existing = db.select().from(problems).where(and(eq(problems.platform, "leetcode"), eq(problems.slug, hint.slug))).get();
  if (existing) {
    const patch: Partial<Problem> = {};
    if (!existing.platformQuestionId && hint.questionId) {
      const clash = db.select({ id: problems.id }).from(problems).where(eq(problems.platformQuestionId, hint.questionId)).get();
      if (!clash) patch.platformQuestionId = hint.questionId;
    }
    if (!existing.frontendId && hint.frontendId) patch.frontendId = hint.frontendId;
    if (existing.difficulty === "Unknown" && hint.difficulty) patch.difficulty = normalizeDifficulty(hint.difficulty);
    if (hint.title && existing.title === titleFromSlug(existing.slug) && hint.title !== existing.title) patch.title = hint.title;
    if (Object.keys(patch).length) {
      db.update(problems).set({ ...patch, updatedAt: Date.now() }).where(eq(problems.id, existing.id)).run();
      return { ...existing, ...patch };
    }
    return existing;
  }
  // The question id is unique; if another problem already holds it, store this one without it.
  const qidTaken = hint.questionId && db.select({ id: problems.id }).from(problems).where(eq(problems.platformQuestionId, hint.questionId)).get();
  return db
    .insert(problems)
    .values({
      platform: "leetcode",
      slug: hint.slug,
      title: hint.title || titleFromSlug(hint.slug),
      platformQuestionId: qidTaken ? null : (hint.questionId ?? null),
      frontendId: hint.frontendId ?? null,
      difficulty: normalizeDifficulty(hint.difficulty),
      url: problemUrl(hint.slug),
    })
    .returning()
    .get();
}

export function getProblemBySlug(db: Db, slug: string) {
  return db.select().from(problems).where(and(eq(problems.platform, "leetcode"), eq(problems.slug, slug))).get() ?? null;
}
export function getProblemById(db: Db, id: number) {
  return db.select().from(problems).where(eq(problems.id, id)).get() ?? null;
}

export function updateProblemPatterns(db: Db, problemId: number, patterns: string[]) {
  const clean = [...new Set(patterns.map((p) => p.trim()).filter(Boolean))].slice(0, 12);
  db.update(problems).set({ patterns: clean, updatedAt: Date.now() }).where(eq(problems.id, problemId)).run();
  bumpRevision(db);
}

export interface ProblemStats {
  sessionCount: number;
  completedCount: number;
  lastPracticedAt: number | null;
  lastOutcome: Outcome | null;
  firstPracticedAt: number | null;
  mastery: Mastery;
  masteryReason: string;
  nextDueDate: string | null;
  lists: { slug: string; name: string; position: number; group: string | null }[];
}

/** Batch-computes per-problem stats + mastery (data is small; done in memory). */
export function getProblemStats(db: Db, settings: AppSettings, problemIds?: number[], now = Date.now()): Map<number, ProblemStats> {
  const today = toLocalDate(now, settings.timeZone);
  const filter = problemIds ? inArray(sessions.problemId, problemIds.length ? problemIds : [-1]) : undefined;
  const rows = db
    .select({
      problemId: sessions.problemId,
      status: sessions.status,
      outcome: sessions.outcome,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      endedDate: sessions.endedDate,
    })
    .from(sessions)
    .where(filter)
    .orderBy(sessions.startedAt)
    .all();
  const rs = db
    .select()
    .from(reviewState)
    .where(problemIds ? inArray(reviewState.problemId, problemIds.length ? problemIds : [-1]) : undefined)
    .all();
  const rsMap = new Map(rs.map((r) => [r.problemId, r]));
  const listRows = db
    .select({ problemId: studyListProblems.problemId, slug: studyLists.slug, name: studyLists.name, position: studyListProblems.position, group: studyListProblems.groupName })
    .from(studyListProblems)
    .innerJoin(studyLists, eq(studyLists.id, studyListProblems.listId))
    .where(problemIds ? inArray(studyListProblems.problemId, problemIds.length ? problemIds : [-1]) : undefined)
    .orderBy(studyLists.id)
    .all();

  const out = new Map<number, ProblemStats>();
  const ensure = (pid: number) => {
    let s = out.get(pid);
    if (!s) {
      s = {
        sessionCount: 0,
        completedCount: 0,
        lastPracticedAt: null,
        lastOutcome: null,
        firstPracticedAt: null,
        mastery: "not_started",
        masteryReason: "No completed sessions yet",
        nextDueDate: rsMap.get(pid)?.nextDueDate ?? null,
        lists: [],
      };
      out.set(pid, s);
    }
    return s;
  };
  const masteryInput = new Map<number, MasterySessionInput[]>();
  for (const r of rows) {
    const s = ensure(r.problemId);
    if (r.status === "abandoned") continue;
    s.sessionCount++;
    if (r.status === "completed" && r.outcome) {
      s.completedCount++;
      s.lastOutcome = r.outcome;
      s.lastPracticedAt = r.endedAt ?? r.startedAt;
      s.firstPracticedAt ??= r.endedAt ?? r.startedAt;
      const list = masteryInput.get(r.problemId) ?? [];
      list.push({ date: r.endedDate ?? toLocalDate(r.endedAt ?? r.startedAt, settings.timeZone), outcome: r.outcome });
      masteryInput.set(r.problemId, list);
    }
  }
  for (const l of listRows) ensure(l.problemId).lists.push({ slug: l.slug, name: l.name, position: l.position, group: l.group });
  for (const [pid, s] of out) {
    const m = computeMastery(masteryInput.get(pid) ?? [], rsMap.get(pid)?.nextDueDate ?? null, today, settings.mastery);
    s.mastery = m.state;
    s.masteryReason = m.reason;
  }
  return out;
}

export function emptyStats(): ProblemStats {
  return {
    sessionCount: 0,
    completedCount: 0,
    lastPracticedAt: null,
    lastOutcome: null,
    firstPracticedAt: null,
    mastery: "not_started",
    masteryReason: "No completed sessions yet",
    nextDueDate: null,
    lists: [],
  };
}

export interface LibraryFilters {
  q?: string;
  difficulty?: string;
  topic?: string;
  list?: string;
  mastery?: string;
  due?: "overdue" | "today" | "week" | "none";
  practiced?: "yes" | "no";
  sort?: "list" | "id" | "last" | "due" | "title";
}

export function searchLibrary(db: Db, settings: AppSettings, f: LibraryFilters, now = Date.now()) {
  const today = toLocalDate(now, settings.timeZone);
  const all = db.select().from(problems).all();
  const stats = getProblemStats(db, settings, undefined, now);
  const q = f.q?.trim().toLowerCase();
  let rows = all.map((p) => ({ problem: p, stats: stats.get(p.id) ?? emptyStats() }));
  if (q) {
    rows = rows.filter(
      ({ problem: p }) => p.title.toLowerCase().includes(q) || p.slug.includes(q) || p.frontendId === q.replace(/^#/, ""),
    );
  }
  if (f.difficulty) rows = rows.filter((r) => r.problem.difficulty === f.difficulty);
  if (f.topic) rows = rows.filter((r) => r.problem.patterns.includes(f.topic!) || r.problem.topics.some((t) => t.name === f.topic));
  if (f.list) rows = rows.filter((r) => r.stats.lists.some((l) => l.slug === f.list));
  if (f.mastery) rows = rows.filter((r) => r.stats.mastery === f.mastery);
  if (f.practiced === "yes") rows = rows.filter((r) => r.stats.completedCount > 0);
  if (f.practiced === "no") rows = rows.filter((r) => r.stats.completedCount === 0);
  if (f.due) {
    const weekEnd = new Date(`${today}T12:00:00Z`);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
    const we = weekEnd.toISOString().slice(0, 10);
    rows = rows.filter((r) => {
      const d = r.stats.nextDueDate;
      if (f.due === "none") return !d;
      if (!d) return false;
      if (f.due === "overdue") return d < today;
      if (f.due === "today") return d <= today;
      return d <= we;
    });
  }
  const rank = new Map(listStudyLists(db).map((l, i) => [l.slug, i]));
  const listOrder = (r: (typeof rows)[number]) => {
    const l = r.stats.lists[0];
    return l ? (rank.get(l.slug) ?? 0) * 100_000 + l.position : 1e9 + r.problem.id;
  };
  switch (f.sort ?? "list") {
    case "id":
      rows.sort((a, b) => Number(a.problem.frontendId ?? 1e9) - Number(b.problem.frontendId ?? 1e9));
      break;
    case "last":
      rows.sort((a, b) => (b.stats.lastPracticedAt ?? 0) - (a.stats.lastPracticedAt ?? 0));
      break;
    case "due":
      rows.sort((a, b) => (a.stats.nextDueDate ?? "9999").localeCompare(b.stats.nextDueDate ?? "9999"));
      break;
    case "title":
      rows.sort((a, b) => a.problem.title.localeCompare(b.problem.title));
      break;
    default:
      rows.sort((a, b) => listOrder(a) - listOrder(b));
  }
  return rows;
}

export function allPatternsAndTopics(db: Db) {
  const all = db.select({ patterns: problems.patterns, topics: problems.topics }).from(problems).all();
  const patterns = new Set<string>();
  const topics = new Set<string>();
  for (const r of all) {
    r.patterns.forEach((p) => patterns.add(p));
    r.topics.forEach((t) => topics.add(t.name));
  }
  return { patterns: [...patterns].sort(), topics: [...topics].sort() };
}

export function listStudyLists(db: Db) {
  return db
    .select({
      id: studyLists.id,
      slug: studyLists.slug,
      name: studyLists.name,
      description: studyLists.description,
      count: sql<number>`(select count(*) from ${studyListProblems} where ${studyListProblems.listId} = ${studyLists.id})`,
    })
    .from(studyLists)
    .all();
}
