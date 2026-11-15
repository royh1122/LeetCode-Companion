export const SYNC_ALARM = "lcc-sync";

/** The part of `chrome.alarms` used here (a fake in tests). */
export interface AlarmsApi {
  get(name: string): Promise<unknown>;
  create(name: string, info: { periodInMinutes: number }): Promise<void>;
}

/**
 * Background sync runs on a repeating alarm. Chrome keeps alarms across worker restarts but not
 * always across disabling and re-enabling the extension, so check for it every time the worker starts.
 */
export async function ensureSyncAlarm(alarms: AlarmsApi) {
  if (!(await alarms.get(SYNC_ALARM))) await alarms.create(SYNC_ALARM, { periodInMinutes: 0.5 });
}
