import Link from "next/link";
import { getAnalytics } from "@lcc/db";
import { MASTERY_LABELS, MASTERY_STATES, formatDuration } from "@lcc/shared";
import { AnalyticsCharts } from "@/components/analytics-charts";
import { Card, CardHeader, PageHeader, Stat } from "@/components/ui";
import { db } from "@/lib/server";
import { pct } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Analytics" };

const RAMP: Record<string, string> = {
  not_started: "var(--surface-3)",
  learning: "var(--ramp-1)",
  needs_review: "var(--ramp-2)",
  improving: "var(--ramp-3)",
  mastered: "var(--ramp-5)",
};

function MasteryBar({ counts, total }: { counts: Record<string, number>; total: number }) {
  return (
    <div>
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded" role="img" aria-label={MASTERY_STATES.map((m) => `${MASTERY_LABELS[m]} ${counts[m] ?? 0}`).join(", ")}>
        {MASTERY_STATES.map((m) => (counts[m] ? <div key={m} title={`${MASTERY_LABELS[m]}: ${counts[m]}`} style={{ width: `${((counts[m] ?? 0) / Math.max(1, total)) * 100}%`, background: RAMP[m] }} /> : null))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {MASTERY_STATES.map((m) => (
          <span key={m} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: RAMP[m] }} aria-hidden />
            {MASTERY_LABELS[m]} <span className="tabular text-fg">{counts[m] ?? 0}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ by?: string }> }) {
  const { by } = await searchParams;
  const a = getAnalytics(db(), { groupBy: by === "tag" ? "tag" : "pattern" });
  const u = a.unique;
  const s = a.sessionLevel;
  return (
    <div className="space-y-6">
      <PageHeader title="Analytics" description="Unique-problem metrics and session-level metrics are kept separate: re-solving a problem adds sessions, not problems." />

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-subtle">Unique problems</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Encountered" value={u.encountered} hint={`of ${u.totalProblems}`} />
            <Stat label="Solved ≥ once" value={u.solvedAtLeastOnce} hint="any success" />
            <Stat label="Solved independently" value={u.solvedIndependently} />
            <Stat label="Mastered" value={u.mastered} />
          </div>
        </Card>
        <Card className="p-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-subtle">Sessions & submissions</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Sessions" value={s.sessions} hint={`${s.firstAttempts} first · ${s.reviewsCompleted} reviews`} />
            <Stat label="Submissions" value={s.submissions} hint={`acceptance ${pct(s.acceptanceRate)}`} />
            <Stat label="Independent rate" value={pct(s.independentRate)} hint={`hints in ${pct(s.hintRate)}`} />
            <Stat label="Median session" value={formatDuration(s.medianDurationMs)} hint={`avg ${formatDuration(s.avgDurationMs)}`} />
          </div>
        </Card>
      </div>

      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Mastery across all {u.totalProblems} problems</h2>
          <span className="text-xs text-muted">
            {s.dueReviews} reviews due · {s.overdueReviews} overdue
          </span>
        </div>
        <MasteryBar counts={a.masteryCounts} total={u.totalProblems} />
        <p className="mt-2 text-[11px] text-subtle">Mastered requires 3 independent solves in a row with the last after a ≥14-day gap (configurable in Settings). Accepted alone never counts.</p>
      </Card>

      <Card>
        <CardHeader title="Last 12 weeks" />
        <div className="p-4">
          <AnalyticsCharts weekly={a.weekly} snapshots={a.snapshots} />
        </div>
      </Card>

      <Card className="overflow-x-auto">
        <CardHeader
          title="By topic"
          description="A problem with several patterns/tags counts toward each of them, so rows can add up to more than the total."
          actions={
            <div className="flex rounded-md border border-border p-0.5 text-xs">
              <Link href="/analytics" className={`rounded px-2 py-1 ${a.groupBy === "pattern" ? "bg-surface-2 text-fg" : "text-muted"}`}>
                Study patterns
              </Link>
              <Link href="/analytics?by=tag" className={`rounded px-2 py-1 ${a.groupBy === "tag" ? "bg-surface-2 text-fg" : "text-muted"}`}>
                LeetCode tags
              </Link>
            </div>
          }
        />
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted">
              <th className="px-4 py-2 font-medium">Topic</th>
              <th className="px-2 py-2 text-right font-medium">Practiced</th>
              <th className="px-2 py-2 text-right font-medium">Sessions</th>
              <th className="px-2 py-2 text-right font-medium">Independent</th>
              <th className="px-2 py-2 text-right font-medium">Failures</th>
              <th className="px-2 py-2 text-right font-medium">Avg time</th>
              <th className="px-2 py-2 text-right font-medium">Overdue</th>
              <th className="w-56 px-4 py-2 font-medium">Mastery</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {a.topics.map((t) => (
              <tr key={t.topic} className="hover:bg-surface-2">
                <td className="px-4 py-2">
                  <Link href={`/library?topic=${encodeURIComponent(t.topic)}`} className="hover:underline">
                    {t.topic}
                  </Link>
                </td>
                <td className="tabular px-2 py-2 text-right">
                  {t.practiced}
                  <span className="text-subtle">/{t.problems}</span>
                </td>
                <td className="tabular px-2 py-2 text-right">{t.sessions}</td>
                <td className="tabular px-2 py-2 text-right">{pct(t.independentRate)}</td>
                <td className={`tabular px-2 py-2 text-right ${t.failures ? "text-bad" : ""}`}>{t.failures}</td>
                <td className="tabular px-2 py-2 text-right">{formatDuration(t.avgDurationMs)}</td>
                <td className={`tabular px-2 py-2 text-right ${t.overdue ? "text-warn" : ""}`}>{t.overdue}</td>
                <td className="px-4 py-2">
                  <div className="flex h-2 w-full gap-[2px] overflow-hidden rounded" title={MASTERY_STATES.map((m) => `${MASTERY_LABELS[m]}: ${t.mastery[m] ?? 0}`).join(" · ")}>
                    {MASTERY_STATES.map((m) => (t.mastery[m] ? <div key={m} style={{ width: `${(t.mastery[m]! / t.problems) * 100}%`, background: RAMP[m] }} /> : null))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
