import { Search } from "lucide-react";
import Link from "next/link";
import { getAppSettings, listMistakes, listSessionHistory, type HistoryFilters } from "@lcc/db";
import { OUTCOMES, OUTCOME_LABELS, formatDuration } from "@lcc/shared";
import { OutcomeBadge, SESSION_TYPE_LABEL, SessionTypeBadge, VerdictBadge } from "@/components/badges";
import { Badge, Card, CardHeader, EmptyState, Input, PageHeader, Select, buttonVariants } from "@/components/ui";
import { db } from "@/lib/server";
import { formatDateTime } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "History" };

export default async function HistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const d = db();
  const tz = getAppSettings(d).timeZone;
  const f: HistoryFilters = {
    q: sp.q || undefined,
    outcome: sp.outcome || undefined,
    type: sp.type || undefined,
    hints: (sp.hints as HistoryFilters["hints"]) || undefined,
    from: sp.from || undefined,
    to: sp.to || undefined,
  };
  const rows = listSessionHistory(d, f);
  const mistakes = listMistakes(d, 40);
  // Recurring mistakes: group by primary pattern.
  const byPattern = new Map<string, typeof mistakes>();
  for (const m of mistakes) {
    const k = m.p.patterns[0] ?? "Other";
    byPattern.set(k, [...(byPattern.get(k) ?? []), m]);
  }
  const active = Object.values(f).some(Boolean);

  return (
    <div className="space-y-5">
      <PageHeader title="History" description="Every practice session, newest first. Search covers titles, numbers and your session notes." />
      <form className="flex flex-wrap items-end gap-2" role="search">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-subtle" />
          <Input name="q" defaultValue={sp.q} placeholder="Search title, #number or notes" className="pl-8" aria-label="Search history" />
        </div>
        <Select name="outcome" defaultValue={sp.outcome ?? ""} className="w-auto" aria-label="Outcome">
          <option value="">Any outcome</option>
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {OUTCOME_LABELS[o].label}
            </option>
          ))}
        </Select>
        <Select name="type" defaultValue={sp.type ?? ""} className="w-auto" aria-label="Session type">
          <option value="">Any type</option>
          {Object.entries(SESSION_TYPE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <Select name="hints" defaultValue={sp.hints ?? ""} className="w-auto" aria-label="Hints">
          <option value="">Hints: any</option>
          <option value="yes">Used hints</option>
          <option value="no">No hints</option>
        </Select>
        <Input type="date" name="from" defaultValue={sp.from} className="w-36" aria-label="From date" />
        <Input type="date" name="to" defaultValue={sp.to} className="w-36" aria-label="To date" />
        <button className={buttonVariants({ variant: "primary" })}>Apply</button>
        {active ? (
          <Link href="/history" className={buttonVariants({ variant: "ghost" })}>
            Clear
          </Link>
        ) : null}
      </form>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <Card className="overflow-x-auto">
          {rows.length ? (
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-2 py-2 font-medium">Problem</th>
                  <th className="px-2 py-2 font-medium">Type</th>
                  <th className="px-2 py-2 font-medium">Outcome</th>
                  <th className="px-2 py-2 text-right font-medium">Time</th>
                  <th className="px-2 py-2 text-right font-medium">Subs</th>
                  <th className="px-4 py-2 font-medium">Final</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map(({ session: s, problem: p }) => (
                  <tr key={s.id} className="align-top hover:bg-surface-2">
                    <td className="tabular whitespace-nowrap px-4 py-2 text-xs text-muted">{formatDateTime(s.endedAt ?? s.startedAt, tz)}</td>
                    <td className="max-w-80 px-2 py-2">
                      <Link href={["in_progress", "paused"].includes(s.status) ? `/sessions/${s.id}` : `/problems/${p.slug}`} className="font-medium hover:underline">
                        {p.title}
                      </Link>
                      {s.notes ? <div className="line-clamp-2 text-xs text-muted">{s.notes}</div> : null}
                      {s.mistakes ? <div className="line-clamp-1 text-xs text-warn">Mistakes: {s.mistakes}</div> : null}
                    </td>
                    <td className="px-2 py-2">
                      <SessionTypeBadge t={s.type} />
                    </td>
                    <td className="px-2 py-2">
                      {s.status === "completed" ? <OutcomeBadge o={s.outcome} /> : <Badge tone="outline">{s.status.replace("_", " ")}</Badge>}
                      {s.hintsUsed ? (
                        <Badge tone="warn" className="ml-1">
                          Hints
                        </Badge>
                      ) : null}
                    </td>
                    <td className="tabular px-2 py-2 text-right text-xs">{formatDuration(s.durationMs, { approx: s.durationApprox })}</td>
                    <td className="tabular px-2 py-2 text-right text-xs">{s.submitCount}</td>
                    <td className="px-4 py-2">
                      <VerdictBadge v={s.finalVerdict} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState title={active ? "No sessions match" : "No sessions yet"}>{active ? "Try clearing a filter." : "Finished sessions show up here."}</EmptyState>
          )}
        </Card>

        <Card>
          <CardHeader title="Recurring mistakes" description="Mistakes and struggles you wrote down, grouped by pattern." />
          {byPattern.size ? (
            <div className="divide-y divide-border">
              {[...byPattern.entries()]
                .sort((a, b) => b[1].length - a[1].length)
                .map(([pattern, items]) => (
                  <div key={pattern} className="px-4 py-3">
                    <div className="mb-1.5 flex items-center justify-between text-xs font-medium">
                      {pattern}
                      <span className="tabular text-subtle">{items.length}</span>
                    </div>
                    <ul className="space-y-1.5 text-xs">
                      {items.slice(0, 5).map((m) => (
                        <li key={m.s.id}>
                          <Link href={`/problems/${m.p.slug}`} className="text-muted hover:underline">
                            {m.p.title}
                          </Link>
                          <p className="line-clamp-2">{m.s.mistakes || m.s.struggles}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
            </div>
          ) : (
            <p className="px-4 py-5 text-xs text-muted">Write a short &quot;mistakes made&quot; note when finishing sessions and patterns will show up here.</p>
          )}
        </Card>
      </div>
    </div>
  );
}
