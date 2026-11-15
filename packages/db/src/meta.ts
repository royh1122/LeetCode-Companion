import { eq, sql } from "drizzle-orm";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { z } from "zod";
import { appSettingsSchema, defaultAppSettings, type AppSettings } from "@lcc/shared";
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

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Walks the schema: each leaf that is missing or invalid takes its default; the rest are kept. */
function pickValid(schema: z.ZodType, value: unknown, fallback: unknown, path: string, dropped: string[]): unknown {
  // Duck-typed (not instanceof) so it works even if @lcc/shared resolves its own copy of zod.
  const shape = (schema as { shape?: unknown }).shape;
  if (isRecord(shape)) {
    const v = isRecord(value) ? value : {};
    if (value !== undefined && !isRecord(value)) dropped.push(path || "(all)");
    const fb = fallback as Record<string, unknown>;
    return Object.fromEntries(Object.entries(shape as Record<string, z.ZodType>).map(([k, s]) => [k, pickValid(s, v[k], fb[k], path ? `${path}.${k}` : k, dropped)]));
  }
  if (value === undefined) return fallback;
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  dropped.push(path);
  return fallback;
}

/**
 * Turns stored or imported settings into valid ones. A field that is invalid (hand-edited, or
 * from an older version) falls back to its default alone; `dropped` lists those fields.
 */
export function normalizeSettings(raw: unknown, defaults: AppSettings = defaultAppSettings()): { settings: AppSettings; dropped: string[] } {
  const dropped: string[] = [];
  const picked = pickValid(appSettingsSchema, raw, defaults, "", dropped);
  const r = appSettingsSchema.safeParse(picked);
  return r.success ? { settings: r.data, dropped } : { settings: defaults, dropped: ["(all)"] };
}

const warned = new Set<string>();

export function getAppSettings(db: Db): AppSettings {
  const raw = getMeta(db, "settings");
  if (!raw) return defaultAppSettings();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const { settings, dropped } = normalizeSettings(parsed);
  // Read on every page render: warn once per distinct problem, not on every read.
  const key = dropped.join(",");
  if (dropped.length && !warned.has(key)) {
    warned.add(key);
    console.warn(`[settings] invalid stored value(s) replaced by defaults: ${key}`);
  }
  return settings;
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
