import { and, eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { normalizeDifficulty, parseProblemSlug, problemUrl } from "@lcc/shared";
import { findRepoRoot, type Db } from "./client";
import { bumpRevision } from "./meta";
import { getActivePlan, rebuildQueue } from "./plans";
import { titleFromSlug } from "./problems";
import { problems, studyListProblems, studyLists } from "./schema";

/**
 * Study lists are imported by the user; none ship with the app, and the app
 * never calls LeetCode to load one. The shape follows LeetCode's study-plan
 * JSON (studyPlanV2Detail) so such a file imports as-is; only titleSlug is required.
 */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const questionSchema = z.object({
  titleSlug: z.string().max(200).transform((s) => s.toLowerCase()).pipe(z.string().regex(SLUG, "not a LeetCode problem slug")),
  id: z.string().max(20).nullish(),
  questionFrontendId: z.string().max(20).nullish(),
  title: z.string().max(300).nullish(),
  difficulty: z.string().max(20).nullish(),
  paidOnly: z.boolean().nullish(),
  topicTags: z.array(z.object({ name: z.string().max(100), slug: z.string().max(100) })).max(30).nullish(),
});
const listSchema = z.object({
  slug: z.string().max(100).nullish(),
  name: z.string().min(1).max(100),
  description: z.string().max(2000).nullish(),
  planSubGroups: z
    .array(z.object({ name: z.string().max(100).nullish(), questions: z.array(questionSchema).max(3000) }))
    .max(200)
    .refine((g) => g.reduce((a, x) => a + x.questions.length, 0) <= 3000, "A list can have at most 3000 questions."),
});
export type ListQuestion = z.infer<typeof questionSchema>;
export interface ListInput {
  slug: string;
  name: string;
  description?: string | null;
  planSubGroups: { name?: string | null; questions: ListQuestion[] }[];
}

/** Validates a study-plan object (bare or wrapped as { data: { studyPlanV2Detail } }). */
export function parseListObject(raw: unknown, name?: string): ListInput {
  const r = raw as { data?: { studyPlanV2Detail?: unknown } } | null;
  const parsed = listSchema.safeParse(r?.data?.studyPlanV2Detail ?? raw);
  if (!parsed.success) throw new Error("That JSON is not a study list. Expected { name, planSubGroups: [{ name, questions: [{ titleSlug }] }] }.");
  const given = name?.trim();
  const list = { ...parsed.data, name: given || parsed.data.name, slug: slugify(given || parsed.data.slug || parsed.data.name) };
  if (!list.slug) throw new Error("The list name needs at least one letter or number.");
  if (!list.planSubGroups.some((g) => g.questions.length)) throw new Error("No questions found.");
  return list;
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * Turns pasted text into a list. Two formats:
 *  - JSON: a study-plan object ({ name, planSubGroups: [{ name, questions: [{ titleSlug, … }] }] }),
 *    bare or wrapped as { data: { studyPlanV2Detail } }.
 *  - Lines: one LeetCode problem link or slug per line; a line starting with "#" names a group.
 */
export function parseListText(text: string, name?: string): ListInput {
  const t = text.trim();
  const given = name?.trim();
  let list: ListInput;
  if (t.startsWith("{")) {
    let raw: unknown;
    try {
      raw = JSON.parse(t);
    } catch {
      throw new Error("That JSON could not be read.");
    }
    return parseListObject(raw, given);
  } else {
    if (!given) throw new Error("Give the list a name.");
    const groups: ListInput["planSubGroups"] = [{ name: null, questions: [] }];
    t.split(/\r?\n/).forEach((line, i) => {
      const l = line.trim();
      if (!l) return;
      if (l.startsWith("#")) return void groups.push({ name: l.replace(/^#+\s*/, "").slice(0, 100) || null, questions: [] });
      const slug = SLUG.test(l.toLowerCase()) ? l.toLowerCase() : parseProblemSlug(l);
      if (!slug) throw new Error(`Line ${i + 1} is not a LeetCode problem link or slug: "${l.slice(0, 80)}"`);
      groups[groups.length - 1]!.questions.push({ titleSlug: slug });
    });
    list = { slug: slugify(given), name: given, planSubGroups: groups };
  }
  if (!list.slug) throw new Error("The list name needs at least one letter or number.");
  if (!list.planSubGroups.some((g) => g.questions.length)) throw new Error("No questions found.");
  return list;
}

/** Strip HTML from the plan description. */
function plain(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500) || null;
}

/**
 * Idempotent: upserts problems by slug (metadata only — never touches history,
 * and never blanks metadata the list doesn't carry), upserts lists, and rewrites
 * each list's membership/order to match the input.
 */
export function importStudyLists(db: Db, lists: ListInput[]) {
  const summary = { lists: 0, membership: 0, problemsInserted: 0, problemsUpdated: 0 };
  db.transaction((tx) => {
    for (const plan of lists) {
      let list = tx.select().from(studyLists).where(eq(studyLists.slug, plan.slug)).get();
      if (!list) {
        list = tx.insert(studyLists).values({ slug: plan.slug, name: plan.name, description: plain(plan.description), source: "leetcode" }).returning().get();
      } else {
        tx.update(studyLists).set({ name: plan.name, description: plain(plan.description), updatedAt: Date.now() }).where(eq(studyLists.id, list.id)).run();
      }
      summary.lists++;
      tx.delete(studyListProblems).where(eq(studyListProblems.listId, list.id)).run();
      let position = 0;
      const seen = new Set<number>();
      for (const group of plan.planSubGroups) {
        for (const q of group.questions) {
          const slug = q.titleSlug.toLowerCase();
          const existing = tx
            .select()
            .from(problems)
            .where(and(eq(problems.platform, "leetcode"), eq(problems.slug, slug)))
            .get();
          // The question id is unique; if another problem already holds it, leave it off.
          const qid = q.id && !tx.select({ id: problems.id }).from(problems).where(eq(problems.platformQuestionId, q.id)).get() ? q.id : null;
          const topics = q.topicTags?.map((t) => ({ name: t.name, slug: t.slug }));
          let problemId: number;
          if (!existing) {
            problemId = tx
              .insert(problems)
              .values({
                platform: "leetcode",
                platformQuestionId: qid,
                frontendId: q.questionFrontendId ?? null,
                slug,
                title: q.title || titleFromSlug(slug),
                difficulty: normalizeDifficulty(q.difficulty),
                url: problemUrl(slug),
                topics: topics ?? [],
                patterns: group.name ? [group.name] : [],
                paidOnly: !!q.paidOnly,
              })
              .returning({ id: problems.id })
              .get().id;
            summary.problemsInserted++;
          } else {
            problemId = existing.id;
            if (seen.has(problemId)) continue; // listed twice
            const patterns = !group.name || existing.patterns.includes(group.name) ? existing.patterns : [...existing.patterns, group.name];
            // Only fill in what is missing: a list never overwrites what is already known about a problem.
            tx.update(problems)
              .set({
                platformQuestionId: existing.platformQuestionId ?? qid,
                frontendId: existing.frontendId ?? q.questionFrontendId ?? null,
                title: existing.title === titleFromSlug(existing.slug) && q.title ? q.title : existing.title,
                difficulty: existing.difficulty === "Unknown" && q.difficulty ? normalizeDifficulty(q.difficulty) : existing.difficulty,
                topics: existing.topics.length ? existing.topics : (topics ?? []),
                patterns,
                paidOnly: existing.paidOnly || !!q.paidOnly,
                updatedAt: Date.now(),
              })
              .where(eq(problems.id, existing.id))
              .run();
            summary.problemsUpdated++;
          }
          seen.add(problemId);
          tx.insert(studyListProblems).values({ listId: list.id, problemId, position: position++, groupName: group.name ?? null }).run();
          summary.membership++;
        }
      }
    }
    bumpRevision(tx);
  });
  return summary;
}

/** Imports one list and, if the active plan uses it, appends its new questions to the plan queue. */
export function importList(db: Db, list: ListInput) {
  const r = importStudyLists(db, [list]);
  const plan = getActivePlan(db);
  if (plan?.settings.listSlugs.includes(list.slug)) rebuildQueue(db, plan.id);
  return { slug: list.slug, name: list.name, count: r.membership };
}

/**
 * Lists that ship with the app: only ones published under a licence that allows it
 * (each file names its source and licence). Read from packages/db/lists.
 */
export function builtInLists(dir = path.join(findRepoRoot(), "packages", "db", "lists")) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { source?: string; license?: string };
      const list = parseListObject(raw);
      return { list, source: raw.source ?? null, license: raw.license ?? null, count: list.planSubGroups.reduce((a, g) => a + g.questions.length, 0) };
    });
}

/** Made-up lists for tests, the demo and end-to-end runs: 75 and 150 questions, 16 of them shared. */
export function sampleLists(): ListInput[] {
  const groups = ["Arrays", "Two Pointers", "Sliding Window", "Stack", "Binary Search", "Linked List", "Trees", "Graphs", "Dynamic Programming", "Heap"];
  const question = (n: number): ListQuestion => ({
    titleSlug: n === 76 ? "two-sum" : `sample-problem-${n}`,
    id: String(9000 + n),
    questionFrontendId: String(n),
    difficulty: ["EASY", "MEDIUM", "HARD"][n % 3],
    topicTags: [{ name: `Topic ${(n % 7) + 1}`, slug: `topic-${(n % 7) + 1}` }],
  });
  const list = (slug: string, name: string, from: number, to: number): ListInput => ({
    slug,
    name,
    planSubGroups: groups.map((g, i) => ({
      name: g,
      questions: Array.from({ length: to - from + 1 }, (_, k) => from + k)
        .filter((_, k) => Math.floor((k * groups.length) / (to - from + 1)) === i)
        .map(question),
    })),
  });
  return [list("sample-a", "Sample list A", 1, 75), list("sample-b", "Sample list B", 60, 209)];
}
