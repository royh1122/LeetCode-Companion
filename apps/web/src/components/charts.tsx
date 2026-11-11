"use client";

import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/**
 * Chart conventions (see dataviz guidance): one y-axis, thin 2px lines, ≥8px
 * markers, 4px rounded bar ends, recessive grid, tooltip on hover, legend only
 * for ≥2 series, text in ink colors (never series colors).
 */
const axis = { stroke: "var(--fg-subtle)", fontSize: 11, tickLine: false, axisLine: false } as const;
const grid = <CartesianGrid stroke="var(--grid)" vertical={false} />;
const tooltipStyle = {
  contentStyle: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12, color: "var(--fg)" },
  labelStyle: { color: "var(--fg-muted)" },
  itemStyle: { color: "var(--fg)" },
  cursor: { fill: "var(--surface-2)", stroke: "var(--border-strong)" },
};

export function ChartFrame({ title, children, height = 180, note }: { title: string; children: React.ReactElement; height?: number; note?: string }) {
  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 text-xs font-medium text-muted">{title}</figcaption>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
      {note ? <p className="mt-1 text-[11px] text-subtle">{note}</p> : null}
    </figure>
  );
}

type Row = Record<string, string | number | null>;

export function LineSeries({ title, data, x, series, height, yDomain, yTicks, yFormat, note, yWidth }: {
  title: string;
  data: Row[];
  x: string;
  series: { key: string; name: string; color: string }[];
  height?: number;
  yDomain?: [number, number];
  yTicks?: number[];
  yFormat?: (v: number) => string;
  note?: string;
  yWidth?: number;
}) {
  return (
    <ChartFrame title={title} height={height} note={note}>
      <LineChart data={data} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
        {grid}
        <XAxis dataKey={x} {...axis} />
        <YAxis {...axis} domain={yDomain} ticks={yTicks} tickFormatter={yFormat} allowDecimals={false} width={yWidth ?? 60} />
        <Tooltip {...tooltipStyle} formatter={(v) => (yFormat && typeof v === "number" ? yFormat(v) : (v as string))} />
        {series.length > 1 ? <Legend wrapperStyle={{ fontSize: 11, color: "var(--fg-muted)" }} iconType="plainline" /> : null}
        {series.map((s) => (
          <Line key={s.key} type="linear" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} dot={{ r: 4, strokeWidth: 2, fill: "var(--chart-surface)" }} activeDot={{ r: 5 }} connectNulls isAnimationActive={false} />
        ))}
      </LineChart>
    </ChartFrame>
  );
}

export function BarSeries({ title, data, x, series, height, stacked, note, colorBy }: {
  title: string;
  data: Row[];
  x: string;
  series: { key: string; name: string; color: string }[];
  height?: number;
  stacked?: boolean;
  note?: string;
  /** Per-bar color for single-series charts (e.g. outcome). */
  colorBy?: (row: Row) => string;
}) {
  return (
    <ChartFrame title={title} height={height} note={note}>
      <BarChart data={data} margin={{ top: 6, right: 8, left: -12, bottom: 0 }} barGap={2} barCategoryGap="20%">
        {grid}
        <XAxis dataKey={x} {...axis} />
        <YAxis {...axis} allowDecimals={false} />
        <Tooltip {...tooltipStyle} />
        {series.length > 1 ? <Legend wrapperStyle={{ fontSize: 11, color: "var(--fg-muted)" }} iconType="square" /> : null}
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.name}
            fill={s.color}
            stackId={stacked ? "a" : undefined}
            radius={stacked ? (i === series.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]) : [4, 4, 0, 0]}
            stroke="var(--chart-surface)"
            strokeWidth={stacked ? 1 : 0}
            maxBarSize={36}
            isAnimationActive={false}
          >
            {colorBy ? data.map((row, j) => <Cell key={j} fill={colorBy(row)} />) : null}
          </Bar>
        ))}
      </BarChart>
    </ChartFrame>
  );
}

const CONF_LABEL: Record<number, string> = { 1: "Failed", 2: "Hints", 3: "Struggled", 4: "Indep.", 5: "Easy" };

export function ProblemCharts({ data }: { data: { n: number; date: string; minutes: number; submissions: number; confidence: number | null; interval: number | null }[] }) {
  if (data.length < 1) return <p className="text-xs text-muted">Charts appear after your first completed session.</p>;
  const rows = data.map((d) => ({ ...d, label: `#${d.n} ${d.date.slice(5)}` }));
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      <LineSeries title="Solve time per session (min)" data={rows} x="label" series={[{ key: "minutes", name: "Minutes", color: "var(--series-1)" }]} />
      <BarSeries title="Submissions per session" data={rows} x="label" series={[{ key: "submissions", name: "Submissions", color: "var(--series-1)" }]} />
      <LineSeries
        title="Confidence"
        data={rows}
        x="label"
        series={[{ key: "confidence", name: "Confidence", color: "var(--series-1)" }]}
        yDomain={[1, 5]}
        yTicks={[1, 2, 3, 4, 5]}
        yFormat={(v) => CONF_LABEL[v] ?? String(v)}
        yWidth={84}
      />
      <BarSeries title="Review interval chosen (days)" data={rows} x="label" series={[{ key: "interval", name: "Days until next review", color: "var(--series-1)" }]} />
    </div>
  );
}
