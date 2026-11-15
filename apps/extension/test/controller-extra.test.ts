import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionSessionState } from "@lcc/shared";
import { httpApi, type ApiConfig } from "../src/lib/api";
import type { LocalSession } from "../src/lib/controller";
import { CONTENT_SCRIPT_MESSAGES, isAllowedMessage } from "../src/lib/gate";
import type { BgRequest } from "../src/lib/messages";
import { setup } from "./helpers";

type Env = ReturnType<typeof setup>;

const drain = async (env: Env) => {
  for (let i = 0; i < 10 && ((await env.local.get<unknown[]>("queue")) ?? []).length; i++) await env.ctl.flush();
};
/** A paired controller with one tab on `slug` and a started session, all synced to the fake dashboard. */
async function started(env: Env, tabId = 1, slug = "two-sum") {
  await env.ctl.setConfig({ token: "t" });
  await env.ctl.onPage(tabId, { slug });
  const { sessionId } = await env.ctl.startSession(tabId);
  await drain(env);
  return sessionId!;
}
const srv = (id: string, over: Partial<ExtensionSessionState> = {}) =>
  ({ id, status: "in_progress", outcome: null, endedAt: null, activeMs: 0, submissions: [], ...over }) as ExtensionSessionState;
const localSession = async (env: Env, id: string) => (await env.local.get<Record<string, LocalSession>>("sessions"))?.[id];
const sentTypes = (env: Env) => env.sent.map((e) => e.type);

describe("Controller session actions", () => {
  it("abandon: ends the session, quiets the tab, tells the dashboard once; a stale second abandon does nothing", async () => {
    const env = setup();
    const id = await started(env);
    env.advance(5_000);
    // The fake dashboard keeps no sessions of its own: give it the copy it would have (abandon reconciles afterwards).
    env.state.serverSessions[id] = srv(id, { status: "abandoned", endedAt: env.now() });
    await env.ctl.abandon(id);
    expect(await localSession(env, id)).toMatchObject({ status: "abandoned", endedAt: env.now() });
    expect(await env.ctl.tabState(1)).toMatchObject({ mode: "ignored", sessionId: null });
    await drain(env);
    expect(env.sent.filter((e) => e.type === "session.abandon")).toEqual([expect.objectContaining({ payload: { sessionId: id, at: env.now() } })]);
    await env.ctl.abandon(id);
    await env.ctl.abandon("no-such-session"); // unknown id: ignored, never throws
    await drain(env);
    expect(env.sent.filter((e) => e.type === "session.abandon")).toHaveLength(1);
    expect((await env.ctl.panelState(1)).recentlyFinished).toMatchObject({ id, status: "abandoned" });
  });

  it("an ended session can no longer be paused, resumed or finished", async () => {
    const env = setup();
    const id = await started(env);
    env.state.serverSessions[id] = srv(id, { status: "abandoned", endedAt: env.now() });
    await env.ctl.abandon(id);
    await drain(env);
    const before = env.sent.length;
    await env.ctl.pause(id);
    await env.ctl.resume(id);
    await env.ctl.finish(id, { outcome: "independent", hintsUsed: false });
    await drain(env);
    expect(env.sent).toHaveLength(before);
    expect((await localSession(env, id))!.status).toBe("abandoned");
  });

  it("resume (unpause): a paused session goes back to in_progress and the dashboard hears pause then resume", async () => {
    const env = setup();
    const id = await started(env);
    await env.ctl.pause(id);
    expect((await localSession(env, id))!.status).toBe("paused");
    env.advance(30_000);
    await env.ctl.resume(id);
    expect((await localSession(env, id))!.status).toBe("in_progress");
    await drain(env);
    expect(sentTypes(env).filter((t) => t === "session.pause" || t === "session.resume")).toEqual(["session.pause", "session.resume"]);
    expect(env.sent.find((e) => e.type === "session.resume")!.payload).toEqual({ sessionId: id, at: env.now() });
    // The tab stays bound throughout.
    expect(await env.ctl.tabState(1)).toMatchObject({ mode: "bound", sessionId: id });
  });

  it("ignore: the tab goes quiet but keeps its problem; an unknown tab gives null and creates nothing", async () => {
    const env = setup();
    await env.ctl.setConfig({ token: "t" });
    await env.ctl.onPage(1, { slug: "two-sum" });
    expect(await env.ctl.ignore(1)).toMatchObject({ mode: "ignored", slug: "two-sum" });
    expect(await env.ctl.tabState(1)).toMatchObject({ mode: "ignored", slug: "two-sum" });
    // A refresh of the same problem keeps it ignored (no re-offer).
    expect(await env.ctl.onPage(1, { slug: "two-sum" })).toMatchObject({ mode: "ignored" });
    expect(await env.ctl.ignore(77)).toBeNull();
    expect(await env.ctl.tabState(77)).toBeNull();
    await drain(env);
    expect(env.sent).toHaveLength(0);
  });

  it("onTabClosed: forgets the tab but not its session; reopening the problem offers to resume it", async () => {
    const env = setup();
    const id = await started(env);
    await env.ctl.onTabClosed(1);
    expect(await env.ctl.tabState(1)).toBeNull();
    expect((await localSession(env, id))!.status).toBe("in_progress");
    expect(await env.ctl.onPage(5, { slug: "two-sum" })).toMatchObject({ mode: "offer", resumable: { id, source: "local" } });
    // Closing a tab it never saw is harmless.
    await env.ctl.onTabClosed(404);
    expect(await env.ctl.tabState(404)).toBeNull();
  });
});

describe("Controller reconcile", () => {
  it("a session start the dashboard rejects is marked missingOnServer, and reconcile then never asks about it", async () => {
    const env = setup();
    await env.ctl.setConfig({ token: "t" });
    env.api.sendEvents = async (events) => ({ ok: true, data: { results: (events as { id: string }[]).map((e) => ({ id: e.id, status: "rejected" as const, error: "bad problem" })) } });
    const asked: string[] = [];
    const realSession = env.api.session;
    env.api.session = async (id) => {
      asked.push(id);
      return realSession(id);
    };
    await env.ctl.onPage(1, { slug: "two-sum" });
    const { sessionId } = await env.ctl.startSession(1);
    await drain(env);
    expect(await localSession(env, sessionId!)).toMatchObject({ missingOnServer: true, status: "in_progress" });
    expect((await env.ctl.panelState(1)).failed).toEqual([expect.objectContaining({ error: "bad problem", event: expect.objectContaining({ type: "session.start" }) })]);
    await env.ctl.reconcile();
    expect(asked).toEqual([]);
    // Not read as "deleted": still there and bound.
    expect(await env.ctl.tabState(1)).toMatchObject({ mode: "bound", sessionId });
    expect(await localSession(env, sessionId!)).toBeDefined();
  });

  it("the dashboard says completed or abandoned: local status, outcome and end time follow, and the tab goes quiet", async () => {
    const env = setup();
    const a = await started(env, 1, "two-sum");
    const b = await started(env, 2, "3sum");
    env.state.serverSessions[a] = srv(a, { status: "completed", outcome: "independent", endedAt: 12345 });
    env.state.serverSessions[b] = srv(b, { status: "abandoned", endedAt: 6789 });
    await env.ctl.reconcile();
    expect(await localSession(env, a)).toMatchObject({ status: "completed", outcome: "independent", endedAt: 12345 });
    expect(await localSession(env, b)).toMatchObject({ status: "abandoned", endedAt: 6789 });
    expect(await env.ctl.tabState(1)).toMatchObject({ mode: "ignored", sessionId: null });
    expect(await env.ctl.tabState(2)).toMatchObject({ mode: "ignored", sessionId: null });
  });

  it("mirrors paused and in_progress from the dashboard without unbinding the tab", async () => {
    const env = setup();
    const id = await started(env);
    env.state.serverSessions[id] = srv(id, { status: "paused" });
    await env.ctl.reconcile();
    expect((await localSession(env, id))!.status).toBe("paused");
    expect(await env.ctl.tabState(1)).toMatchObject({ mode: "bound", sessionId: id });
    env.state.serverSessions[id] = srv(id, { status: "in_progress" });
    await env.ctl.reconcile();
    expect((await localSession(env, id))!.status).toBe("in_progress");
    expect(await env.ctl.tabState(1)).toMatchObject({ mode: "bound", sessionId: id });
  });

  it("skips sessions with events still waiting to be sent (its own changes win)", async () => {
    const env = setup();
    const id = await started(env);
    env.state.online = false;
    await env.ctl.pause(id); // queued, not delivered
    env.state.online = true;
    env.state.serverSessions[id] = srv(id, { status: "in_progress" });
    await env.ctl.reconcile();
    expect((await localSession(env, id))!.status).toBe("paused");
  });

  it("a session deleted in the dashboard is forgotten and its tab is offered a fresh start, once the dashboard answers the ping", async () => {
    const env = setup();
    const id = await started(env);
    // (the fake has no server copy of it: the session call answers "not found")
    await env.ctl.reconcile();
    expect(await localSession(env, id)).toBeUndefined();
    expect(await env.ctl.tabState(1)).toMatchObject({ mode: "offer", sessionId: null });
    expect((await env.ctl.panelState(1)).conn.status).toBe("ok");
  });

  it("pings only once per pass to confirm 'not found' for several sessions", async () => {
    const env = setup();
    const a = await started(env, 1, "two-sum");
    const b = await started(env, 2, "3sum");
    let pings = 0;
    const realPing = env.api.ping;
    env.api.ping = async () => {
      pings++;
      return realPing();
    };
    await env.ctl.reconcile();
    expect(pings).toBe(1);
    expect(await localSession(env, a)).toBeUndefined();
    expect(await localSession(env, b)).toBeUndefined();
  });

  it("'not found' while the ping fails (outage, not our dashboard) keeps the session and reports offline", async () => {
    const env = setup();
    const id = await started(env);
    env.api.session = async () => ({ ok: true, data: null });
    env.api.ping = async () => ({ ok: false, error: { kind: "offline", message: "down" } });
    await env.ctl.reconcile();
    expect(await localSession(env, id)).toMatchObject({ status: "in_progress" });
    expect(await env.ctl.tabState(1)).toMatchObject({ mode: "bound", sessionId: id });
    expect((await env.ctl.panelState(1)).conn).toMatchObject({ status: "offline", lastError: expect.stringMatching(/did not answer/) });
  });

  it("'not found' while the ping answers something else (not our dashboard) keeps the session", async () => {
    const env = setup();
    const id = await started(env);
    env.api.session = async () => ({ ok: true, data: null });
    env.api.ping = async () => ({ ok: true, data: { ok: false } as unknown as { ok: true; serverTime: number } });
    await env.ctl.reconcile();
    expect(await localSession(env, id)).toBeDefined();
    expect((await env.ctl.panelState(1)).conn.status).toBe("offline");
  });

  it("a failure partway through a pass keeps what the earlier sessions already taught it", async () => {
    const env = setup();
    const a = await started(env, 1, "two-sum");
    const b = await started(env, 2, "3sum");
    env.state.serverSessions[a] = srv(a, { status: "completed", outcome: "independent", endedAt: 4242 });
    const realSession = env.api.session;
    env.api.session = async (id) => (id === b ? { ok: false, error: { kind: "offline", message: "down" } } : realSession(id));
    await env.ctl.reconcile();
    expect(await localSession(env, a)).toMatchObject({ status: "completed", outcome: "independent", endedAt: 4242 });
    expect(await env.ctl.tabState(1)).toMatchObject({ mode: "ignored", sessionId: null });
    // The one it could not reach is untouched, and the dashboard is reported unreachable.
    expect(await localSession(env, b)).toMatchObject({ status: "in_progress" });
    expect(await env.ctl.tabState(2)).toMatchObject({ mode: "bound", sessionId: b });
    expect((await env.ctl.panelState(2)).conn.status).toBe("offline");
  });

  it("an unauthorized answer mid-pass is reported as such", async () => {
    const env = setup();
    await started(env);
    env.api.session = async () => ({ ok: false, error: { kind: "unauthorized", message: "token rejected" } });
    await env.ctl.reconcile();
    expect((await env.ctl.panelState(1)).conn).toMatchObject({ status: "unauthorized", lastError: "token rejected" });
  });

  it("forgets finished sessions a day after they ended, but never an open one", async () => {
    const env = setup();
    const done = await started(env, 1, "two-sum");
    const open = await started(env, 2, "3sum");
    await env.ctl.finish(done, { outcome: "independent", hintsUsed: false });
    await drain(env);
    const endedAt = env.now();
    env.state.serverSessions[done] = srv(done, { status: "completed", outcome: "independent", endedAt });
    env.state.serverSessions[open] = srv(open, { status: "in_progress" });
    env.advance(23 * 3_600_000);
    await env.ctl.reconcile();
    expect(await localSession(env, done)).toBeDefined();
    env.advance(2 * 3_600_000);
    await env.ctl.reconcile();
    expect(await localSession(env, done)).toBeUndefined();
    expect(await localSession(env, open)).toMatchObject({ status: "in_progress" });
  });
});

describe("httpApi", () => {
  afterEach(() => vi.useRealTimers());

  type Call = { url: string; init: RequestInit };
  function mk(respond: (call: Call) => Response | Promise<Response>, cfg: Partial<ApiConfig> = {}) {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const call = { url, init };
      calls.push(call);
      return respond(call);
    }) as unknown as typeof fetch;
    const api = httpApi(async () => ({ serverUrl: "http://127.0.0.1:4317", token: "tok", version: "9.9.9", ...cfg }), fetchImpl);
    return { api, calls };
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const status = (n: number) => new Response("", { status: n });

  it("sends the token and version, joins the URL without doubled slashes, and encodes path parts", async () => {
    const { api, calls } = mk(() => json({ ok: true, serverTime: 1 }), { serverUrl: "http://127.0.0.1:4317///" });
    expect(await api.ping()).toEqual({ ok: true, data: { ok: true, serverTime: 1 } });
    await api.context("two sum/x");
    await api.session("a b");
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:4317/api/ext/ping",
      "http://127.0.0.1:4317/api/ext/context?slug=two%20sum%2Fx",
      "http://127.0.0.1:4317/api/ext/sessions/a%20b",
    ]);
    expect(calls[0]!.init.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer tok", "X-LCC-Version": "9.9.9" });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("posts events and lists as JSON bodies", async () => {
    const { api, calls } = mk(() => json({ results: [] }));
    await api.sendEvents([{ id: "e1" }]);
    await api.importList({ slug: "s" });
    expect(calls[0]).toMatchObject({ url: "http://127.0.0.1:4317/api/ext/events", init: { method: "POST", body: JSON.stringify({ events: [{ id: "e1" }] }) } });
    expect(calls[1]).toMatchObject({ url: "http://127.0.0.1:4317/api/ext/lists", init: { method: "POST", body: JSON.stringify({ list: { slug: "s" } }) } });
  });

  it("without a token it says unauthorized and never calls fetch", async () => {
    const { api, calls } = mk(() => json({}), { token: "" });
    expect(await api.ping()).toMatchObject({ ok: false, error: { kind: "unauthorized" } });
    expect(await api.sendEvents([])).toMatchObject({ ok: false, error: { kind: "unauthorized" } });
    expect(calls).toHaveLength(0);
  });

  it("maps statuses: 401 unauthorized, 5xx server, other 4xx bad_request, 2xx data", async () => {
    let code = 200;
    const { api } = mk(() => (code === 200 ? json({ ok: true, serverTime: 0 }) : status(code)));
    const kinds: Record<number, string> = {};
    for (const c of [401, 400, 403, 404, 409, 422, 500, 502, 503]) {
      code = c;
      const r = await api.ping();
      kinds[c] = r.ok ? "ok" : r.error.kind;
    }
    expect(kinds).toEqual({ 401: "unauthorized", 400: "bad_request", 403: "bad_request", 404: "bad_request", 409: "bad_request", 422: "bad_request", 500: "server", 502: "server", 503: "server" });
    code = 503;
    expect(await api.ping()).toEqual({ ok: false, error: { kind: "server", message: "Dashboard error 503" } });
    code = 409;
    expect(await api.ping()).toEqual({ ok: false, error: { kind: "bad_request", message: "Request failed (409)" } });
  });

  it("404 is 'no such session' (ok, null) only for the session lookup; 401/5xx still win there", async () => {
    let code = 404;
    const { api } = mk(() => status(code));
    expect(await api.session("x")).toEqual({ ok: true, data: null });
    expect(await api.context("two-sum")).toMatchObject({ ok: false, error: { kind: "bad_request" } });
    code = 401;
    expect(await api.session("x")).toMatchObject({ ok: false, error: { kind: "unauthorized" } });
    code = 500;
    expect(await api.session("x")).toMatchObject({ ok: false, error: { kind: "server" } });
  });

  it("a thrown fetch is offline, with the error's message (or a generic one)", async () => {
    let boom: unknown = new TypeError("Failed to fetch");
    const { api } = mk(() => {
      throw boom;
    });
    expect(await api.ping()).toEqual({ ok: false, error: { kind: "offline", message: "Failed to fetch" } });
    boom = "weird";
    expect(await api.ping()).toEqual({ ok: false, error: { kind: "offline", message: "Network error" } });
  });

  it("a request that hangs is aborted after 8 s and reported offline", async () => {
    vi.useFakeTimers();
    const { api } = mk(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal!.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        }),
    );
    const p = api.ping();
    await vi.advanceTimersByTimeAsync(7_999);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ ok: false, error: { kind: "offline" } });
  });

  it("an unparseable 200 body is reported offline instead of throwing", async () => {
    const { api } = mk(() => new Response("<html>not json</html>", { status: 200 }));
    expect(await api.ping()).toMatchObject({ ok: false, error: { kind: "offline" } });
  });
});

describe("content-script permission gate", () => {
  const ID = "abcdefghijklmnopabcdefghijklmnop";
  const ALL: BgRequest["type"][] = [
    "page", "heartbeat", "intercepted", "start", "resume", "ignore", "pause", "unpause", "notes", "finish", "abandon", "panel:get", "panel:input",
    "sync:now", "sync:retry", "list:import", "config:get", "config:set", "ping", "open-dashboard",
  ];
  const web = "https://leetcode.com/problems/two-sum/";

  it("web-page senders may send only page, heartbeat, intercepted, start, resume, ignore and open-dashboard", () => {
    expect(ALL.filter((t) => isAllowedMessage(t, web, ID)).sort()).toEqual(["heartbeat", "ignore", "intercepted", "open-dashboard", "page", "resume", "start"]);
    expect([...CONTENT_SCRIPT_MESSAGES].sort()).toEqual(["heartbeat", "ignore", "intercepted", "open-dashboard", "page", "resume", "start"]);
  });

  it("the sensitive messages (token, settings, sync, finishing) are refused from a web page", () => {
    for (const t of ["config:get", "config:set", "sync:now", "sync:retry", "finish", "abandon", "pause", "unpause", "notes", "list:import", "panel:get"] as const) {
      expect(isAllowedMessage(t, web, ID)).toBe(false);
    }
  });

  it("extension pages (side panel, options) may send everything", () => {
    for (const t of ALL) expect(isAllowedMessage(t, `chrome-extension://${ID}/sidepanel.html`, ID)).toBe(true);
  });

  it("senders without an address, or pretending to be an extension page, get no extra rights", () => {
    expect(isAllowedMessage("config:get", undefined, ID)).toBe(false);
    expect(isAllowedMessage("config:get", `chrome-extension://otherextensionid/page.html`, ID)).toBe(false);
    expect(isAllowedMessage("config:get", `chrome-extension://${ID}`, ID)).toBe(false); // no path: not a page of ours
    expect(isAllowedMessage("config:get", `https://evil.example/chrome-extension://${ID}/x`, ID)).toBe(false);
    expect(isAllowedMessage("config:get", `https://evil.example/?u=chrome-extension://${ID}/`, ID)).toBe(false);
    expect(isAllowedMessage("page", undefined, ID)).toBe(true);
  });
});
