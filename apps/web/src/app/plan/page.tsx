import Link from "next/link";
import { getActivePlan, getAppSettings, getQueue, getUpcoming, listSkipDates, listStudyLists, practicedProblemIds, queueCounts, todayFor } from "@lcc/db";
import { formatLocalDate } from "@lcc/shared";
import { DifficultyBadge } from "@/components/badges";
import { CreatePlanForm } from "@/components/create-plan-form";
import { AddProblemForm, DayModeControls, PauseButton, PlanSettingsForm, QueueControls, SkipTodayButton } from "@/components/plan-controls";
import { Badge, Card, CardHeader, PageHeader } from "@/components/ui";
import { db } from "@/lib/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Study plan" };

const STATUS_LABEL: Record<string, string> = {
  pending: "Up next",
  assigned: "Assigned",
  done: "Done",
  skipped_practiced: "Already practiced",
  removed: "Removed",
};

export default async function PlanPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const { show = "pending" } = await searchParams;
  const d = db();
  const plan = getActivePlan(d);
  const lists = listStudyLists(d);
  const today = todayFor(d);
  if (!plan) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Study plan" description="No active plan yet." />
        <Card className="p-5">
          <CreatePlanForm today={today} lists={lists.map((l) => ({ slug: l.slug, name: l.name, count: l.count }))} />
        </Card>
      </div>
    );
  }
  const queue = getQueue(d, plan.id);
  const counts = queueCounts(d, plan.id);
  const upcoming = getUpcoming(d, 14);
  const skips = listSkipDates(d, plan);
  const showPatterns = getAppSettings(d).showPatterns;
  const practiced = practicedProblemIds(d);
  const shown = queue.filter((q) => (show === "all" ? true : show === "skipped" ? q.status === "skipped_practiced" || q.status === "removed" : q.status === "pending"));
  const pendingIdx = new Map(queue.filter((q) => q.status === "pending").map((q, i) => [q.problemId, i + 1]));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Study plan"
        description={`${plan.name} · started ${formatLocalDate(plan.startDate)} · ${plan.timeZone}`}
        actions={
          <>
            {plan.status === "active" ? <SkipTodayButton planId={plan.id} today={today} skipped={skips.some((s) => s.date === today)} /> : null}
            <PauseButton planId={plan.id} paused={plan.status === "paused"} />
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <Card>
          <CardHeader title="Plan settings" description="Defaults are a starting point — change anything." />
          <div className="p-4">
            <PlanSettingsForm planId={plan.id} name={plan.name} startDate={plan.startDate} settings={plan.settings} lists={lists.map((l) => ({ slug: l.slug, name: l.name }))} />
          </div>
        </Card>

        <Card>
          <CardHeader title="Next 14 days" description="Projection — new questions are only assigned on the day itself. Busy day ahead? Make it light or skip it." />
          <ul className="divide-y divide-border text-xs">
            {upcoming.days.map((day) => (
              <li key={day.date} className="px-4 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{formatLocalDate(day.date)}</span>
                  <span className="flex gap-1">
                    {day.skipped ? <Badge tone="outline">Skipped</Badge> : null}
                    {day.lightNew != null ? <Badge tone="outline">Light</Badge> : null}
                    {day.newProblems.length ? <Badge tone="accent">{day.newProblems.length} new</Badge> : null}
                    {day.mandatoryReviews ? <Badge tone="neutral">≤{day.mandatoryReviews} mandatory</Badge> : null}
                    {day.srsDue ? <Badge tone="neutral">{day.srsDue} SRS due</Badge> : null}
                  </span>
                </div>
                {day.newProblems.length ? <div className="mt-1 truncate text-muted">{day.newProblems.map((p) => p.title).join(" · ")}</div> : null}
                {day.lightNew != null && day.srsDue ? <div className="mt-1 text-subtle">Reviews aren&apos;t picked on a light day; they stay due.</div> : null}
                {plan.status === "active" && !day.reviewDay && day.quota > 0 ? (
                  <div className="mt-1.5 flex justify-end">
                    <DayModeControls planId={plan.id} date={day.date} mode={day.skipped ? "skip" : day.lightNew != null ? "light" : "normal"} lightNew={day.lightNew} quota={day.quota} />
                  </div>
                ) : null}
                {upcoming.future
                  .filter((f) => f.a.scheduledDate === day.date)
                  .map((f) => (
                    <div key={f.a.id} className="mt-1 text-muted">
                      Rescheduled: {f.p.title}
                    </div>
                  ))}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Question queue"
          description={`${counts.pending} up next · ${counts.assigned} assigned · ${counts.done} done · ${counts.skipped_practiced} skipped as already practiced`}
          actions={
            <div className="flex rounded-md border border-border p-0.5 text-xs">
              {[
                ["pending", "Up next"],
                ["skipped", "Skipped"],
                ["all", "All"],
              ].map(([k, l]) => (
                <Link key={k} href={`/plan?show=${k}`} className={`rounded px-2 py-1 ${show === k ? "bg-surface-2 text-fg" : "text-muted"}`}>
                  {l}
                </Link>
              ))}
            </div>
          }
        />
        <div className="border-b border-border p-4">
          <AddProblemForm planId={plan.id} today={today} />
        </div>
        <ul className="max-h-[640px] divide-y divide-border overflow-y-auto">
          {shown.map((q) => (
            <li key={q.id} className="flex flex-wrap items-center gap-3 px-4 py-2">
              <span className="tabular w-8 text-right text-xs text-subtle">{q.status === "pending" ? pendingIdx.get(q.problemId) : ""}</span>
              <span className="tabular w-12 font-mono text-xs text-subtle">{q.frontendId ? `#${q.frontendId}` : ""}</span>
              <Link href={`/problems/${q.slug}`} className="min-w-0 flex-1 truncate hover:underline">
                {q.title}
              </Link>
              <DifficultyBadge d={q.difficulty} className="w-14" />
              {showPatterns ? <span className="hidden w-40 truncate text-xs text-muted md:inline">{q.patterns[0]}</span> : null}
              <span className="hidden w-32 text-xs text-subtle sm:inline">{q.listName ?? (q.addedManually ? "Added" : "")}</span>
              {q.status !== "pending" ? <Badge tone={q.status === "done" ? "good" : "outline"}>{STATUS_LABEL[q.status]}</Badge> : null}
              {q.addedManually && q.status === "pending" && practiced.has(q.problemId) ? <Badge tone="accent">As new</Badge> : null}
              <QueueControls planId={plan.id} problemId={q.problemId} status={q.status} />
            </li>
          ))}
          {!shown.length ? <li className="px-4 py-6 text-center text-xs text-muted">Nothing here.</li> : null}
        </ul>
      </Card>

      <Card className="p-4 text-xs leading-relaxed text-muted">
        <h2 className="mb-2 text-sm font-semibold text-fg">How scheduling works</h2>
        <ul className="list-disc space-y-1 pl-4">
          <li>New questions are pulled from the top of the queue on each study day, once per day. Your place only advances when questions are actually assigned.</li>
          <li>The week (Monday–Sunday) has a target: the sum of the daily amounts. &quot;Do more today&quot; on the dashboard takes the next questions now: it first makes up a day you missed this week, then takes from the nearest upcoming study day, so that day gets lighter. It never takes from next week, and stops at the weekly target.</li>
          <li>A busy day ahead can be made light (fewer new questions, no automatic reviews) or skipped, in the calendar above. Review days can&apos;t, because their mandatory reviews would move onto Monday. Reviews not picked on a light day stay due and count as overdue the next day; nothing is postponed silently.</li>
          <li>Unfinished new questions carry over. With the recommended policy, carried-over questions (and questions rescheduled onto a day) take that day&apos;s slots, so the list never grows past one day&apos;s quota. Skipping a question returns it to the queue and leaves the week one short.</li>
          <li>Skipping a day returns that day&apos;s unstarted new questions to the queue — nothing is lost.</li>
          <li>Mandatory reviews cover the questions you completed earlier in the same week. If you miss Saturday, Sunday includes Saturday&apos;s share.</li>
          <li>Spaced-repetition reviews are picked daily (capped), weakest and most overdue first. Unfinished picks expire at midnight and are re-ranked — the review stays due. Questions in this week&apos;s cohort wait for the mandatory review instead of getting an extra one.</li>
          <li>A problem never gets two open tasks at once. Problems already practiced (e.g. from an earlier list) don&apos;t consume new-question quota in later lists unless you choose &quot;Practice as new&quot;.</li>
        </ul>
      </Card>
    </div>
  );
}
