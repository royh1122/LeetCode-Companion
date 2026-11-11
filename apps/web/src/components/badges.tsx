import { CheckCircle2, CircleDashed, CircleDot, Hourglass, RotateCcw, Sparkles, TriangleAlert, XCircle } from "lucide-react";
import { MASTERY_LABELS, OUTCOME_LABELS, type Mastery, type Outcome } from "@lcc/shared";
import { cn } from "@/lib/utils";
import { Badge } from "./ui";

export function DifficultyBadge({ d, className }: { d: string; className?: string }) {
  const color = d === "Easy" ? "text-easy" : d === "Medium" ? "text-medium" : d === "Hard" ? "text-hard" : "text-subtle";
  return <span className={cn("text-xs font-medium", color, className)}>{d === "Unknown" ? "—" : d}</span>;
}

const MASTERY_STYLE: Record<Mastery, { tone: "neutral" | "accent" | "good" | "warn" | "bad"; icon: React.ReactNode }> = {
  not_started: { tone: "neutral", icon: <CircleDashed className="size-3" /> },
  learning: { tone: "accent", icon: <CircleDot className="size-3" /> },
  needs_review: { tone: "warn", icon: <TriangleAlert className="size-3" /> },
  improving: { tone: "accent", icon: <RotateCcw className="size-3" /> },
  mastered: { tone: "good", icon: <CheckCircle2 className="size-3" /> },
};

export function MasteryBadge({ m, title }: { m: Mastery; title?: string }) {
  const s = MASTERY_STYLE[m];
  return (
    <Badge tone={s.tone} title={title}>
      {s.icon}
      {MASTERY_LABELS[m]}
    </Badge>
  );
}

export function OutcomeBadge({ o }: { o: Outcome | null | undefined }) {
  if (!o) return <span className="text-xs text-subtle">—</span>;
  const tone = o === "easy" || o === "independent" ? "good" : o === "struggled" ? "warn" : "bad";
  return <Badge tone={tone}>{OUTCOME_LABELS[o].label}</Badge>;
}

export function VerdictBadge({ v }: { v: string | null | undefined }) {
  if (!v) return <span className="text-xs text-subtle">—</span>;
  if (v === "Accepted")
    return (
      <Badge tone="good">
        <CheckCircle2 className="size-3" />
        Accepted
      </Badge>
    );
  if (v === "Pending")
    return (
      <Badge tone="neutral">
        <Hourglass className="size-3" />
        Judging…
      </Badge>
    );
  if (v === "Unknown") return <Badge tone="neutral">Unknown</Badge>;
  const short: Record<string, string> = {
    "Wrong Answer": "WA",
    "Time Limit Exceeded": "TLE",
    "Memory Limit Exceeded": "MLE",
    "Output Limit Exceeded": "OLE",
    "Runtime Error": "RE",
    "Compile Error": "CE",
  };
  return (
    <Badge tone="bad" title={v}>
      <XCircle className="size-3" />
      {short[v] ?? v}
    </Badge>
  );
}

export const ASSIGNMENT_TYPE_LABEL: Record<string, string> = {
  new: "New",
  weekend_review: "Mandatory review",
  srs_review: "Spaced review",
  manual: "Added",
};

export const SESSION_TYPE_LABEL: Record<string, string> = {
  first_attempt: "First attempt",
  repeat_new: "Practice as new",
  weekend_review: "Weekend review",
  srs_review: "Spaced review",
  free_practice: "Extra practice",
};

export function SessionTypeBadge({ t }: { t: string }) {
  const tone = t === "first_attempt" || t === "repeat_new" ? "accent" : "outline";
  return (
    <Badge tone={tone}>
      {t === "first_attempt" ? <Sparkles className="size-3" /> : null}
      {SESSION_TYPE_LABEL[t] ?? t}
    </Badge>
  );
}
