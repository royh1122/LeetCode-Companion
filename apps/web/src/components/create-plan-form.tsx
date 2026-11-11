"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createPlanAction } from "@/lib/actions";
import { Button, Input, Label } from "./ui";

export function CreatePlanForm({ today, lists }: { today: string; lists: { slug: string; name: string; count: number }[] }) {
  const router = useRouter();
  const [startDate, setStartDate] = useState(today);
  const [order, setOrder] = useState(lists.map((l) => l.slug));
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const move = (i: number) => setOrder((o) => (i <= 0 ? o : [...o.slice(0, i - 1), o[i]!, o[i - 1]!, ...o.slice(i + 1)]));
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await createPlanAction({ startDate, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, settings: { listSlugs: order } });
          if (!r.ok) setError(r.error);
          else router.refresh();
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="start">Start date</Label>
          <Input id="start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          <p className="text-xs text-subtle">Today works. Weeks run Monday → Sunday.</p>
        </div>
        <div className="space-y-1.5">
          <Label>List order (overlaps are only counted once)</Label>
          <ol className="space-y-1">
            {order.map((slug, i) => {
              const l = lists.find((x) => x.slug === slug)!;
              return (
                <li key={slug} className="flex items-center justify-between rounded-md border border-border px-2.5 py-1.5">
                  <span>
                    {i + 1}. {l.name} <span className="text-xs text-subtle">({l.count})</span>
                  </span>
                  {i > 0 ? (
                    <Button size="sm" variant="ghost" onClick={() => move(i)}>
                      Move up
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
      <p className="text-xs text-muted">
        Defaults: 5 new questions Mon–Fri, mandatory review of the week&apos;s 25 on Saturday (12) and Sunday (rest), up to 5 spaced-repetition reviews per day. Everything is adjustable later under Study plan.
      </p>
      {error ? <p className="text-xs text-bad">{error}</p> : null}
      <Button type="submit" variant="primary" disabled={pending}>
        Create study plan
      </Button>
    </form>
  );
}
