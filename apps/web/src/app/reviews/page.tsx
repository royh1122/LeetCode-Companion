import Link from "next/link";
import { getAppSettings, getReviewQueue } from "@lcc/db";
import { formatLocalDate } from "@lcc/shared";
import { ASSIGNMENT_TYPE_LABEL, DifficultyBadge, MasteryBadge, OutcomeBadge } from "@/components/badges";
import { PracticeButton } from "@/components/practice";
import { PostponeButtons, PullEarly, PullMore } from "@/components/review-actions";
import { Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { db } from "@/lib/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review queue" };

export default function ReviewsPage() {
  const q = getReviewQueue(db());
  const showPatterns = getAppSettings(db()).showPatterns;
  const notScheduled = q.dueNow.filter((r) => !r.openAssignment).length;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Review queue"
        description="Everything due for spaced repetition, ranked by how overdue it is relative to its interval and how weak your last attempt was."
        actions={<PullMore available={notScheduled} />}
      />
      <Card>
        <CardHeader title={`Due now (${q.dueNow.length})`} description={`${notScheduled} not yet on today's list. Today's list is capped — pull more if you have time.`} />
        {q.dueNow.length ? (
          <ul className="divide-y divide-border">
            {q.dueNow.map((r) => (
              <li key={r.problem.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
                <span className="tabular w-10 text-right text-xs text-subtle" title="Priority score">
                  {r.priority.toFixed(1)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-xs text-subtle">#{r.problem.frontendId}</span>
                    <Link href={`/problems/${r.problem.slug}`} className="truncate font-medium hover:underline">
                      {r.problem.title}
                    </Link>
                    <DifficultyBadge d={r.problem.difficulty} />
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                    {showPatterns && r.problem.patterns[0] ? <span>{r.problem.patterns[0]} ·</span> : null}
                    <span>due {r.due.nextDueDate}</span>
                    {r.daysOverdue ? <Badge tone="warn">{r.daysOverdue}d overdue</Badge> : <Badge tone="neutral">due today</Badge>}
                    <span>· interval {r.due.intervalDays}d</span>
                    {r.due.lapses ? <span>· {r.due.lapses} lapse(s)</span> : null}
                    {r.openAssignment ? <Badge tone="accent">On list: {ASSIGNMENT_TYPE_LABEL[r.openAssignment.type]}</Badge> : null}
                  </div>
                </div>
                <OutcomeBadge o={r.due.lastOutcome} />
                <MasteryBadge m={r.stats.mastery} title={r.stats.masteryReason} />
                <PostponeButtons problemId={r.problem.id} today={q.today} />
                <PracticeButton problemId={r.problem.id} assignmentId={r.openAssignment?.id} label="Review" />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No reviews due">Completed questions get a next review date when you finish a session.</EmptyState>
        )}
      </Card>
      <Card>
        <CardHeader
          title="Coming up (next 14 days)"
          description={`${q.earlyAvailable.length} due in the next 2 days can be done early. The next interval then counts from the day you do it. This week's new questions wait for the weekend review instead.`}
          actions={<PullEarly available={q.earlyAvailable.length} />}
        />
        {q.upcoming.length ? (
          <ul className="divide-y divide-border text-sm">
            {q.upcoming.map((r) => (
              <li key={r.problem.id} className="flex items-center gap-3 px-4 py-2">
                <span className="tabular w-28 text-xs text-muted">{formatLocalDate(r.due.nextDueDate)}</span>
                <Link href={`/problems/${r.problem.slug}`} className="min-w-0 flex-1 truncate hover:underline">
                  {r.problem.title}
                </Link>
                <span className="text-xs text-subtle">interval {r.due.intervalDays}d</span>
                <OutcomeBadge o={r.due.lastOutcome} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-5 text-xs text-muted">Nothing scheduled in the next two weeks.</p>
        )}
      </Card>
    </div>
  );
}
