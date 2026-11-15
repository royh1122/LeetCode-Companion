import fs from "node:fs";
import path from "node:path";
import { and, eq, lt, ne, sql } from "drizzle-orm";
import { backupDir } from "./client";
import type { Db } from "./client";
import { syncEvents } from "./schema";

export interface BackupInfo {
  name: string;
  file: string;
  bytes: number;
  /** Taken by the app (before a migration, delete, import or restore), not by the user. */
  automatic: boolean;
}

/** lcc-<yyyy-mm-dd_hh-mm-ss>-<label>[-n].db, as written by backupDatabase(). */
const BACKUP_NAME = /^lcc-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-(.+?)(?:-\d+)?\.db$/;

/** Backups in the backup folder: the app's own newest first, then other files. Files not named by the app count as manual (never pruned). */
export function listBackups(): BackupInfo[] {
  const dir = backupDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".db"));
  } catch {
    return [];
  }
  const ours = (n: string) => BACKUP_NAME.test(n);
  // The app's names start with a sortable timestamp.
  return names
    .sort((a, b) => Number(ours(b)) - Number(ours(a)) || (ours(a) ? b.localeCompare(a) : a.localeCompare(b)))
    .map((name) => {
      const file = path.join(dir, name);
      const label = BACKUP_NAME.exec(name)?.[1];
      let bytes = 0;
      try {
        bytes = fs.statSync(file).size;
      } catch {
        /* removed meanwhile */
      }
      return { name, file, bytes, automatic: !!label && label !== "manual" };
    });
}

/**
 * Delete automatic backups beyond the newest `keep`. Only on the user's explicit request (Settings):
 * backups made with "Back up now" or `npm run db:backup`, and files the app didn't name, are never touched.
 * Returns the names deleted.
 */
export function pruneAutomaticBackups(keep = 20): string[] {
  const old = listBackups()
    .filter((b) => b.automatic)
    .slice(Math.max(0, keep));
  const deleted: string[] = [];
  for (const b of old) {
    try {
      fs.rmSync(b.file);
      deleted.push(b.name);
    } catch {
      /* in use or already gone: leave it */
    }
  }
  return deleted;
}

/**
 * The sync log keeps every extension event's id forever (that is what makes a resent event a
 * no-op). Activity payloads (the most frequent event) only matter for debugging recent syncs:
 * older than `days`, they are emptied, since the session keeps the time. Other payloads stay; an
 * old notes payload can be the only copy of text that was later overwritten.
 * Returns how many rows were trimmed.
 */
export function pruneSyncEventPayloads(db: Db, days = 30, now = Date.now()): number {
  const r = db
    .update(syncEvents)
    .set({ payload: {} })
    .where(and(eq(syncEvents.type, "session.activity"), lt(syncEvents.receivedAt, now - days * 86_400_000), ne(sql`${syncEvents.payload}`, "{}")))
    .run();
  return r.changes;
}
