import { Search } from "lucide-react";
import Link from "next/link";
import { allPatternsAndTopics, getAppSettings, listStudyLists, searchLibrary, todayFor, type LibraryFilters } from "@lcc/db";
import { MASTERY_LABELS, MASTERY_STATES } from "@lcc/shared";
import { DifficultyBadge, MasteryBadge, OutcomeBadge } from "@/components/badges";
import { ImportListForm } from "@/components/import-list-form";
import { PracticeButton } from "@/components/practice";
import { Card, EmptyState, Input, PageHeader, Select, buttonVariants } from "@/components/ui";
import { builtInListsFor } from "@/lib/lists";
import { db } from "@/lib/server";
import { relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Question library" };

export default async function LibraryPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const d = db();
  const filters: LibraryFilters = {
    q: sp.q,
    difficulty: sp.difficulty || undefined,
    topic: sp.topic || undefined,
    list: sp.list || undefined,
    mastery: sp.mastery || undefined,
    due: (sp.due as LibraryFilters["due"]) || undefined,
    practiced: (sp.practiced as LibraryFilters["practiced"]) || undefined,
    sort: (sp.sort as LibraryFilters["sort"]) || undefined,
  };
  const settings = getAppSettings(d);
  const rows = searchLibrary(d, settings, filters);
  const lists = listStudyLists(d);
  const { patterns, topics } = allPatternsAndTopics(d);
  const today = todayFor(d);
  const active = Object.values(filters).some(Boolean);

  return (
    <div className="space-y-5">
      <PageHeader title="Question library" description={`${rows.length} question${rows.length === 1 ? "" : "s"}${active ? " match" : ""}. One record per problem, however many lists contain it.`} />
      <details className="rounded-lg border border-border bg-surface px-4 py-3 text-sm" open={!lists.length}>
        <summary className="cursor-pointer font-medium">Import a question list</summary>
        <div className="mt-3 max-w-2xl">
          <ImportListForm builtIns={builtInListsFor(lists)} />
        </div>
      </details>
      <form className="flex flex-wrap items-end gap-2" role="search">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-subtle" />
          <Input name="q" defaultValue={sp.q} placeholder="Title, slug or #number" className="pl-8" aria-label="Search" />
        </div>
        <Select name="difficulty" defaultValue={sp.difficulty ?? ""} aria-label="Difficulty" className="w-auto">
          <option value="">Any difficulty</option>
          <option>Easy</option>
          <option>Medium</option>
          <option>Hard</option>
        </Select>
        <Select name="list" defaultValue={sp.list ?? ""} aria-label="Study list" className="w-auto">
          <option value="">Any list</option>
          {lists.map((l) => (
            <option key={l.slug} value={l.slug}>
              {l.name}
            </option>
          ))}
        </Select>
        <Select name="topic" defaultValue={sp.topic ?? ""} aria-label="Topic or pattern" className="w-auto max-w-48">
          <option value="">Any topic</option>
          <optgroup label="Patterns">
            {patterns.map((p) => (
              <option key={`p-${p}`} value={p}>
                {p}
              </option>
            ))}
          </optgroup>
          <optgroup label="LeetCode tags">
            {topics.map((t) => (
              <option key={`t-${t}`} value={t}>
                {t}
              </option>
            ))}
          </optgroup>
        </Select>
        <Select name="mastery" defaultValue={sp.mastery ?? ""} aria-label="Mastery" className="w-auto">
          <option value="">Any mastery</option>
          {MASTERY_STATES.map((m) => (
            <option key={m} value={m}>
              {MASTERY_LABELS[m]}
            </option>
          ))}
        </Select>
        <Select name="due" defaultValue={sp.due ?? ""} aria-label="Review due" className="w-auto">
          <option value="">Any review date</option>
          <option value="overdue">Overdue</option>
          <option value="today">Due by today</option>
          <option value="week">Due within a week</option>
          <option value="none">No review scheduled</option>
        </Select>
        <Select name="practiced" defaultValue={sp.practiced ?? ""} aria-label="Practiced" className="w-auto">
          <option value="">Practiced or not</option>
          <option value="yes">Practiced</option>
          <option value="no">Not practiced</option>
        </Select>
        <Select name="sort" defaultValue={sp.sort ?? "list"} aria-label="Sort" className="w-auto">
          <option value="list">List order</option>
          <option value="id">LeetCode #</option>
          <option value="last">Last practiced</option>
          <option value="due">Review due</option>
          <option value="title">Title</option>
        </Select>
        <button className={buttonVariants({ variant: "primary" })}>Apply</button>
        {active ? (
          <Link href="/library" className={buttonVariants({ variant: "ghost" })}>
            Clear
          </Link>
        ) : null}
      </form>

      <Card className="overflow-x-auto">
        {rows.length ? (
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="px-4 py-2 font-medium">#</th>
                <th className="px-2 py-2 font-medium">Title</th>
                <th className="px-2 py-2 font-medium">Difficulty</th>
                {settings.showPatterns ? <th className="px-2 py-2 font-medium">Pattern</th> : null}
                <th className="px-2 py-2 font-medium">Mastery</th>
                <th className="px-2 py-2 font-medium">Last result</th>
                <th className="px-2 py-2 text-right font-medium">Sessions</th>
                <th className="px-2 py-2 font-medium">Last practiced</th>
                <th className="px-2 py-2 font-medium">Next review</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.slice(0, 400).map(({ problem: p, stats: s }) => (
                <tr key={p.id} className="hover:bg-surface-2">
                  <td className="tabular px-4 py-2 font-mono text-xs text-subtle">{p.frontendId}</td>
                  <td className="max-w-72 px-2 py-2">
                    <Link href={`/problems/${p.slug}`} className="block truncate font-medium hover:underline">
                      {p.title}
                    </Link>
                    <div className="truncate text-[11px] text-subtle">{s.lists.map((l) => l.name).join(" · ")}</div>
                  </td>
                  <td className="px-2 py-2">
                    <DifficultyBadge d={p.difficulty} />
                  </td>
                  {settings.showPatterns ? <td className="max-w-40 truncate px-2 py-2 text-xs text-muted">{p.patterns[0]}</td> : null}
                  <td className="px-2 py-2">
                    <MasteryBadge m={s.mastery} title={s.masteryReason} />
                  </td>
                  <td className="px-2 py-2">
                    <OutcomeBadge o={s.lastOutcome} />
                  </td>
                  <td className="tabular px-2 py-2 text-right">{s.completedCount}</td>
                  <td className="px-2 py-2 text-xs text-muted">{s.lastPracticedAt ? relativeTime(s.lastPracticedAt) : "—"}</td>
                  <td className={`tabular px-2 py-2 text-xs ${s.nextDueDate && s.nextDueDate < today ? "text-warn" : "text-muted"}`}>{s.nextDueDate ?? "—"}</td>
                  <td className="px-4 py-2 text-right">
                    <PracticeButton problemId={p.id} label="Practice" variant="secondary" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState title="No questions match these filters" />
        )}
      </Card>
    </div>
  );
}
