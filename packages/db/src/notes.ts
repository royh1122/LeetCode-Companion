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
 */
export function saveNotes(db: Db, problemId: number, patch: NotesPatch) {
  const clean: NotesPatch = {};
  for (const f of NOTE_FIELDS) if (typeof patch[f] === "string") clean[f] = patch[f]!.slice(0, 50_000);
  db.transaction((tx) => {
    const existing = getNotes(tx, problemId);
    if (existing && !isNotesEmpty(existing)) {
      const changed = NOTE_FIELDS.some((f) => clean[f] !== undefined && clean[f] !== existing[f]);
      if (!changed) return;
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
  });
}

export function listNoteRevisions(db: Db, problemId: number) {
  return db.select().from(problemNoteRevisions).where(eq(problemNoteRevisions.problemId, problemId)).orderBy(desc(problemNoteRevisions.createdAt)).all();
}
