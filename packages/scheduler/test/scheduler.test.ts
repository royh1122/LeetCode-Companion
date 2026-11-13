import { describe, expect, it } from "vitest";
import { DEFAULT_MASTERY_SETTINGS, DEFAULT_PLAN_SETTINGS, DEFAULT_SRS_SETTINGS, addDays, weekdayOf, type PlanSettings } from "@lcc/shared";
import { computeMastery, computeNextReview, cumulativeNewShare, dayNewShare, forecast, newQuestionPull, planDay, rankDueReviews, weekendReviewTarget, weeklyNewTarget, type PlanDayInput } from "../src";

const MON = "2026-11-09";

describe("dates sanity", () => {
  it("2026-11-09 is a Monday", () => expect(weekdayOf(MON)).toBe(1));
});

describe("computeNextReview", () => {
  const cfg = DEFAULT_SRS_SETTINGS;
  it("uses base intervals on first sight", () => {
    expect(computeNextReview(null, "failed", MON, cfg).intervalDays).toBe(1);
    expect(computeNextReview(null, "hints", MON, cfg).intervalDays).toBe(1);
    expect(computeNextReview(null, "struggled", MON, cfg).intervalDays).toBe(3);
    expect(computeNextReview(null, "independent", MON, cfg).intervalDays).toBe(7);
    expect(computeNextReview(null, "easy", MON, cfg).intervalDays).toBe(21);
    expect(computeNextReview(null, "independent", MON, cfg).nextDueDate).toBe(addDays(MON, 7));
  });
  it("grows intervals with repeated independent success and caps them", () => {
    let s = computeNextReview(null, "independent", MON, cfg);
    s = computeNextReview(s, "independent", s.nextDueDate!, cfg);
    expect(s.intervalDays).toBe(14);
    s = computeNextReview(s, "easy", s.nextDueDate!, cfg);
    expect(s.intervalDays).toBe(35);
    for (let i = 0; i < 10; i++) s = computeNextReview(s, "easy", s.nextDueDate!, cfg);
    expect(s.intervalDays).toBe(cfg.maxIntervalDays);
    expect(s.successStreak).toBe(13);
  });
  it("does not jump to long intervals off a struggle", () => {
    const a = computeNextReview(null, "struggled", MON, cfg);
    const b = computeNextReview(a, "easy", a.nextDueDate!, cfg);
    expect(b.intervalDays).toBe(21); // base, not 3 × 2.5 growth chain
  });
  it("struggling after a long interval shrinks it but never resets to zero history", () => {
    let s = computeNextReview(null, "independent", MON, cfg);
    s = computeNextReview(s, "independent", s.nextDueDate!, cfg); // 14
    s = computeNextReview(s, "independent", s.nextDueDate!, cfg); // 28
    const st = computeNextReview(s, "struggled", s.nextDueDate!, cfg);
    expect(st.intervalDays).toBe(14);
    expect(st.reviewCount).toBe(4);
    expect(st.lapses).toBe(0);
  });
  it("counts lapses only after the problem was learned", () => {
    const f = computeNextReview(null, "failed", MON, cfg);
    expect(f.lapses).toBe(0);
    const ok = computeNextReview(f, "independent", addDays(MON, 1), cfg);
    const lapse = computeNextReview(ok, "hints", addDays(MON, 8), cfg);
    expect(lapse.lapses).toBe(1);
    expect(lapse.stage).toBe("relearning");
    expect(lapse.intervalDays).toBe(1);
  });
});

describe("computeMastery", () => {
  const cfg = DEFAULT_MASTERY_SETTINGS;
  const today = "2026-12-31";
  it("Accepted-once is not mastery", () => {
    expect(computeMastery([{ date: MON, outcome: "easy" }], null, today, cfg).state).toBe("improving");
  });
  it("requires a streak with a gap", () => {
    const s = [
      { date: "2026-11-09", outcome: "struggled" as const },
      { date: "2026-11-14", outcome: "independent" as const },
      { date: "2026-11-21", outcome: "independent" as const },
      { date: "2026-12-12", outcome: "easy" as const },
    ];
    expect(computeMastery(s, "2027-01-20", today, cfg).state).toBe("mastered");
    const noGap = [...s.slice(0, 3), { date: "2026-11-25", outcome: "easy" as const }];
    expect(computeMastery(noGap, "2027-01-20", today, cfg).state).toBe("improving");
  });
  it("learning vs needs review", () => {
    expect(computeMastery([{ date: MON, outcome: "hints" }], null, today, cfg).state).toBe("learning");
    expect(
      computeMastery(
        [
          { date: MON, outcome: "independent" },
          { date: "2026-11-20", outcome: "failed" },
        ],
        null,
        today,
        cfg,
      ).state,
    ).toBe("needs_review");
    expect(computeMastery([{ date: MON, outcome: "independent" }], "2026-12-01", today, cfg).state).toBe("needs_review");
    expect(computeMastery([], null, today, cfg).state).toBe("not_started");
  });
});

function input(over: Partial<PlanDayInput> = {}, settings: PlanSettings = DEFAULT_PLAN_SETTINGS): PlanDayInput {
  return {
    today: MON,
    plan: { status: "active", startDate: MON, settings },
    isSkipped: false,
    allocated: { newQuestions: false, srs: false },
    queue: Array.from({ length: 40 }, (_, i) => ({ problemId: i + 1 })),
    practicedProblemIds: new Set(),
    openAssignments: [],
    weekReviewAssigned: new Set(),
    cohort: [],
    dueReviews: [],
    ...over,
  };
}

describe("planDay", () => {
  it("allocates 5 new questions on a weekday", () => {
    const r = planDay(input());
    expect(r.createNew).toEqual([1, 2, 3, 4, 5]);
    expect(r.createWeekendReview).toEqual([]);
    expect(r.markAllocated.newQuestions).toBe(true);
  });
  it("is idempotent once allocated", () => {
    expect(planDay(input({ allocated: { newQuestions: true, srs: true } })).createNew).toEqual([]);
  });
  it("no new questions on weekends; 12 then the remaining 13 reviews", () => {
    const sat = addDays(MON, 5);
    const sun = addDays(MON, 6);
    const cohort = Array.from({ length: 25 }, (_, i) => ({ problemId: i + 1, completedDate: addDays(MON, Math.floor(i / 5)) }));
    const r1 = planDay(input({ today: sat, cohort }));
    expect(r1.createNew).toEqual([]);
    expect(r1.createWeekendReview).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    const r2 = planDay(input({ today: sun, cohort, weekReviewAssigned: new Set(r1.createWeekendReview) }));
    expect(r2.createWeekendReview).toEqual(Array.from({ length: 13 }, (_, i) => i + 13));
    // Running Saturday again adds nothing (cumulative target reached).
    expect(planDay(input({ today: sat, cohort, weekReviewAssigned: new Set(r1.createWeekendReview) })).createWeekendReview).toEqual([]);
  });
  it("catches up Saturday's mandatory reviews on Sunday if Saturday was missed", () => {
    const cohort = Array.from({ length: 25 }, (_, i) => ({ problemId: i + 1, completedDate: MON }));
    expect(planDay(input({ today: addDays(MON, 6), cohort })).createWeekendReview).toHaveLength(25);
  });
  it("carry-over reduces today's new pull (no unlimited catch-up)", () => {
    const open = [1, 2, 3].map((pid, i) => ({ id: i + 1, problemId: pid, type: "new" as const, scheduledDate: MON, status: "pending" as const }));
    const r = planDay(input({ today: addDays(MON, 1), openAssignments: open, queue: Array.from({ length: 37 }, (_, i) => ({ problemId: i + 4 })) }));
    expect(r.createNew).toEqual([4, 5]);
  });
  it("paused plans and skipped days create nothing", () => {
    expect(planDay(input({ plan: { status: "paused", startDate: MON, settings: DEFAULT_PLAN_SETTINGS } })).createNew).toEqual([]);
    const s = planDay(input({ isSkipped: true }));
    expect(s.createNew).toEqual([]);
    expect(s.markAllocated.newQuestions).toBe(false);
  });
  it("skips already-practiced overlap problems unless forced", () => {
    const r = planDay(input({ practicedProblemIds: new Set([1, 3]), queue: [{ problemId: 1 }, { problemId: 2 }, { problemId: 3, force: true }, { problemId: 4 }, { problemId: 5 }, { problemId: 6 }] }));
    expect(r.createNew).toEqual([2, 3, 4, 5, 6]);
    expect(r.skipPracticedQueue).toEqual([1]);
  });
  it("SRS: capped, ranked, never duplicates an open assignment, defers to the weekend review", () => {
    const thu = addDays(MON, 3);
    const due = [
      { problemId: 100, nextDueDate: addDays(MON, -10), intervalDays: 7, lapses: 0, lastOutcome: "independent" as const, firstPracticedDate: "2026-10-01" },
      { problemId: 101, nextDueDate: thu, intervalDays: 3, lapses: 2, lastOutcome: "failed" as const, firstPracticedDate: "2026-10-01" },
      { problemId: 102, nextDueDate: thu, intervalDays: 3, lapses: 0, lastOutcome: "struggled" as const, firstPracticedDate: MON }, // this week's cohort
      { problemId: 103, nextDueDate: thu, intervalDays: 7, lapses: 0, lastOutcome: "independent" as const, firstPracticedDate: "2026-10-01" },
      ...Array.from({ length: 10 }, (_, i) => ({ problemId: 200 + i, nextDueDate: thu, intervalDays: 21, lapses: 0, lastOutcome: "easy" as const, firstPracticedDate: "2026-09-01" })),
    ];
    const open = [{ id: 9, problemId: 103, type: "manual" as const, scheduledDate: thu, status: "pending" as const }];
    const r = planDay(input({ today: thu, dueReviews: due, openAssignments: open, allocated: { newQuestions: true, srs: false } }));
    expect(r.createSrs).toHaveLength(5);
    expect(r.createSrs[0]).toBe(100); // 13 days overdue on a 7-day interval
    expect(r.createSrs[1]).toBe(101); // weak + lapses
    expect(r.createSrs).not.toContain(102);
    expect(r.createSrs).not.toContain(103);
  });
  it("expires stale SRS picks so they get re-ranked instead of piling up", () => {
    const open = [{ id: 1, problemId: 5, type: "srs_review" as const, scheduledDate: addDays(MON, -1), status: "pending" as const }];
    expect(planDay(input({ openAssignments: open })).expireSrsIds).toEqual([1]);
  });
  it("respects custom quotas and review days", () => {
    const settings: PlanSettings = { ...DEFAULT_PLAN_SETTINGS, newPerWeekday: [0, 3, 3, 3, 3, 3, 2], reviewDays: [{ weekday: 0, quota: null }] };
    expect(planDay(input({}, settings)).createNew).toHaveLength(3);
    expect(planDay(input({ today: addDays(MON, 5) }, settings)).createNew).toHaveLength(2);
    expect(weekendReviewTarget(settings, addDays(MON, 5))).toBe(0);
  });
  it("ranks overdue weak reviews first", () => {
    const ranked = rankDueReviews(
      [
        { problemId: 1, nextDueDate: MON, intervalDays: 7, lapses: 0, lastOutcome: "easy", firstPracticedDate: null },
        { problemId: 2, nextDueDate: addDays(MON, -14), intervalDays: 7, lapses: 0, lastOutcome: "independent", firstPracticedDate: null },
      ],
      MON,
    );
    expect(ranked.map((r) => r.problemId)).toEqual([2, 1]);
  });
});

describe("forecast", () => {
  it("projects new questions and weekend reviews", () => {
    const fc = forecast({ from: MON, days: 8, settings: DEFAULT_PLAN_SETTINGS, queue: Array.from({ length: 60 }, (_, i) => i), skipDates: new Set([addDays(MON, 2)]), cohortSoFar: 0, reviewsAssignedThisWeek: 0 });
    expect(fc[0]!.newProblemIds).toEqual([0, 1, 2, 3, 4]);
    expect(fc[2]!.skipped).toBe(true);
    expect(fc[2]!.newProblemIds).toEqual([]);
    expect(fc[5]!.mandatoryReviews).toBe(12);
    expect(fc[6]!.mandatoryReviews).toBe(8);
    expect(fc[7]!.newProblemIds).toEqual([20, 21, 22, 23, 24]);
  });
});

describe("weekly target", () => {
  const S = DEFAULT_PLAN_SETTINGS;
  const pull = (o: Partial<Parameters<typeof newQuestionPull>[0]>) =>
    newQuestionPull({ share: 5, cumShare: 5, weekAssignedBefore: 0, ownToday: 0, carriedIn: 0, carryOverReducesNew: true, ...o });

  it("the weekly target is the sum of the quotas, from the plan start; skips and light days don't lower it", () => {
    expect(weeklyNewTarget(S, addDays(MON, 3))).toBe(25);
    expect(weeklyNewTarget(S, addDays(MON, 3), addDays(MON, 2))).toBe(15);
    expect(dayNewShare(S, addDays(MON, 2), { skipDates: new Set([addDays(MON, 2)]) })).toBe(0);
    expect(dayNewShare(S, addDays(MON, 2), { lightDays: new Map([[addDays(MON, 2), 1]]) })).toBe(1);
    expect(dayNewShare(S, addDays(MON, 2), { lightDays: new Map([[addDays(MON, 2), 9]]) })).toBe(5);
    expect(cumulativeNewShare(S, addDays(MON, 2), { lightDays: new Map([[addDays(MON, 2), 1]]) })).toBe(11);
  });

  it("the user's example: Tue +3 makes Wed 2; Wed +1 makes Thu 4; Fri stays 5; week totals 25", () => {
    // Mon 5, Tue 5 + 3 more = 13 assigned before Wednesday.
    expect(pull({ cumShare: 15, weekAssignedBefore: 13 })).toBe(2);
    // Wed 2 + 1 more → 16 before Thursday.
    expect(pull({ cumShare: 20, weekAssignedBefore: 16 })).toBe(4);
    expect(pull({ cumShare: 25, weekAssignedBefore: 20 })).toBe(5);
  });

  it("working far ahead empties the nearest days first, never past Sunday", () => {
    // Tue 5 + 7 more → Wed 0, Thu 3, Fri 5.
    expect(pull({ cumShare: 15, weekAssignedBefore: 17 })).toBe(0);
    expect(pull({ cumShare: 20, weekAssignedBefore: 17 })).toBe(3);
    expect(pull({ cumShare: 25, weekAssignedBefore: 20 })).toBe(5);
  });

  it("a missed day is never turned into debt: a day never pulls above its share", () => {
    // Mon 5, Tue missed (0). Wednesday still pulls just 5.
    expect(pull({ cumShare: 15, weekAssignedBefore: 5 })).toBe(5);
  });

  it("carried-over and rescheduled-in questions take the day's slots; 'add' policy ignores them", () => {
    expect(pull({ cumShare: 20, weekAssignedBefore: 15, carriedIn: 3 })).toBe(2);
    expect(pull({ cumShare: 20, weekAssignedBefore: 15, carriedIn: 3, carryOverReducesNew: false })).toBe(5);
    expect(pull({ cumShare: 20, weekAssignedBefore: 15, ownToday: 1 })).toBe(4);
  });

  it("planDay: without week info it behaves exactly as before", () => {
    expect(planDay(input()).createNew).toEqual([1, 2, 3, 4, 5]);
    expect(planDay(input({ week: { cumShare: 10, assignedBefore: 8, ownToday: 0 }, today: addDays(MON, 1) })).createNew).toEqual([1, 2]);
  });

  it("planDay: a question rescheduled into today takes one of today's slots", () => {
    const wed = addDays(MON, 2);
    const open = [{ id: 1, problemId: 99, type: "new" as const, scheduledDate: wed, originalDate: MON, status: "pending" as const }];
    expect(planDay(input({ today: wed, openAssignments: open, week: { cumShare: 15, assignedBefore: 10, ownToday: 0 } })).createNew).toHaveLength(4);
  });

  it("planDay: a light day pulls its light count and picks no SRS reviews (they stay due)", () => {
    const due = [{ problemId: 100, nextDueDate: addDays(MON, -2), intervalDays: 7, lapses: 0, lastOutcome: "independent" as const, firstPracticedDate: "2026-10-01" }];
    const r = planDay(input({ lightNewQuota: 1, dueReviews: due }));
    expect(r.createNew).toEqual([1]);
    expect(r.createSrs).toEqual([]);
    expect(r.markAllocated.srs).toBe(true);
  });

  it("forecast: work done ahead lightens the next day; light and skipped days show", () => {
    const tue = addDays(MON, 1);
    const fc = forecast({
      from: addDays(MON, 2),
      days: 6,
      settings: S,
      queue: Array.from({ length: 60 }, (_, i) => i),
      skipDates: new Set([addDays(MON, 4)]),
      lightDays: new Map([[addDays(MON, 3), 1]]),
      startDate: MON,
      cohortSoFar: 13,
      reviewsAssignedThisWeek: 0,
      weekAssignedBefore: 13, // Mon 5 + Tue 8
      persisted: new Map(),
    });
    expect(tue < fc[0]!.date).toBe(true);
    expect(fc.map((d) => d.newProblemIds.length)).toEqual([2, 1, 0, 0, 0, 5]);
    expect(fc[1]!.lightNew).toBe(1);
    expect(fc[2]!.skipped).toBe(true);
    // Weekend review covers 13 + 2 + 1 = 16 (Sat 12, Sun the rest).
    expect(fc[3]!.mandatoryReviews).toBe(12);
    expect(fc[4]!.mandatoryReviews).toBe(4);
  });
});
