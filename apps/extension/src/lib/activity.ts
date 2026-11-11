/**
 * Active-time estimation from periodic heartbeats.
 *
 * A heartbeat says whether the tab was "active" at that instant: visible,
 * window focused, and user input within the idle threshold. The interval
 * between two heartbeats is credited if the *earlier* heartbeat was active and
 * the gap is short (≤ maxGapMs). Long gaps — browser closed, laptop asleep,
 * timers throttled — are never credited. All state is timestamps, so it
 * survives service-worker restarts. This is an estimate and is labeled as such.
 */
export interface ActivityState {
  activeMs: number;
  lastTickAt: number | null;
  lastActive: boolean;
  lastTabId: number | null;
}

export const HEARTBEAT_MS = 15_000;
export const MAX_GAP_MS = 45_000;

export function isActive(h: { visible: boolean; focused: boolean; lastInputAt: number }, now: number, idleThresholdSec: number): boolean {
  return h.visible && h.focused && now - h.lastInputAt < idleThresholdSec * 1000;
}

export function applyHeartbeat(prev: ActivityState, tabId: number, now: number, activeNow: boolean, maxGapMs = MAX_GAP_MS): ActivityState {
  // An inactive tick from a *different* tab (e.g. a background duplicate tab)
  // must not interrupt crediting for the tab the user is actually working in.
  if (!activeNow && prev.lastActive && prev.lastTabId != null && prev.lastTabId !== tabId && prev.lastTickAt != null && now - prev.lastTickAt <= maxGapMs) {
    return prev;
  }
  let add = 0;
  if (prev.lastActive && prev.lastTickAt != null) {
    const gap = now - prev.lastTickAt;
    if (gap > 0 && gap <= maxGapMs) add = gap;
  }
  return { activeMs: prev.activeMs + add, lastTickAt: now, lastActive: activeNow, lastTabId: tabId };
}

/** Value to display between heartbeats (smooth timer), never exceeding one gap. */
export function displayActiveMs(s: ActivityState, now: number, maxGapMs = MAX_GAP_MS): number {
  if (s.lastActive && s.lastTickAt != null) return s.activeMs + Math.min(Math.max(0, now - s.lastTickAt), maxGapMs);
  return s.activeMs;
}
