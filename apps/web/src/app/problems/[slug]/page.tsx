import { ArrowLeft, ExternalLink } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { allPatternsAndTopics, getAppSettings, getProblemDetail, problemPerformanceSeries } from "@lcc/db";
import { formatDuration, problemUrl } from "@lcc/shared";
import { ProblemNoteField } from "@/components/autosave";
import { ASSIGNMENT_TYPE_LABEL, DifficultyBadge, MasteryBadge, OutcomeBadge, SessionTypeBadge, VerdictBadge } from "@/components/badges";
import { ProblemCharts } from "@/components/charts";
import { CodeDiff, type CodeVersion } from "@/components/code";
import { SpoilerReveal } from "@/components/patterns-toggle";
import { PracticeButton } from "@/components/practice";
import { DeleteSessionButton, EditSessionForm, LogPastAttempt, PatternsEditor, ScheduleButtons } from "@/components/problem-actions";
import { LinkSubmission, SubmissionList } from "@/components/session";
import { Badge, Card, CardHeader, EmptyState, buttonVariants } from "@/components/ui";
import { db } from "@/lib/server";
import { formatDateTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return { title: slug.replace(/-/g, " ") };
}

const NOTE_FIELDS: { field: string; label: string; placeholder: string; rows?: number }[] = [
  { field: "insight", label: "Core algorithmic insight", placeholder: "The one idea that cracks it", rows: 3 },
  { field: "recognition", label: "Pattern recognition", placeholder: "What in the prompt signals this approach?", rows: 2 },
  { field: "timeComplexity", label: "Time complexity", placeholder: "O(n)", rows: 1 },
  { field: "spaceComplexity", label: "Space complexity", placeholder: "O(1)", rows: 1 },
  { field: "edgeCases", label: "Edge cases", placeholder: "Empty input, duplicates, overflow…", rows: 2 },
  { field: "pitfalls", label: "Common pitfalls", placeholder: "Off-by-one on the right pointer…", rows: 2 },
  { field: "related", label: "Related problems", placeholder: "3Sum Closest, 4Sum", rows: 1 },
  { field: "body", label: "Free-form notes", placeholder: "Anything else", rows: 4 },
];

export default async function ProblemPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const d = db();
  const detail = getProblemDetail(d, slug);
  if (!detail) notFound();
  const { problem: p, stats, reviewState: rs, notes, sessions, today } = detail;
  const { timeZone: tz, showPatterns } = getAppSettings(d);
  const completed = sessions.filter((s) => s.status === "completed");
  const series = problemPerformanceSeries(sessions);
  const open = sessions.find((s) => ["in_progress", "paused", "not_started"].includes(s.status));
  const { patterns: allPatterns } = allPatternsAndTopics(d);
  const versions: CodeVersion[] = [];
  sessions.forEach((s, i) =>
    s.submissions
      .filter((x) => x.code)
      .forEach((x) => versions.push({ id: x.id, code: x.code!, lang: x.language, label: `Session ${i + 1} · ${s.endedDate ?? formatDateTime(s.startedAt, tz)} · ${x.kind === "run" ? "Run" : x.verdict}` })),
  );
  for (const u of detail.unattributed.filter((x) => x.code)) versions.push({ id: u.id, code: u.code!, lang: u.language, label: `Unlinked · ${formatDateTime(u.submittedAt, tz)} · ${u.verdict}` });
  const firstAcceptedVersion = versions.find((v) => v.label.includes("Accepted"));
  const lastVersion = versions[versions.length - 1];

  return (
    <div className="space-y-6">
      <Link href="/library" className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> Library
      </Link>

      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              <span className="mr-2 font-mono text-base text-subtle">{p.frontendId ? `#${p.frontendId}` : ""}</span>
              {p.title}
            </h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <DifficultyBadge d={p.difficulty} />
              <MasteryBadge m={stats.mastery} title={stats.masteryReason} />
              <span className="text-xs text-subtle">{stats.masteryReason}</span>
              {stats.lists.map((l) => (
                <Badge key={l.slug} tone="outline" title={l.group ?? undefined}>
                  {l.name} #{l.position + 1}
                </Badge>
              ))}
              {p.paidOnly ? <Badge tone="warn">Premium</Badge> : null}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a href={problemUrl(p.slug)} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary" })}>
              <ExternalLink /> LeetCode
            </a>
            <PracticeButton problemId={p.id} label={completed.length ? "Practice again" : "Start"} resume={!!open} size="md" />
          </div>
        </div>
        <SpoilerReveal shown={showPatterns} label="Show patterns & tags">
          <PatternsEditor problemId={p.id} patterns={p.patterns} suggestions={allPatterns} />
          <div className="flex flex-wrap gap-1">
            {p.topics.map((t) => (
              <span key={t.slug} className="text-[11px] text-subtle">
                {t.name}
              </span>
            )).reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, <span key={`d${i}`} className="text-[11px] text-subtle">·</span>, el] : [el]), [])}
          </div>
        </SpoilerReveal>
      </header>

      <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-5">
        {[
          ["Sessions", String(completed.length)],
          ["First attempted", completed[0]?.endedDate ?? "—"],
          ["Last practiced", completed[completed.length - 1]?.endedDate ?? "—"],
          ["Next review", rs?.nextDueDate ? `${rs.nextDueDate}${rs.nextDueDate < today ? " (overdue)" : ""}` : "—"],
          ["Interval / streak", rs ? `${rs.intervalDays}d · ${rs.successStreak} indep.` : "—"],
        ].map(([k, v]) => (
          <div key={k} className="bg-surface px-4 py-3">
            <div className="text-xs text-muted">{k}</div>
            <div className="tabular mt-0.5 text-sm font-medium">{v}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <ScheduleButtons problemId={p.id} today={today} hasHistory={completed.length > 0} />
        <LogPastAttempt problemId={p.id} today={today} />
      </div>
      {detail.openAssignments.length ? (
        <p className="text-xs text-muted">
          Scheduled: {detail.openAssignments.map((a) => `${ASSIGNMENT_TYPE_LABEL[a.type]} on ${a.scheduledDate}`).join(", ")}
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader title="Session history" description="Every attempt is kept separately — notes, submissions and code included." />
            {sessions.length ? (
              <ol className="divide-y divide-border">
                {[...sessions].reverse().map((s, ri) => {
                  const n = sessions.length - ri;
                  return (
                    <li key={s.id}>
                      <details className="group" open={ri === 0}>
                        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
                          <span className="tabular w-6 text-xs text-subtle">#{n}</span>
                          <span className="tabular w-24 text-sm">{s.endedDate ?? formatDateTime(s.startedAt, tz)}</span>
                          <SessionTypeBadge t={s.type} />
                          <OutcomeBadge o={s.outcome} />
                          {s.status !== "completed" ? <Badge tone="outline">{s.status.replace("_", " ")}</Badge> : null}
                          <span className="tabular text-xs text-muted" title={s.durationSource}>
                            {formatDuration(s.durationMs, { approx: s.durationApprox })}
                          </span>
                          <span className="tabular text-xs text-muted">
                            {s.submitCount} sub{s.submitCount === 1 ? "" : "s"}
                          </span>
                          {s.finalVerdict ? <VerdictBadge v={s.finalVerdict} /> : null}
                          {s.hintsUsed ? <Badge tone="warn">Hints</Badge> : null}
                          {s.origin === "manual_log" ? <Badge tone="outline">Logged manually</Badge> : null}
                          <span className="ml-auto text-xs text-subtle">{s.nextReviewDate ? `next → ${s.nextReviewDate}${s.nextReviewOverridden ? " (you chose)" : ""}` : ""}</span>
                        </summary>
                        <div className="space-y-3 px-4 pb-4 pl-13 text-sm">
                          {s.notes ? <p className="whitespace-pre-wrap">{s.notes}</p> : null}
                          {s.timeComplexity || s.spaceComplexity ? (
                            <p className="text-xs">
                              <span className="text-muted">Complexity: </span>
                              <span className="font-mono">
                                {[s.timeComplexity && `time ${s.timeComplexity}`, s.spaceComplexity && `space ${s.spaceComplexity}`].filter(Boolean).join(" · ")}
                              </span>
                            </p>
                          ) : null}
                          {s.struggles || s.mistakes || s.takeaway ? (
                            <dl className="grid gap-2 text-xs sm:grid-cols-3">
                              {s.struggles ? (
                                <div>
                                  <dt className="text-muted">Struggled with</dt>
                                  <dd className="whitespace-pre-wrap">{s.struggles}</dd>
                                </div>
                              ) : null}
                              {s.mistakes ? (
                                <div>
                                  <dt className="text-muted">Mistakes</dt>
                                  <dd className="whitespace-pre-wrap">{s.mistakes}</dd>
                                </div>
                              ) : null}
                              {s.takeaway ? (
                                <div>
                                  <dt className="text-muted">Takeaway</dt>
                                  <dd className="whitespace-pre-wrap">{s.takeaway}</dd>
                                </div>
                              ) : null}
                            </dl>
                          ) : null}
                          <div className="flex flex-wrap gap-3 text-xs text-muted">
                            <span>Started {formatDateTime(s.startedAt, tz)}</span>
                            {s.firstAcceptedAt ? <span>First Accepted after {formatDuration(s.firstAcceptedAt - s.startedAt - s.pausedMs)}</span> : null}
                            {s.revealedNotes || s.revealedCode || s.revealedHints ? (
                              <span>Revealed: {[s.revealedHints && "hints", s.revealedNotes && "notes", s.revealedCode && "code"].filter(Boolean).join(", ")}</span>
                            ) : null}
                            {s.difficultyRating ? <span>Felt {s.difficultyRating}/5</span> : null}
                          </div>
                          <SubmissionList subs={s.submissions} />
                          <div className="flex flex-wrap items-center gap-2">
                            {["in_progress", "paused"].includes(s.status) ? (
                              <Link href={`/sessions/${s.id}`} className={buttonVariants({ size: "sm", variant: "primary" })}>
                                Open session
                              </Link>
                            ) : (
                              <>
                                <EditSessionForm
                                  id={s.id}
                                  notes={s.notes ?? ""}
                                  mistakes={s.mistakes ?? ""}
                                  takeaway={s.takeaway ?? ""}
                                  timeComplexity={s.timeComplexity ?? ""}
                                  spaceComplexity={s.spaceComplexity ?? ""}
                                  durationMin={s.durationOverrideMs != null ? Math.round(s.durationOverrideMs / 60_000) : null}
                                  outcome={s.outcome}
                                  hintsUsed={s.hintsUsed}
                                  difficultyRating={s.difficultyRating}
                                />
                                <span className="ml-auto self-start">
                                  <DeleteSessionButton id={s.id} submissionCount={s.submissions.length} />
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </details>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <EmptyState title="No sessions yet">Start practice to create the first session, or log an attempt you did before.</EmptyState>
            )}
          </Card>

          {detail.unattributed.length ? (
            <Card>
              <CardHeader title="Unlinked submissions" description="Captured, but it wasn't clear which session they belong to. Link them manually." />
              <ul className="divide-y divide-border text-xs">
                {detail.unattributed.map((u) => (
                  <li key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-2">
                    <VerdictBadge v={u.verdict} />
                    <span className="text-muted">{formatDateTime(u.submittedAt, tz)}</span>
                    <span className="text-muted">{u.language}</span>
                    {sessions.length ? (
                      <LinkSubmission submissionId={u.id} options={[...sessions].reverse().map((s, i) => ({ id: s.id, label: `#${sessions.length - i} · ${s.endedDate ?? formatDateTime(s.startedAt, tz)}` }))} />
                    ) : (
                      <span className="text-subtle">No sessions to link to yet</span>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Compare code" description="Line diff between any two captured versions — e.g. your first Accepted vs. your latest." />
            <div className="p-4">
              <CodeDiff versions={versions} defaultA={firstAcceptedVersion?.id ?? versions[0]?.id} defaultB={lastVersion?.id} />
            </div>
          </Card>

          <Card>
            <CardHeader title="Performance over sessions" />
            <div className="p-4">
              <ProblemCharts data={series} />
            </div>
          </Card>
        </div>

        <aside>
          <Card className="lg:sticky lg:top-6">
            <CardHeader title="Permanent notes" description="Concept-level notes for this problem. Autosaved; earlier versions are kept." />
            <div className="space-y-3 p-4">
              {NOTE_FIELDS.map((f) => (
                <ProblemNoteField key={f.field} problemId={p.id} field={f.field} label={f.label} placeholder={f.placeholder} rows={f.rows} initial={(notes as unknown as Record<string, string> | null)?.[f.field] ?? ""} />
              ))}
              {detail.noteRevisions.length ? <p className="text-[11px] text-subtle">{detail.noteRevisions.length} earlier version(s) saved (included in JSON export).</p> : null}
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}
