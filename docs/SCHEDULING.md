# Scheduling policy

The scheduler is a set of pure functions in `packages/scheduler`: `planDay`, `computeNextReview`, `computeMastery` and `forecast`. The database layer (`packages/db/src/schedule.ts`) feeds them data and applies the result in one transaction. All behavior below is covered by tests in `packages/scheduler/test` and `packages/db/test`.

## Concepts

- **Plan queue.** An ordered list of problems the plan will introduce as *new*. It is built from the plan's lists in the order you set and de-duplicated by problem, so each problem appears once, at its first position.
- **Assignment.** A planned task for a date (`new`, `weekend_review`, `srs_review` or `manual`). An assignment is *not* a practice session; it only completes when a session for that problem is finished. A date passing doesn't complete it.
- **Session.** An actual sitting. Starting practice on a problem with an open assignment due today or earlier links the two automatically.
- **Study days.** These are local calendar dates in the configured time zone. Weeks run Monday through Sunday. Timestamps are stored in UTC milliseconds.

## Daily allocation (runs once per day, idempotent)

The first time the dashboard is opened on a day, the scheduler runs these steps. If the dashboard is not opened that day, nothing is allocated for it; see the backlog policy below.

1. **Expire stale SRS picks.** Unfinished `srs_review` assignments from earlier days are marked *expired*. The problem stays due and is re-ranked today, so SRS tasks never pile up as duplicates.
2. **Mandatory cohort review.** This step runs only on configured review days. The *cohort* is the set of new questions completed earlier in the same week, in completion order.
   - Each review day has a quota (default Sat 12, Sun "rest"). The target is cumulative, so if Saturday was missed, Sunday includes Saturday's share.
   - A problem gets at most one weekend review per cohort week (enforced by a unique index).
   - Unfinished mandatory reviews carry over until done, skipped or rescheduled.
3. **New questions.** These are pulled from the top of the queue, `newPerWeekday[weekday]` of them, once per day (recorded in `plan_days`).
   - **Backlog policy (default):** carried-over unfinished new questions reduce today's pull, so the open new list never exceeds one day's quota. Missed days don't create debt, and your queue position only moves when questions are actually assigned.
   - **Overlap policy (default `skip_practiced`):** a queue problem you already completed a session for (e.g. from an earlier list) is marked *skipped as practiced* instead of consuming quota. Use **Practice as new** on the Study plan page, or **Restart as new** on a question page, to opt in.
4. **SRS reviews.** Problems whose next-review date is today or earlier, ranked by:

   `priority = daysOverdue / interval + weakness(failed/hints = 1, struggled = 0.5) + 0.25 × lapses`

   They are capped at `srsDailyCap` (default 5) or `srsReviewDayCap` on review days (default 3). The rest wait in the **Review queue**, where you can pull more into today. Excluded are:
   - problems with any open assignment, so a problem never has two tasks at once;
   - this week's cohort while a mandatory review day is still ahead, because the weekend review covers them.

## Fixed weekend review vs. adaptive SRS

Both are kept and displayed in separate sections:

- A mandatory review *is* a review. Completing it updates spaced-repetition state like any other session.
- While a new problem's weekend review is pending, its SRS due date is ignored, so there is no double booking.
- If a problem has both an open weekend review and is SRS-due, only the weekend review appears.
- Finishing any review session also completes any other open review task for that problem due by that day.

## Skip, pause, reschedule

- **Skip today.** No new questions are pulled today. Today's not-yet-started new questions return to the queue at their original position. You can un-skip the same day.
- **Pause plan.** Nothing is allocated automatically. The review backlog stays visible.
- **Reschedule.** A new or mandatory task moves to the chosen date. An SRS task instead postpones the problem's next-review date. Postponements are kept until a later session supersedes them.
- **Reorder queue.** Move items top, up, down or bottom; remove them; or add any problem by URL or slug, at the front or end, or to today as new.

## Spaced repetition

These are defaults, and all are editable in Settings.

| Outcome | First interval | After a streak |
|---|---|---|
| Failed / needed hints | 1 day | resets to 1 day; streak → 0; counts a *lapse* only if it had been solved independently before |
| Struggled | 3 days | shrinks a long interval to ×0.5, but never below 3 days or above the previous interval |
| Independent | 7 days | previous × 2 (7 → 14 → 28 …) |
| Easy | 21 days | previous × 2.5 |

- The maximum interval is 180 days.
- Growth only applies on top of an existing independent streak, so one lucky "easy" after struggles doesn't jump straight to months.
- **Review state is derived.** It is re-computed by replaying every completed session in order, applying any date you picked instead of the recommendation. History is never reset; only the interval changes.

## Mastery (deterministic)

1. No completed session → **Not started**
2. Last session failed or needed hints → **Learning** if never solved independently, otherwise **Needs review**
3. Review overdue by more than 3 days → **Needs review**
4. 3 independent or easy sessions in a row, the last one at least 14 days after the previous → **Mastered**
5. Otherwise, improving performance → **Improving**; still struggling and never independent → **Learning**

An Accepted submission alone never makes a problem Mastered. The thresholds are editable in Settings.
