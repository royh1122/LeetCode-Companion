import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

/** Works for both the root database and a transaction handle. */
export type Db = BaseSQLiteDatabase<"sync", Database.RunResult, typeof schema>;
/** The root handle, with access to the raw better-sqlite3 connection. */
export type RootDb = Db & { $client: Database.Database };

/** Walk up from cwd to the monorepo root (package.json with "workspaces"). */
export function findRepoRoot(start = process.cwd()): string {
  let dir = path.resolve(/* turbopackIgnore: true */ start);
  for (;;) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const json = JSON.parse(fs.readFileSync(pkg, "utf8"));
        if (json.workspaces) return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(/* turbopackIgnore: true */ start);
    dir = parent;
  }
}

export function dataDir(): string {
  const dir = process.env.LCC_DATA_DIR ? path.resolve(process.env.LCC_DATA_DIR) : path.join(findRepoRoot(), "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * LCC_DB_PATH picks the file only when LCC_DATA_DIR is not set: a data directory (the demo,
 * the e2e runner's temp folder) always wins, so a leftover LCC_DB_PATH can't point an
 * isolated run at the real database.
 */
export function defaultDbPath(): string {
  if (process.env.LCC_DB_PATH && !process.env.LCC_DATA_DIR) return path.resolve(process.env.LCC_DB_PATH);
  return path.join(dataDir(), "leetcode-companion.db");
}

export function migrationsFolder(): string {
  return path.join(findRepoRoot(), "packages", "db", "drizzle");
}

function pendingMigrationCount(sqlite: Database.Database, folder: string): number {
  const journalPath = path.join(folder, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) return 0;
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: unknown[] };
  const hasTable = sqlite.prepare("select name from sqlite_master where type='table' and name='__drizzle_migrations'").get();
  const applied = hasTable ? (sqlite.prepare("select count(*) as c from __drizzle_migrations").get() as { c: number }).c : 0;
  return journal.entries.length - applied;
}

/** Next to the database file, so backups follow LCC_DB_PATH too. */
export function backupDir(): string {
  const dir = path.join(path.dirname(defaultDbPath()), "backups");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Why `file` can't be restored (not SQLite, damaged, or not this app's database), or null if it's fine. */
export function checkDatabaseFile(file: string): string | null {
  let check: Database.Database | undefined;
  try {
    check = new Database(file, { readonly: true, fileMustExist: true });
    const integrity = check.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") return `The file is damaged (integrity check: ${String(integrity)}).`;
    const ok = check.prepare("select name from sqlite_master where type='table' and name='sessions'").get();
    return ok ? null : "That file does not look like a LeetCode Companion database.";
  } catch (e) {
    return `That file can't be opened as a database (${e instanceof Error ? e.message : String(e)}).`;
  } finally {
    check?.close();
  }
}

/** A new backup file name; a second backup in the same second gets a numbered suffix. */
function newBackupPath(label: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const dir = backupDir();
  let file = path.join(dir, `lcc-${stamp}-${label}.db`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `lcc-${stamp}-${label}-${n}.db`);
  return file;
}

export async function backupDatabase(sqlite: Database.Database, label = "manual"): Promise<string> {
  const file = newBackupPath(label);
  await sqlite.backup(file);
  return file;
}

/** Synchronous backup (used before migrations). VACUUM INTO produces a consistent copy. */
export function backupDatabaseSync(sqlite: Database.Database, label: string): string {
  const file = newBackupPath(label);
  sqlite.prepare("VACUUM INTO ?").run(file);
  return file;
}

export interface OpenOptions {
  /** Run pending migrations (default true). A backup is taken first when data exists. */
  migrate?: boolean;
  /** Skip pre-migration backup (tests). */
  skipBackup?: boolean;
}

export function openDb(file: string = defaultDbPath(), opts: OpenOptions = {}): RootDb {
  const isMemory = file === ":memory:";
  if (!isMemory) fs.mkdirSync(path.dirname(file), { recursive: true });
  const existed = !isMemory && fs.existsSync(file) && fs.statSync(file).size > 0;
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  const db = drizzle(sqlite, { schema }) as unknown as RootDb;
  if (opts.migrate !== false) {
    const folder = migrationsFolder();
    const pending = pendingMigrationCount(sqlite, folder);
    if (pending > 0) {
      if (existed && !opts.skipBackup) backupDatabaseSync(sqlite, "pre-migration");
      migrate(db as never, { migrationsFolder: folder });
    }
  }
  return db;
}

const globalKey = Symbol.for("lcc.db");
type GlobalWithDb = typeof globalThis & { [globalKey]?: RootDb };

/** Process-wide singleton (survives Next.js hot reloads). */
export function getDb(): RootDb {
  const g = globalThis as GlobalWithDb;
  if (!g[globalKey]) g[globalKey] = openDb();
  return g[globalKey]!;
}

export { schema };
