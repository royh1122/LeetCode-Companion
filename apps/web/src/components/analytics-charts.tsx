"use client";

import { BarSeries, LineSeries } from "./charts";

interface Week {
  week: string;
  newQuestions: number;
  reviews: number;
  studyMinutes: number;
  independentRate: number | null;
  medianFirstAcceptedMin: number | null;
  medianSessionMin: number | null;
  adherence: number | null;
}
interface Snapshot {
  date: string;
  dueCount: number;
  overdueCount: number;
  mastery: Record<string, number>;
}

/** Mastery stages are ordered, so they use one ordinal blue ramp (light → dark). */
const MASTERY_SERIES = [
  { key: "learning", name: "Learning", color: "var(--ramp-1)" },
  { key: "needs_review", name: "Needs review", color: "var(--ramp-2)" },
  { key: "improving", name: "Improving", color: "var(--ramp-3)" },
  { key: "mastered", name: "Mastered", color: "var(--ramp-5)" },
];

export function AnalyticsCharts({ weekly, snapshots }: { weekly: Week[]; snapshots: Snapshot[] }) {
  const w = weekly.map((x) => ({
    ...x,
    label: x.week.slice(5),
    independentPct: x.independentRate == null ? null : Math.round(x.independentRate * 100),
    adherencePct: x.adherence == null ? null : Math.round(x.adherence * 100),
  }));
  const snaps = snapshots.map((s) => ({ label: s.date.slice(5), due: s.dueCount, overdue: s.overdueCount, ...s.mastery }));
  const pct = (v: number) => `${v}%`;
  return (
    <div className="grid gap-8 md:grid-cols-2">
      <BarSeries
        title="Sessions per week"
        data={w}
        x="label"
        stacked
        series={[
          { key: "newQuestions", name: "New questions", color: "var(--series-1)" },
          { key: "reviews", name: "Reviews", color: "var(--series-2)" },
        ]}
      />
      <BarSeries title="Study time per week (min)" data={w} x="label" series={[{ key: "studyMinutes", name: "Minutes", color: "var(--series-1)" }]} note="Sum of session durations (manual > extension active estimate > wall clock)." />
      <LineSeries
        title="Median time to first Accepted, new questions (min)"
        data={w}
        x="label"
        series={[{ key: "medianFirstAcceptedMin", name: "Median minutes", color: "var(--series-1)" }]}
        note="Only sessions where an Accepted submission was captured."
      />
      <LineSeries title="Independent solve rate" data={w} x="label" series={[{ key: "independentPct", name: "Independent", color: "var(--series-1)" }]} yDomain={[0, 100]} yFormat={pct} note="Share of sessions rated Easy or Independent." />
      <LineSeries title="Plan adherence" data={w} x="label" series={[{ key: "adherencePct", name: "Completed / assigned", color: "var(--series-1)" }]} yDomain={[0, 100]} yFormat={pct} note="New + mandatory review assignments completed, counting only days that have passed." />
      {snaps.length ? (
        <LineSeries
          title="Review backlog"
          data={snaps}
          x="label"
          series={[
            { key: "due", name: "Due", color: "var(--series-1)" },
            { key: "overdue", name: "Overdue", color: "var(--series-2)" },
          ]}
          note="Daily snapshot taken the first time the dashboard is opened each day."
        />
      ) : null}
      {snaps.length ? <BarSeries title="Mastery progression (practiced problems)" data={snaps} x="label" stacked series={MASTERY_SERIES} /> : null}
    </div>
  );
}
