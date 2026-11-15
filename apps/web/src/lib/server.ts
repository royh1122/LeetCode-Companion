import "server-only";
import { getDb, pruneSyncEventPayloads, type RootDb } from "@lcc/db";

const pruned = Symbol.for("lcc.syncPruned");
type G = typeof globalThis & { [pruned]?: boolean };

/** Database handle for server code. */
export function db(): RootDb {
  const d = getDb();
  // Once per server start: trim old activity payloads from the sync log (ids are kept).
  const g = globalThis as G;
  if (!g[pruned]) {
    g[pruned] = true;
    try {
      pruneSyncEventPayloads(d);
    } catch (e) {
      log("sync log pruning failed (harmless; retried at next start)", e instanceof Error ? e.message : e);
    }
  }
  return d;
}

export function log(msg: string, extra?: unknown) {
  // Structured, local-only logging for sync debugging.
  console.log(`[lcc] ${new Date().toISOString()} ${msg}`, extra ?? "");
}
