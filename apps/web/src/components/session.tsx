"use client";

import { ChevronDown, Eye, EyeOff, Flag, Lightbulb, Pause, Play, Square, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { OUTCOMES, OUTCOME_LABELS, VERDICTS, addDays, effectiveDuration, elapsedMs, formatClock, formatDuration, type Outcome } from "@lcc/shared";
import { abandonSession, deleteSubmissionAction, finishSessionAction, linkSubmissionAction, logSubmissionManually, pauseSession, resumeSession, revealInSession } from "@/lib/actions";
import { cn, formatDateTime } from "@/lib/utils";
import { VerdictBadge } from "./badges";
import { CodeBlock } from "./code";
import { Badge, Button, Input, Kbd, Label, Select, Textarea } from "./ui";

export interface SessionTiming {
  startedAt: number;
  endedAt: number | null;
  pausedMs: number;
  pausedAt: number | null;
  activeMs: number | null;
  durationOverrideMs: number | null;
  lastActivityAt: number | null;
  status: string;
}

export function SessionTimer({ t }: { t: SessionTiming }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (t.status !== "in_progress") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [t.status]);
  const wall = elapsedMs(t, now);
  return (
    <div className="flex items-end gap-6">
      <div>
        <div className="text-xs text-muted">{t.status === "paused" ? "Paused" : "Elapsed (minus pauses)"}</div>
        <div className={cn("tabular font-mono text-3xl font-semibold tracking-tight", t.status === "paused" && "text-muted")} aria-live="off">
          {formatClock(wall)}
        </div>
      </div>
      <div className="pb-1 text-xs text-muted">
        <div>Active (extension estimate)</div>
        <div className="tabular font-mono text-sm text-fg">{t.activeMs ? `≈ ${formatClock(t.activeMs)}` : "not tracked"}</div>
      </div>
    </div>
  );
}

export function SessionControls({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === "paused" ? (
        <Button size="sm" disabled={pending} onClick={() => start(async () => void (await resumeSession(id)))}>
          <Play /> Resume
        </Button>
      ) : (
        <Button size="sm" disabled={pending} onClick={() => start(async () => void (await pauseSession(id)))}>
          <Pause /> Pause
        </Button>
      )}
      {confirm ? (
        <span className="flex items-center gap-1 text-xs">
          Abandon? History is kept and the task goes back to your list.
          <Button
            size="sm"
            variant="danger"
            disabled={pending}
            onClick={() =>
              start(async () => {
                await abandonSession(id);
                router.push("/");
              })
            }
          >
            Abandon
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
            Cancel
          </Button>
        </span>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
          <Square /> Abandon
        </Button>
      )}
    </div>
  );
}

/** Review mode: everything from previous attempts is hidden until explicitly revealed (and the reveal is recorded). */
export function Reveal({
  sessionId,
  what,
  label,
  already,
  children,
}: {
  sessionId: string;
  what: "hints" | "notes" | "code";
  label: string;
  already: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  return (
    <div className="rounded-md border border-border">
      <button
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm"
        aria-expanded={open}
        disabled={pending}
        onClick={() => {
          if (!open && !already) start(async () => void (await revealInSession(sessionId, what)));
          setOpen((o) => !o);
        }}
      >
        <span className="flex items-center gap-2">
          {what === "hints" ? <Lightbulb className="size-4 text-muted" /> : open ? <EyeOff className="size-4 text-muted" /> : <Eye className="size-4 text-muted" />}
          {open ? `Hide ${label.toLowerCase()}` : `Reveal ${label.toLowerCase()}`}
        </span>
        {already ? <Badge tone="warn">Revealed this session</Badge> : <span className="text-[11px] text-subtle">Recorded if revealed</span>}
      </button>
      {open ? <div className="border-t border-border p-3">{children}</div> : null}
    </div>
  );
}

export function ReflectionForm({
  sessionId,
  recommendations,
  today,
  hintsRevealed,
  timing,
  interrupted,
  initialNotes,
}: {
  sessionId: string;
  recommendations: Record<Outcome, string>;
  today: string;
  hintsRevealed: boolean;
  timing: SessionTiming;
  interrupted: boolean;
  initialNotes: string;
}) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [hints, setHints] = useState(hintsRevealed);
  const [more, setMore] = useState(false);
  const [struggles, setStruggles] = useState("");
  const [takeaway, setTakeaway] = useState("");
  const [mistakes, setMistakes] = useState("");
  const [rating, setRating] = useState<number | null>(null);
  const [reviewDate, setReviewDate] = useState<string | null>(null);
  const [durationMin, setDurationMin] = useState<string>("");
  const [endAtLastActivity, setEndAtLastActivity] = useState(interrupted);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const rec = outcome ? recommendations[outcome] : null;
  const est = useMemo(() => {
    const end = endAtLastActivity && timing.lastActivityAt ? timing.lastActivityAt : Date.now();
    return effectiveDuration({ ...timing, endedAt: timing.endedAt ?? end }, end);
  }, [timing, endAtLastActivity]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const o = OUTCOMES.find((x) => OUTCOME_LABELS[x].key === e.key);
      if (o) setOutcome(o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = () =>
    start(async () => {
      if (!outcome) return setError("Pick how it went first.");
      setError(null);
      const r = await finishSessionAction(
        sessionId,
        {
          outcome,
          hintsUsed: hints || outcome === "hints",
          struggles: struggles || null,
          takeaway: takeaway || null,
          mistakes: mistakes || null,
          difficultyRating: rating,
          nextReviewDate: reviewDate && reviewDate !== rec ? reviewDate : null,
          durationOverrideMs: durationMin ? Math.round(Number(durationMin) * 60_000) : null,
        },
        endAtLastActivity && timing.lastActivityAt ? timing.lastActivityAt : null,
      );
      if (!r.ok) return setError(r.error);
      router.push("/");
    });

  const quick = [
    ["Tomorrow", addDays(today, 1)],
    ["3 days", addDays(today, 3)],
    ["1 week", addDays(today, 7)],
    ["3 weeks", addDays(today, 21)],
  ] as const;

  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-2 text-xs font-medium text-muted">How did it go?</legend>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-5" role="radiogroup">
          {OUTCOMES.map((o) => (
            <button
              key={o}
              role="radio"
              aria-checked={outcome === o}
              onClick={() => {
                setOutcome(o);
                setReviewDate(null);
              }}
              className={cn(
                "rounded-md border px-2.5 py-2 text-left transition-colors",
                outcome === o ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-2",
              )}
            >
              <div className="flex items-center justify-between text-sm font-medium">
                {OUTCOME_LABELS[o].label} <Kbd>{OUTCOME_LABELS[o].key}</Kbd>
              </div>
              <div className="mt-0.5 text-[11px] leading-tight text-muted">{OUTCOME_LABELS[o].description}</div>
            </button>
          ))}
        </div>
      </fieldset>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={hints} onChange={(e) => setHints(e.target.checked)} className="size-4 accent-[var(--accent)]" />
        I used hints, the editorial or a previous solution
        {hintsRevealed ? <span className="text-xs text-subtle">(you revealed hints/notes/code this session)</span> : null}
      </label>

      <div className="rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm">
            Next review:{" "}
            {rec ? (
              <span className="font-medium">
                {reviewDate ?? rec}
                {reviewDate && reviewDate !== rec ? <span className="ml-1 text-xs text-muted">(recommended {rec})</span> : <span className="ml-1 text-xs text-muted">(recommended)</span>}
              </span>
            ) : (
              <span className="text-muted">pick an outcome to see the recommendation</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {quick.map(([l, d]) => (
              <Button key={l} size="sm" variant={reviewDate === d ? "secondary" : "ghost"} disabled={!outcome} onClick={() => setReviewDate(d)}>
                {l}
              </Button>
            ))}
            <Input type="date" min={addDays(today, 1)} className="w-36" value={reviewDate ?? rec ?? ""} disabled={!outcome} onChange={(e) => setReviewDate(e.target.value || null)} aria-label="Override next review date" />
          </div>
        </div>
      </div>

      <button className="flex items-center gap-1 text-xs font-medium text-muted hover:text-fg" onClick={() => setMore((m) => !m)} aria-expanded={more}>
        <ChevronDown className={cn("size-3.5 transition-transform", more && "rotate-180")} />
        More details (optional)
      </button>
      {more ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="r-str">What did I struggle with?</Label>
            <Textarea id="r-str" rows={2} value={struggles} onChange={(e) => setStruggles(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="r-mis">Mistakes made</Label>
            <Textarea id="r-mis" rows={2} value={mistakes} onChange={(e) => setMistakes(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="r-take">Key takeaway</Label>
            <Textarea id="r-take" rows={2} value={takeaway} onChange={(e) => setTakeaway(e.target.value)} />
          </div>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Personal difficulty (1–5)</Label>
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <Button key={n} size="sm" variant={rating === n ? "primary" : "secondary"} onClick={() => setRating(rating === n ? null : n)} aria-pressed={rating === n}>
                    {n}
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="r-dur">Correct the duration (minutes)</Label>
              <Input id="r-dur" type="number" min={0} max={1440} placeholder={`${Math.round(est.ms / 60_000)} (${est.source === "extension_active" ? "active estimate" : "wall clock"})`} value={durationMin} onChange={(e) => setDurationMin(e.target.value)} />
            </div>
          </div>
        </div>
      ) : null}

      {interrupted ? (
        <label className="flex items-start gap-2 rounded-md bg-warn-soft p-2.5 text-xs text-warn">
          <input type="checkbox" checked={endAtLastActivity} onChange={(e) => setEndAtLastActivity(e.target.checked)} className="mt-0.5" />
          This session looks interrupted. End it at the last recorded activity ({formatDateTime(timing.lastActivityAt)}) instead of now, so the duration isn&apos;t inflated.
        </label>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" size="lg" disabled={pending || !outcome} onClick={submit}>
          <Flag /> Finish session
        </Button>
        <span className="text-xs text-muted">
          Duration recorded: {durationMin ? `${durationMin} min (manual)` : formatDuration(est.ms, { approx: est.approx })}
          {initialNotes ? "" : " · tip: jot a one-line note above"}
        </span>
        {error ? <span className="text-xs text-bad">{error}</span> : null}
      </div>
    </div>
  );
}

export function ManualSubmissionForm({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [verdict, setVerdict] = useState("Accepted");
  const [lang, setLang] = useState("");
  const [code, setCode] = useState("");
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  if (!open)
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        + Log a submission manually
      </Button>
    );
  return (
    <form
      className="space-y-2 rounded-md border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await logSubmissionManually(sessionId, { verdict, lang, code });
          if (!r.ok) setMsg(r.error);
          else {
            setMsg("Logged");
            setCode("");
            setOpen(false);
          }
        });
      }}
    >
      <p className="text-xs text-muted">Fallback when automatic capture isn&apos;t available. Stored as a manual entry, never as a capture.</p>
      <div className="flex gap-2">
        <Select value={verdict} onChange={(e) => setVerdict(e.target.value)} aria-label="Verdict" className="w-48">
          {VERDICTS.filter((v) => v !== "Pending").map((v) => (
            <option key={v}>{v}</option>
          ))}
        </Select>
        <Input placeholder="Language (e.g. python3)" value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Language" />
      </div>
      <Textarea rows={5} className="font-mono text-xs" placeholder="Paste code (optional)" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Code" />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          Save submission
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        {msg ? <span className="text-xs text-muted">{msg}</span> : null}
      </div>
    </form>
  );
}

export interface SubmissionView {
  id: number;
  verdict: string;
  kind: string;
  language: string | null;
  code: string | null;
  submittedAt: number;
  runtime: string | null;
  memory: string | null;
  totalCorrect: number | null;
  totalTestcases: number | null;
  captureSource: string;
  attribution: string;
  details: Record<string, string | null> | null;
}

export function SubmissionList({ subs, showRuns = true }: { subs: SubmissionView[]; showRuns?: boolean }) {
  const [openId, setOpenId] = useState<number | null>(null);
  const list = showRuns ? subs : subs.filter((s) => s.kind === "submit");
  if (!list.length) return <p className="text-xs text-muted">No submissions recorded.</p>;
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {list.map((s, i) => (
        <li key={s.id}>
          <button className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-xs hover:bg-surface-2" onClick={() => setOpenId(openId === s.id ? null : s.id)} aria-expanded={openId === s.id}>
            <span className="tabular w-5 text-subtle">{i + 1}</span>
            {s.kind === "run" ? <Badge tone="outline">Run</Badge> : <VerdictBadge v={s.verdict} />}
            {s.kind === "run" ? <span className="text-muted">{s.verdict}</span> : null}
            <span className="text-muted">{formatDateTime(s.submittedAt)}</span>
            <span className="text-muted">{s.language ?? ""}</span>
            {s.totalTestcases ? (
              <span className="tabular text-muted">
                {s.totalCorrect}/{s.totalTestcases} tests
              </span>
            ) : null}
            {s.runtime ? <span className="tabular text-muted">{s.runtime}</span> : null}
            {s.memory ? <span className="tabular text-muted">{s.memory}</span> : null}
            <span className="ml-auto flex gap-1">
              {s.captureSource === "manual" ? <Badge tone="outline">Manual</Badge> : null}
              {s.attribution === "inferred" ? <Badge tone="outline" title="Linked because it was the only open session for this problem">Auto-linked</Badge> : null}
              {!s.code ? <Badge tone="outline">No code captured</Badge> : null}
            </span>
          </button>
          {openId === s.id ? (
            <div className="space-y-2 border-t border-border p-3">
              {s.details && Object.values(s.details).some(Boolean) ? (
                <dl className="grid gap-1 text-xs sm:grid-cols-2">
                  {Object.entries(s.details)
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <div key={k} className="min-w-0">
                        <dt className="text-muted">{k.replace(/([A-Z])/g, " $1").toLowerCase()}</dt>
                        <dd className="truncate font-mono" title={v ?? ""}>
                          {v}
                        </dd>
                      </div>
                    ))}
                </dl>
              ) : null}
              {s.code ? <CodeBlock code={s.code} lang={s.language} /> : <p className="text-xs text-muted">The extension saw the result but not the submitted code (e.g. the page reloaded mid-judge).</p>}
              <DeleteSubmission id={s.id} label={s.kind === "run" ? "run" : "submission"} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function DeleteSubmission({ id, label }: { id: number; label: string }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        className="text-bad"
        disabled={pending}
        onClick={() => {
          if (!window.confirm(`Delete this ${label} permanently? A database backup is taken first.`)) return;
          start(async () => {
            const r = await deleteSubmissionAction(id);
            if (!r.ok) setErr(r.error);
          });
        }}
      >
        <Trash2 /> Delete {label}
      </Button>
      {err ? <span className="text-xs text-bad">{err}</span> : null}
    </div>
  );
}

export function LinkSubmission({ submissionId, options }: { submissionId: number; options: { id: string; label: string }[] }) {
  const [sel, setSel] = useState(options[0]?.id ?? "");
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-1">
      <Select value={sel} onChange={(e) => setSel(e.target.value)} aria-label="Session to link" className="h-7 w-auto text-xs">
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
      <Button
        size="sm"
        disabled={pending || !sel}
        onClick={() =>
          start(async () => {
            const r = await linkSubmissionAction(submissionId, sel);
            setMsg(r.ok ? "Linked" : r.error);
          })
        }
      >
        Link
      </Button>
      {msg ? <span className="text-[11px] text-muted">{msg}</span> : null}
    </span>
  );
}

export function UnlinkButton({ submissionId }: { submissionId: number }) {
  const [pending, start] = useTransition();
  return (
    <Button size="icon-sm" variant="ghost" aria-label="Unlink submission from this session" disabled={pending} onClick={() => start(async () => void (await linkSubmissionAction(submissionId, null)))}>
      <Trash2 />
    </Button>
  );
}
