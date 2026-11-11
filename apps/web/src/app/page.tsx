import { AlertTriangle, CalendarOff, Coffee, Inbox, PauseCircle, PlayCircle } from "lucide-react";
import Link from "next/link";
import { getProblemById, getTodayView, listStudyLists, type TodayItem } from "@lcc/db";
import { builtInListsFor } from "@/lib/lists";
import { formatLocalDate } from "@lcc/shared";
import { CreatePlanForm } from "@/components/create-plan-form";
import { ImportListForm } from "@/components/import-list-form";
import { QuestionRow } from "@/components/question-row";
import { SkipTodayButton } from "@/components/plan-controls";
import { Badge, Card, CardHeader, EmptyState, Progress, buttonVariants } from "@/components/ui";
import { db } from "@/lib/server";
import { relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

function Section({ title, description, items, today, empty, accent }: { title: string; description: string; items: TodayItem[]; today: string; empty: string; accent?: string }) {
  const done = items.filter((i) => i.assignment.status === "completed").length;
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {accent ? <span className="size-2 rounded-full" style={{ background: accent }} aria-hidden /> : null}
            {title}
            <span className="tabular text-xs font-normal text-muted">
              {done}/{items.length}
            </span>
          </span>
        }
        description={description}
      />
      {items.length ? (
        <ul className="divide-y divide-border">
          {items.map((i) => (
            <QuestionRow key={i.assignment.id} item={i} today={today} />
          ))}
        </ul>
      ) : (
        <p className="px-4 py-5 text-xs text-muted">{empty}</p>
      )}
    </Card>
  );
}

export default function TodayPage() {
  const d = db();
  const v = getTodayView(d);
  const lists = listStudyLists(d);

  if (!v.plan && !lists.length) {
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="text-xl font-semibold tracking-tight">Import a question list</h1>
        <p className="mb-6 mt-1 text-sm text-muted">Pick the questions you want to study, then create a plan from them.</p>
        <Card className="p-5">
          <ImportListForm builtIns={builtInListsFor(lists)} />
        </Card>
      </div>
    );
  }
  if (!v.plan) {
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="text-xl font-semibold tracking-tight">Set up your study plan</h1>
        <p className="mb-6 mt-1 text-sm text-muted">
          {lists.length} list{lists.length === 1 ? "" : "s"} imported ({lists.reduce((a, l) => a + l.count, 0)} list entries). Create a plan to get today&apos;s questions, or{" "}
          <Link href="/library" className="text-accent hover:underline">
            import another list
          </Link>{" "}
          first.
        </p>
        <Card className="p-5">
          <CreatePlanForm today={v.today} lists={lists.map((l) => ({ slug: l.slug, name: l.name, count: l.count }))} />
        </Card>
      </div>
    );
  }

  const { progress, sections } = v;
  const openSessions = v.openSessions.map((s) => ({ s, p: getProblemById(d, s.problemId)! }));
  const interruptedIds = new Set(v.interrupted.map((s) => s.id));

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-subtle">{formatLocalDate(v.today, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">Today&apos;s questions</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            <Link href="/plan" className="hover:underline">
              {v.plan.name}
            </Link>
            <span>·</span>
            <span>Week {v.weekNumber}</span>
            {v.plan.status === "paused" ? <Badge tone="warn">Paused</Badge> : null}
            {v.isSkipped ? <Badge tone="outline">Day skipped</Badge> : null}
            {v.isReviewDay ? <Badge tone="accent">Review day</Badge> : null}
          </p>
        </div>
        <div className="grid w-full grid-cols-2 gap-x-6 gap-y-3 sm:w-auto sm:grid-cols-4 [&>*]:min-w-32">
          <div className="min-w-28">
            <div className="flex justify-between text-xs text-muted">
              <span>Today</span>
              <span className="tabular">
                {progress.todayDone}/{progress.todayTotal}
              </span>
            </div>
            <Progress className="mt-1.5" value={progress.todayDone} max={progress.todayTotal} label="Today's progress" />
          </div>
          <div className="min-w-28">
            <div className="flex justify-between text-xs text-muted">
              <span>New / week</span>
              <span className="tabular">
                {progress.weekNewDone}/{progress.weeklyNewQuota}
              </span>
            </div>
            <Progress className="mt-1.5" value={progress.weekNewDone} max={progress.weeklyNewQuota} label="Weekly new-question progress" />
          </div>
          <div className="min-w-28">
            <div className="flex justify-between text-xs text-muted">
              <span>Reviews / week</span>
              <span className="tabular">
                {progress.weekReviewsDone}/{progress.weekReviewsTotal}
              </span>
            </div>
            <Progress className="mt-1.5" value={progress.weekReviewsDone} max={progress.weekReviewsTotal} label="Weekly review progress" />
          </div>
          <Link href="/reviews" className="min-w-28 rounded-md hover:bg-surface-2">
            <div className="text-xs text-muted">Review backlog</div>
            <div className="tabular mt-0.5 text-sm font-medium">
              {v.backlog.due} due {v.backlog.overdue ? <span className="text-warn">· {v.backlog.overdue} overdue</span> : null}
            </div>
          </Link>
        </div>
      </header>

      {openSessions.length ? (
        <Card className="divide-y divide-border">
          {openSessions.map(({ s, p }) => {
            const interrupted = interruptedIds.has(s.id);
            return (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="flex items-center gap-2.5">
                  {interrupted ? <AlertTriangle className="size-4 text-warn" /> : s.status === "paused" ? <PauseCircle className="size-4 text-muted" /> : <PlayCircle className="size-4 text-accent" />}
                  <div>
                    <div className="font-medium">
                      {interrupted ? "Interrupted session: " : s.status === "paused" ? "Paused: " : "In progress: "}
                      {p.title}
                    </div>
                    <div className="text-xs text-muted">
                      Started {relativeTime(s.startedAt)} · last activity {relativeTime(s.lastActivityAt ?? s.startedAt)}
                      {interrupted ? " — resume it, or finish it with the time you actually spent." : ""}
                    </div>
                  </div>
                </div>
                <Link href={`/sessions/${s.id}`} className={buttonVariants({ variant: interrupted ? "secondary" : "primary", size: "sm" })}>
                  {interrupted ? "Resume or finish" : "Continue"}
                </Link>
              </div>
            );
          })}
        </Card>
      ) : null}

      {v.notStartedYet ? (
        <Card>
          <EmptyState icon={<CalendarOff />} title={`Your plan starts ${formatLocalDate(v.plan.startDate)}`}>
            Questions will appear here from the start date. You can change it in Study plan.
          </EmptyState>
        </Card>
      ) : null}

      <Section
        title="New questions"
        description="First encounters from your plan queue, plus anything you added."
        items={sections.newQuestions}
        today={v.today}
        accent="var(--series-1)"
        empty={v.isReviewDay ? "No new questions on review days." : v.isSkipped ? "You skipped today — your place in the queue is kept." : v.plan.status === "paused" ? "Plan is paused." : "No new questions today."}
      />
      <Section
        title="Mandatory reviews"
        description="Fixed review of this week's cohort — separate from adaptive reviews."
        items={sections.mandatory}
        today={v.today}
        accent="var(--series-2)"
        empty={v.isReviewDay ? "This week's cohort is fully assigned." : "Mandatory reviews happen on review days (Saturday & Sunday by default)."}
      />
      <Section
        title="Spaced-repetition reviews"
        description="Adaptive reviews due today, weakest and most overdue first (capped per day)."
        items={sections.srs}
        today={v.today}
        accent="var(--series-3)"
        empty={v.backlog.due ? "Today's cap is reached or the remaining due reviews are already scheduled. See the Review queue to pull more." : "Nothing due. Nice."}
      />

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <p className="max-w-xl">
          <Inbox className="mr-1.5 inline size-3.5 align-[-2px]" />
          Practicing something off-plan? Open it from the{" "}
          <Link href="/library" className="text-accent hover:underline">
            library
          </Link>
          , or just open it on LeetCode — the extension will offer to track it.
        </p>
        {v.plan.status === "active" ? (
          <SkipTodayButton planId={v.plan.id} today={v.today} skipped={v.isSkipped} />
        ) : (
          <span className="flex items-center gap-1">
            <Coffee className="size-3.5" /> Plan paused
          </span>
        )}
      </div>
    </div>
  );
}
