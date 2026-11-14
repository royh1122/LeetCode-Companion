import { Check, ExternalLink, History } from "lucide-react";
import Link from "next/link";
import type { TodayItem } from "@lcc/db";
import { problemUrl } from "@lcc/shared";
import { cn, relativeTime } from "@/lib/utils";
import { DifficultyBadge, OutcomeBadge } from "./badges";
import { AssignmentMenu, PracticeButton } from "./practice";
import { Badge, buttonVariants } from "./ui";

export function QuestionRow({ item, today, showPatterns }: { item: TodayItem; today: string; showPatterns: boolean }) {
  const { assignment: a, problem: p, stats } = item;
  const done = a.status === "completed";
  const inactive = a.status === "skipped" || a.status === "postponed";
  return (
    <li className={cn("group flex items-center gap-x-4 gap-y-2 px-4 py-3", (done || inactive) && "opacity-60")}>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border", done ? "border-good bg-good text-white" : "border-border-strong")} aria-hidden>
          {done ? <Check className="size-3" /> : null}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="tabular font-mono text-xs text-subtle">{p.frontendId ? `#${p.frontendId}` : ""}</span>
            <Link href={`/problems/${p.slug}`} className={cn("font-medium break-words hover:underline", done && "line-through decoration-subtle")}>
              {p.title}
            </Link>
            <DifficultyBadge d={p.difficulty} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            {showPatterns && p.patterns[0] ? <span>{p.patterns[0]}</span> : null}
            {item.carriedOver && !done ? <Badge tone="warn">Carried over · {item.daysOverdue}d</Badge> : null}
            {item.urgency === "overdue" ? <Badge tone="warn">Overdue {item.daysOverdue}d</Badge> : null}
            {a.type === "manual" ? <Badge tone="outline">Added</Badge> : null}
            {a.note && !item.carriedOver && a.type !== "manual" ? <span className="text-subtle">· {a.note}</span> : null}
            {inactive ? <Badge tone="outline">{a.status === "skipped" ? "Skipped" : "Postponed"}</Badge> : null}
            {a.status === "in_progress" ? <Badge tone="accent">In progress</Badge> : null}
          </div>
        </div>
      </div>
      <div className="hidden w-56 shrink-0 items-center gap-3 text-xs text-muted lg:flex">
        <div className="w-24">{stats.completedCount > 0 ? <OutcomeBadge o={stats.lastOutcome} /> : <span className="text-subtle">New to you</span>}</div>
        <div className="tabular w-28 leading-tight">
          <div>
            {stats.completedCount} session{stats.completedCount === 1 ? "" : "s"}
          </div>
          <div className="text-subtle">{stats.lastPracticedAt ? relativeTime(stats.lastPracticedAt) : "never practiced"}</div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!done && !inactive ? <PracticeButton problemId={p.id} assignmentId={a.id} resume={!!item.openSessionId} label={a.type === "new" ? "Start" : "Review"} /> : null}
        <a href={problemUrl(p.slug)} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "hidden sm:inline-flex")} aria-label={`Open ${p.title} on LeetCode`} title="Open on LeetCode">
          <ExternalLink />
        </a>
        <Link href={`/problems/${p.slug}`} className={buttonVariants({ variant: "ghost", size: "icon-sm" })} aria-label={`History for ${p.title}`} title="View history">
          <History />
        </Link>
        {!done && !inactive ? <AssignmentMenu assignmentId={a.id} today={today} canSkip={a.status === "pending"} /> : <span className="w-7" />}
      </div>
    </li>
  );
}
