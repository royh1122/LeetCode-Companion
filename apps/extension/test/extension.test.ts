import { describe, expect, it } from "vitest";
import { parseProblemSlug, type ExtensionContext, type ExtensionSessionState } from "@lcc/shared";
import { applyHeartbeat, isActive } from "../src/lib/activity";
import type { Api } from "../src/lib/api";
import { ensureSyncAlarm } from "../src/lib/alarms";
import { Controller, isLeetCodeUrl } from "../src/lib/controller";
import { interpret, isInterceptedMessage, studyPlanFromNextData } from "../src/lib/intercept";
import { pageTitle } from "../src/lib/page-info";
import { MemoryKV } from "../src/lib/storage";
import * as F from "./fixtures";

describe("problem identification", () => {
  it("parses slugs from all problem URL shapes", () => {
    expect(parseProblemSlug("https://leetcode.com/problems/two-sum/")).toBe("two-sum");
    expect(parseProblemSlug("https://leetcode.com/problems/two-sum/description/")).toBe("two-sum");
    expect(parseProblemSlug("https://leetcode.com/problems/two-sum/submissions/1234/")).toBe("two-sum");
    expect(parseProblemSlug("https://leetcode.com/problems/two-sum")).toBe("two-sum");
    expect(parseProblemSlug("https://leetcode.com/problems/two-sum/?envType=study-plan-v2#lcc-session=abc")).toBe("two-sum");
    expect(parseProblemSlug("https://leetcode.com/problemset/")).toBeNull();
    expect(parseProblemSlug("https://leetcode.com/studyplan/leetcode-75/")).toBeNull();
    expect(parseProblemSlug("https://evil.example/problems/two-sum/")).toBeNull();
  });
});

describe("interpret (MAIN-world capture logic)", () => {
  it("distinguishes Submit from Run", () => {
    const s = interpret("POST", "https://leetcode.com/problems/two-sum/submit/", F.SUBMIT_BODY, F.SUBMIT_RESPONSE);
    expect(s).toMatchObject({ type: "submit", slug: "two-sum", submissionId: "1234567890", lang: "python3", questionId: "1" });
    expect(s && "code" in s && s.code).toContain("twoSum");
    const r = interpret("POST", "https://leetcode.com/problems/two-sum/interpret_solution/", F.RUN_BODY, JSON.stringify(F.RUN_RESPONSE));
    expect(r).toMatchObject({ type: "run", interpretId: F.RUN_RESPONSE.interpret_id });
  });
  it("only reports finished judge results, with normalized verdicts", () => {
    const url = "https://leetcode.com/submissions/detail/1234567890/check/";
    expect(interpret("GET", url, null, F.CHECK_PENDING)).toBeNull();
    expect(interpret("GET", url, null, F.CHECK_STARTED)).toBeNull();
    expect(interpret("GET", url, null, F.CHECK_ACCEPTED)).toMatchObject({ type: "check", kind: "submit", result: { verdict: "Accepted", runtime: "3 ms", totalCorrect: 63 } });
    expect(interpret("GET", url, null, F.CHECK_WRONG)).toMatchObject({ result: { verdict: "Wrong Answer", details: { expectedOutput: "[1,2]" } } });
    expect(interpret("GET", url, null, F.CHECK_TLE)).toMatchObject({ result: { verdict: "Time Limit Exceeded" } });
    expect(interpret("GET", url, null, F.CHECK_CE)).toMatchObject({ result: { verdict: "Compile Error", details: { compileError: expect.stringContaining("expected") } } });
    expect(interpret("GET", "https://leetcode.com/submissions/detail/runcode_1731100000.123456_abcd/check/", null, F.CHECK_RUN_DONE)).toMatchObject({ kind: "run" });
  });
  it("parses the real /v2/check/ endpoint observed on leetcode.com", () => {
    const res = interpret("GET", "https://leetcode.com/submissions/detail/1000000001/v2/check/", null, JSON.stringify(F.CHECK_WRONG_REAL_V2));
    expect(res).toMatchObject({
      type: "check",
      id: "1000000001",
      kind: "submit",
      result: { verdict: "Wrong Answer", statusCode: 11, runtime: null, memory: null, totalCorrect: 24, totalTestcases: 129, lang: "python3", questionId: "1146", finishedAt: 1700000000000, details: { expectedOutput: '"AB"', codeOutput: '"ABAB"' } },
    });
    expect(interpret("GET", "https://leetcode.com/submissions/detail/runcode_1794267588.8536685_eXrkOxkbtA/v2/check/", null, F.CHECK_RUN_DONE)).toMatchObject({ kind: "run" });
  });
  it("ignores unrelated or changed endpoints instead of guessing", () => {
    expect(interpret("POST", "https://leetcode.com/graphql/", "{}", {})).toBeNull();
    expect(interpret("GET", "https://leetcode.com/problems/two-sum/submit/", null, {})).toBeNull();
    expect(interpret("POST", "https://leetcode.com/problems/two-sum/submit/v2/", F.SUBMIT_BODY, F.SUBMIT_RESPONSE)).toBeNull();
    // Changed response shape → still recorded, but with no id (server uses fingerprint identity).
    expect(interpret("POST", "https://leetcode.com/problems/two-sum/submit/", F.SUBMIT_BODY, { id: 5 })).toMatchObject({ submissionId: null });
    expect(interpret("GET", "https://leetcode.com/submissions/detail/1/check/", null, "not json")).toBeNull();
    expect(interpret("GET", "https://leetcode.com/submissions/detail/1/check/", null, { state: "SUCCESS", status_msg: "Something New" })).toMatchObject({ result: { verdict: "Unknown" } });
  });
  it("reads a study plan from the page's own GraphQL response, and nothing else", () => {
    const m = interpret("POST", "https://leetcode.com/graphql/", F.STUDY_PLAN_REQUEST, F.STUDY_PLAN_RESPONSE);
    expect(m).toMatchObject({ type: "studyplan", list: { slug: "top-interview-150", name: "Top Interview 150" } });
    const list = (m as { list: { planSubGroups: { name: string; questions: { titleSlug: string; difficulty: string }[] }[] } }).list;
    expect(list.planSubGroups[0]!.name).toBe("Array / String");
    expect(list.planSubGroups[0]!.questions.map((q) => [q.titleSlug, q.difficulty])).toEqual([["merge-sorted-array", "EASY"], ["remove-element", "EASY"]]);
    expect(interpret("POST", "https://leetcode.com/graphql/", F.OTHER_GRAPHQL_REQUEST, { data: { surveyV2: { showSurvey: false } } })).toBeNull();
    // Only the study-plan request is read, whatever page it happens on.
    expect(interpret("POST", "https://leetcode.com/graphql/", F.OTHER_GRAPHQL_REQUEST, F.STUDY_PLAN_RESPONSE)).toBeNull();
    expect(interpret("GET", "https://leetcode.com/graphql/", F.STUDY_PLAN_REQUEST, F.STUDY_PLAN_RESPONSE)).toBeNull();
    expect(isInterceptedMessage({ __lcc: true, payload: m })).toBe(true);
    expect(isInterceptedMessage({ __lcc: true, payload: { type: "studyplan", list: { slug: "x", name: "x", planSubGroups: [{ questions: [{}] }] } } })).toBe(false);
  });

  it("reads the plan LeetCode embeds in a fully loaded study-plan page, only for the plan in the address bar", () => {
    expect(studyPlanFromNextData(F.STUDY_PLAN_NEXT_DATA, "/studyplan/top-interview-150/")).toMatchObject({ slug: "top-interview-150", name: "Top Interview 150" });
    expect(studyPlanFromNextData(F.STUDY_PLAN_NEXT_DATA, "/studyplan/top-interview-150")!.planSubGroups[0]!.questions).toHaveLength(2);
    // After in-app navigation to another plan, the embedded data is stale: ignore it.
    expect(studyPlanFromNextData(F.STUDY_PLAN_NEXT_DATA, "/studyplan/leetcode-75/")).toBeNull();
    expect(studyPlanFromNextData(F.STUDY_PLAN_NEXT_DATA, "/problems/two-sum/")).toBeNull();
    expect(studyPlanFromNextData("not json", "/studyplan/top-interview-150/")).toBeNull();
    expect(studyPlanFromNextData(undefined, "/studyplan/top-interview-150/")).toBeNull();
  });

  it("validates page messages", () => {
    expect(isInterceptedMessage({ __lcc: true, ready: true })).toBe(true);
    expect(isInterceptedMessage({ __lcc: true, payload: { type: "submit", slug: "two-sum", code: "x" } })).toBe(true);
    expect(isInterceptedMessage({ __lcc: true, payload: { type: "check", id: "1", result: { verdict: "Accepted" } } })).toBe(true);
    // Forged or malformed messages from the page are dropped before they reach the service worker.
    expect(isInterceptedMessage({ __lcc: true, payload: { type: "submit" } })).toBe(false);
    expect(isInterceptedMessage({ __lcc: true, payload: { type: "check", id: "1" } })).toBe(false);
    expect(isInterceptedMessage({ __lcc: true, payload: { type: "run", slug: "two-sum", code: "x".repeat(200_001) } })).toBe(false);
    expect(isInterceptedMessage({ payload: { type: "submit" } })).toBe(false);
    expect(isInterceptedMessage({ __lcc: true, payload: { type: "steal" } })).toBe(false);
  });
});

describe("activity estimation", () => {
  const s0 = { activeMs: 0, lastTickAt: null, lastActive: false, lastTabId: null };
  it("credits only intervals that started active and are short", () => {
    let s = applyHeartbeat(s0, 1, 1000, true);
    s = applyHeartbeat(s, 1, 16_000, true);
    expect(s.activeMs).toBe(15_000);
    s = applyHeartbeat(s, 1, 31_000, false); // went idle: interval 16→31 still credited (was active at 16)
    expect(s.activeMs).toBe(30_000);
    s = applyHeartbeat(s, 1, 46_000, true); // idle interval not credited
    expect(s.activeMs).toBe(30_000);
    s = applyHeartbeat(s, 1, 46_000 + 3_600_000, true); // browser closed for an hour → gap not credited
    expect(s.activeMs).toBe(30_000);
  });
  it("is not double-counted or interrupted by a second background tab", () => {
    let s = applyHeartbeat(s0, 1, 0, true);
    s = applyHeartbeat(s, 2, 5_000, false); // other tab, hidden
    s = applyHeartbeat(s, 1, 15_000, true);
    expect(s.activeMs).toBe(15_000);
  });
  it("respects the idle threshold", () => {
    expect(isActive({ visible: true, focused: true, lastInputAt: 0 }, 299_000, 300)).toBe(true);
    expect(isActive({ visible: true, focused: true, lastInputAt: 0 }, 301_000, 300)).toBe(false);
    expect(isActive({ visible: false, focused: true, lastInputAt: 0 }, 1, 300)).toBe(false);
  });
});

// ---------- controller ----------
function fakeApi(opts: { online?: boolean; context?: Partial<ExtensionContext> } = {}) {
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

function setup(o: Parameters<typeof fakeApi>[0] & { queueMaxChars?: number } = {}) {
  let t = 1_000_000;
  let n = 0;
  const local = new MemoryKV();
  const ephemeral = new MemoryKV();
  const fa = fakeApi(o);
  const mk = () =>
    new Controller({ local, ephemeral, api: fa.api, now: () => t, uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, queueMaxChars: o.queueMaxChars });
  return { ...fa, local, ephemeral, mk, ctl: mk(), advance: (ms: number) => (t += ms), now: () => t };
}

describe("Controller", () => {
  it("stops saying 'unreachable' once the dashboard answers again, even with nothing to sync", async () => {
    const env = setup({ online: false });
    await env.ctl.setConfig({ token: "t" });
    await env.ctl.onPage(1, { slug: "two-sum" });
    expect((await env.ctl.panelState(1)).conn.status).toBe("offline");
    await env.ctl.reconcile();
    expect((await env.ctl.panelState(1)).conn.status).toBe("offline");
    env.state.online = true;
    await env.ctl.flush();
    await env.ctl.reconcile();
    expect((await env.ctl.panelState(1)).conn.status).toBe("ok");
  });

  it("offers a study plan the page loaded, and imports it only when asked", async () => {
    const env = setup();
    await env.ctl.setConfig({ token: "t" });
    await env.ctl.onPage(1, { slug: null });
    const m = interpret("POST", "https://leetcode.com/graphql/", F.STUDY_PLAN_REQUEST, F.STUDY_PLAN_RESPONSE)!;
    await env.ctl.onIntercepted(1, m);
    expect(env.imported).toHaveLength(0);
    expect((await env.ctl.panelState(1)).studyPlan).toMatchObject({ slug: "top-interview-150", name: "Top Interview 150", count: 2, status: "new" });
    expect((await env.ctl.panelState(2)).studyPlan).toBeNull();
    env.state.online = false;
    expect(await env.ctl.importStudyPlan(1)).toMatchObject({ status: "error", message: expect.stringMatching(/unreachable/) });
    env.state.online = true;
    expect(await env.ctl.importStudyPlan(1)).toMatchObject({ status: "imported" });
    expect(env.imported).toHaveLength(1);
    // The page re-sending the same plan keeps the "imported" state.
    await env.ctl.onIntercepted(1, m);
    expect((await env.ctl.panelState(1)).studyPlan!.status).toBe("imported");
  });

  it("binds the tab to the dashboard's session from the URL hash; refresh keeps it; no duplicate start", async () => {
    const env = setup();
    await env.ctl.setConfig({ token: "t" });
    const sid = "11111111-2222-4333-8444-555555555555";
    const t1 = await env.ctl.onPage(7, { slug: "two-sum", hashSessionId: sid });
    expect(t1).toMatchObject({ mode: "bound", sessionId: sid });
    const t2 = await env.ctl.onPage(7, { slug: "two-sum" }); // refresh (hash gone)
    expect(t2).toMatchObject({ mode: "bound", sessionId: sid });
    await env.ctl.flush();
    expect(env.sent.filter((e) => e.type === "session.start")).toHaveLength(0); // dashboard already created it
  });

  it("offers instead of auto-creating; Start creates exactly one session; second tab shares it", async () => {
    const env = setup();
    await env.ctl.setConfig({ token: "t" });
    expect(await env.ctl.onPage(1, { slug: "two-sum" })).toMatchObject({ mode: "offer", sessionId: null });
    const bound = await env.ctl.startSession(1);
    await env.ctl.startSession(1);
    expect((await env.ctl.onPage(2, { slug: "two-sum" })).sessionId).toBe(bound.sessionId);
    await env.ctl.flush();
    expect(env.sent.filter((e) => e.type === "session.start")).toHaveLength(1);
    expect(env.sent[0]!.payload.problem).toMatchObject({ slug: "two-sum", title: "Two Sum", frontendId: "1" });
  });

  it("ignores forged page messages: verdicts for submissions it never saw, submits for another problem", async () => {
    const env = setup();
    await env.ctl.setConfig({ token: "t" });
    await env.ctl.onPage(1, { slug: "two-sum" });
    await env.ctl.startSession(1);
    await env.ctl.onIntercepted(1, interpret("GET", "https://leetcode.com/submissions/detail/1234567890/check/", null, F.CHECK_ACCEPTED)!);
    await env.ctl.onIntercepted(1, interpret("POST", "https://leetcode.com/problems/3sum/submit/", F.SUBMIT_BODY, F.SUBMIT_RESPONSE)!);
    for (let i = 0; i < 5; i++) await env.ctl.flush();
    expect(env.sent.filter((e) => e.type === "submission.result" || e.type === "submission.captured")).toHaveLength(0);
    expect((await env.ctl.panelState(1)).session!.submissions).toHaveLength(0);
  });

  it("only ever talks to a dashboard on this computer", async () => {
    const env = setup();
    await expect(env.ctl.setConfig({ serverUrl: "https://evil.example.com" })).rejects.toThrow(/this computer/);
    await expect(env.ctl.setConfig({ serverUrl: "http://127.0.0.1:4320" })).resolves.toMatchObject({ serverUrl: "http://127.0.0.1:4320" });
  });

  it("captures submit + result into the bound session, once, ignoring repeated polls", async () => {
    const env = setup();
    await env.ctl.setConfig({ token: "t" });
    await env.ctl.onPage(1, { slug: "two-sum" });
    const { sessionId } = await env.ctl.startSession(1);
    const sub = interpret("POST", "https://leetcode.com/problems/two-sum/submit/", F.SUBMIT_BODY, F.SUBMIT_RESPONSE)!;
    const res = interpret("GET", "https://leetcode.com/submissions/detail/1234567890/check/", null, F.CHECK_ACCEPTED)!;
    await env.ctl.onIntercepted(1, sub);
    await env.ctl.onIntercepted(1, res);
    await env.ctl.onIntercepted(1, res); // LeetCode polls check repeatedly
    await env.ctl.flush();
    const caps = env.sent.filter((e) => e.type === "submission.captured");
    const results = env.sent.filter((e) => e.type === "submission.result");
    expect(caps).toHaveLength(1);
    expect(caps[0]!.payload).toMatchObject({ sessionId, kind: "submit", platformSubmissionId: "1234567890", code: expect.stringContaining("twoSum") });
    expect(results).toHaveLength(1);
    expect(results[0]!.payload).toMatchObject({ sessionId, verdict: "Accepted" });
    const panel = await env.ctl.panelState(1);
    expect(panel.session!.submissions).toEqual([expect.objectContaining({ verdict: "Accepted", kind: "submit" })]);
  });

  it("forgets sessions and submissions deleted in the dashboard, but never unsynced ones", async () => {
    const env = setup();
    await env.ctl.setConfig({ token: "t" });
    await env.ctl.onPage(1, { slug: "two-sum" });
    const { sessionId } = await env.ctl.startSession(1);
    await env.ctl.onIntercepted(1, interpret("POST", "https://leetcode.com/problems/two-sum/submit/", F.SUBMIT_BODY, { submission_id: 111 })!);
    await env.ctl.onIntercepted(1, interpret("POST", "https://leetcode.com/problems/two-sum/submit/", F.SUBMIT_BODY, { submission_id: 222 })!);
    await env.ctl.finish(sessionId!, { outcome: "independent", hintsUsed: false });
    // Captures kick off background syncs; drain until everything has reached the server.
    for (let i = 0; i < 10 && ((await env.local.get<unknown[]>("queue")) ?? []).length; i++) await env.ctl.flush();
    const sub = (pid: string, verdict: string) => ({ id: Number(pid), verdict, kind: "submit" as const, submittedAt: 0, platformSubmissionId: pid });
    // Server still has the session, but one submission was deleted there and the other got its verdict.
    env.state.serverSessions[sessionId!] = { id: sessionId!, status: "completed", outcome: "independent", endedAt: env.now(), activeMs: 0, submissions: [sub("222", "Accepted")] } as ExtensionSessionState;
    await env.ctl.reconcile();
    const fin = (await env.ctl.panelState(1)).recentlyFinished!;
    expect(fin.submissions).toEqual([expect.objectContaining({ platformId: "222", verdict: "Accepted" })]);
    // Session deleted in the dashboard → the panel stops showing it.
    delete env.state.serverSessions[sessionId!];
    await env.ctl.reconcile();
    expect((await env.ctl.panelState(1)).recentlyFinished).toBeNull();

    // A session started while the dashboard is down is unknown to the server but must be kept.
    env.state.online = false;
    const offline = await env.ctl.startSession(1);
    env.state.online = true;
    // Queue not flushed yet: reconcile must skip it, not treat the 404 as "deleted".
    await env.ctl.reconcile();
    expect((await env.ctl.panelState(1)).session?.id).toBe(offline.sessionId);
  });

  it("after finishing, the tab goes quiet (no re-offer) and problem info refreshes once synced", async () => {
    const env = setup();
    await env.ctl.setConfig({ token: "t" });
    await env.ctl.onPage(1, { slug: "two-sum" });
    expect((await env.ctl.panelState(1)).tab!.context!.problem!.sessionCount).toBe(0);
    const { sessionId } = await env.ctl.startSession(1);
    env.advance(60_000);
    await env.ctl.finish(sessionId!, { outcome: "independent", hintsUsed: false });
    expect(await env.ctl.tabState(1)).toMatchObject({ mode: "ignored", sessionId: null });
    // A refresh of the same problem keeps it quiet.
    expect(await env.ctl.onPage(1, { slug: "two-sum" })).toMatchObject({ mode: "ignored" });
    // Once synced, the server reports the session and reconcile refreshes the stale "first time" info.
    for (let i = 0; i < 10 && ((await env.local.get<unknown[]>("queue")) ?? []).length; i++) await env.ctl.flush();
    env.state.serverSessions[sessionId!] = { id: sessionId!, status: "completed", outcome: "independent", endedAt: env.now(), activeMs: 0, submissions: [] } as ExtensionSessionState;
    env.state.contextOverride = { problem: { id: 1, slug: "two-sum", title: "Two Sum", frontendId: "1", difficulty: "Easy", patterns: [], mastery: "improving", sessionCount: 1, lastPracticedAt: env.now(), nextReviewDate: "2026-11-16" } } as Partial<ExtensionContext>;
    env.advance(1_000);
    await env.ctl.reconcile();
    const panel = await env.ctl.panelState(1);
    expect(panel.tab!.context!.problem!.sessionCount).toBe(1);
    expect(panel.recentlyFinished).toMatchObject({ id: sessionId, status: "completed" });
    // Opening a different problem behaves normally (offer).
    expect(await env.ctl.onPage(1, { slug: "3sum" })).toMatchObject({ mode: "offer" });
  });

  it("time/space complexity: sent only once known, so an untouched panel never blanks the dashboard's", async () => {
    const env = setup();
    await env.ctl.setConfig({ token: "t" });
    await env.ctl.onPage(1, { slug: "two-sum" });
    const { sessionId } = await env.ctl.startSession(1);
    await env.ctl.setNotes(sessionId!, { notes: "hash map" });
    for (let i = 0; i < 10 && ((await env.local.get<unknown[]>("queue")) ?? []).length; i++) await env.ctl.flush();
    const first = env.sent.filter((e) => e.type === "session.notes").at(-1)!.payload;
    expect(first).toEqual({ sessionId, notes: "hash map", base: { notes: "" } });
    await env.ctl.setNotes(sessionId!, { timeComplexity: "O(n)" });
    await env.ctl.setNotes(sessionId!, { spaceComplexity: "O(n)" });
    for (let i = 0; i < 10 && ((await env.local.get<unknown[]>("queue")) ?? []).length; i++) await env.ctl.flush();
    // Coalesced into one event carrying the fields edited since the last one was sent. The notes
    // were not touched again, so they are not sent again (the dashboard may have newer ones).
    const last = env.sent.filter((e) => e.type === "session.notes").at(-1)!.payload;
    expect(last).toMatchObject({ sessionId, timeComplexity: "O(n)", spaceComplexity: "O(n)", base: { spaceComplexity: "" } });
    expect(last).not.toHaveProperty("notes");
    await env.ctl.finish(sessionId!, { outcome: "independent", hintsUsed: false, spaceComplexity: "O(1)" });
    for (let i = 0; i < 10 && ((await env.local.get<unknown[]>("queue")) ?? []).length; i++) await env.ctl.flush();
    expect(env.sent.find((e) => e.type === "session.finish")!.payload.reflection).toMatchObject({ spaceComplexity: "O(1)" });
    expect((await env.ctl.panelState(1)).recentlyFinished).toMatchObject({ timeComplexity: "O(n)", spaceComplexity: "O(1)" });
  });

  it("does not attribute submissions for a different problem, or when no session is bound", async () => {
    const env = setup();
    await env.ctl.setConfig({ token: "t" });
    await env.ctl.onPage(1, { slug: "two-sum" });
    await env.ctl.startSession(1);
    await env.ctl.onIntercepted(1, interpret("POST", "https://leetcode.com/problems/3sum/submit/", F.SUBMIT_BODY, { submission_id: 9 })!);
    await env.ctl.onPage(2, { slug: "add-two-numbers" });
    await env.ctl.onIntercepted(2, interpret("POST", "https://leetcode.com/problems/add-two-numbers/submit/", F.SUBMIT_BODY, { submission_id: 10 })!);
    await env.ctl.flush();
    for (const c of env.sent.filter((e) => e.type === "submission.captured")) expect(c.payload.sessionId).toBeNull();
  });

  it("queues offline, survives a service-worker restart, then syncs in order exactly once", async () => {
    const env = setup({ online: false });
    await env.ctl.setConfig({ token: "t" });
    expect(await env.ctl.onPage(1, { slug: "two-sum", title: "Two Sum" })).toMatchObject({ mode: "offer", context: null });
    const { sessionId } = await env.ctl.startSession(1);
    await env.ctl.onIntercepted(1, interpret("POST", "https://leetcode.com/problems/two-sum/submit/", F.SUBMIT_BODY, F.SUBMIT_RESPONSE)!);
    await env.ctl.setNotes(sessionId!, { notes: "draft" });
    await env.ctl.setNotes(sessionId!, { notes: "final notes" });
    await env.ctl.finish(sessionId!, { outcome: "independent", hintsUsed: false });
    expect(await env.ctl.flush()).toMatchObject({ sent: 0 });
    expect((await env.ctl.panelState(1)).conn.status).toBe("offline");

    // Worker restart: brand-new controller over the same storage.
    env.state.online = true;
    const ctl2 = env.mk();
    await ctl2.flush();
    const types = env.sent.map((e) => e.type);
    expect(types[0]).toBe("session.start");
    expect(types.indexOf("session.finish")).toBeGreaterThan(types.indexOf("submission.captured"));
    expect(types.filter((x) => x === "session.notes")).toHaveLength(1); // coalesced
    expect(env.sent.find((e) => e.type === "session.notes")!.payload.notes).toBe("final notes");
    expect((await ctl2.panelState(1)).queueLength).toBe(0);
    expect((await ctl2.panelState(1)).conn.status).toBe("ok");
    // Flushing again sends nothing new.
    const before = env.sent.length;
    await ctl2.flush();
    expect(env.sent.length).toBe(before);
  });

  it("tracks active time from heartbeats and sends cumulative snapshots", async () => {
    const env = setup();
    await env.ctl.setConfig({ token: "t" });
    await env.ctl.onPage(1, { slug: "two-sum" });
    const { sessionId } = await env.ctl.startSession(1);
    for (let i = 0; i < 9; i++) {
      await env.ctl.onHeartbeat(1, { visible: true, focused: true, lastInputAt: env.now(), captureReady: true });
      env.advance(15_000);
    }
    await env.ctl.pause(sessionId!);
    await env.ctl.onHeartbeat(1, { visible: true, focused: true, lastInputAt: env.now(), captureReady: true });
    env.advance(15_000);
    await env.ctl.onHeartbeat(1, { visible: true, focused: true, lastInputAt: env.now(), captureReady: true });
    const p = await env.ctl.panelState(1);
    expect(p.session!.activity.activeMs).toBe(120_000);
    expect(p.tab!.captureReady).toBe(true);
    await env.ctl.flush();
    const acts = env.sent.filter((e) => e.type === "session.activity");
    expect(acts.length).toBeGreaterThan(0);
    expect(acts[acts.length - 1]!.payload.activeMs).toBeLessThanOrEqual(120_000);
    // A paused tab left open keeps sending heartbeats but must not keep reporting activity.
    for (let i = 0; i < 10 && ((await env.local.get<unknown[]>("queue")) ?? []).length; i++) await env.ctl.flush();
    const before = env.sent.filter((e) => e.type === "session.activity").length;
    for (let i = 0; i < 20; i++) {
      env.advance(15_000);
      await env.ctl.onHeartbeat(1, { visible: true, focused: true, lastInputAt: env.now(), captureReady: true });
    }
    for (let i = 0; i < 10 && ((await env.local.get<unknown[]>("queue")) ?? []).length; i++) await env.ctl.flush();
    expect(env.sent.filter((e) => e.type === "session.activity")).toHaveLength(before);
  });

  it("an event the server keeps failing on is set aside so the rest of the queue still syncs", async () => {
    const env = setup();
    await env.ctl.setConfig({ token: "t" });
    await env.ctl.onPage(1, { slug: "two-sum" });
    const { sessionId } = await env.ctl.startSession(1);
    for (let i = 0; i < 10 && ((await env.local.get<unknown[]>("queue")) ?? []).length; i++) await env.ctl.flush();
    env.state.poison = "session.notes";
    await env.ctl.setNotes(sessionId!, { notes: "the server chokes on this" });
    await env.ctl.finish(sessionId!, { outcome: "independent", hintsUsed: false });
    for (let i = 0; i < 20 && ((await env.local.get<unknown[]>("queue")) ?? []).length; i++) await env.ctl.flush();
    expect(env.sent.some((e) => e.type === "session.finish")).toBe(true);
    const panel = await env.ctl.panelState(1);
    expect(panel.failed.map((f) => f.event.type)).toEqual(["session.notes"]);
    // It keeps its data in the worker (the panel only gets the type and the error) and can be sent again.
    expect(panel.failed[0]!.event.payload).toEqual({});
    expect(panel.retryable).toBe(1);
    env.state.poison = null;
    expect(await env.ctl.retryFailed()).toBe(1);
    for (let i = 0; i < 10 && ((await env.local.get<unknown[]>("queue")) ?? []).length; i++) await env.ctl.flush();
    expect(env.sent.find((e) => e.type === "session.notes")!.payload.notes).toBe("the server chokes on this");
    expect(await env.ctl.panelState(1)).toMatchObject({ failed: [], retryable: 0, queueLength: 0 });
    // Being offline never counts against an event.
    env.state.online = false;
    await env.ctl.onPage(1, { slug: "3sum" });
    const second = await env.ctl.startSession(1);
    for (let i = 0; i < 12; i++) await env.ctl.flush();
    env.state.online = true;
    for (let i = 0; i < 10 && ((await env.local.get<unknown[]>("queue")) ?? []).length; i++) await env.ctl.flush();
    expect(env.sent.filter((e) => e.type === "session.start").map((e) => e.payload.sessionId)).toContain(second.sessionId);
  });

  it("a dashboard that keeps answering with errors never costs an event", async () => {
    const env = setup();
    await env.ctl.setConfig({ token: "t" });
    await env.ctl.onPage(1, { slug: "two-sum" });
    env.state.broken = true; // e.g. rebuilt underneath itself, or its database is locked
    const { sessionId } = await env.ctl.startSession(1);
    await env.ctl.onIntercepted(1, interpret("POST", "https://leetcode.com/problems/two-sum/submit/", F.SUBMIT_BODY, F.SUBMIT_RESPONSE)!);
    await env.ctl.setNotes(sessionId!, { notes: "written during the outage" });
    await env.ctl.finish(sessionId!, { outcome: "independent", hintsUsed: false });
    const queued = ((await env.local.get<unknown[]>("queue")) ?? []).length;
    expect(queued).toBeGreaterThanOrEqual(4);
    // Far more failed attempts than it takes to set a single bad event aside.
    for (let i = 0; i < 40; i++) await env.ctl.flush();
    await env.ctl.reconcile();
    expect(((await env.local.get<unknown[]>("queue")) ?? []).length).toBe(queued);
    expect(await env.ctl.panelState(1)).toMatchObject({ failed: [], retryable: 0, conn: { status: "offline" } });
    // The session is still known locally (reconcile must not read the outage as "deleted").
    expect((await env.ctl.panelState(1)).recentlyFinished?.id).toBe(sessionId);

    env.state.broken = false;
    for (let i = 0; i < 10 && ((await env.local.get<unknown[]>("queue")) ?? []).length; i++) await env.ctl.flush();
    const types = env.sent.map((e) => e.type);
    expect(types[0]).toBe("session.start");
    expect(types).toEqual(expect.arrayContaining(["submission.captured", "session.notes", "session.finish"]));
    expect(env.sent.find((e) => e.type === "submission.captured")!.payload.code).toContain("twoSum");
    expect(env.sent.find((e) => e.type === "session.notes")!.payload.notes).toBe("written during the outage");
    expect((await env.ctl.panelState(1)).queueLength).toBe(0);
  });

  it("another program on the dashboard's address neither drops events nor makes it forget sessions", async () => {
    const env = setup();
    await env.ctl.setConfig({ token: "t" });
    await env.ctl.onPage(1, { slug: "two-sum" });
    const { sessionId } = await env.ctl.startSession(1);
    for (let i = 0; i < 10 && ((await env.local.get<unknown[]>("queue")) ?? []).length; i++) await env.ctl.flush();
    // The dashboard is stopped and something else now answers there, with 404 for every path.
    env.state.notOurs = true;
    await env.ctl.reconcile();
    expect((await env.ctl.panelState(1)).session?.id).toBe(sessionId);
    await env.ctl.setNotes(sessionId!, { notes: "kept" });
    for (let i = 0; i < 20; i++) await env.ctl.flush();
    await env.ctl.reconcile();
    expect(await env.ctl.panelState(1)).toMatchObject({ session: { id: sessionId }, failed: [], queueLength: 1 });
    env.state.notOurs = false;
    for (let i = 0; i < 10 && ((await env.local.get<unknown[]>("queue")) ?? []).length; i++) await env.ctl.flush();
    expect(env.sent.find((e) => e.type === "session.notes")!.payload.notes).toBe("kept");
  });

  it("shows notes typed in the dashboard, and an untouched notes box never overwrites them", async () => {
    const env = setup();
    await env.ctl.setConfig({ token: "t" });
    await env.ctl.onPage(1, { slug: "two-sum" });
    const { sessionId } = await env.ctl.startSession(1);
    for (let i = 0; i < 10 && ((await env.local.get<unknown[]>("queue")) ?? []).length; i++) await env.ctl.flush();
    env.state.serverSessions[sessionId!] = { id: sessionId!, status: "in_progress", outcome: null, endedAt: null, activeMs: 0, notes: "typed in the dashboard", timeComplexity: null, spaceComplexity: null, submissions: [] };
    await env.ctl.reconcile();
    expect((await env.ctl.panelState(1)).session).toMatchObject({ notes: "typed in the dashboard" });
    // Only the complexity is edited in the panel: the event must not carry the notes at all.
    await env.ctl.setNotes(sessionId!, { timeComplexity: "O(n)" });
    for (let i = 0; i < 10 && ((await env.local.get<unknown[]>("queue")) ?? []).length; i++) await env.ctl.flush();
    expect(env.sent.filter((e) => e.type === "session.notes").at(-1)!.payload).toEqual({ sessionId, timeComplexity: "O(n)", base: { timeComplexity: "" } });
    // While an edit of ours is still waiting to be sent, the dashboard's copy must not replace it.
    env.state.online = false;
    await env.ctl.setNotes(sessionId!, { notes: "typed in the panel" });
    env.state.online = true;
    await env.ctl.reconcile();
    expect((await env.ctl.panelState(1)).session).toMatchObject({ notes: "typed in the panel" });
  });

  it("offers to resume an open session after the browser restarts (tabs forgotten)", async () => {
    const env = setup();
    await env.ctl.setConfig({ token: "t" });
    await env.ctl.onPage(1, { slug: "two-sum" });
    const { sessionId } = await env.ctl.startSession(1);
    env.ephemeral.data.clear(); // browser restart clears session storage
    const ctl2 = env.mk();
    const t = await ctl2.onPage(42, { slug: "two-sum" });
    expect(t).toMatchObject({ mode: "offer", resumable: { id: sessionId, source: "local" } });
    expect((await ctl2.resumeSession(42, sessionId!)).sessionId).toBe(sessionId);
  });

  it("offers to resume a session that is open on the server (started from the dashboard)", async () => {
    const env = setup({ context: { openSession: { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", type: "srs_review", status: "in_progress", startedAt: 5, activeMs: 1000, notes: "n", timeComplexity: "O(n)", spaceComplexity: null, isReview: true } } });
    await env.ctl.setConfig({ token: "t" });
    const t = await env.ctl.onPage(3, { slug: "two-sum" });
    expect(t.resumable).toMatchObject({ source: "server" });
    const b = await env.ctl.startSession(3); // "start" on a server-open problem resumes it instead of duplicating
    expect(b.sessionId).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    await env.ctl.flush();
    expect(env.sent.filter((e) => e.type === "session.start")).toHaveLength(0);
  });

  it("SPA navigation to another problem unbinds; unsupported pages go idle", async () => {
    const env = setup();
    await env.ctl.setConfig({ token: "t" });
    await env.ctl.onPage(1, { slug: "two-sum" });
    await env.ctl.startSession(1);
    expect(await env.ctl.onPage(1, { slug: "3sum" })).toMatchObject({ mode: "offer", sessionId: null });
    expect(await env.ctl.onPage(1, { slug: null })).toMatchObject({ mode: "idle" });
  });
});

describe("milestone F: extension robustness", () => {
  const drain = async (env: ReturnType<typeof setup>) => {
    for (let i = 0; i < 10 && ((await env.local.get<unknown[]>("queue")) ?? []).length; i++) await env.ctl.flush();
  };
  const plan = () => interpret("POST", "https://leetcode.com/graphql/", F.STUDY_PLAN_REQUEST, F.STUDY_PLAN_RESPONSE)!;

  it("F1/F4: a tab that leaves LeetCode is unbound, and closed or departed tabs drop their study plan", async () => {
    expect(isLeetCodeUrl("https://leetcode.com/problems/two-sum/")).toBe(true);
    expect(isLeetCodeUrl("https://www.google.com/search?q=leetcode.com")).toBe(false);
    expect(isLeetCodeUrl("http://127.0.0.1:4317/")).toBe(false);
    // Chrome hides the address of pages the extension has no access to: that is not LeetCode.
    expect(isLeetCodeUrl(undefined)).toBe(false);
    const env = setup();
    await env.ctl.setConfig({ token: "t" });
    await env.ctl.onPage(1, { slug: "two-sum" });
    const { sessionId } = await env.ctl.startSession(1);
    await env.ctl.onIntercepted(1, plan());
    await env.ctl.onTabLeft(1);
    expect(await env.ctl.tabState(1)).toMatchObject({ mode: "idle", slug: null, sessionId: null });
    expect((await env.ctl.panelState(1)).studyPlan).toBeNull();
    // The session itself is kept: coming back to the problem offers to resume it.
    expect(await env.ctl.onPage(1, { slug: "two-sum" })).toMatchObject({ mode: "offer", resumable: { id: sessionId, source: "local" } });
    await env.ctl.onIntercepted(2, plan());
    await env.ctl.onTabClosed(2);
    expect(await env.ephemeral.get("studyPlans")).toEqual({});
    // A tab it never saw stays unknown.
    await env.ctl.onTabLeft(99);
    expect(await env.ctl.tabState(99)).toBeNull();
  });

  it("F3: the sync alarm is created when the worker starts without one, and only then", async () => {
    const made: string[] = [];
    let existing: object | undefined;
    const alarms = {
      get: async () => existing,
      create: async (name: string) => {
        made.push(name);
        existing = {};
      },
    };
    await ensureSyncAlarm(alarms);
    await ensureSyncAlarm(alarms);
    expect(made).toEqual(["lcc-sync"]);
  });

  it("F5: a full offline queue drops activity first, then the oldest code, and says so", async () => {
    const env = setup({ online: false, queueMaxChars: 6_000 });
    await env.ctl.setConfig({ token: "t" });
    await env.ctl.onPage(1, { slug: "two-sum" });
    await env.ctl.startSession(1);
    await env.ctl.onHeartbeat(1, { visible: true, focused: true, lastInputAt: env.now(), captureReady: true });
    expect(((await env.local.get<{ event: { type: string } }[]>("queue")) ?? []).map((x) => x.event.type)).toContain("session.activity");
    const sub = (n: number) => ({ type: "submit" as const, slug: "two-sum", submissionId: String(n), lang: "python3", questionId: "1", code: `# ${n}\n${"x".repeat(1500)}` });
    for (let n = 1; n <= 5; n++) {
      env.advance(1000);
      await env.ctl.onIntercepted(1, sub(n));
    }
    const q = (await env.local.get<{ event: { type: string; payload: Record<string, unknown> } }[]>("queue"))!;
    expect(JSON.stringify(q).length).toBeLessThanOrEqual(6_000);
    expect(q.map((x) => x.event.type)).toEqual(["session.start", ...Array<string>(5).fill("submission.captured")]);
    const codes = q.filter((x) => x.event.type === "submission.captured").map((x) => x.event.payload.code as string | null);
    expect(codes[0]).toBeNull();
    expect(codes.at(-1)).toContain("# 5");
    expect((await env.ctl.panelState(1)).queueWarning).toMatchObject({ codeDropped: codes.filter((c) => c === null).length, dropped: 0 });
    // Once everything has reached the dashboard, the warning goes away.
    env.state.online = true;
    await drain(env);
    expect((await env.ctl.panelState(1)).queueWarning).toBeNull();
  });

  it("F7: only accepts a plain http dashboard address (the extension may not call https://localhost)", async () => {
    const env = setup();
    await expect(env.ctl.setConfig({ serverUrl: "https://localhost:4317" })).rejects.toThrow(/this computer/);
    await expect(env.ctl.setConfig({ serverUrl: "http://localhost:4317" })).resolves.toMatchObject({ serverUrl: "http://localhost:4317" });
  });

  it("F9: after in-app navigation the previous problem's title is not used; the real one fills in later", async () => {
    expect(pageTitle("1. Two Sum - LeetCode", null)).toEqual({ frontendId: "1", title: "Two Sum" });
    // The address already shows the new problem but the tab title is still the old one.
    expect(pageTitle("1. Two Sum - LeetCode", "1. Two Sum - LeetCode")).toEqual({ frontendId: null, title: null });
    expect(pageTitle("15. 3Sum - LeetCode", "1. Two Sum - LeetCode")).toEqual({ frontendId: "15", title: "3Sum" });
    const env = setup({ context: { problem: null } }); // a problem the dashboard doesn't know yet
    await env.ctl.setConfig({ token: "t" });
    await env.ctl.onPage(1, { slug: "3sum", title: null, frontendId: null });
    await env.ctl.onPage(1, { slug: "3sum", title: "3Sum", frontendId: "15" });
    await env.ctl.startSession(1);
    await drain(env);
    expect(env.sent.find((e) => e.type === "session.start")!.payload.problem).toMatchObject({ slug: "3sum", title: "3Sum", frontendId: "15" });
  });

  it("F10: a fractional finish time is rounded, so the dashboard accepts the verdict", () => {
    const url = "https://leetcode.com/submissions/detail/1000000001/v2/check/";
    expect(interpret("GET", url, null, { ...F.CHECK_WRONG_REAL_V2, task_finish_time: 1700000000123.6 })).toMatchObject({ result: { finishedAt: 1700000000124 } });
    expect(interpret("GET", url, null, { ...F.CHECK_WRONG_REAL_V2, task_finish_time: 1700000000.5 })).toMatchObject({ result: { finishedAt: 1700000000500 } });
  });

  it("F11: typing in the side panel counts as active time", async () => {
    const env = setup();
    await env.ctl.setConfig({ token: "t" });
    await env.ctl.onPage(1, { slug: "two-sum" });
    await env.ctl.startSession(1);
    // The page has had no input for a while and has lost focus to the panel.
    const page = () => ({ visible: true, focused: false, lastInputAt: env.now() - 400_000, captureReady: true });
    for (let i = 0; i < 3; i++) {
      await env.ctl.onPanelInput(1);
      await env.ctl.onHeartbeat(1, page());
      env.advance(15_000);
    }
    expect((await env.ctl.panelState(1)).session!.activity.activeMs).toBe(30_000);
    // Without panel input, the same heartbeats are idle.
    env.advance(120_000);
    await env.ctl.onHeartbeat(1, page());
    env.advance(15_000);
    await env.ctl.onHeartbeat(1, page());
    expect((await env.ctl.panelState(1)).session!.activity.activeMs).toBe(30_000);
  });

  it("F12: panel edits carry what the dashboard last had, and newer dashboard text is kept", async () => {
    const env = setup();
    await env.ctl.setConfig({ token: "t" });
    await env.ctl.onPage(1, { slug: "two-sum" });
    const { sessionId } = await env.ctl.startSession(1);
    await env.ctl.setNotes(sessionId!, { notes: "v1" });
    await drain(env);
    expect(env.sent.filter((e) => e.type === "session.notes").at(-1)!.payload).toEqual({ sessionId, notes: "v1", base: { notes: "" } });
    // Two edits while offline coalesce; the base stays what the dashboard had before the first.
    env.state.online = false;
    await env.ctl.setNotes(sessionId!, { notes: "v2" });
    await env.ctl.setNotes(sessionId!, { notes: "v3", timeComplexity: "O(n)" });
    env.state.online = true;
    env.state.conflictWith = { notes: "typed in the dashboard meanwhile" };
    await drain(env);
    expect(env.sent.filter((e) => e.type === "session.notes").at(-1)!.payload).toEqual({ sessionId, notes: "v3", timeComplexity: "O(n)", base: { notes: "v1", timeComplexity: "" } });
    // The dashboard kept both; the panel now shows what it stored and flags it.
    const s = (await env.ctl.panelState(1)).session!;
    expect(s).toMatchObject({ notes: "typed in the dashboard meanwhile", timeComplexity: "O(n)" });
    expect(s.conflictAt).toBe(env.now());
    await env.ctl.setNotes(sessionId!, { notes: "v4" });
    await drain(env);
    expect(env.sent.filter((e) => e.type === "session.notes").at(-1)!.payload).toEqual({ sessionId, notes: "v4", base: { notes: "typed in the dashboard meanwhile" } });
  });
});
