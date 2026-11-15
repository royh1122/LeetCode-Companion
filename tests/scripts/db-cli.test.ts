import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportAll, finishSession, getAppSettings, getProblemBySlug, importStudyLists, openDb, sampleLists, startSession, updateAppSettings, type RootDb } from "@lcc/db";

const ROOT = process.cwd();
const TIMEOUT = 60_000;
const PREFIX = path.join(os.tmpdir(), "lcc-script-test-");
const dirs: string[] = [];

/** The only place a child env is built: always an isolated data dir, never LCC_DB_PATH. */
function isolatedEnv(dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LCC_DATA_DIR: dataDir, LCC_PORT: "4391" };
  delete env.LCC_DB_PATH;
  return env;
}

function tempDir(): string {
  const d = fs.mkdtempSync(PREFIX);
  dirs.push(d);
  return d;
}

/** Runs `scripts/db.ts` against `dataDir`, which must be one of our temp dirs. */
function cli(dataDir: string, ...args: string[]) {
  expect(dirs).toContain(dataDir);
  const r = spawnSync("npx", ["tsx", "scripts/db.ts", ...args], { cwd: ROOT, env: isolatedEnv(dataDir), encoding: "utf8", shell: true });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** restore always checks port 4317 (the real dashboard's) and refuses while it answers; skip those tests then. */
const dashboardUp = await fetch("http://127.0.0.1:4317/", { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);

const dbFile = (dir: string) => path.join(dir, "leetcode-companion.db");

function addSession(db: RootDb, slug: string) {
  const p = getProblemBySlug(db, slug);
  if (!p) throw new Error(`no problem ${slug}`);
  const { session } = startSession(db, { problemId: p.id, origin: "dashboard" });
  finishSession(db, session.id, { outcome: "independent", hintsUsed: false });
}

/** Seeds a DB through @lcc/db with one finished session and a non-default time zone. */
function seed(dir: string): RootDb {
  const db = openDb(dbFile(dir));
  importStudyLists(db, sampleLists());
  updateAppSettings(db, { timeZone: "Asia/Tokyo" });
  addSession(db, "sample-problem-1");
  return db;
}

const sessionCount = (db: RootDb) => exportAll(db).sessions.length;
const backups = (dir: string) => (fs.existsSync(path.join(dir, "backups")) ? fs.readdirSync(path.join(dir, "backups")).filter((f) => f.endsWith(".db")) : []);

beforeAll(() => {
  // Even if the parent shell had LCC_DB_PATH set, children never see it.
  process.env.LCC_DB_PATH = path.join(os.tmpdir(), "should-never-be-used.db");
  expect(isolatedEnv("x").LCC_DB_PATH).toBeUndefined();
});

afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("scripts/db.ts", () => {
  it("backup writes a .db file next to the database", () => {
    const dir = tempDir();
    seed(dir).$client.close();
    const r = cli(dir, "backup");
    expect(r.code, r.out).toBe(0);
    const files = backups(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^lcc-.*-manual\.db$/);
    expect(fs.statSync(path.join(dir, "backups", files[0]!)).size).toBeGreaterThan(0);
  }, TIMEOUT);

  it.skipIf(dashboardUp)("restore brings back data changed after the backup", () => {
    const dir = tempDir();
    const db = seed(dir);
    expect(cli(dir, "backup").code).toBe(0);
    const backup = path.join(dir, "backups", backups(dir)[0]!);

    addSession(db, "sample-problem-2");
    updateAppSettings(db, { timeZone: "Europe/Paris" });
    expect(sessionCount(db)).toBe(2);
    db.$client.close();

    const r = cli(dir, "restore", backup);
    expect(r.code, r.out).toBe(0);
    expect(backups(dir).some((f) => f.endsWith("-before-restore.db"))).toBe(true);

    const after = openDb(dbFile(dir));
    expect(sessionCount(after)).toBe(1);
    expect(getAppSettings(after).timeZone).toBe("Asia/Tokyo");
    after.$client.close();
  }, TIMEOUT);

  it("restore refuses a file that is not a database, and leaves the data alone", () => {
    const dir = tempDir();
    seed(dir).$client.close();
    const bogus = path.join(dir, "not-a-db.db");
    fs.writeFileSync(bogus, "this is definitely not sqlite, just some text".repeat(50));
    const r = cli(dir, "restore", bogus);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/can't be opened|does not look like|damaged/);
    const db = openDb(dbFile(dir));
    expect(sessionCount(db)).toBe(1);
    db.$client.close();
  }, TIMEOUT);

  it("restore refuses the live database itself", () => {
    const dir = tempDir();
    seed(dir).$client.close();
    const r = cli(dir, "restore", dbFile(dir));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/live database/);
  }, TIMEOUT);

  it("export then import into a fresh database reproduces sessions and settings", () => {
    const src = tempDir();
    const db = seed(src);
    const original = exportAll(db);
    db.$client.close();
    const file = path.join(src, "out.json");
    const e = cli(src, "export", file);
    expect(e.code, e.out).toBe(0);

    const dst = tempDir();
    const i = cli(dst, "import", file);
    expect(i.code, i.out).toBe(0);

    const fresh = openDb(dbFile(dst));
    const copy = exportAll(fresh);
    fresh.$client.close();
    expect(copy.sessions).toHaveLength(1);
    expect(copy.sessions).toEqual(original.sessions);
    expect(copy.settings).toEqual(original.settings);
    expect(copy.settings.timeZone).toBe("Asia/Tokyo");
  }, TIMEOUT);
});
