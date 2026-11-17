import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  activePairingCodeExpiry,
  cancelPairingCode,
  cleanDeviceName,
  createPairingCode,
  getDevicesLastSeen,
  getMeta,
  getProblemDetail,
  LEGACY_DEVICE_NAME,
  listDevices,
  migrateLegacyPairing,
  normalizePairingCode,
  PAIRING_CODE_TTL_MS,
  processSyncEvents,
  redeemPairingCode,
  removeDevice,
  renameDevice,
  schema,
  setMeta,
  touchDevice,
  verifyDeviceToken,
} from "../src";
import { freshDb } from "./helpers";

function pair(db: ReturnType<typeof freshDb>, name = "Chrome on Windows") {
  const { code } = createPairingCode(db);
  const r = redeemPairingCode(db, code, name);
  if (!r.ok) throw new Error(r.reason);
  return r;
}

describe("pairing codes", () => {
  it("look like XXXX-XXXX from an unambiguous alphabet", () => {
    const db = freshDb({ seed: false });
    const { code, expiresAt } = createPairingCode(db, 1_000);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(expiresAt).toBe(1_000 + PAIRING_CODE_TTL_MS);
    expect(activePairingCodeExpiry(db, 1_000)).toBe(expiresAt);
    // Only a hash is stored.
    expect(getMeta(db, "pairing_code")).not.toContain(code.replace("-", ""));
  });

  it("accept sloppy typing: lowercase, spaces, O for 0 and I/L for 1", () => {
    expect(normalizePairingCode(" k7q4-mx0p ")).toBe("K7Q4MX0P");
    expect(normalizePairingCode("abOd 1il2")).toBe("AB0D1112");
  });

  it("pair once, then stop working", () => {
    const db = freshDb({ seed: false });
    const { code } = createPairingCode(db);
    const r = redeemPairingCode(db, code.toLowerCase(), "  Edge   on Android ");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name).toBe("Edge on Android");
    expect(verifyDeviceToken(db, r.token)?.id).toBe(r.deviceId);
    expect(redeemPairingCode(db, code, "again")).toEqual({ ok: false, reason: "no-code" });
    expect(activePairingCodeExpiry(db)).toBeNull();
    // The key itself is never stored.
    const row = db.select().from(schema.devices).where(eq(schema.devices.id, r.deviceId)).get()!;
    expect(row.tokenHash).not.toBe(r.token);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("expire after 10 minutes", () => {
    const db = freshDb({ seed: false });
    const { code } = createPairingCode(db, 0);
    expect(redeemPairingCode(db, code, "x", PAIRING_CODE_TTL_MS)).toEqual({ ok: false, reason: "expired" });
    expect(listDevices(db)).toHaveLength(0);
  });

  it("are void after 5 wrong tries, and 4 wrong tries still leave the right code working", () => {
    const db = freshDb({ seed: false });
    let { code } = createPairingCode(db);
    for (let i = 0; i < 4; i++) expect(redeemPairingCode(db, "0000-0000", "x")).toEqual({ ok: false, reason: "invalid" });
    expect(redeemPairingCode(db, code, "x").ok).toBe(true);

    ({ code } = createPairingCode(db));
    for (let i = 0; i < 5; i++) expect(redeemPairingCode(db, "0000-0000", "x").ok).toBe(false);
    expect(redeemPairingCode(db, code, "x")).toEqual({ ok: false, reason: "no-code" });
  });

  it("a new code cancels the old one; cancel removes it", () => {
    const db = freshDb({ seed: false });
    const first = createPairingCode(db).code;
    const second = createPairingCode(db).code;
    if (first !== second) expect(redeemPairingCode(db, first, "x")).toEqual({ ok: false, reason: "invalid" });
    cancelPairingCode(db);
    expect(redeemPairingCode(db, second, "x")).toEqual({ ok: false, reason: "no-code" });
  });
});

describe("devices", () => {
  it("each have their own key; removing one leaves the others", () => {
    const db = freshDb({ seed: false });
    const a = pair(db, "Chrome on Windows");
    const b = pair(db, "Edge on Android");
    expect(listDevices(db).map((d) => d.name)).toEqual(["Chrome on Windows", "Edge on Android"]);
    expect(removeDevice(db, a.deviceId)).toBe(true);
    expect(verifyDeviceToken(db, a.token)).toBeNull();
    expect(verifyDeviceToken(db, b.token)?.id).toBe(b.deviceId);
    expect(verifyDeviceToken(db, "")).toBeNull();
    expect(verifyDeviceToken(db, "nope")).toBeNull();
  });

  it("can be renamed; empty names fall back", () => {
    const db = freshDb({ seed: false });
    const a = pair(db);
    renameDevice(db, a.deviceId, "Desk PC");
    expect(listDevices(db)[0]!.name).toBe("Desk PC");
    expect(cleanDeviceName("   ")).toBe("Browser");
    expect(cleanDeviceName(42)).toBe("Browser");
    expect(cleanDeviceName("x".repeat(100))).toHaveLength(60);
  });

  it("last seen is the most recent contact from any device", () => {
    const db = freshDb({ seed: false });
    expect(getDevicesLastSeen(db)).toBeNull();
    const a = pair(db);
    const b = pair(db);
    touchDevice(db, a.deviceId, { version: "0.2.0" }, 1_000);
    touchDevice(db, b.deviceId, { version: "0.3.0" }, 2_000);
    expect(getDevicesLastSeen(db)).toEqual({ at: 2_000, version: "0.3.0" });
  });
});

describe("pairing from before devices existed", () => {
  it("becomes a device once, so the browser already paired keeps working", () => {
    const db = freshDb({ seed: false });
    // freshDb ran the one-time step already with no token; simulate an older database.
    db.delete(schema.appMeta).where(eq(schema.appMeta.key, "legacy_token_migrated")).run();
    setMeta(db, "extension_token", "old-shared-token");
    setMeta(db, "extension_last_seen", JSON.stringify({ at: 1234, version: "0.2.0" }));
    migrateLegacyPairing(db);
    const [d] = listDevices(db);
    expect(d?.name).toBe(LEGACY_DEVICE_NAME);
    expect(d?.lastSeenAt).toBe(1234);
    expect(d?.lastVersion).toBe("0.2.0");
    expect(verifyDeviceToken(db, "old-shared-token")?.id).toBe(d?.id);
    migrateLegacyPairing(db);
    expect(listDevices(db)).toHaveLength(1);
    // Removing it sticks: the next start doesn't bring it back.
    removeDevice(db, d!.id);
    migrateLegacyPairing(db);
    expect(listDevices(db)).toHaveLength(0);
    expect(verifyDeviceToken(db, "old-shared-token")).toBeNull();
  });

  it("does nothing on a new install", () => {
    const db = freshDb({ seed: false });
    expect(listDevices(db)).toHaveLength(0);
  });
});

describe("events from several devices", () => {
  it("record the device and store the same LeetCode submission once", () => {
    const db = freshDb();
    const a = pair(db);
    const b = pair(db);
    let seq = 0;
    const ev = (clientId: string, type: string, payload: unknown) => ({ id: randomUUID(), clientId, seq: seq++, createdAt: Date.now(), type, payload });
    const problem = { slug: "two-sum", title: "Two Sum", frontendId: "1", questionId: "1" };
    const sid = randomUUID();
    const capture = (clientId: string) =>
      ev(clientId, "submission.captured", { sessionId: sid, problem, kind: "submit", platformSubmissionId: "424242", lang: "python3", code: "x", submittedAt: Date.now() });
    const r1 = processSyncEvents(db, [ev("pc", "session.start", { sessionId: sid, problem, startedAt: Date.now() }), capture("pc")], undefined, a.deviceId);
    const r2 = processSyncEvents(db, [capture("ipad")], undefined, b.deviceId);
    expect([...r1, ...r2].every((r) => r.status === "processed")).toBe(true);
    expect(getProblemDetail(db, "two-sum")!.sessions[0]!.submissions).toHaveLength(1);
    const byDevice = db.select().from(schema.syncEvents).all().map((e) => e.deviceId);
    expect(byDevice).toEqual([a.deviceId, a.deviceId, b.deviceId]);
  });
});
