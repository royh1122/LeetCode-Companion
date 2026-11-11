import { eq, sql } from "drizzle-orm";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { appSettingsSchema, defaultAppSettings, isValidTimeZone, type AppSettings } from "@lcc/shared";
import type { Db } from "./client";
import { appMeta } from "./schema";

export function getMeta(db: Db, key: string): string | null {
  return db.select().from(appMeta).where(eq(appMeta.key, key)).get()?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.insert(appMeta)
    .values({ key, value })
    .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: Date.now() } })
    .run();
}

/** Monotonic change counter; the dashboard polls it to refresh after extension syncs. */
export function bumpRevision(db: Db): void {
  db.insert(appMeta)
    .values({ key: "revision", value: "1" })
    .onConflictDoUpdate({ target: appMeta.key, set: { value: sql`cast(${appMeta.value} as integer) + 1`, updatedAt: Date.now() } })
    .run();
}

export function getRevision(db: Db): number {
  return Number(getMeta(db, "revision") ?? 0);
}

export function getAppSettings(db: Db): AppSettings {
  const raw = getMeta(db, "settings");
  const defaults = defaultAppSettings();
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw);
    const merged = {
      ...defaults,
      ...parsed,
      srs: { ...defaults.srs, ...parsed.srs, baseIntervals: { ...defaults.srs.baseIntervals, ...parsed.srs?.baseIntervals } },
      mastery: { ...defaults.mastery, ...parsed.mastery },
    };
    // An unknown zone (e.g. typed by hand before validation existed) falls back alone, keeping other settings.
    if (typeof merged.timeZone !== "string" || !isValidTimeZone(merged.timeZone)) merged.timeZone = defaults.timeZone;
    const r = appSettingsSchema.safeParse(merged);
    return r.success ? r.data : defaults;
  } catch {
    return defaults;
  }
}

export function updateAppSettings(db: Db, patch: Partial<AppSettings>): AppSettings {
  const next = appSettingsSchema.parse({ ...getAppSettings(db), ...patch });
  setMeta(db, "settings", JSON.stringify(next));
  bumpRevision(db);
  return next;
}

/** Pairing token for the browser extension. Generated once; can be rotated. */
export function getExtensionToken(db: Db): string {
  let token = getMeta(db, "extension_token");
  if (!token) {
    token = randomBytes(24).toString("base64url");
    setMeta(db, "extension_token", token);
  }
  return token;
}

export function rotateExtensionToken(db: Db): string {
  const token = randomBytes(24).toString("base64url");
  setMeta(db, "extension_token", token);
  return token;
}

export function verifyExtensionToken(db: Db, presented: string | null | undefined): boolean {
  if (!presented) return false;
  const expected = Buffer.from(getExtensionToken(db));
  const got = Buffer.from(presented);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

/** Records the last time the extension talked to us (for the "extension connected" indicator). */
export function touchExtensionSeen(db: Db, info: { version?: string }) {
  setMeta(db, "extension_last_seen", JSON.stringify({ at: Date.now(), ...info }));
}

export function getExtensionLastSeen(db: Db): { at: number; version?: string } | null {
  const raw = getMeta(db, "extension_last_seen");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
