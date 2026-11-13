"use client";

import { Clock } from "lucide-react";
import { useState, useTransition } from "react";
import { addDays } from "@lcc/shared";
import { postponeReviewAction, pullEarlyReviewsAction, pullMoreReviewsAction } from "@/lib/actions";
import { Button } from "./ui";

export function PostponeButtons({ problemId, today }: { problemId: number; today: string }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-0.5">
      <Clock className="mr-1 size-3.5 text-subtle" aria-hidden />
      {[1, 3, 7].map((n) => (
        <Button
          key={n}
          size="sm"
          variant="ghost"
          disabled={pending}
          aria-label={`Postpone ${n} day${n > 1 ? "s" : ""}`}
          onClick={() =>
            start(async () => {
              const r = await postponeReviewAction(problemId, addDays(today, n));
              if (!r.ok) setErr(r.error);
            })
          }
        >
          +{n}d
        </Button>
      ))}
      {err ? <span className="text-[11px] text-bad">{err}</span> : null}
    </span>
  );
}

export function PullMore({ available }: { available: number }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  if (!available) return null;
  return (
    <span className="flex items-center gap-2">
      {msg ? <span className="text-xs text-muted">{msg}</span> : null}
      {[3, 5].map((n) => (
        <Button
          key={n}
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await pullMoreReviewsAction(Math.min(n, available));
              setMsg(r.ok ? `Added ${r.data} to today` : r.error);
            })
          }
        >
          Pull {Math.min(n, available)} into today
        </Button>
      ))}
    </span>
  );
}

/** Do reviews due in the next 2 days today (when you know a busy day is coming). */
export function PullEarly({ available }: { available: number }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  if (!available) return null;
  return (
    <span className="flex items-center gap-2">
      {msg ? <span className="text-xs text-muted">{msg}</span> : null}
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await pullEarlyReviewsAction(available);
            setMsg(r.ok ? `Added ${r.data} to today` : r.error);
          })
        }
      >
        Do {available} early
      </Button>
    </span>
  );
}
