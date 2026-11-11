"use client";

import { CalendarPlus, History, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { OUTCOMES, OUTCOME_LABELS, addDays, type Outcome } from "@lcc/shared";
import { addToDayAction, deleteSessionAction, editSession, logPastAttempt, restartProblemAction, setProblemPatterns } from "@/lib/actions";
import { Button, Input, Label, Select, Textarea } from "./ui";

function useRun() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, ok = "Done") =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? { ok: true, text: ok } : { ok: false, text: r.error ?? "Failed" });
    });
  return { pending, msg, run };
}

export function ScheduleButtons({ problemId, today, hasHistory }: { problemId: number; today: string; hasHistory: boolean }) {
  const [date, setDate] = useState(today);
  const { pending, msg, run } = useRun();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input type="date" value={date} min={today} onChange={(e) => setDate(e.target.value)} className="w-36" aria-label="Schedule date" />
      <Button size="sm" disabled={pending} onClick={() => run(() => addToDayAction(problemId, date), "Scheduled")}>
        <CalendarPlus /> Schedule
      </Button>
      {hasHistory ? (
        <Button size="sm" variant="ghost" disabled={pending} title="Adds it to today as a new question; history is kept" onClick={() => run(() => restartProblemAction(problemId), "Added to today as new")}>
          <RotateCcw /> Restart as new
        </Button>
      ) : null}
      {msg ? <span className={msg.ok ? "text-xs text-good" : "text-xs text-bad"}>{msg.text}</span> : null}
    </div>
  );
}

export function LogPastAttempt({ problemId, today }: { problemId: number; today: string }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(today);
  const [outcome, setOutcome] = useState("independent");
  const [minutes, setMinutes] = useState("");
  const [notes, setNotes] = useState("");
  const { pending, msg, run } = useRun();
  if (!open)
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <History /> Log a past attempt / mark completed
      </Button>
    );
  return (
    <form
      className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[auto_auto_auto_1fr_auto]"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => logPastAttempt({ problemId, date, outcome, durationMin: minutes ? Number(minutes) : null, notes: notes || undefined }), "Logged");
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="lp-date">Date</Label>
        <Input id="lp-date" type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="lp-out">Outcome</Label>
        <Select id="lp-out" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {OUTCOME_LABELS[o].label}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="lp-min">Minutes</Label>
        <Input id="lp-min" type="number" min={0} className="w-20" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="lp-notes">Note</Label>
        <Input id="lp-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <div className="flex items-end gap-1">
        <Button type="submit" size="md" disabled={pending}>
          Save
        </Button>
        <Button size="icon" variant="ghost" aria-label="Cancel" onClick={() => setOpen(false)}>
          <X />
        </Button>
      </div>
      <p className="text-[11px] text-subtle sm:col-span-5">
        Stored as a manually logged session (clearly marked). It feeds the review schedule like any other session. {msg ? <span className={msg.ok ? "text-good" : "text-bad"}>{msg.text}</span> : null}
      </p>
    </form>
  );
}

export function PatternsEditor({ problemId, patterns, suggestions }: { problemId: number; patterns: string[]; suggestions: string[] }) {
  const [list, setList] = useState(patterns);
  const [input, setInput] = useState("");
  const { pending, run } = useRun();
  const save = (next: string[]) => {
    setList(next);
    run(() => setProblemPatterns(problemId, next));
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {list.map((p, i) => (
        <span key={p} className="inline-flex items-center gap-1 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-xs">
          {i === 0 ? <span className="text-[10px] text-subtle">primary</span> : null}
          {p}
          <button aria-label={`Remove pattern ${p}`} disabled={pending} onClick={() => save(list.filter((x) => x !== p))} className="text-subtle hover:text-fg">
            <X className="size-3" />
          </button>
        </span>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (input.trim() && !list.includes(input.trim())) save([...list, input.trim()]);
          setInput("");
        }}
      >
        <input list="pattern-suggestions" value={input} onChange={(e) => setInput(e.target.value)} placeholder="+ pattern" aria-label="Add pattern" className="h-6 w-28 rounded border border-dashed border-border bg-transparent px-1.5 text-xs" />
        <datalist id="pattern-suggestions">
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </form>
    </div>
  );
}

export function EditSessionForm({
  id,
  notes,
  mistakes,
  takeaway,
  timeComplexity,
  spaceComplexity,
  durationMin,
  outcome,
  hintsUsed,
  difficultyRating,
}: {
  id: string;
  notes: string;
  mistakes: string;
  takeaway: string;
  timeComplexity: string;
  spaceComplexity: string;
  durationMin: number | null;
  outcome: Outcome | null;
  hintsUsed: boolean;
  difficultyRating: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(notes);
  const [m, setM] = useState(mistakes);
  const [t, setT] = useState(takeaway);
  const [tc, setTc] = useState(timeComplexity);
  const [sc, setSc] = useState(spaceComplexity);
  const [d, setD] = useState(durationMin == null ? "" : String(durationMin));
  const [o, setO] = useState<Outcome | "">(outcome ?? "");
  const [h, setH] = useState(hintsUsed);
  const [r, setR] = useState(difficultyRating == null ? "" : String(difficultyRating));
  const { pending, msg, run } = useRun();
  if (!open)
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Pencil /> Edit
      </Button>
    );
  return (
    <form
      className="w-full space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(
          () =>
            editSession(id, {
              notes: n,
              mistakes: m,
              takeaway: t,
              timeComplexity: tc,
              spaceComplexity: sc,
              durationMin: d === "" ? null : Number(d),
              hintsUsed: h,
              difficultyRating: r === "" ? null : Number(r),
              ...(o ? { outcome: o } : {}),
            }),
          o && o !== outcome ? "Saved — next review re-calculated" : "Saved",
        );
      }}
    >
      {outcome ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor={`o-${id}`}>How it went</Label>
            <Select id={`o-${id}`} value={o} onChange={(e) => setO(e.target.value as Outcome)} className="w-40">
              {OUTCOMES.map((x) => (
                <option key={x} value={x}>
                  {OUTCOME_LABELS[x].label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`r-${id}`}>Difficulty felt</Label>
            <Select id={`r-${id}`} value={r} onChange={(e) => setR(e.target.value)} className="w-28">
              <option value="">—</option>
              {[1, 2, 3, 4, 5].map((x) => (
                <option key={x} value={x}>
                  {x}/5
                </option>
              ))}
            </Select>
          </div>
          <label className="flex h-8 items-center gap-2 text-xs">
            <input type="checkbox" checked={h} onChange={(e) => setH(e.target.checked)} /> Used hints
          </label>
        </div>
      ) : null}
      <Textarea rows={2} value={n} onChange={(e) => setN(e.target.value)} aria-label="Session notes" placeholder="Notes" />
      <div className="grid gap-2 sm:grid-cols-2">
        <Textarea rows={2} value={m} onChange={(e) => setM(e.target.value)} aria-label="Mistakes" placeholder="Mistakes" />
        <Textarea rows={2} value={t} onChange={(e) => setT(e.target.value)} aria-label="Takeaway" placeholder="Takeaway" />
        <Input value={tc} onChange={(e) => setTc(e.target.value)} aria-label="Time complexity" maxLength={200} placeholder="Time complexity, e.g. O(n)" className="font-mono" />
        <Input value={sc} onChange={(e) => setSc(e.target.value)} aria-label="Space complexity" maxLength={200} placeholder="Space complexity, e.g. O(1)" className="font-mono" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input type="number" min={0} className="w-28" value={d} onChange={(e) => setD(e.target.value)} aria-label="Duration override in minutes" placeholder="Minutes" />
        <Button type="submit" size="sm" disabled={pending}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Close
        </Button>
        {msg ? <span className={msg.ok ? "text-xs text-good" : "text-xs text-bad"}>{msg.text}</span> : null}
      </div>
    </form>
  );
}

/** Permanently delete a finished session. Confirms first; the server backs up the database before deleting. */
export function DeleteSessionButton({ id, submissionCount, redirectToProblem = false }: { id: string; submissionCount: number; redirectToProblem?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      <Button
        size="sm"
        variant="danger"
        disabled={pending}
        onClick={() => {
          const subs = submissionCount ? ` and its ${submissionCount} submission${submissionCount === 1 ? "" : "s"}` : "";
          if (!window.confirm(`Delete this session${subs} permanently?

Any planned task it completed goes back to your list, and the next review date is re-calculated. A database backup is taken first.`)) return;
          start(async () => {
            const r = await deleteSessionAction(id);
            if (!r.ok) return setErr(r.error);
            if (redirectToProblem && r.data.slug) router.push(`/problems/${r.data.slug}`);
          });
        }}
      >
        <Trash2 /> Delete
      </Button>
      {err ? <span className="text-xs text-bad">{err}</span> : null}
    </span>
  );
}
