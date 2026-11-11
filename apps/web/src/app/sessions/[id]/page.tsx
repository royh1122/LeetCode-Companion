import { ArrowLeft, ExternalLink } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAppSettings, getSessionDetail, isReviewSessionType, recommendNextReview } from "@lcc/db";
import { OUTCOMES, formatDuration, problemUrl, toLocalDate, type Outcome, type SessionType } from "@lcc/shared";
import { ProblemNoteField, SessionNoteField } from "@/components/autosave";
import { DifficultyBadge, OutcomeBadge, SessionTypeBadge } from "@/components/badges";
import { CodeBlock } from "@/components/code";
import { DeleteSessionButton, EditSessionForm } from "@/components/problem-actions";
import { LinkSubmission, ManualSubmissionForm, ReflectionForm, Reveal, SessionControls, SessionTimer, SubmissionList } from "@/components/session";
import { Badge, Card, CardHeader, buttonVariants } from "@/components/ui";
import { db } from "@/lib/server";
import { formatDateTime, relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Practice session" };

const NOTE_LABELS: [string, string][] = [
  ["insight", "Core insight"],
  ["recognition", "How to recognize the pattern"],
  ["timeComplexity", "Time"],
  ["spaceComplexity", "Space"],
  ["edgeCases", "Edge cases"],
  ["pitfalls", "Pitfalls"],
];

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = db();
  const detail = getSessionDetail(d, id);
  if (!detail) notFound();
  const { session: s, problem: p, notes, previousSessions, previousCode } = detail;
  const settings = getAppSettings(d);
  const now = Date.now();
  const today = toLocalDate(now, settings.timeZone);
  const open = ["in_progress", "paused", "not_started"].includes(s.status);
  const review = isReviewSessionType(s.type as SessionType) && previousSessions.length > 0;
  const interrupted = open && now - (s.lastActivityAt ?? s.startedAt) > settings.staleSessionHours * 3_600_000;
  const recommendations = Object.fromEntries(OUTCOMES.map((o) => [o, recommendNextReview(d, p.id, o, today).date])) as Record<Outcome, string>;
  const timing = {
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    pausedMs: s.pausedMs,
    pausedAt: s.pausedAt,
    activeMs: s.activeMs,
    durationOverrideMs: s.durationOverrideMs,
    lastActivityAt: s.lastActivityAt,
    status: s.status,
  };
  const leetcodeHref = `${problemUrl(p.slug)}#lcc-session=${s.id}`;
  const hasPrevNotes = notes && Object.entries(notes).some(([k, v]) => typeof v === "string" && v.trim() && k !== "problemId");

  return (
    <div className="space-y-5">
      <Link href="/" className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> Today
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <SessionTypeBadge t={s.type} />
            {s.status === "completed" ? <Badge tone="good">Completed</Badge> : s.status === "abandoned" ? <Badge tone="outline">Abandoned</Badge> : s.status === "paused" ? <Badge tone="warn">Paused</Badge> : <Badge tone="accent">In progress</Badge>}
            {interrupted ? <Badge tone="warn">Interrupted · last activity {relativeTime(s.lastActivityAt ?? s.startedAt)}</Badge> : null}
          </div>
          <h1 className="mt-2 text-xl font-semibold tracking-tight">
            <span className="mr-2 font-mono text-base text-subtle">{p.frontendId ? `#${p.frontendId}` : ""}</span>
            {p.title}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
            <DifficultyBadge d={p.difficulty} />
            <span>Started {formatDateTime(s.startedAt, settings.timeZone)}</span>
            <span>·</span>
            <Link href={`/problems/${p.slug}`} className="hover:underline">
              Full history ({previousSessions.length} previous session{previousSessions.length === 1 ? "" : "s"})
            </Link>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a href={leetcodeHref} target="lcc-leetcode" className={buttonVariants({ variant: open ? "primary" : "secondary" })}>
            <ExternalLink /> Open on LeetCode
          </a>
        </div>
      </header>

      {open ? (
        <>
          <Card className="flex flex-wrap items-center justify-between gap-4 p-4">
            <SessionTimer t={timing} />
            <SessionControls id={s.id} status={s.status} />
          </Card>

          <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
            <div className="space-y-5">
              <Card>
                <CardHeader title="Session notes" description="Autosaved. Specific to this attempt — your permanent notes live on the question page." />
                <div className="p-4">
                  <SessionNoteField sessionId={s.id} field="notes" initial={s.notes ?? ""} rows={4} placeholder="What's your approach? What tripped you up?" />
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <SessionNoteField sessionId={s.id} field="timeComplexity" label="Time complexity" initial={s.timeComplexity ?? ""} rows={1} placeholder="O(n)" />
                    <SessionNoteField sessionId={s.id} field="spaceComplexity" label="Space complexity" initial={s.spaceComplexity ?? ""} rows={1} placeholder="O(1)" />
                  </div>
                </div>
              </Card>

              <Card>
                <CardHeader
                  title={`Submissions (${s.submitCount})`}
                  description="Captured automatically by the extension when it's installed and paired. Runs are listed but not counted."
                  actions={<ManualSubmissionForm sessionId={s.id} />}
                />
                <div className="space-y-3 p-4">
                  <SubmissionList subs={s.submissions} />
                  {detail.unattributedForProblem.length ? (
                    <div className="rounded-md border border-dashed border-border p-3 text-xs">
                      <p className="mb-2 text-muted">Unlinked submissions for this problem (the extension couldn&apos;t tell which session they belong to):</p>
                      <ul className="space-y-1.5">
                        {detail.unattributedForProblem.map((u) => (
                          <li key={u.id} className="flex flex-wrap items-center gap-2">
                            <span>{u.verdict}</span>
                            <span className="text-muted">{formatDateTime(u.submittedAt)}</span>
                            <LinkSubmission submissionId={u.id} options={[{ id: s.id, label: "This session" }]} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              </Card>

              <Card>
                <CardHeader title="Finish & reflect" description="Takes ~15 seconds. Keys 1–5 pick the outcome." />
                <div className="p-4">
                  <ReflectionForm
                    sessionId={s.id}
                    recommendations={recommendations}
                    today={today}
                    hintsRevealed={s.revealedHints || s.revealedNotes || s.revealedCode}
                    timing={timing}
                    interrupted={interrupted}
                    initialNotes={s.notes ?? ""}
                  />
                </div>
              </Card>
            </div>

            <aside className="space-y-5">
              {review ? (
                <Card>
                  <CardHeader title="Review mode" description="Previous work is hidden. Try first — reveals are recorded." />
                  <div className="space-y-2 p-4">
                    <Reveal sessionId={s.id} what="hints" label="High-level hints" already={s.revealedHints}>
                      <div className="space-y-2 text-sm">
                        <div>
                          <span className="text-xs text-muted">Pattern: </span>
                          {p.patterns.join(", ") || "—"}
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {p.topics.map((t) => (
                            <Badge key={t.slug} tone="outline">
                              {t.name}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    </Reveal>
                    <Reveal sessionId={s.id} what="notes" label="Previous notes" already={s.revealedNotes}>
                      <div className="space-y-3 text-sm">
                        {hasPrevNotes ? (
                          NOTE_LABELS.filter(([k]) => (notes as Record<string, unknown>)[k]).map(([k, l]) => (
                            <div key={k}>
                              <div className="text-xs text-muted">{l}</div>
                              <p className="whitespace-pre-wrap">{String((notes as unknown as Record<string, unknown>)[k])}</p>
                            </div>
                          ))
                        ) : (
                          <p className="text-xs text-muted">No permanent notes yet.</p>
                        )}
                        {previousSessions
                          .filter((x) => x.notes || x.mistakes)
                          .slice(0, 3)
                          .map((x) => (
                            <div key={x.id} className="border-t border-border pt-2 text-xs">
                              <div className="mb-1 flex items-center gap-2 text-muted">
                                {x.endedDate} <OutcomeBadge o={x.outcome} />
                              </div>
                              {x.notes ? <p className="whitespace-pre-wrap">{x.notes}</p> : null}
                              {x.mistakes ? <p className="mt-1 whitespace-pre-wrap text-muted">Mistakes: {x.mistakes}</p> : null}
                            </div>
                          ))}
                      </div>
                    </Reveal>
                    <Reveal sessionId={s.id} what="code" label="Previous code" already={s.revealedCode}>
                      {previousCode?.code ? (
                        <CodeBlock code={previousCode.code} lang={previousCode.language} maxHeight={360} header={`${previousCode.verdict} · ${formatDateTime(previousCode.submittedAt)}`} />
                      ) : (
                        <p className="text-xs text-muted">No previous code captured.</p>
                      )}
                    </Reveal>
                  </div>
                </Card>
              ) : null}
              <Card>
                <CardHeader title="Permanent notes" description="Concept-level, shared by every session of this problem. Optional." />
                <div className="space-y-3 p-4">
                  {review && !s.revealedNotes ? (
                    <p className="text-xs text-muted">Hidden during review — reveal previous notes to edit them here, or edit after finishing.</p>
                  ) : (
                    <>
                      <ProblemNoteField problemId={p.id} field="insight" label="Core insight" initial={notes?.insight ?? ""} rows={3} />
                      <ProblemNoteField problemId={p.id} field="pitfalls" label="Pitfalls / edge cases" initial={notes?.pitfalls ?? ""} rows={2} />
                    </>
                  )}
                </div>
              </Card>
            </aside>
          </div>
        </>
      ) : (
        <Card>
          <CardHeader title="Session summary" />
          <div className="grid gap-4 p-4 sm:grid-cols-4">
            <div>
              <div className="text-xs text-muted">Outcome</div>
              <div className="mt-1">
                <OutcomeBadge o={s.outcome} />
              </div>
            </div>
            <div>
              <div className="text-xs text-muted">Duration</div>
              <div className="tabular mt-1">{formatDuration(s.durationMs, { approx: s.durationApprox })}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Submissions</div>
              <div className="tabular mt-1">{s.submitCount}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Next review</div>
              <div className="tabular mt-1">{s.nextReviewDate ?? "—"}</div>
            </div>
          </div>
          <div className="space-y-3 border-t border-border p-4">
            {s.notes ? <p className="whitespace-pre-wrap text-sm">{s.notes}</p> : null}
            {s.timeComplexity || s.spaceComplexity ? (
              <p className="text-xs">
                <span className="text-muted">Complexity: </span>
                <span className="font-mono">{[s.timeComplexity && `time ${s.timeComplexity}`, s.spaceComplexity && `space ${s.spaceComplexity}`].filter(Boolean).join(" · ")}</span>
              </p>
            ) : null}
            <SubmissionList subs={s.submissions} />
            <div className="flex flex-wrap items-start gap-2">
              <Link href={`/problems/${p.slug}`} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                View full history
              </Link>
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
              <span className="ml-auto">
                <DeleteSessionButton id={s.id} submissionCount={s.submissions.length} redirectToProblem />
              </span>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
