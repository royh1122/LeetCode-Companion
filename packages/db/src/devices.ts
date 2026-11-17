/**
 * Paired devices (one per extension install) and the one-time pairing code that adds one.
 *
 * Each device has its own random key; only its SHA-256 is stored. Pairing identifies devices and lets
 * one be removed without re-pairing the rest. It is not access control for the dashboard itself:
 * in server mode the private network is what keeps others out (docs/SERVER_MODE.md).
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { desc, eq, isNotNull } from "drizzle-orm";
import type { Db } from "./client";
import { getMeta, setMeta } from "./meta";
import { appMeta, devices } from "./schema";

export type Device = typeof devices.$inferSelect;

/** Crockford base32: no I, L, O, U, so codes read aloud or typed on a tablet are unambiguous. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8; // 40 bits; with 5 tries and 10 minutes, guessing is hopeless
export const PAIRING_CODE_TTL_MS = 10 * 60_000;
export const PAIRING_CODE_ATTEMPTS = 5;
const CODE_KEY = "pairing_code";
/** Set once the pre-devices pairing token has been turned into a device (so removing it sticks). */
const LEGACY_DONE_KEY = "legacy_token_migrated";
export const LEGACY_DEVICE_NAME = "This computer";
const NAME_MAX = 60;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** "k7q4 mx2p", "K7Q4-MX2P", "k7q4mxzp" with O/I/L typed for 0/1 → "K7Q4MX2P". */
export function normalizePairingCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

export const formatPairingCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

export function cleanDeviceName(name: unknown): string {
  const s = typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX) : "";
  return s || "Browser";
}

interface StoredCode {
  hash: string;
  expiresAt: number;
  attemptsLeft: number;
}

function readCode(db: Db): StoredCode | null {
  const raw = getMeta(db, CODE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredCode;
  } catch {
    return null;
  }
}

const clearCode = (db: Db) => db.delete(appMeta).where(eq(appMeta.key, CODE_KEY)).run();

/** A new one-time code (shown once, formatted XXXX-XXXX). Replaces any earlier code. */
export function createPairingCode(db: Db, now = Date.now()): { code: string; expiresAt: number } {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  const expiresAt = now + PAIRING_CODE_TTL_MS;
  setMeta(db, CODE_KEY, JSON.stringify({ hash: sha256(code), expiresAt, attemptsLeft: PAIRING_CODE_ATTEMPTS } satisfies StoredCode));
  return { code: formatPairingCode(code), expiresAt };
}

/** When the current code expires, or null if there is none (used, cancelled, expired). */
export function activePairingCodeExpiry(db: Db, now = Date.now()): number | null {
  const c = readCode(db);
  return c && c.expiresAt > now && c.attemptsLeft > 0 ? c.expiresAt : null;
}

export function cancelPairingCode(db: Db): void {
  clearCode(db);
}

export type RedeemResult = { ok: true; deviceId: string; token: string; name: string } | { ok: false; reason: "no-code" | "expired" | "invalid" };

/** Swaps a valid code for a new device and its key (returned once, never stored in the clear). */
export function redeemPairingCode(db: Db, input: string, name: unknown, now = Date.now()): RedeemResult {
  return db.transaction((tx) => {
    const stored = readCode(tx);
    if (!stored) return { ok: false, reason: "no-code" } as const;
    if (stored.expiresAt <= now || stored.attemptsLeft <= 0) {
      clearCode(tx);
      return { ok: false, reason: "expired" } as const;
    }
    if (!sameHash(sha256(normalizePairingCode(input)), stored.hash)) {
      const left = stored.attemptsLeft - 1;
      if (left <= 0) clearCode(tx);
      else setMeta(tx, CODE_KEY, JSON.stringify({ ...stored, attemptsLeft: left }));
      return { ok: false, reason: "invalid" } as const;
    }
    clearCode(tx);
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const deviceName = cleanDeviceName(name);
    tx.insert(devices).values({ id, name: deviceName, tokenHash: sha256(token), createdAt: now, updatedAt: now }).run();
    return { ok: true, deviceId: id, token, name: deviceName } as const;
  });
}

/** The device a presented key belongs to, or null. */
export function verifyDeviceToken(db: Db, presented: string | null | undefined): Device | null {
  if (!presented) return null;
  const hash = sha256(presented);
  const row = db.select().from(devices).where(eq(devices.tokenHash, hash)).get();
  return row && sameHash(row.tokenHash, hash) ? row : null;
}

export function touchDevice(db: Db, id: string, info: { version?: string } = {}, now = Date.now()): void {
  db.update(devices)
    .set({ lastSeenAt: now, ...(info.version ? { lastVersion: info.version.slice(0, 40) } : {}) })
    .where(eq(devices.id, id))
    .run();
}

export function listDevices(db: Db): Device[] {
  return db.select().from(devices).orderBy(devices.createdAt).all();
}

export function renameDevice(db: Db, id: string, name: unknown): void {
  db.update(devices).set({ name: cleanDeviceName(name), updatedAt: Date.now() }).where(eq(devices.id, id)).run();
}

/** Its key stops working at once; what it already synced stays. */
export function removeDevice(db: Db, id: string): boolean {
  return db.delete(devices).where(eq(devices.id, id)).run().changes > 0;
}

/** Most recent contact from any device (the "extension connected" indicator). */
export function getDevicesLastSeen(db: Db): { at: number; version?: string } | null {
  const row = db.select().from(devices).where(isNotNull(devices.lastSeenAt)).orderBy(desc(devices.lastSeenAt)).limit(1).get();
  return row?.lastSeenAt ? { at: row.lastSeenAt, version: row.lastVersion ?? undefined } : null;
}

/**
 * Before devices existed, every browser shared one pairing token (app_meta.extension_token).
 * Turn it into a device once, so the browser already paired keeps working with no re-pairing.
 * Runs on every open; does nothing after the first time.
 */
export function migrateLegacyPairing(db: Db): void {
  if (getMeta(db, LEGACY_DONE_KEY)) return;
  db.transaction((tx) => {
    const token = getMeta(tx, "extension_token");
    if (token) {
      const hash = sha256(token);
      if (!tx.select().from(devices).where(eq(devices.tokenHash, hash)).get()) {
        let lastSeenAt: number | null = null;
        let lastVersion: string | null = null;
        try {
          const seen = JSON.parse(getMeta(tx, "extension_last_seen") ?? "null") as { at?: number; version?: string } | null;
          lastSeenAt = typeof seen?.at === "number" ? seen.at : null;
          lastVersion = typeof seen?.version === "string" ? seen.version : null;
        } catch {
          /* no record */
        }
        tx.insert(devices).values({ id: randomUUID(), name: LEGACY_DEVICE_NAME, tokenHash: hash, lastSeenAt, lastVersion }).run();
      }
    }
    setMeta(tx, LEGACY_DONE_KEY, "1");
  });
}
