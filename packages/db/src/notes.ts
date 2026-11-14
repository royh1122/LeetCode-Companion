import { desc, eq } from "drizzle-orm";
import type { Db } from "./client";
import { problemNoteRevisions, problemNotes, type ProblemNotes } from "./schema";

export const NOTE_FIELDS = ["insight", "recognition", "timeComplexity", "spaceComplexity", "edgeCases", "pitfalls", "related", "body"] as const;
export type NoteField = (typeof NOTE_FIELDS)[number];
export type NotesPatch = Partial<Record<NoteField, string>>;

const REVISION_INTERVAL_MS = 10 * 60_000;

export function getNotes(db: Db, problemId: number): ProblemNotes | null {
  return db.select().from(problemNotes).where(eq(problemNotes.problemId, problemId)).get() ?? null;
}

export function isNotesEmpty(n: ProblemNotes | null): boolean {
  return !n || NOTE_FIELDS.every((f) => !n[f]?.trim());
}

/**
 * Autosave-friendly: patches only the given fields. Before overwriting, the
 * previous version is kept as a revision (at most one per 10 minutes, so
 * autosave doesn't flood history).
 *
 * `base` is what the editor last saw stored for each field. If a field's stored text has changed
 * since (another tab saved it), nothing is written and the stored text of those fields is
 * returned, so the editor can ask instead of overwriting. Returns null when saved.
 */
export function saveNotes(db: Db, problemId: number, patch: NotesPatch, base?: NotesPatch): NotesPatch | null {
  const clean: NotesPatch = {};
  for (const f of NOTE_FIELDS) if (typeof patch[f] === "string") clean[f] = patch[f]!.slice(0, 50_000);
  return db.transaction((tx) => {
    const existing = getNotes(tx, problemId);
    if (base) {
      const conflicts: NotesPatch = {};
      for (const f of NOTE_FIELDS) {
        if (clean[f] === undefined || typeof base[f] !== "string") continue;
        const stored = existing?.[f] ?? "";
        if (stored !== base[f] && stored !== clean[f]) conflicts[f] = stored;
      }
      if (Object.keys(conflicts).length) return conflicts;
    }
    if (existing && !isNotesEmpty(existing)) {
      const changed = NOTE_FIELDS.some((f) => clean[f] !== undefined && clean[f] !== existing[f]);
      if (!changed) return null;
      const last = tx
        .select({ createdAt: problemNoteRevisions.createdAt })
        .from(problemNoteRevisions)
        .where(eq(problemNoteRevisions.problemId, problemId))
        .orderBy(desc(problemNoteRevisions.createdAt))
        .get();
      if (!last || Date.now() - last.createdAt > REVISION_INTERVAL_MS) {
        const snapshot = Object.fromEntries(NOTE_FIELDS.map((f) => [f, existing[f]]));
        tx.insert(problemNoteRevisions).values({ problemId, snapshot }).run();
      }
    }
    tx.insert(problemNotes)
      .values({ problemId, ...clean })
      .onConflictDoUpdate({ target: problemNotes.problemId, set: { ...clean, updatedAt: Date.now() } })
      .run();
    return null;
  });
}

export function listNoteRevisions(db: Db, problemId: number) {
  return db.select().from(problemNoteRevisions).where(eq(problemNoteRevisions.problemId, problemId)).orderBy(desc(problemNoteRevisions.createdAt)).all();
}
