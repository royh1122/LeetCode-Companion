/**
 * Session duration rules (single source of truth for dashboard + extension).
 *
 *  - wall-clock elapsed = end − start − paused time
 *  - extension active time = estimate from tab visibility/focus/input activity
 *  - manual override always wins
 *
 * Only the manual override is "exact"; everything else is shown with "≈".
 */
export interface DurationInput {
  startedAt: number;
  endedAt: number | null;
  pausedMs: number;
  pausedAt: number | null;
  activeMs: number | null;
  durationOverrideMs: number | null;
}

export type DurationSource = "manual" | "extension_active" | "wall_clock";

export function elapsedMs(s: DurationInput, now: number): number {
  const end = s.endedAt ?? now;
  const currentPause = s.pausedAt != null && s.endedAt == null ? Math.max(0, now - s.pausedAt) : 0;
  return Math.max(0, end - s.startedAt - s.pausedMs - currentPause);
}

export function effectiveDuration(s: DurationInput, now: number): { ms: number; source: DurationSource; approx: boolean } {
  if (s.durationOverrideMs != null) return { ms: s.durationOverrideMs, source: "manual", approx: false };
  if (s.activeMs != null && s.activeMs > 0) return { ms: s.activeMs, source: "extension_active", approx: true };
  return { ms: elapsedMs(s, now), source: "wall_clock", approx: true };
}
