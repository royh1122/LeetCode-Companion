"use client";

import { ArrowDown, ArrowUp, ChevronsDown, ChevronsUp, CalendarOff, FastForward, Pause, Play, Plus, Trash2, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { WEEKDAY_SHORT, weekdayOf, type PlanSettings } from "@lcc/shared";
import {
  addProblemBySlug,
  addToDayAction,
  doMoreTodayAction,
  enqueueAction,
  moveQueueAction,
  removeFromQueueAction,
  setDayModeAction,
  setPlanPausedAction,
  skipDayAction,
  updatePlanAction,
} from "@/lib/actions";
import { Button, Input, Label, Select } from "./ui";

function useAction() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success?: string) =>
    start(async () => {
      setError(null);
      setOk(null);
      const r = await fn();
      if (!r.ok) setError(r.error ?? "Failed");
      else if (success) setOk(success);
    });
  return { pending, error, ok, run };
}

export function SkipTodayButton({ planId, today, skipped }: { planId: number; today: string; skipped: boolean }) {
  const { pending, run, error } = useAction();
  return (
    <span className="flex items-center gap-2">
      {error ? <span className="text-bad">{error}</span> : null}
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => skipDayAction(planId, today, !skipped))}>
        {skipped ? <Undo2 /> : null}
        {skipped ? "Un-skip today" : "Skip today (keep my place)"}
      </Button>
    </span>
  );
}

/**
 * "Do more today": pull the next questions from the queue. They count toward this
 * week's target, so a missed day is made up first, then the nearest upcoming day gets lighter.
 */
export function DoMoreToday({ remaining, behind, lightens }: { remaining: number; behind: number; lightens: string | null }) {
  const { pending, run, error } = useAction();
  const [n, setN] = useState(1);
  if (remaining <= 0) return <span className="text-xs text-muted">This week&apos;s target is reached.</span>;
  const max = Math.min(remaining, 10);
  const count = Math.min(n, max);
  const made = Math.min(count, behind);
  const ahead = count - made;
  const hint = [
    made ? `makes up ${made} missed this week` : null,
    ahead ? (lightens ? `takes ${ahead} from ${WEEKDAY_SHORT[weekdayOf(lightens)]} onward` : `${ahead} toward this week's target`) : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <span className="flex flex-wrap items-center justify-end gap-2">
      <span className="text-xs text-subtle" title="Counts toward this week's target. Never takes from next week.">
        {remaining} left this week · {hint}
      </span>
      <Select aria-label="How many more" className="h-7 w-14 px-1.5 text-xs" value={count} onChange={(e) => setN(Number(e.target.value))}>
        {Array.from({ length: max }, (_, i) => i + 1).map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </Select>
      <Button size="sm" disabled={pending} onClick={() => run(() => doMoreTodayAction(count))}>
        <FastForward /> Do more today
      </Button>
      {error ? <span className="text-xs text-bad">{error}</span> : null}
    </span>
  );
}

/** Plan a busy day ahead from the calendar: skip it, or make it light (fewer new questions, no automatic reviews). */
export function DayModeControls({ planId, date, mode, lightNew, quota }: { planId: number; date: string; mode: "normal" | "skip" | "light"; lightNew: number | null; quota: number }) {
  const { pending, run, error } = useAction();
  const set = (m: Parameters<typeof setDayModeAction>[2]) => run(() => setDayModeAction(planId, date, m));
  const lightOptions = Array.from({ length: Math.max(0, quota) }, (_, i) => i); // 0 … quota-1
  return (
    <span className="flex items-center gap-1">
      {mode !== "normal" ? (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => set({ mode: "normal" })} title="Back to a normal day">
          <Undo2 /> Normal
        </Button>
      ) : null}
      {lightOptions.length ? (
        <Select
          aria-label={`Light day on ${date}`}
          title="Light day: fewer new questions and no automatic reviews. Due reviews stay due."
          className="h-7 w-auto px-1.5 text-xs"
          disabled={pending}
          value={mode === "light" ? String(lightNew ?? 0) : ""}
          onChange={(e) => (e.target.value === "" ? undefined : set({ mode: "light", newQuota: Number(e.target.value) }))}
        >
          {mode !== "light" ? <option value="">Light…</option> : null}
          {lightOptions.map((k) => (
            <option key={k} value={k}>
              Light: {k} new
            </option>
          ))}
        </Select>
      ) : null}
      {mode !== "skip" ? (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => set({ mode: "skip" })} title="Skip this day. Your place in the queue is kept.">
          <CalendarOff /> Skip
        </Button>
      ) : null}
      {error ? <span className="text-[11px] text-bad">{error}</span> : null}
    </span>
  );
}

export function PauseButton({ planId, paused }: { planId: number; paused: boolean }) {
  const { pending, run } = useAction();
  return (
    <Button size="sm" disabled={pending} onClick={() => run(() => setPlanPausedAction(planId, !paused))}>
      {paused ? <Play /> : <Pause />}
      {paused ? "Resume plan" : "Pause plan"}
    </Button>
  );
}

export function PlanSettingsForm({
  planId,
  name,
  startDate,
  settings,
  lists,
}: {
  planId: number;
  name: string;
  startDate: string;
  settings: PlanSettings;
  lists: { slug: string; name: string }[];
}) {
  const [s, setS] = useState<PlanSettings>(settings);
  const [planName, setPlanName] = useState(name);
  const [start, setStart] = useState(startDate);
  const { pending, run, error, ok } = useAction();
  const setQuota = (wd: number, v: number) => setS((x) => ({ ...x, newPerWeekday: x.newPerWeekday.map((q, i) => (i === wd ? v : q)) }));
  const order = [1, 2, 3, 4, 5, 6, 0];
  const reviewFor = (wd: number) => s.reviewDays.find((r) => r.weekday === wd);
  const setReview = (wd: number, val: string) =>
    setS((x) => {
      const rest = x.reviewDays.filter((r) => r.weekday !== wd);
      if (val === "off") return { ...x, reviewDays: rest };
      return { ...x, reviewDays: [...rest, { weekday: wd, quota: val === "rest" ? null : Math.max(0, Number(val) || 0) }] };
    });
  const allLists = [...s.listSlugs, ...lists.map((l) => l.slug).filter((l) => !s.listSlugs.includes(l))];
  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => updatePlanAction(planId, { ...s, name: planName, startDate: start }), "Saved");
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="pname">Plan name</Label>
          <Input id="pname" value={planName} onChange={(e) => setPlanName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pstart">Start date</Label>
          <Input id="pstart" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-muted">Weekly schedule</legend>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="text-xs text-muted">
                <th className="py-1 pr-2 text-left font-medium">Day</th>
                {order.map((wd) => (
                  <th key={wd} className="px-1 py-1 font-medium">
                    {WEEKDAY_SHORT[wd]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="py-1 pr-2 text-xs text-muted">New questions</td>
                {order.map((wd) => (
                  <td key={wd} className="px-1 py-1">
                    <Input type="number" min={0} max={50} className="text-center" value={s.newPerWeekday[wd]} onChange={(e) => setQuota(wd, Number(e.target.value))} aria-label={`New questions on ${WEEKDAY_SHORT[wd]}`} />
                  </td>
                ))}
              </tr>
              <tr>
                <td className="py-1 pr-2 text-xs text-muted">Mandatory review</td>
                {order.map((wd) => {
                  const r = reviewFor(wd);
                  return (
                    <td key={wd} className="px-1 py-1">
                      <Select
                        value={!r ? "off" : r.quota == null ? "rest" : String(r.quota)}
                        onChange={(e) => setReview(wd, e.target.value)}
                        aria-label={`Mandatory review on ${WEEKDAY_SHORT[wd]}`}
                        className="px-1 text-center"
                      >
                        <option value="off">—</option>
                        <option value="rest">Rest</option>
                        {[3, 5, 8, 10, 12, 13, 15, 20, 25].map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                        {r && r.quota != null && ![3, 5, 8, 10, 12, 13, 15, 20, 25].includes(r.quota) ? <option value={r.quota}>{r.quota}</option> : null}
                      </Select>
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-xs text-subtle">
          Weekly new total: {s.newPerWeekday.reduce((a, b) => a + b, 0)}. Mandatory reviews cover the questions you completed earlier in the same Monday–Sunday week; &quot;Rest&quot; takes whatever remains.
        </p>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="srscap">Spaced-repetition reviews per day</Label>
          <Input id="srscap" type="number" min={0} max={100} value={s.srsDailyCap} onChange={(e) => setS({ ...s, srsDailyCap: Number(e.target.value) })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="srscap2">…on mandatory review days</Label>
          <Input id="srscap2" type="number" min={0} max={100} value={s.srsReviewDayCap} onChange={(e) => setS({ ...s, srsReviewDayCap: Number(e.target.value) })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="overlap">Problems you already practiced (list overlaps)</Label>
          <Select id="overlap" value={s.overlapPolicy} onChange={(e) => setS({ ...s, overlapPolicy: e.target.value as PlanSettings["overlapPolicy"] })}>
            <option value="skip_practiced">Skip — don&apos;t use new-question quota (recommended)</option>
            <option value="include_all">Include — practice them again as new</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="carry">Unfinished new questions</Label>
          <Select id="carry" value={s.carryOverReducesNew ? "reduce" : "add"} onChange={(e) => setS({ ...s, carryOverReducesNew: e.target.value === "reduce" })}>
            <option value="reduce">Carry over and reduce today&apos;s new pull (recommended)</option>
            <option value="add">Carry over and still pull a full quota</option>
          </Select>
        </div>
      </div>

      <fieldset className="space-y-1.5">
        <legend className="text-xs font-medium text-muted">List order</legend>
        <ol className="space-y-1">
          {allLists.map((slug) => {
            const active = s.listSlugs.includes(slug);
            const idx = s.listSlugs.indexOf(slug);
            const l = lists.find((x) => x.slug === slug);
            return (
              <li key={slug} className="flex items-center justify-between rounded-md border border-border px-2.5 py-1.5">
                <span className={active ? "" : "text-subtle line-through"}>
                  {active ? `${idx + 1}. ` : ""}
                  {l?.name ?? slug}
                </span>
                <span className="flex gap-1">
                  {active && idx > 0 ? (
                    <Button size="sm" variant="ghost" onClick={() => setS({ ...s, listSlugs: [...s.listSlugs.slice(0, idx - 1), slug, s.listSlugs[idx - 1]!, ...s.listSlugs.slice(idx + 1)] })}>
                      <ArrowUp /> Up
                    </Button>
                  ) : null}
                  {active && s.listSlugs.length > 1 ? (
                    <Button size="sm" variant="ghost" onClick={() => setS({ ...s, listSlugs: s.listSlugs.filter((x) => x !== slug) })}>
                      Exclude
                    </Button>
                  ) : null}
                  {!active ? (
                    <Button size="sm" variant="ghost" onClick={() => setS({ ...s, listSlugs: [...s.listSlugs, slug] })}>
                      Include
                    </Button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
        <p className="text-xs text-subtle">The queue is built in this order. A problem in several lists appears once, at its first position. Excluding a list later does not remove problems already in the queue.</p>
      </fieldset>

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          Save plan settings
        </Button>
        {ok ? <span className="text-xs text-good">{ok}</span> : null}
        {error ? <span className="text-xs text-bad">{error}</span> : null}
      </div>
    </form>
  );
}

export function QueueControls({ planId, problemId, status }: { planId: number; problemId: number; status: string }) {
  const { pending, run, error } = useAction();
  if (status === "skipped_practiced" || status === "removed") {
    return (
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => enqueueAction(planId, problemId, "front"))} title="Practice it as a new question">
        <Plus /> Practice as new
      </Button>
    );
  }
  if (status !== "pending") return null;
  const b = (to: "top" | "up" | "down" | "bottom", icon: React.ReactNode, label: string) => (
    <Button size="icon-sm" variant="ghost" disabled={pending} aria-label={label} title={label} onClick={() => run(() => moveQueueAction(planId, problemId, to))}>
      {icon}
    </Button>
  );
  return (
    <span className="flex items-center">
      {b("top", <ChevronsUp />, "Move to top")}
      {b("up", <ArrowUp />, "Move up")}
      {b("down", <ArrowDown />, "Move down")}
      {b("bottom", <ChevronsDown />, "Move to bottom")}
      <Button size="icon-sm" variant="ghost" disabled={pending} aria-label="Remove from queue" title="Remove from queue" onClick={() => run(() => removeFromQueueAction(planId, problemId))}>
        <Trash2 />
      </Button>
      {error ? <span className="text-[11px] text-bad">{error}</span> : null}
    </span>
  );
}

export function AddProblemForm({ planId, today }: { planId: number | null; today: string }) {
  const router = useRouter();
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [where, setWhere] = useState<"front" | "end" | "today">("front");
  const { pending, run, error, ok } = useAction();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const r = await addProblemBySlug(slug, title);
          if (!r.ok) return r;
          if (where === "today") return addToDayAction(r.data.id, today, true);
          if (planId == null) return { ok: false, error: "No active plan" };
          const q = await enqueueAction(planId, r.data.id, where);
          if (q.ok) {
            setSlug("");
            setTitle("");
            router.refresh();
          }
          return q;
        }, "Added");
      }}
    >
      <div className="min-w-56 flex-1 space-y-1">
        <Label htmlFor="add-slug">LeetCode URL or slug</Label>
        <Input id="add-slug" placeholder="https://leetcode.com/problems/two-sum/" value={slug} onChange={(e) => setSlug(e.target.value)} required />
      </div>
      <div className="min-w-40 flex-1 space-y-1">
        <Label htmlFor="add-title">Title (optional)</Label>
        <Input id="add-title" placeholder="Filled in automatically if blank" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="add-where">Add to</Label>
        <Select id="add-where" value={where} onChange={(e) => setWhere(e.target.value as typeof where)}>
          <option value="front">Front of queue</option>
          <option value="end">End of queue</option>
          <option value="today">Today, as new</option>
        </Select>
      </div>
      <Button type="submit" disabled={pending}>
        <Plus /> Add
      </Button>
      {ok ? <span className="text-xs text-good">{ok}</span> : null}
      {error ? <span className="text-xs text-bad">{error}</span> : null}
    </form>
  );
}
