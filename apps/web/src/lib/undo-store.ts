import "server-only";
import { randomUUID } from "node:crypto";
import type { UndoRecord } from "@lcc/db";

/**
 * Undo records for the last few plan changes, kept in memory for a short while (an inline
 * "Undo" button, not a history). Lost on restart, which only means the button stops working.
 */
const TTL_MS = 10 * 60_000;
const key = Symbol.for("lcc.undo");
type G = typeof globalThis & { [key]?: Map<string, { record: UndoRecord; at: number }> };

function store() {
  const g = globalThis as G;
  g[key] ??= new Map();
  return g[key];
}

export function putUndo(record: UndoRecord): string {
  const s = store();
  const now = Date.now();
  for (const [k, v] of s) if (now - v.at > TTL_MS) s.delete(k);
  const token = randomUUID();
  s.set(token, { record, at: now });
  return token;
}

/** The record for `token`, removed from the store (an undo works once). */
export function takeUndo(token: string): UndoRecord | null {
  const s = store();
  const e = s.get(token);
  s.delete(token);
  return e && Date.now() - e.at <= TTL_MS ? e.record : null;
}
