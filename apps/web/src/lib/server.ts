import "server-only";
import { getDb, type RootDb } from "@lcc/db";

/** Database handle for server code. */
export function db(): RootDb {
  return getDb();
}

export function log(msg: string, extra?: unknown) {
  // Structured, local-only logging for sync debugging.
  console.log(`[lcc] ${new Date().toISOString()} ${msg}`, extra ?? "");
}
