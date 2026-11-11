"use client";

import { CalendarClock, Loader2, MoreHorizontal, Play, SkipForward } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { addDays } from "@lcc/shared";
import { rescheduleAction, skipAssignmentAction, startPractice } from "@/lib/actions";
import { cn } from "@/lib/utils";
import { Button, Input } from "./ui";

/**
 * Start (or resume) a session: creates it on the server, opens the problem on
 * LeetCode in a reusable tab (tagged with the session id for the extension),
 * and shows the session workspace here.
 */
export function PracticeButton({
  problemId,
  assignmentId,
  label = "Start",
  resume = false,
  size = "sm",
  variant,
  openLeetCode = true,
}: {
  problemId: number;
  assignmentId?: number | null;
  label?: string;
  resume?: boolean;
  size?: "sm" | "md";
  variant?: "primary" | "secondary";
  openLeetCode?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-end">
      <Button
        size={size}
        variant={variant ?? (resume ? "secondary" : "primary")}
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await startPractice({ problemId, assignmentId });
            if (!r.ok) return setError(r.error);
            if (openLeetCode) {
              // Within the click's user-activation window; reuses one LeetCode tab.
              window.open(r.data.url, "lcc-leetcode");
            }
            router.push(`/sessions/${r.data.sessionId}`);
          })
        }
      >
        {pending ? <Loader2 className="animate-spin" /> : <Play />}
        {resume ? "Resume" : label}
      </Button>
      {error ? <span className="mt-1 text-[11px] text-bad">{error}</span> : null}
    </span>
  );
}

export function AssignmentMenu({ assignmentId, today, canSkip }: { assignmentId: number; today: string; canSkip: boolean }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(addDays(today, 1));
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const go = (to: string) =>
    start(async () => {
      const r = await rescheduleAction(assignmentId, to);
      if (!r.ok) setError(r.error);
      else setOpen(false);
    });
  const nextMonday = (() => {
    let d = addDays(today, 1);
    while (new Date(`${d}T12:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1);
    return d;
  })();
  return (
    <div className="relative" ref={ref}>
      <Button size="icon-sm" variant="ghost" aria-label="Reschedule or skip" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal />
      </Button>
      {open ? (
        <div className="absolute right-0 top-8 z-20 w-60 rounded-lg border border-border bg-surface p-2 shadow-lg">
          <div className="px-1 pb-1.5 text-xs font-medium text-muted">Reschedule</div>
          <div className="grid grid-cols-3 gap-1">
            {[
              ["Tomorrow", addDays(today, 1)],
              ["+3 days", addDays(today, 3)],
              ["Next Mon", nextMonday],
            ].map(([l, d]) => (
              <Button key={l} size="sm" disabled={pending} onClick={() => go(d!)}>
                {l}
              </Button>
            ))}
          </div>
          <div className="mt-1.5 flex gap-1">
            <Input type="date" value={date} min={today} onChange={(e) => setDate(e.target.value)} aria-label="Reschedule to date" />
            <Button size="md" disabled={pending} onClick={() => go(date)} aria-label="Reschedule to chosen date">
              <CalendarClock />
            </Button>
          </div>
          {canSkip ? (
            <Button
              size="sm"
              variant="ghost"
              className="mt-1.5 w-full justify-start"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await skipAssignmentAction(assignmentId);
                  if (!r.ok) setError(r.error);
                  else setOpen(false);
                })
              }
            >
              <SkipForward /> Skip (returns to queue)
            </Button>
          ) : null}
          {error ? <p className={cn("mt-1 px-1 text-[11px] text-bad")}>{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
