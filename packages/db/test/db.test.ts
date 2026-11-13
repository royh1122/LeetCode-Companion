import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { addDays, toLocalDate, weekdayOf, type Outcome } from "@lcc/shared";
import {
  abandonSession,
  addAssignment,
  pauseSession,
  deleteSession,
  deleteSubmission,
  editCompletedSession,
  createPlan,
  enqueueProblem,
  ensureSchedule,
  exportAll,
  finishSession,
  getActivePlan,
  getProblemBySlug,
  getProblemDetail,
  getQueue,
  getReviewQueue,
  getTodayView,
  importAll,
  builtInLists,
  importList,
  parseListObject,
  linkSubmission,
  logManualAttempt,
  moveQueueItem,
  pendingQueue,
  processSyncEvents,
  recordSubmission,
  rescheduleAssignment,
  schema,
  importStudyLists,
  parseListText,
  sampleLists,
  setPlanPaused,
  skipAssignment,
  skipDay,
  startSession,
  getUpcoming,
  getAnalytics,
  saveNotes,
  getNotes,
  listNoteRevisions,
  doMoreToday,
  setDayMode,
  getLightDays,
  pullMoreReviews,
} from "../src";
import { at, freshDb, TZ } from "./helpers";

const MON = "2026-11-09";

function solveAll(db: ReturnType<typeof freshDb>, items: { assignment: { id: number }; problem: { id: number } }[], date: string, outcome: Outcome = "independent") {
  let minute = 0;
  for (const it of items) {
    const { session } = startSession(db, { problemId: it.problem.id, assignmentId: it.assignment.id, origin: "dashboard", startedAt: at(date, 10, minute) }, at(date, 10, minute));
    finishSession(db, session.id, { outcome, hintsUsed: false }, at(date, 10, minute + 5));
    minute += 6;
  }
}

describe("seed / problem identity", () => {
  it("imports both lists with correct membership, order and overlap de-duplication", () => {
    const db = freshDb();
    const lists = db.select().from(schema.studyLists).all();
    expect(lists.map((l) => l.slug).sort()).toEqual(["sample-a", "sample-b"]);
    const members = db.select().from(schema.studyListProblems).all();
    const l75 = lists.find((l) => l.slug === "sample-a")!;
    const l150 = lists.find((l) => l.slug === "sample-b")!;
    expect(members.filter((m) => m.listId === l75.id)).toHaveLength(75);
    expect(members.filter((m) => m.listId === l150.id)).toHaveLength(150);
    const problems = db.select().from(schema.problems).all();
    const overlap = 75 + 150 - problems.length;
    expect(overlap).toBeGreaterThan(10); // the lists genuinely overlap
    // One permanent record per problem; overlapping problems belong to both lists.
    const first = members.filter((m) => m.listId === l75.id).sort((a, b) => a.position - b.position)[0]!;
    expect(problems.find((p) => p.id === first.problemId)!.slug).toBe("sample-problem-1");
    // Re-seeding is idempotent and does not create duplicates.
    importStudyLists(db, sampleLists());
    expect(db.select().from(schema.problems).all()).toHaveLength(problems.length);
  });

  it("ships only licensed lists, and importing one adds it to an active plan that uses it", () => {
    const b = builtInLists();
    expect(b.map((x) => x.list.slug)).toEqual(["tech-interview-handbook-5-week"]);
    expect(b.every((x) => x.license && x.source)).toBe(true);
    expect(b[0]!.count).toBe(61);
    const db = freshDb();
    const plan = createPlan(db, { startDate: MON, timeZone: TZ, settings: { listSlugs: ["sample-a", "tech-interview-handbook-5-week"] } }, at(MON, 8));
    const before = getQueue(db, plan.id).length;
    expect(importList(db, b[0]!.list).count).toBe(61);
    expect(getQueue(db, plan.id).length).toBeGreaterThan(before);
    expect(getProblemBySlug(db, "3sum")).toMatchObject({ title: "3Sum", difficulty: "Medium" });
    expect(getProblemBySlug(db, "alien-dictionary")!.paidOnly).toBe(true);
  });

  it("a list never overwrites what is known about a problem, and rejects bad slugs and oversized lists", () => {
    const db = freshDb();
    importStudyLists(db, [parseListObject({ slug: "real", name: "Real", planSubGroups: [{ questions: [{ titleSlug: "two-sum", title: "Two Sum (real title)" }] }] })]);
    const known = getProblemBySlug(db, "two-sum")!;
    expect(known.title).toBe("Two Sum (real title)"); // a slug-made title is filled in
    const forged = parseListObject({ slug: "x", name: "X", planSubGroups: [{ name: null, questions: [{ titleSlug: "two-sum", title: "Hacked", difficulty: "HARD", questionFrontendId: "999", topicTags: [] }] }] });
    importStudyLists(db, [forged]);
    expect(getProblemBySlug(db, "two-sum")).toMatchObject({ title: known.title, difficulty: known.difficulty, frontendId: known.frontendId, topics: known.topics });
    expect(() => parseListObject({ name: "X", planSubGroups: [{ questions: [{ titleSlug: "../../etc" }] }] })).toThrow(/not a study list/);
    expect(() => parseListObject({ name: "X", planSubGroups: [{ questions: Array.from({ length: 3001 }, (_, i) => ({ titleSlug: `p-${i}` })) }] })).toThrow();
    expect(parseListText("Two-Sum", "Mixed case").planSubGroups[0]!.questions[0]!.titleSlug).toBe("two-sum");
  });

  it("imports a pasted list of links and slugs without blanking what is already known", () => {
    const db = freshDb();
    const known = getProblemBySlug(db, "two-sum")!;
    const list = parseListText(["# Warm-up", "https://leetcode.com/problems/two-sum/description/", "valid-anagram", "", "two-sum"].join("\n"), " My list ");
    expect(list.slug).toBe("my-list");
    importStudyLists(db, [list]);
    const mine = db.select().from(schema.studyLists).all().find((l) => l.slug === "my-list")!;
    expect(db.select().from(schema.studyListProblems).all().filter((m) => m.listId === mine.id)).toHaveLength(2); // the repeat is dropped
    expect(getProblemBySlug(db, "two-sum")).toMatchObject({ difficulty: known.difficulty, frontendId: known.frontendId, topics: known.topics });
    expect(getProblemBySlug(db, "valid-anagram")).toMatchObject({ title: "Valid Anagram", difficulty: "Unknown", patterns: ["Warm-up"] });
    // A plan made without choosing lists covers every imported list.
    expect(createPlan(db, { startDate: MON, timeZone: TZ }, at(MON, 8)).settings.listSlugs).toEqual(["sample-a", "sample-b", "my-list"]);
    // LeetCode's study-plan JSON imports as-is.
    const json = parseListText(JSON.stringify({ data: { studyPlanV2Detail: { slug: "x-1", name: "X", planSubGroups: [{ name: "G", questions: [{ titleSlug: "valid-anagram", difficulty: "EASY" }] }] } } }));
    importStudyLists(db, [json]);
    expect(getProblemBySlug(db, "valid-anagram")).toMatchObject({ difficulty: "Easy", patterns: ["Warm-up", "G"] });
    expect(() => parseListText("Two Sum", "x")).toThrow(/Line 1/);
    expect(() => createPlan(freshDb({ seed: false }), {})).toThrow(/Import a question list/);
  });
});

describe("study plan — a full week", () => {
  it("Mon–Fri 5 new each, Sat 12 + Sun 13 mandatory reviews, next Monday continues the queue", () => {
    const db = freshDb();
    expect(weekdayOf(MON)).toBe(1);
    createPlan(db, { startDate: MON, timeZone: TZ }, at(MON, 8));
    const seen: number[] = [];
    for (let d = 0; d < 5; d++) {
      const date = addDays(MON, d);
      const v = getTodayView(db, at(date, 8));
      expect(v.today).toBe(date);
      expect(v.sections.newQuestions).toHaveLength(5);
      expect(v.sections.mandatory).toHaveLength(0);
      // Thursday: Monday's "struggled" problems are due (3 days) but deferred to the weekend review.
      expect(v.sections.srs).toHaveLength(0);
      seen.push(...v.sections.newQuestions.map((i) => i.problem.id));
      solveAll(db, v.sections.newQuestions, date, d === 0 ? "struggled" : "independent");
      // Calling again the same day does not allocate more.
      expect(getTodayView(db, at(date, 20)).sections.newQuestions).toHaveLength(5);
    }
    expect(new Set(seen).size).toBe(25);
    const sat = getTodayView(db, at(addDays(MON, 5), 9));
    expect(sat.sections.newQuestions).toHaveLength(0);
    expect(sat.sections.mandatory).toHaveLength(12);
    solveAll(db, sat.sections.mandatory, addDays(MON, 5), "easy");
    const sun = getTodayView(db, at(addDays(MON, 6), 9));
    expect(sun.sections.mandatory).toHaveLength(13);
    const reviewed = new Set([...sat.sections.mandatory, ...sun.sections.mandatory].map((i) => i.problem.id));
    expect(reviewed).toEqual(new Set(seen));
    solveAll(db, sun.sections.mandatory, addDays(MON, 6));
    const nextMon = getTodayView(db, at(addDays(MON, 7), 9));
    expect(nextMon.sections.newQuestions).toHaveLength(5);
    for (const i of nextMon.sections.newQuestions) expect(seen).not.toContain(i.problem.id);
    expect(nextMon.weekNumber).toBe(2);
    // Each problem keeps two separate sessions (first attempt + weekend review).
    const detail = getProblemDetail(db, sat.sections.mandatory[0]!.problem.slug, at(addDays(MON, 7), 9))!;
    expect(detail.sessions.map((s) => s.type)).toEqual(["first_attempt", "weekend_review"]);
  });

  it("missed days carry over without unlimited catch-up; skipping keeps your place", () => {
    const db = freshDb();
    createPlan(db, { startDate: MON, timeZone: TZ }, at(MON, 8));
    const mon = getTodayView(db, at(MON, 8));
    const monIds = mon.sections.newQuestions.map((i) => i.problem.id);
    // Do nothing Monday. Tuesday shows Monday's 5 as carried over, no new pull.
    const tue = getTodayView(db, at(addDays(MON, 1), 8));
    expect(tue.sections.newQuestions).toHaveLength(5);
    expect(tue.sections.newQuestions.every((i) => i.carriedOver)).toBe(true);
    // Finish 2 of them on Wednesday → Wednesday pulls only 2 new (5 - 3 carried).
    solveAll(db, tue.sections.newQuestions.slice(0, 2), addDays(MON, 2));
    const wed = getTodayView(db, at(addDays(MON, 2), 9));
    expect(wed.sections.newQuestions.filter((i) => i.assignment.status !== "completed")).toHaveLength(5);
    expect(wed.sections.newQuestions.filter((i) => !i.carriedOver && i.assignment.status !== "completed")).toHaveLength(2);
    // Skip-day on a fresh plan: the same questions come back next time.
    const db2 = freshDb();
    const plan = createPlan(db2, { startDate: MON, timeZone: TZ }, at(MON, 8));
    const m2 = getTodayView(db2, at(MON, 8)).sections.newQuestions.map((i) => i.problem.id);
    skipDay(db2, plan.id, MON);
    expect(getTodayView(db2, at(MON, 9)).sections.newQuestions.filter((i) => i.assignment.status === "pending")).toHaveLength(0);
    const t2 = getTodayView(db2, at(addDays(MON, 1), 9)).sections.newQuestions.map((i) => i.problem.id);
    expect(t2).toEqual(m2);
    expect(monIds).toEqual(m2);
  });

  it("paused plan assigns nothing; resuming continues", () => {
    const db = freshDb();
    const plan = createPlan(db, { startDate: MON, timeZone: TZ }, at(MON, 8));
    setPlanPaused(db, plan.id, true);
    expect(getTodayView(db, at(MON, 9)).sections.newQuestions).toHaveLength(0);
    setPlanPaused(db, plan.id, false);
    expect(getTodayView(db, at(MON, 10)).sections.newQuestions).toHaveLength(5);
  });

  it("uses the local calendar date at time-zone boundaries", () => {
    const db = freshDb();
    createPlan(db, { startDate: MON, timeZone: TZ }, at(MON, 8));
    // 23:30 Monday Toronto = 04:30 UTC Tuesday.
    const lateMon = at(MON, 23, 30);
    expect(new Date(lateMon).toISOString().slice(0, 10)).toBe(addDays(MON, 1));
    const v = getTodayView(db, lateMon);
    expect(v.today).toBe(MON);
    const it0 = v.sections.newQuestions[0]!;
    const { session } = startSession(db, { problemId: it0.problem.id, assignmentId: it0.assignment.id, origin: "dashboard" }, lateMon);
    const done = finishSession(db, session.id, { outcome: "independent", hintsUsed: false }, lateMon + 10 * 60_000);
    expect(done.endedDate).toBe(MON);
    // 00:30 Tuesday local → Tuesday's allocation.
    expect(getTodayView(db, at(addDays(MON, 1), 0, 30)).today).toBe(addDays(MON, 1));
  });

  it("moving from LeetCode 75 to Top Interview 150 skips already-practiced overlaps and keeps their history", () => {
    const db = freshDb();
    const plan = createPlan(db, { startDate: MON, timeZone: TZ }, at(MON, 8));
    const queue = getQueue(db, plan.id);
    const l75 = queue.filter((q) => q.listSlug === "sample-a");
    expect(l75).toHaveLength(75);
    // Mark all of LeetCode 75 as previously completed.
    for (const q of l75) logManualAttempt(db, { problemId: q.problemId, date: addDays(MON, -30), outcome: "independent" });
    const v = getTodayView(db, at(MON, 9));
    const l75ids = new Set(l75.map((q) => q.problemId));
    expect(v.sections.newQuestions).toHaveLength(5);
    for (const i of v.sections.newQuestions) expect(l75ids.has(i.problem.id)).toBe(false);
    const overlapQueue = getQueue(db, plan.id).filter((q) => q.listSlug === "sample-b");
    // Overlaps were never added twice: the queue holds each problem once.
    expect(new Set(getQueue(db, plan.id).map((q) => q.problemId)).size).toBe(getQueue(db, plan.id).length);
    expect(overlapQueue.length).toBe(150 - (75 + 150 - db.select().from(schema.problems).all().length));
    // History intact.
    const slug = queue[0]!.slug;
    expect(getProblemDetail(db, slug, at(MON, 9))!.sessions).toHaveLength(1);
    // Explicitly practicing an overlap as new is allowed.
    enqueueProblem(db, plan.id, l75[0]!.problemId, "front");
    expect(pendingQueue(db, plan.id)[0]).toEqual({ problemId: l75[0]!.problemId, force: true });
  });

  it("queue reorder, reschedule, skip and manual add", () => {
    const db = freshDb();
    const plan = createPlan(db, { startDate: MON, timeZone: TZ }, at(MON, 8));
    const before = pendingQueue(db, plan.id).map((q) => q.problemId);
    moveQueueItem(db, plan.id, before[3]!, "top");
    expect(pendingQueue(db, plan.id)[0]!.problemId).toBe(before[3]);
    moveQueueItem(db, plan.id, before[3]!, "down");
    expect(pendingQueue(db, plan.id)[1]!.problemId).toBe(before[3]);
    const v = getTodayView(db, at(MON, 9));
    const a = v.sections.newQuestions[0]!;
    rescheduleAssignment(db, a.assignment.id, addDays(MON, 2), at(MON, 9));
    expect(getTodayView(db, at(MON, 9)).sections.newQuestions).toHaveLength(4);
    const b = v.sections.newQuestions[1]!;
    skipAssignment(db, b.assignment.id);
    expect(pendingQueue(db, plan.id).map((q) => q.problemId)).toContain(b.problem.id);
    const extra = getProblemBySlug(db, "two-sum")!;
    addAssignment(db, extra.id, MON);
    expect(() => addAssignment(db, extra.id, MON)).toThrow(/Already scheduled/);
    expect(getTodayView(db, at(MON, 9)).sections.newQuestions.some((i) => i.problem.id === extra.id)).toBe(true);
    const up = getUpcoming(db, 7, at(MON, 9));
    expect(up.days[0]!.newProblems.length).toBeGreaterThan(0);
  });
});

describe("flexible weekly plan", () => {
  const TUE = addDays(MON, 1);
  const WED = addDays(MON, 2);
  const THU = addDays(MON, 3);
  const FRI = addDays(MON, 4);
  const SAT = addDays(MON, 5);
  const SUN = addDays(MON, 6);
  type Db = ReturnType<typeof freshDb>;
  const open = (v: ReturnType<typeof getTodayView>) => v.sections.newQuestions.filter((i) => i.assignment.status !== "completed");
  function solveAt(db: Db, items: { assignment: { id: number }; problem: { id: number } }[], date: string, hour: number, outcome: Outcome = "independent") {
    let minute = 0;
    for (const it of items) {
      const { session } = startSession(db, { problemId: it.problem.id, assignmentId: it.assignment.id, origin: "dashboard", startedAt: at(date, hour, minute) }, at(date, hour, minute));
      finishSession(db, session.id, { outcome, hintsUsed: false }, at(date, hour, minute + 4));
      minute += 5;
    }
  }

  it("the agreed example: Tue +3 → Wed 2; Wed +1 → Thu 4; Fri 5; week stays 25 and so does the weekend review", () => {
    const db = freshDb();
    createPlan(db, { startDate: MON, timeZone: TZ }, at(MON, 8));
    const seen: number[] = [];
    const day = (date: string, expectNew: number, more = 0) => {
      let v = getTodayView(db, at(date, 8));
      expect(open(v)).toHaveLength(expectNew);
      expect(open(v).every((i) => !i.carriedOver)).toBe(true);
      seen.push(...open(v).map((i) => i.problem.id));
      solveAt(db, open(v), date, 9);
      if (more) {
        expect(doMoreToday(db, more, at(date, 12))).toBe(more);
        v = getTodayView(db, at(date, 12));
        expect(open(v)).toHaveLength(more);
        seen.push(...open(v).map((i) => i.problem.id));
        solveAt(db, open(v), date, 13);
      }
      // Re-opening the dashboard later the same day never adds more.
      expect(open(getTodayView(db, at(date, 20)))).toHaveLength(0);
    };
    day(MON, 5);
    expect(getTodayView(db, at(TUE, 8)).weekNew).toMatchObject({ target: 25, assigned: 10, remaining: 15, lightens: WED });
    day(TUE, 5, 3);
    // The calendar shows the lighter Wednesday right away.
    const up = getUpcoming(db, 4, at(TUE, 14));
    expect(up.days.map((d) => d.newProblems.length)).toEqual([2, 5, 5, 0]);
    day(WED, 2, 1);
    expect(getUpcoming(db, 2, at(WED, 14)).days[0]!.newProblems).toHaveLength(4);
    day(THU, 4);
    day(FRI, 5);
    expect(new Set(seen).size).toBe(25);
    const fri = getTodayView(db, at(FRI, 21));
    expect(fri.weekNew).toMatchObject({ target: 25, assigned: 25, remaining: 0, lightens: null });
    expect(fri.progress).toMatchObject({ weekNewDone: 25, weeklyNewQuota: 25 });
    expect(() => doMoreToday(db, 1, at(FRI, 21))).toThrow(/target is reached/);
    const sat = getTodayView(db, at(SAT, 9));
    expect(sat.sections.mandatory).toHaveLength(12);
    solveAt(db, sat.sections.mandatory, SAT, 9, "easy");
    const sun = getTodayView(db, at(SUN, 9));
    expect(sun.sections.mandatory).toHaveLength(13);
    expect(new Set([...sat.sections.mandatory, ...sun.sections.mandatory].map((i) => i.problem.id))).toEqual(new Set(seen));
    solveAt(db, sun.sections.mandatory, SUN, 9);
    // Next week starts fresh at its own target.
    const nextMon = getTodayView(db, at(addDays(MON, 7), 9));
    expect(open(nextMon)).toHaveLength(5);
    expect(nextMon.weekNew).toMatchObject({ target: 25, assigned: 5 });
    // Analytics: weekly target X/Y next to adherence.
    const week = getAnalytics(db, { weeks: 2 }, at(addDays(MON, 7), 9)).weekly[0]!;
    expect(week).toMatchObject({ week: MON, newDone: 25, newTarget: 25, adherence: 1 });
  });

  it("doing more than the next day's share empties the nearest days first; Do more is capped at the week", () => {
    const db = freshDb();
    createPlan(db, { startDate: MON, timeZone: TZ }, at(MON, 8));
    solveAt(db, open(getTodayView(db, at(MON, 8))), MON, 9);
    // Ask for 30 on Monday: capped at the 20 left this week.
    expect(doMoreToday(db, 30, at(MON, 12))).toBe(20);
    expect(getUpcoming(db, 6, at(MON, 13)).days.every((d) => d.newProblems.length === 0)).toBe(true);
    expect(open(getTodayView(db, at(TUE, 8))).filter((i) => !i.carriedOver)).toHaveLength(0);
  });

  it("missed days stay forgiving: no debt, and Do more can catch up later in the week", () => {
    const db = freshDb();
    createPlan(db, { startDate: MON, timeZone: TZ }, at(MON, 8));
    solveAt(db, open(getTodayView(db, at(MON, 8))), MON, 9);
    // Tuesday never opened. Wednesday is still a normal 5.
    const wed = getTodayView(db, at(WED, 8));
    expect(open(wed)).toHaveLength(5);
    expect(wed.weekNew).toMatchObject({ assigned: 10, remaining: 15, behind: 5 });
    solveAt(db, open(wed), WED, 9);
    // Catching up Tuesday's 5 on Wednesday makes up the missed share: Thursday and Friday stay at 5.
    expect(doMoreToday(db, 5, at(WED, 12))).toBe(5);
    expect(getUpcoming(db, 2, at(WED, 13)).days.map((d) => d.newProblems.length)).toEqual([5, 5]);
    expect(getTodayView(db, at(WED, 13)).weekNew).toMatchObject({ behind: 0, lightens: THU });
    // Doing more after that works ahead: it comes off Thursday.
    expect(doMoreToday(db, 2, at(WED, 14))).toBe(2);
    expect(getUpcoming(db, 2, at(WED, 15)).days.map((d) => d.newProblems.length)).toEqual([3, 5]);
    // The week can still reach its full target.
    expect(getTodayView(db, at(WED, 15)).weekNew).toMatchObject({ assigned: 17, remaining: 8 });
  });

  it("'Today, as new' counts toward the week and lightens the next day", () => {
    const db = freshDb();
    const plan = createPlan(db, { startDate: MON, timeZone: TZ }, at(MON, 8));
    solveAt(db, open(getTodayView(db, at(MON, 8))), MON, 9);
    const tue = getTodayView(db, at(TUE, 8));
    expect(open(tue)).toHaveLength(5);
    const next = pendingQueue(db, plan.id)[0]!.problemId;
    addAssignment(db, next, TUE, { asNew: true });
    expect(getTodayView(db, at(TUE, 9)).weekNew).toMatchObject({ assigned: 11, remaining: 14 });
    solveAt(db, open(getTodayView(db, at(TUE, 9))), TUE, 10);
    expect(open(getTodayView(db, at(WED, 8)))).toHaveLength(4);
  });

  it("skipping a question leaves the week short instead of adding to tomorrow", () => {
    const db = freshDb();
    createPlan(db, { startDate: MON, timeZone: TZ }, at(MON, 8));
    const mon = getTodayView(db, at(MON, 8));
    skipAssignment(db, open(mon)[0]!.assignment.id);
    solveAt(db, open(getTodayView(db, at(MON, 9))), MON, 9);
    const tue = getTodayView(db, at(TUE, 8));
    expect(open(tue)).toHaveLength(5);
    expect(tue.weekNew).toMatchObject({ assigned: 9, remaining: 16 });
  });

  it("a question rescheduled into a day takes one of that day's slots", () => {
    const db = freshDb();
    createPlan(db, { startDate: MON, timeZone: TZ }, at(MON, 8));
    const mon = getTodayView(db, at(MON, 8));
    const moved = open(mon)[0]!;
    rescheduleAssignment(db, moved.assignment.id, WED, at(MON, 9));
    solveAt(db, open(getTodayView(db, at(MON, 9))), MON, 9);
    solveAt(db, open(getTodayView(db, at(TUE, 8))), TUE, 9);
    // The forecast already shows Wednesday at 4 new + the moved one.
    expect(getUpcoming(db, 1, at(TUE, 12)).days[0]!.newProblems).toHaveLength(4);
    const wed = getTodayView(db, at(WED, 8));
    expect(open(wed)).toHaveLength(5);
    expect(open(wed).map((i) => i.problem.id)).toContain(moved.problem.id);
  });

  it("light and skipped days ahead: fewer new questions, reviews stay due (honest overdue); not on review days", () => {
    const db = freshDb();
    const plan = createPlan(db, { startDate: MON, timeZone: TZ }, at(MON, 8));
    // A review that falls due on Wednesday (7 days after an independent solve).
    const q = getQueue(db, plan.id);
    const reviewPid = q[q.length - 1]!.problemId;
    logManualAttempt(db, { problemId: reviewPid, date: addDays(MON, -5), outcome: "independent" });
    solveAt(db, open(getTodayView(db, at(MON, 8))), MON, 9);
    setDayMode(db, plan.id, WED, { mode: "light", newQuota: 1 }, at(MON, 10));
    setDayMode(db, plan.id, THU, { mode: "skip" }, at(MON, 10));
    expect(() => setDayMode(db, plan.id, SAT, { mode: "skip" }, at(MON, 10))).toThrow(/Review days/);
    expect(() => setDayMode(db, plan.id, MON, { mode: "light", newQuota: 1 }, at(MON, 10))).toThrow(/after today/);
    const up = getUpcoming(db, 4, at(MON, 10));
    expect(up.days.map((d) => [d.newProblems.length, d.lightNew, d.skipped])).toEqual([
      [5, null, false],
      [1, 1, false],
      [0, null, true],
      [5, null, false],
    ]);
    solveAt(db, open(getTodayView(db, at(TUE, 8))), TUE, 9);
    const wed = getTodayView(db, at(WED, 8));
    expect(wed.lightDay).toBe(1);
    expect(open(wed)).toHaveLength(1);
    expect(wed.sections.srs).toHaveLength(0);
    expect(wed.backlog).toMatchObject({ due: 1, overdue: 0 });
    solveAt(db, open(wed), WED, 9);
    const thu = getTodayView(db, at(THU, 8));
    expect(thu.isSkipped).toBe(true);
    expect(open(thu)).toHaveLength(0);
    expect(thu.sections.srs.map((i) => i.problem.id)).toEqual([reviewPid]);
    expect(thu.backlog.overdue).toBe(1);
    expect(open(getTodayView(db, at(FRI, 8)))).toHaveLength(5);
    // Light days survive export / import, and can be set back to normal.
    const nextTue = addDays(MON, 8);
    setDayMode(db, plan.id, nextTue, { mode: "light", newQuota: 2 }, at(FRI, 9));
    const data = JSON.parse(JSON.stringify(exportAll(db)));
    const target = freshDb({ seed: false });
    importAll(target, data);
    expect([...getLightDays(target, getActivePlan(target)!.id)]).toContainEqual([nextTue, 2]);
    setDayMode(db, plan.id, nextTue, { mode: "normal" }, at(FRI, 9));
    expect(getLightDays(db, plan.id).has(nextTue)).toBe(false);
  });

  it("reviews can be done up to 2 days early; this week's new questions wait for the weekend review", () => {
    const db = freshDb();
    const plan = createPlan(db, { startDate: MON, timeZone: TZ }, at(MON, 8));
    const q = getQueue(db, plan.id);
    const inTwo = q[q.length - 1]!.problemId;
    const inThree = q[q.length - 2]!.problemId;
    logManualAttempt(db, { problemId: inTwo, date: addDays(MON, -5), outcome: "independent" });
    logManualAttempt(db, { problemId: inThree, date: addDays(MON, -4), outcome: "independent" });
    solveAt(db, open(getTodayView(db, at(MON, 8))), MON, 9, "failed"); // due tomorrow, but in this week's cohort
    expect(getReviewQueue(db, at(MON, 10)).earlyAvailable).toEqual([inTwo]);
    expect(pullMoreReviews(db, 5, at(MON, 10), { early: true })).toBe(1);
    const early = getTodayView(db, at(MON, 10)).sections.srs.find((i) => i.problem.id === inTwo)!;
    expect(early.assignment.note).toBe("Done early");
    solveAt(db, [early], MON, 11);
    // The next interval counts from the day it was actually done: 7 × 2 = 14 days from Monday.
    expect(getProblemDetail(db, early.problem.slug, at(MON, 12))!.reviewState!.nextDueDate).toBe(addDays(MON, 14));
    expect(getReviewQueue(db, at(MON, 12)).earlyAvailable).toEqual([]);
  });
});

describe("sessions & submissions", () => {
  it("refresh / second start never duplicates an open session", () => {
    const db = freshDb();
    const p = getProblemBySlug(db, "two-sum")!;
    const a = startSession(db, { problemId: p.id, origin: "dashboard" });
    const b = startSession(db, { problemId: p.id, origin: "extension", id: randomUUID() });
    expect(b.session.id).toBe(a.session.id);
    expect(b.resumed).toBe(true);
  });

  it("each review is a separate session; history is preserved", () => {
    const db = freshDb();
    const p = getProblemBySlug(db, "two-sum")!;
    const s1 = startSession(db, { problemId: p.id, origin: "dashboard", startedAt: at(MON, 10) }, at(MON, 10)).session;
    finishSession(db, s1.id, { outcome: "struggled", hintsUsed: false, notes: "Forgot to skip duplicates" }, at(MON, 10, 25));
    const s2 = startSession(db, { problemId: p.id, origin: "dashboard", startedAt: at(addDays(MON, 5), 10) }, at(addDays(MON, 5), 10)).session;
    expect(s2.type).toBe("free_practice");
    finishSession(db, s2.id, { outcome: "independent", hintsUsed: false, notes: "Boundary conditions" }, at(addDays(MON, 5), 10, 12));
    const d = getProblemDetail(db, "two-sum", at(addDays(MON, 5), 11))!;
    expect(d.sessions.map((s) => s.notes)).toEqual(["Forgot to skip duplicates", "Boundary conditions"]);
    expect(d.sessions[0]!.durationMs).toBe(25 * 60_000);
    expect(d.reviewState!.nextDueDate).toBe(addDays(addDays(MON, 5), 7));
    // Override the recommendation.
    const s3 = startSession(db, { problemId: p.id, origin: "dashboard" }, at(addDays(MON, 6), 10)).session;
    const f = finishSession(db, s3.id, { outcome: "easy", hintsUsed: false, nextReviewDate: addDays(MON, 40) }, at(addDays(MON, 6), 10, 5));
    expect(f.nextReviewOverridden).toBe(true);
    expect(getProblemDetail(db, "two-sum")!.reviewState!.nextDueDate).toBe(addDays(MON, 40));
    expect(() => finishSession(db, s3.id, { outcome: "easy", hintsUsed: false })).toThrow(/already completed/);
  });

  it("abandoning returns the assignment to pending and keeps the session", () => {
    const db = freshDb();
    createPlan(db, { startDate: MON, timeZone: TZ }, at(MON, 8));
    const it0 = getTodayView(db, at(MON, 9)).sections.newQuestions[0]!;
    const s = startSession(db, { problemId: it0.problem.id, assignmentId: it0.assignment.id, origin: "dashboard" }, at(MON, 9)).session;
    abandonSession(db, s.id, at(MON, 9, 30));
    const again = getTodayView(db, at(MON, 10)).sections.newQuestions[0]!;
    expect(again.assignment.status).toBe("pending");
    expect(getProblemDetail(db, it0.problem.slug)!.sessions[0]!.status).toBe("abandoned");
  });

  it("submissions: dedupe by platform id, attribution bound / inferred / none, manual link", () => {
    const db = freshDb();
    const p = getProblemBySlug(db, "two-sum")!;
    const s = startSession(db, { problemId: p.id, origin: "dashboard" }, at(MON, 10)).session;
    const base = { problemId: p.id, kind: "submit" as const, lang: "python3", code: "print(1)", captureSource: "extension_network" as const };
    const r1 = recordSubmission(db, { ...base, claimedSessionId: s.id, platformSubmissionId: "111", submittedAt: at(MON, 10, 5) });
    expect(r1.created).toBe(true);
    expect(r1.submission.attribution).toBe("bound");
    const r2 = recordSubmission(db, { ...base, claimedSessionId: s.id, platformSubmissionId: "111", submittedAt: at(MON, 10, 5), code: "changed" });
    expect(r2.created).toBe(false);
    expect(r2.submission.code).toBe("print(1)"); // never overwritten
    const r3 = recordSubmission(db, { ...base, claimedSessionId: null, platformSubmissionId: "112", submittedAt: at(MON, 10, 8) });
    expect(r3.submission.attribution).toBe("inferred");
    finishSession(db, s.id, { outcome: "independent", hintsUsed: false }, at(MON, 10, 10));
    // Next day, no open session → unattributed, can be linked manually.
    const r4 = recordSubmission(db, { ...base, claimedSessionId: null, platformSubmissionId: "113", submittedAt: at(addDays(MON, 1), 12) });
    expect(r4.submission.sessionId).toBeNull();
    linkSubmission(db, r4.submission.id, s.id);
    expect(db.select().from(schema.submissions).where(eq(schema.submissions.id, r4.submission.id)).get()!.attribution).toBe("manual");
  });

  it("deleting a test session reopens its task, removes its submissions and re-derives the schedule", () => {
    const db = freshDb();
    createPlan(db, { startDate: MON, timeZone: TZ }, at(MON, 8));
    const it0 = getTodayView(db, at(MON, 9)).sections.newQuestions[0]!;
    const s = startSession(db, { problemId: it0.problem.id, assignmentId: it0.assignment.id, origin: "dashboard" }, at(MON, 9)).session;
    const base = { problemId: it0.problem.id, kind: "submit" as const, lang: "python3", captureSource: "extension_network" as const, claimedSessionId: s.id };
    recordSubmission(db, { ...base, platformSubmissionId: "901", code: "a", submittedAt: at(MON, 9, 5) });
    expect(() => deleteSession(db, s.id)).toThrow(/Finish or abandon/);
    finishSession(db, s.id, { outcome: "independent", hintsUsed: false }, at(MON, 9, 10));
    expect(getProblemDetail(db, it0.problem.slug)!.reviewState).not.toBeNull();
    expect(getQueue(db, getActivePlan(db)!.id).find((q) => q.problemId === it0.problem.id)!.status).toBe("done");

    const r = deleteSession(db, s.id, MON);
    expect(r).toMatchObject({ deletedSubmissions: 1, reopenedAssignments: 1 });
    const d = getProblemDetail(db, it0.problem.slug)!;
    expect(d.sessions).toHaveLength(0);
    expect(d.reviewState).toBeNull();
    expect(db.select().from(schema.submissions).all()).toHaveLength(0);
    expect(getTodayView(db, at(MON, 11)).sections.newQuestions[0]!.assignment.status).toBe("pending");
    expect(getQueue(db, getActivePlan(db)!.id).find((q) => q.problemId === it0.problem.id)!.status).toBe("assigned");
    expect(() => deleteSession(db, s.id)).toThrow(/not found/);
  });

  it("deleting one of several sessions keeps the others and recomputes review state", () => {
    const db = freshDb();
    const p = getProblemBySlug(db, "two-sum")!;
    const s1 = startSession(db, { problemId: p.id, origin: "dashboard" }, at(MON, 10)).session;
    finishSession(db, s1.id, { outcome: "independent", hintsUsed: false }, at(MON, 10, 20));
    const day2 = addDays(MON, 2);
    const s2 = startSession(db, { problemId: p.id, origin: "dashboard" }, at(day2, 10)).session;
    finishSession(db, s2.id, { outcome: "failed", hintsUsed: true }, at(day2, 10, 20));
    expect(getProblemDetail(db, "two-sum")!.reviewState!.nextDueDate).toBe(addDays(day2, 1));
    deleteSession(db, s2.id, day2);
    const d = getProblemDetail(db, "two-sum")!;
    expect(d.sessions.map((x) => x.id)).toEqual([s1.id]);
    expect(d.reviewState!.nextDueDate).toBe(addDays(MON, 7));
  });

  it("deleting a submission re-derives first Accepted; editing the outcome re-derives the schedule", () => {
    const db = freshDb();
    const p = getProblemBySlug(db, "two-sum")!;
    const s = startSession(db, { problemId: p.id, origin: "dashboard" }, at(MON, 10)).session;
    const base = { problemId: p.id, kind: "submit" as const, lang: "python3", captureSource: "extension_network" as const, claimedSessionId: s.id };
    const a1 = recordSubmission(db, { ...base, platformSubmissionId: "1", code: "x", verdict: "Accepted", submittedAt: at(MON, 10, 5) }).submission;
    recordSubmission(db, { ...base, platformSubmissionId: "2", code: "y", verdict: "Accepted", submittedAt: at(MON, 10, 9) });
    expect(getProblemDetail(db, "two-sum")!.sessions[0]!.firstAcceptedAt).toBe(at(MON, 10, 5));
    deleteSubmission(db, a1.id);
    expect(getProblemDetail(db, "two-sum")!.sessions[0]!.firstAcceptedAt).toBe(at(MON, 10, 9));
    finishSession(db, s.id, { outcome: "independent", hintsUsed: false }, at(MON, 10, 12));
    expect(getProblemDetail(db, "two-sum")!.reviewState!.nextDueDate).toBe(addDays(MON, 7));
    editCompletedSession(db, s.id, { outcome: "struggled", hintsUsed: true, difficultyRating: 4 });
    const d = getProblemDetail(db, "two-sum")!;
    expect(d.reviewState!.nextDueDate).toBe(addDays(MON, 3));
    expect(d.sessions[0]).toMatchObject({ outcome: "struggled", hintsUsed: true, difficultyRating: 4, nextReviewDate: addDays(MON, 3), recommendedReviewDate: addDays(MON, 3) });
  });

  it("session time/space complexity: saved per attempt, synced from the extension, fills empty permanent notes only", () => {
    const db = freshDb();
    const p = getProblemBySlug(db, "two-sum")!;
    saveNotes(db, p.id, { spaceComplexity: "O(n) — hash map" });
    const sid = randomUUID();
    const base = { clientId: randomUUID(), createdAt: at(MON, 10) };
    const r = processSyncEvents(db, [
      { ...base, id: randomUUID(), seq: 1, type: "session.start", payload: { sessionId: sid, problem: { slug: "two-sum" }, startedAt: at(MON, 10) } },
      { ...base, id: randomUUID(), seq: 2, type: "session.notes", payload: { sessionId: sid, notes: "one pass", timeComplexity: "O(n)" } },
      // A later snapshot without complexity leaves it alone.
      { ...base, id: randomUUID(), seq: 3, type: "session.notes", payload: { sessionId: sid, notes: "one pass + map" } },
      { ...base, id: randomUUID(), seq: 4, type: "session.finish", payload: { sessionId: sid, endedAt: at(MON, 10, 20), reflection: { outcome: "independent", hintsUsed: false, spaceComplexity: "O(n)" } } },
    ]);
    expect(r.map((x) => x.status)).toEqual(["processed", "processed", "processed", "processed"]);
    const s = getProblemDetail(db, "two-sum")!.sessions[0]!;
    expect(s).toMatchObject({ notes: "one pass + map", timeComplexity: "O(n)", spaceComplexity: "O(n)" });
    // Empty permanent field filled; the existing one is never overwritten.
    expect(getNotes(db, p.id)).toMatchObject({ timeComplexity: "O(n)", spaceComplexity: "O(n) — hash map" });
    // Editable afterwards.
    editCompletedSession(db, sid, { timeComplexity: "O(n log n)" });
    expect(getProblemDetail(db, "two-sum")!.sessions[0]!.timeComplexity).toBe("O(n log n)");
  });

  it("a question id already held by another problem doesn't break syncing", () => {
    const db = freshDb();
    const taken = getProblemBySlug(db, "two-sum")!.platformQuestionId!;
    const r = processSyncEvents(db, [
      { id: randomUUID(), clientId: randomUUID(), seq: 1, createdAt: at(MON, 9), type: "session.start", payload: { sessionId: randomUUID(), problem: { slug: "some-renamed-problem", questionId: taken }, startedAt: at(MON, 9) } },
    ]);
    expect(r[0]!.status).toBe("processed");
    expect(getProblemBySlug(db, "some-renamed-problem")!.platformQuestionId).toBeNull();
  });

  it("moving an Accepted submission updates first-Accepted on both sessions", () => {
    const db = freshDb();
    const p = getProblemBySlug(db, "two-sum")!;
    const a = startSession(db, { problemId: p.id, origin: "dashboard" }, at(MON, 10)).session;
    const sub = recordSubmission(db, { problemId: p.id, kind: "submit", lang: "python3", code: "x", captureSource: "extension_network", claimedSessionId: a.id, platformSubmissionId: "7", verdict: "Accepted", submittedAt: at(MON, 10, 5) }).submission;
    finishSession(db, a.id, { outcome: "independent", hintsUsed: false }, at(MON, 10, 10));
    const b = startSession(db, { problemId: p.id, origin: "dashboard" }, at(MON, 11)).session;
    const first = (id: string) => getProblemDetail(db, "two-sum")!.sessions.find((s) => s.id === id)!.firstAcceptedAt;
    linkSubmission(db, sub.id, b.id);
    expect([first(a.id), first(b.id)]).toEqual([null, at(MON, 10, 5)]);
    linkSubmission(db, sub.id, null);
    expect(first(b.id)).toBeNull();
  });

  it("permanent notes autosave and keep revisions", () => {
    const db = freshDb();
    const p = getProblemBySlug(db, "two-sum")!;
    saveNotes(db, p.id, { insight: "hash map of complements" });
    saveNotes(db, p.id, { insight: "hash map of complement → index", timeComplexity: "O(n)" });
    expect(getNotes(db, p.id)!.insight).toBe("hash map of complement → index");
    expect(listNoteRevisions(db, p.id)).toHaveLength(1);
  });

  it("mandatory review prevents a duplicate SRS task on the same day", () => {
    const db = freshDb();
    createPlan(db, { startDate: MON, timeZone: TZ }, at(MON, 8));
    const mon = getTodayView(db, at(MON, 9));
    solveAll(db, mon.sections.newQuestions, MON, "failed"); // due Tuesday
    for (let d = 1; d < 5; d++) getTodayView(db, at(addDays(MON, d), 9));
    const sat = getTodayView(db, at(addDays(MON, 5), 9));
    const mandatoryIds = new Set(sat.sections.mandatory.map((i) => i.problem.id));
    for (const i of sat.sections.srs) expect(mandatoryIds.has(i.problem.id)).toBe(false);
    const rq = getReviewQueue(db, at(addDays(MON, 5), 9));
    expect(rq.dueNow.length).toBe(5);
    expect(rq.dueNow.every((r) => r.openAssignment)).toBe(true);
  });
});

describe("sync events", () => {
  const client = "test-client";
  let seq = 0;
  const ev = (type: string, payload: unknown) => ({ id: randomUUID(), clientId: client, seq: seq++, createdAt: Date.now(), type, payload });

  it("are idempotent and handle offline-created sessions", () => {
    const db = freshDb();
    const sid = randomUUID();
    const problem = { slug: "two-sum", title: "Two Sum", frontendId: "1", questionId: "1" };
    const start = ev("session.start", { sessionId: sid, problem, startedAt: at(MON, 10) });
    const cap = ev("submission.captured", { sessionId: sid, problem, kind: "submit", platformSubmissionId: "999", lang: "python3", code: "x", submittedAt: at(MON, 10, 5) });
    const res = ev("submission.result", {
      sessionId: sid,
      problem,
      kind: "submit",
      platformSubmissionId: "999",
      verdict: "Accepted",
      statusCode: 10,
      runtime: "1 ms",
      memory: "17 MB",
      totalCorrect: 63,
      totalTestcases: 63,
      lang: "python3",
      judgedAt: at(MON, 10, 5),
    });
    const act = ev("session.activity", { sessionId: sid, activeMs: 300_000, lastActivityAt: at(MON, 10, 6) });
    const fin = ev("session.finish", { sessionId: sid, endedAt: at(MON, 10, 10), reflection: { outcome: "independent", hintsUsed: false, notes: "ok" } });
    const r1 = processSyncEvents(db, [start, cap, res, act, fin]);
    expect(r1.map((r) => r.status)).toEqual(["processed", "processed", "processed", "processed", "processed"]);
    const r2 = processSyncEvents(db, [start, cap, res, act, fin]);
    expect(r2.map((r) => r.status)).toEqual(["duplicate", "duplicate", "duplicate", "duplicate", "duplicate"]);
    const d = getProblemDetail(db, "two-sum")!;
    expect(d.sessions).toHaveLength(1);
    expect(d.sessions[0]!.submissions).toHaveLength(1);
    expect(d.sessions[0]!.submissions[0]!.verdict).toBe("Accepted");
    expect(d.sessions[0]!.activeMs).toBe(300_000);
    expect(d.sessions[0]!.firstAcceptedAt).toBe(at(MON, 10, 5));
    // A late duplicate start for a different id while a session is open gets aliased.
    const open = startSession(db, { problemId: d.problem.id, origin: "dashboard" }).session;
    const other = randomUUID();
    const r3 = processSyncEvents(db, [ev("session.start", { sessionId: other, problem, startedAt: Date.now() }), ev("session.notes", { sessionId: other, notes: "from ext" })]);
    expect(r3[0]!.sessionId).toBe(open.id);
    expect(getProblemDetail(db, "two-sum")!.sessions.find((s) => s.id === open.id)!.notes).toBe("from ext");
    // Invalid & domain-failing events are rejected (not retried forever).
    const bad = processSyncEvents(db, [{ id: randomUUID(), type: "session.finish", payload: {} }, ev("session.pause", { sessionId: randomUUID(), at: Date.now() })]);
    expect(bad.map((b) => b.status)).toEqual(["rejected", "rejected"]);
  });

  it("result arriving without the submit request creates an honest code-less row", () => {
    const db = freshDb();
    const r = processSyncEvents(db, [
      ev("submission.result", { sessionId: null, problem: { slug: "brand-new-problem" }, kind: "submit", platformSubmissionId: "5", verdict: "Wrong Answer", statusCode: 11, runtime: null, memory: null, totalCorrect: 3, totalTestcases: 10, lang: "cpp", judgedAt: Date.now() }),
    ]);
    expect(r[0]!.status).toBe("processed");
    const p = getProblemBySlug(db, "brand-new-problem")!;
    expect(p.title).toBe("Brand New Problem");
    const sub = db.select().from(schema.submissions).where(eq(schema.submissions.problemId, p.id)).get()!;
    expect(sub.code).toBeNull();
    expect(sub.verdict).toBe("Wrong Answer");
  });
});

describe("export / import", () => {
  it("round-trips into an empty database and never duplicates on re-import", () => {
    const db = freshDb();
    createPlan(db, { startDate: MON, timeZone: TZ }, at(MON, 8));
    const v = getTodayView(db, at(MON, 9));
    solveAll(db, v.sections.newQuestions, MON);
    saveNotes(db, v.sections.newQuestions[0]!.problem.id, { insight: "two pointers" });
    saveNotes(db, v.sections.newQuestions[0]!.problem.id, { pitfalls: "off by one" }); // creates one revision
    recordSubmission(db, { problemId: v.sections.newQuestions[0]!.problem.id, claimedSessionId: null, kind: "submit", platformSubmissionId: "42", lang: "java", code: "class S{}", submittedAt: at(MON, 11), captureSource: "extension_network" });
    const data = JSON.parse(JSON.stringify(exportAll(db)));

    const target = freshDb({ seed: false });
    const rep = importAll(target, data);
    expect(rep.sessions.inserted).toBe(5);
    expect(rep.submissions.inserted).toBe(1);
    expect(rep.plans.inserted).toBe(1);
    expect(rep.notes.inserted).toBe(1);
    expect(getActivePlan(target)).not.toBeNull();
    // Review state is re-derived.
    const slug = v.sections.newQuestions[0]!.problem.slug;
    expect(getProblemDetail(target, slug)!.reviewState!.nextDueDate).toBe(addDays(MON, 7));
    // Same day in the restored DB does not re-allocate.
    expect(getTodayView(target, at(MON, 12)).sections.newQuestions).toHaveLength(5);

    const again = importAll(target, data);
    expect(again.sessions.inserted).toBe(0);
    expect(again.sessions.existing).toBe(5);
    expect(again.submissions.inserted).toBe(0);
    expect(again.notes.identical).toBe(1);
    expect(target.select().from(schema.problemNoteRevisions).all()).toHaveLength(1); // not duplicated by the re-import

    // Differing notes are kept as a revision, not overwritten.
    saveNotes(target, getProblemBySlug(target, slug)!.id, { insight: "edited locally" });
    const rep3 = importAll(target, data);
    expect(rep3.notes.conflictsKeptAsRevision).toBe(1);
    expect(getNotes(target, getProblemBySlug(target, slug)!.id)!.insight).toBe("edited locally");
  });

  it("a hand-edited backup with wrong field types is refused before anything is written", () => {
    const src = freshDb();
    const data = JSON.parse(JSON.stringify(exportAll(src)));
    data.problems[0].topics = "not a list";
    const target = freshDb({ seed: false });
    expect(() => importAll(target, data)).toThrow();
    expect(target.select().from(schema.problems).all()).toHaveLength(0);
    const data2 = JSON.parse(JSON.stringify(exportAll(src)));
    data2.problems[0].slug = "../evil";
    expect(() => importAll(target, data2)).toThrow();
  });

  it("imports an open session next to a differently-open local one without failing", () => {
    const src = freshDb();
    startSession(src, { problemId: getProblemBySlug(src, "two-sum")!.id, origin: "dashboard" }, at(MON, 9));
    const data = JSON.parse(JSON.stringify(exportAll(src)));
    const target = freshDb();
    const p = getProblemBySlug(target, "two-sum")!;
    const mine = startSession(target, { problemId: p.id, origin: "dashboard" }, at(MON, 10)).session;
    pauseSession(target, mine.id, at(MON, 10, 5));
    expect(importAll(target, data).sessions.inserted).toBe(1);
    expect(getProblemDetail(target, "two-sum")!.sessions.map((s) => s.status).sort()).toEqual(["abandoned", "paused"]);
  });

  it("analytics separate unique-problem and session metrics", () => {
    const db = freshDb();
    const p = getProblemBySlug(db, "two-sum")!;
    for (let i = 0; i < 3; i++) {
      const day = addDays(MON, i * 7);
      const s = startSession(db, { problemId: p.id, origin: "dashboard" }, at(day, 10)).session;
      recordSubmission(db, { problemId: p.id, claimedSessionId: s.id, kind: "submit", platformSubmissionId: `x${i}`, lang: "py", code: `v${i}`, submittedAt: at(day, 10, 3), captureSource: "manual", verdict: "Accepted" });
      finishSession(db, s.id, { outcome: "independent", hintsUsed: false }, at(day, 10, 10));
    }
    const a = getAnalytics(db, {}, at(addDays(MON, 15), 9));
    expect(a.unique.encountered).toBe(1);
    expect(a.sessionLevel.sessions).toBe(3);
    expect(a.sessionLevel.submissions).toBe(3);
    expect(a.sessionLevel.acceptanceRate).toBe(1);
    expect(toLocalDate(at(MON, 10), TZ)).toBe(MON);
  });
});
