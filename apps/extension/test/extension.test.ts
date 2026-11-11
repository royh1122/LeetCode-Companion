import { describe, expect, it } from "vitest";
import { parseProblemSlug, type ExtensionContext, type ExtensionSessionState } from "@lcc/shared";
import { applyHeartbeat, isActive } from "../src/lib/activity";
import type { Api } from "../src/lib/api";
import { Controller } from "../src/lib/controller";
import { interpret, isInterceptedMessage, studyPlanFromNextData } from "../src/lib/intercept";
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
  const state = { online: opts.online ?? true, failNext: false, serverSessions: {} as Record<string, ExtensionSessionState>, contextOverride: null as Partial<ExtensionContext> | null, poison: null as string | null };
  const api = {
    async ping() {
      return state.online ? { ok: true, data: { ok: true, serverTime: 0 } } : { ok: false, error: { kind: "offline", message: "down" } };
    },
    async context(slug) {
      if (!state.online) return { ok: false, error: { kind: "offline", message: "down" } };
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
      if (!state.online) return { ok: false, error: { kind: "offline", message: "down" } };
      return { ok: true, data: state.serverSessions[id] ?? null };
    },
    async sendEvents(events) {
      if (!state.online) return { ok: false, error: { kind: "offline", message: "down" } };
      if ((events as { type: string }[]).some((e) => e.type === state.poison)) return { ok: false, error: { kind: "server", message: "Dashboard error 500" } };
      return {
        ok: true,
        data: {
          results: (events as { id: string; type: string; payload: Record<string, unknown> }[]).map((e) => {
            if (seenIds.has(e.id)) return { id: e.id, status: "duplicate" as const };
            seenIds.add(e.id);
            sent.push(e);
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

function setup(o: Parameters<typeof fakeApi>[0] = {}) {
  let t = 1_000_000;
  let n = 0;
  const local = new MemoryKV();
  const ephemeral = new MemoryKV();
  const fa = fakeApi(o);
  const mk = () => new Controller({ local, ephemeral, api: fa.api, now: () => t, uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` });
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
    expect(first).toEqual({ sessionId, notes: "hash map" });
    await env.ctl.setNotes(sessionId!, { timeComplexity: "O(n)" });
    await env.ctl.setNotes(sessionId!, { spaceComplexity: "O(n)" });
    for (let i = 0; i < 10 && ((await env.local.get<unknown[]>("queue")) ?? []).length; i++) await env.ctl.flush();
    // Coalesced into one snapshot carrying every known field.
    expect(env.sent.filter((e) => e.type === "session.notes").at(-1)!.payload).toEqual({ sessionId, notes: "hash map", timeComplexity: "O(n)", spaceComplexity: "O(n)" });
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
    expect((await env.ctl.panelState(1)).failed.map((f) => f.event.type)).toEqual(["session.notes"]);
    // Being offline never counts against an event.
    env.state.online = false;
    await env.ctl.onPage(1, { slug: "3sum" });
    const second = await env.ctl.startSession(1);
    for (let i = 0; i < 12; i++) await env.ctl.flush();
    env.state.online = true;
    for (let i = 0; i < 10 && ((await env.local.get<unknown[]>("queue")) ?? []).length; i++) await env.ctl.flush();
    expect(env.sent.filter((e) => e.type === "session.start").map((e) => e.payload.sessionId)).toContain(second.sessionId);
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
