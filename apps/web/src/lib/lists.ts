import "server-only";
import { builtInLists } from "@lcc/db";
import type { BuiltInList } from "@/components/import-list-form";

/** The lists that ship with the app, marked as imported when a list with the same slug exists. */
export function builtInListsFor(existing: { slug: string }[]): BuiltInList[] {
  const have = new Set(existing.map((l) => l.slug));
  return builtInLists().map((b) => ({ slug: b.list.slug, name: b.list.name, description: b.list.description ?? null, count: b.count, source: b.source, imported: have.has(b.list.slug) }));
}
