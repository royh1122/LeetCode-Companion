import { describe, expect, it } from "vitest";
import { effectiveDuration, elapsedMs, localDateBounds, type DurationInput } from "../src";

const H = 3_600_000;
const MIN = 60_000;

/** Bounds are exact: the first millisecond of the local day. */
const near = (actualMs: number, iso: string) => expect(new Date(actualMs).toISOString()).toBe(iso);

describe("localDateBounds", () => {
  it("is 24 h on a normal day (Toronto, EST)", () => {
    const b = localDateBounds("2026-01-15", "America/Toronto");
    near(b.start, "2026-01-15T05:00:00.000Z");
    expect(b.end - b.start).toBe(24 * H);
  });

  it("is 23 h on the spring-forward day (Toronto 2026-03-08)", () => {
    const b = localDateBounds("2026-03-08", "America/Toronto");
    near(b.start, "2026-03-08T05:00:00.000Z"); // midnight EST
    near(b.end, "2026-03-09T04:00:00.000Z"); // midnight EDT
    expect(b.end - b.start).toBe(23 * H);
  });

  it("is 25 h on the fall-back day (Toronto 2026-11-01)", () => {
    const b = localDateBounds("2026-11-01", "America/Toronto");
    near(b.start, "2026-11-01T04:00:00.000Z"); // midnight EDT
    near(b.end, "2026-11-02T05:00:00.000Z"); // midnight EST
    expect(b.end - b.start).toBe(25 * H);
  });

  it("is 24 h every day in a zone without DST (Asia/Tokyo)", () => {
    for (const d of ["2026-03-08", "2026-11-01", "2026-06-30"]) {
      const b = localDateBounds(d, "Asia/Tokyo");
      expect(b.end - b.start).toBe(24 * H);
    }
    near(localDateBounds("2026-03-08", "Asia/Tokyo").start, "2026-03-07T15:00:00.000Z");
  });

  // Was 1 s after midnight (the search stopped at 1 s and rounded up): a session in the first
  // second of a day fell outside its own day.
  it("an instant in the first second of a day belongs to that day", () => {
    const b = localDateBounds("2026-01-15", "America/Toronto");
    expect(new Date(b.start).toISOString()).toBe("2026-01-15T05:00:00.000Z");
    const prev = localDateBounds("2026-01-14", "America/Toronto");
    expect(prev.end).toBe(b.start);
    expect(b.start <= Date.parse("2026-01-15T05:00:00.500Z")).toBe(true);
  });

  it("consecutive days tile with no gap or overlap across DST", () => {
    const a = localDateBounds("2026-03-07", "America/Toronto");
    const b = localDateBounds("2026-03-08", "America/Toronto");
    const c = localDateBounds("2026-03-09", "America/Toronto");
    expect(a.end).toBe(b.start);
    expect(b.end).toBe(c.start);
  });
});

const base: DurationInput = { startedAt: 1_000_000, endedAt: null, pausedMs: 0, pausedAt: null, activeMs: null, durationOverrideMs: null };

describe("elapsedMs", () => {
  it("is end - start with no pauses", () => {
    expect(elapsedMs({ ...base, endedAt: base.startedAt + 30 * MIN }, 0)).toBe(30 * MIN);
  });
  it("uses now while the session is open", () => {
    expect(elapsedMs(base, base.startedAt + 5 * MIN)).toBe(5 * MIN);
  });
  it("subtracts one finished pause", () => {
    expect(elapsedMs({ ...base, endedAt: base.startedAt + 30 * MIN, pausedMs: 10 * MIN }, 0)).toBe(20 * MIN);
  });
  it("subtracts several pauses (accumulated in pausedMs)", () => {
    expect(elapsedMs({ ...base, endedAt: base.startedAt + 60 * MIN, pausedMs: 5 * MIN + 7 * MIN + 3 * MIN }, 0)).toBe(45 * MIN);
  });
  it("excludes a still-open pause up to now", () => {
    const s = { ...base, pausedMs: 4 * MIN, pausedAt: base.startedAt + 20 * MIN };
    expect(elapsedMs(s, base.startedAt + 30 * MIN)).toBe(30 * MIN - 4 * MIN - 10 * MIN);
  });
  it("freezes while paused: time passing during the pause adds nothing", () => {
    const s = { ...base, pausedAt: base.startedAt + 20 * MIN };
    expect(elapsedMs(s, base.startedAt + 25 * MIN)).toBe(20 * MIN);
    expect(elapsedMs(s, base.startedAt + 90 * MIN)).toBe(20 * MIN);
  });
  it("ignores pausedAt once the session has ended", () => {
    const s = { ...base, endedAt: base.startedAt + 30 * MIN, pausedAt: base.startedAt + 10 * MIN };
    expect(elapsedMs(s, base.startedAt + 999 * MIN)).toBe(30 * MIN);
  });
  it("never goes negative", () => {
    expect(elapsedMs({ ...base, endedAt: base.startedAt + MIN, pausedMs: 10 * MIN }, 0)).toBe(0);
    expect(elapsedMs(base, base.startedAt - 5 * MIN)).toBe(0);
  });
});

describe("effectiveDuration", () => {
  const ended = { ...base, endedAt: base.startedAt + 40 * MIN, pausedMs: 10 * MIN };
  it("falls back to wall clock minus pauses, marked approximate", () => {
    expect(effectiveDuration(ended, 0)).toEqual({ ms: 30 * MIN, source: "wall_clock", approx: true });
  });
  it("prefers extension active time when it is positive", () => {
    expect(effectiveDuration({ ...ended, activeMs: 22 * MIN }, 0)).toEqual({ ms: 22 * MIN, source: "extension_active", approx: true });
  });
  it("ignores zero active time", () => {
    expect(effectiveDuration({ ...ended, activeMs: 0 }, 0).source).toBe("wall_clock");
  });
  it("manual override wins over everything and is exact", () => {
    expect(effectiveDuration({ ...ended, activeMs: 22 * MIN, durationOverrideMs: 45 * MIN }, 0)).toEqual({ ms: 45 * MIN, source: "manual", approx: false });
  });
  it("a zero manual override still counts as an override", () => {
    expect(effectiveDuration({ ...ended, durationOverrideMs: 0 }, 0)).toEqual({ ms: 0, source: "manual", approx: false });
  });
  it("open pause is excluded from the wall-clock fallback", () => {
    const s = { ...base, pausedAt: base.startedAt + 10 * MIN };
    expect(effectiveDuration(s, base.startedAt + 60 * MIN).ms).toBe(10 * MIN);
  });
});
