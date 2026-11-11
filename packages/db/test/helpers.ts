import { localDateBounds, type LocalDate } from "@lcc/shared";
import { importStudyLists, openDb, sampleLists, updateAppSettings, type RootDb } from "../src";

export const TZ = "America/Toronto";

export function freshDb(opts: { seed?: boolean } = {}): RootDb {
  const db = openDb(":memory:", { skipBackup: true });
  updateAppSettings(db, { timeZone: TZ });
  if (opts.seed !== false) importStudyLists(db, sampleLists());
  return db;
}

/** Epoch ms for a local wall-clock time in TZ. */
export function at(date: LocalDate, hour = 9, minute = 0): number {
  return localDateBounds(date, TZ).start + hour * 3_600_000 + minute * 60_000;
}
