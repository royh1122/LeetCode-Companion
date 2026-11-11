/**
 * Calendar-date helpers. Timestamps are stored as UTC epoch milliseconds;
 * study days are plain local calendar dates ("YYYY-MM-DD") computed in the
 * plan's configured IANA time zone. Date arithmetic is done on the calendar
 * string (via UTC noon) so DST transitions can never shift a day.
 */

export type LocalDate = string; // YYYY-MM-DD

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalDate(s: unknown): s is LocalDate {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    fmtCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** The local calendar date of an instant in a given time zone. */
export function toLocalDate(instantMs: number, timeZone: string): LocalDate {
  const parts = formatter(timeZone).formatToParts(new Date(instantMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function toUtcNoon(d: LocalDate): Date {
  return new Date(`${d}T12:00:00Z`);
}

export function addDays(d: LocalDate, n: number): LocalDate {
  const x = toUtcNoon(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

/** b - a in whole days. */
export function diffDays(a: LocalDate, b: LocalDate): number {
  return Math.round((toUtcNoon(b).getTime() - toUtcNoon(a).getTime()) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday (JS convention). */
export function weekdayOf(d: LocalDate): number {
  return toUtcNoon(d).getUTCDay();
}

/** 0 = Monday … 6 = Sunday. Study weeks run Monday → Sunday. */
export function mondayIndex(d: LocalDate): number {
  return (weekdayOf(d) + 6) % 7;
}

export function startOfWeek(d: LocalDate): LocalDate {
  return addDays(d, -mondayIndex(d));
}

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function formatLocalDate(d: LocalDate, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }) {
  return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(toUtcNoon(d));
}

/** Local midnight → UTC instant range for a calendar date, used for "sessions on day X" queries. */
export function localDateBounds(d: LocalDate, timeZone: string): { start: number; end: number } {
  // Search around UTC noon for the first instant whose local date is d.
  const guess = toUtcNoon(d).getTime();
  const find = (target: LocalDate, from: number) => {
    // Binary search on [from - 36h, from + 36h] for the first instant with local date >= target.
    let lo = from - 36 * 3_600_000;
    let hi = from + 36 * 3_600_000;
    while (hi - lo > 1000) {
      const mid = Math.floor((lo + hi) / 2);
      if (toLocalDate(mid, timeZone) >= target) hi = mid;
      else lo = mid;
    }
    return Math.ceil(hi / 1000) * 1000;
  };
  return { start: find(d, guess), end: find(addDays(d, 1), guess + 86_400_000) };
}

export function formatDuration(ms: number | null | undefined, opts: { approx?: boolean } = {}): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const totalMin = Math.round(ms / 60_000);
  const prefix = opts.approx ? "≈" : "";
  if (totalMin < 1) return `${prefix}<1 min`;
  if (totalMin < 60) return `${prefix}${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${prefix}${h}h ${m.toString().padStart(2, "0")}m`;
}

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = m.toString().padStart(2, "0");
  const ss = sec.toString().padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
