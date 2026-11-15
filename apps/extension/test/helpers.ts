import type { ExtensionContext, ExtensionSessionState } from "@lcc/shared";
import type { Api } from "../src/lib/api";
import { Controller } from "../src/lib/controller";
import { MemoryKV } from "../src/lib/storage";

export function fakeApi(opts: { online?: boolean; context?: Partial<ExtensionContext> } = {}) {
  const sent: { type: string; id: string; payload: Record<string, unknown> }[] = [];
  const seenIds = new Set<string>();
  const state = {
    online: opts.online ?? true,
    failNext: false,
    serverSessions: {} as Record<string, ExtensionSessionState>,
    contextOverride: null as Partial<ExtensionContext> | null,
    poison: null as string | null,
    /** The dashboard is running but broken: every request gets a 500. */
    broken: false,
    /** Some other program listens on the configured address: it answers 404 to everything. */
    notOurs: false,
    /** Session text fields as the dashboard stores them (session.notes results report them back). */
    notes: {} as Record<string, Record<string, string>>,
    /** The next session.notes finds this newer dashboard text: the dashboard keeps it (both kept). */
    conflictWith: null as Record<string, string> | null,
  };
  const down = () =>
    !state.online
      ? { ok: false as const, error: { kind: "offline" as const, message: "down" } }
      : state.broken
        ? { ok: false as const, error: { kind: "server" as const, message: "Dashboard error 500" } }
        : null;
  const notFound = { ok: false as const, error: { kind: "bad_request" as const, message: "Request failed (404)" } };
  const api = {
    async ping() {
      return down() ?? (state.notOurs ? notFound : { ok: true, data: { ok: true, serverTime: 0 } });
    },
    async context(slug) {
      if (down()) return down()!;
      if (state.notOurs) return notFound;
      return {
        ok: true,
        data: {
          problem: { id: 1, slug, title: "Two Sum", frontendId: "1", difficulty: "Easy", patterns: [], mastery: "not_started", sessionCount: 0, lastPracticedAt: null, nextReviewDate: null },
          openSession: null,
          todayAssignment: null,
          settings: { idleThresholdSec: 300 },
          dashboardUrl: "http://127.0.0.1:4317",
          recommendations: { independent: "2026-11-16" },
          ...opts.context,
          ...state.contextOverride,
        },
      };
    },
    async session(id) {
      if (down()) return down()!;
      if (state.notOurs) return { ok: true, data: null }; // a 404 reads as "no such session"
      return { ok: true, data: state.serverSessions[id] ?? null };
    },
    async sendEvents(events) {
      if (down()) return down()!;
      if (state.notOurs) return notFound;
      if ((events as { type: string }[]).some((e) => e.type === state.poison)) return { ok: false, error: { kind: "server", message: "Dashboard error 500" } };
      return {
        ok: true,
        data: {
          results: (events as { id: string; type: string; payload: Record<string, unknown> }[]).map((e) => {
            if (seenIds.has(e.id)) return { id: e.id, status: "duplicate" as const };
            seenIds.add(e.id);
            sent.push(e);
            if (e.type === "session.notes") {
              const sid = e.payload.sessionId as string;
              const cur = (state.notes[sid] ??= { notes: "", timeComplexity: "", spaceComplexity: "" });
              for (const f of ["notes", "timeComplexity", "spaceComplexity"]) if (typeof e.payload[f] === "string") cur[f] = e.payload[f] as string;
              const conflict = !!state.conflictWith;
              Object.assign(cur, state.conflictWith);
              state.conflictWith = null;
              return { id: e.id, status: "processed" as const, stored: { ...cur }, conflict };
            }
            return { id: e.id, status: "processed" as const };
          }),
        },
      };
    },
  } as Api;
  const imported: unknown[] = [];
  api.importList = async (list) => {
    if (!state.online) return { ok: false, error: { kind: "offline", message: "down" } };
    imported.push(list);
    return { ok: true, data: { slug: "top-interview-150", name: "Top Interview 150", count: 2 } };
  };
  return { api, sent, state, imported };
}

export function setup(o: Parameters<typeof fakeApi>[0] & { queueMaxChars?: number } = {}) {
  let t = 1_000_000;
  let n = 0;
  const local = new MemoryKV();
  const ephemeral = new MemoryKV();
  const fa = fakeApi(o);
  const mk = () =>
    new Controller({ local, ephemeral, api: fa.api, now: () => t, uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, queueMaxChars: o.queueMaxChars });
  return { ...fa, local, ephemeral, mk, ctl: mk(), advance: (ms: number) => (t += ms), now: () => t };
}
