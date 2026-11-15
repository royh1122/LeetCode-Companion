import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupDir, listBackups, processSyncEvents, pruneAutomaticBackups, pruneSyncEventPayloads, schema } from "../src";
import { at, freshDb } from "./helpers";

describe("backup listing and pruning (H5)", () => {
  let dir: string;
  const saved = { data: process.env.LCC_DATA_DIR, path: process.env.LCC_DB_PATH };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcc-backups-test-"));
    process.env.LCC_DATA_DIR = dir;
    delete process.env.LCC_DB_PATH;
  });
  afterEach(() => {
    if (saved.data === undefined) delete process.env.LCC_DATA_DIR;
    else process.env.LCC_DATA_DIR = saved.data;
    if (saved.path !== undefined) process.env.LCC_DB_PATH = saved.path;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const touch = (name: string) => fs.writeFileSync(path.join(backupDir(), name), "x");

  it("keeps the newest automatic backups and never touches manual or unknown files", () => {
    expect(backupDir().startsWith(dir)).toBe(true); // never the real folder
    for (let i = 1; i <= 5; i++) touch(`lcc-2026-11-0${i}_10-00-00-pre-delete.db`);
    touch("lcc-2026-11-01_09-00-00-pre-migration.db");
    touch("lcc-2026-11-01_09-00-00-pre-delete-2.db");
    touch("lcc-2026-10-01_09-00-00-manual.db");
    touch("lcc-2026-10-02_09-00-00-manual-2.db");
    touch("my-own-copy.db");
    const before = listBackups();
    expect(before.filter((b) => b.automatic)).toHaveLength(7);
    expect(before[0]!.name).toBe("lcc-2026-11-05_10-00-00-pre-delete.db"); // newest first
    const deleted = pruneAutomaticBackups(3);
    expect(deleted.sort()).toEqual(["lcc-2026-11-01_09-00-00-pre-delete-2.db", "lcc-2026-11-01_09-00-00-pre-migration.db", "lcc-2026-11-01_10-00-00-pre-delete.db", "lcc-2026-11-02_10-00-00-pre-delete.db"]);
    const left = listBackups().map((b) => b.name);
    expect(left).toEqual(expect.arrayContaining(["lcc-2026-10-01_09-00-00-manual.db", "lcc-2026-10-02_09-00-00-manual-2.db", "my-own-copy.db", "lcc-2026-11-05_10-00-00-pre-delete.db"]));
    expect(left).toHaveLength(6);
  });
});

describe("sync log pruning (H6)", () => {
  it("empties old activity payloads, keeps their ids (resends stay no-ops) and every other payload", () => {
    const db = freshDb();
    const sid = randomUUID();
    const base = { clientId: "c", createdAt: at("2026-11-02", 10) };
    const ev = (type: string, payload: unknown, seq: number) => ({ ...base, id: randomUUID(), seq, type, payload });
    const start = ev("session.start", { sessionId: sid, problem: { slug: "two-sum" }, startedAt: at("2026-11-02", 10) }, 1);
    const act = ev("session.activity", { sessionId: sid, activeMs: 60_000, lastActivityAt: at("2026-11-02", 10, 1) }, 2);
    const notes = ev("session.notes", { sessionId: sid, notes: "old text" }, 3);
    processSyncEvents(db, [start, act, notes]);
    const now = Date.now();
    expect(pruneSyncEventPayloads(db, 30, now)).toBe(0); // all received just now
    expect(pruneSyncEventPayloads(db, 30, now + 31 * 86_400_000)).toBe(1);
    const rows = Object.fromEntries(db.select().from(schema.syncEvents).all().map((r) => [r.type, r]));
    expect(rows["session.activity"]!.payload).toEqual({});
    expect(rows["session.notes"]!.payload).toMatchObject({ payload: { notes: "old text" } });
    expect(rows["session.start"]!.payload).toMatchObject({ payload: { sessionId: sid } });
    // A resend of the trimmed event is still recognised.
    expect(processSyncEvents(db, [act])[0]!.status).toBe("duplicate");
    expect(pruneSyncEventPayloads(db, 30, now + 31 * 86_400_000)).toBe(0); // nothing left to trim
    expect(db.select().from(schema.syncEvents).where(eq(schema.syncEvents.id, act.id)).get()).toBeTruthy();
  });
});
