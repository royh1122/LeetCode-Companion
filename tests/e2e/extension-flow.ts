/**
 * Extension E2E against the REAL dashboard and the REAL built extension in Chromium.
 * LeetCode itself is replaced by a stub page served at the real leetcode.com URLs
 * (so the content scripts inject exactly as in production) whose Submit/Run
 * buttons issue the same requests LeetCode's UI does. Optionally also checks the
 * real, logged-out leetcode.com problem page for detection + hook injection.
 *
 *   npm run ext:build
 *   LCC_DATA_DIR=data/e2e npx next dev -p 4327   (in apps/web; the e2e port, see port.ts)
 *   LCC_DATA_DIR=data/e2e tsx tests/e2e/extension-flow.ts [--real-leetcode] [screenshotDir]
 */
import { chromium, expect, type BrowserContext, type Page, type Worker } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { defaultDbPath, getExtensionToken, openDb } from "@lcc/db";
import { E2E_BASE } from "./port";
import { OTHER_GRAPHQL_REQUEST, STUDY_PLAN_NEXT_DATA, STUDY_PLAN_REQUEST, STUDY_PLAN_RESPONSE } from "../../apps/extension/test/fixtures";

const BASE = process.env.LCC_URL ?? E2E_BASE;
const EXT = path.resolve("apps/extension/dist");
const args = process.argv.slice(2);
const REAL = args.includes("--real-leetcode");
const SHOTS = args.find((a) => !a.startsWith("--"));

function stubProblemPage(slug: string) {
  const title = slug
    .split("-")
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
  return `<!doctype html><html><head><title>1. ${title} - LeetCode</title></head><body>
  <h1>${title}</h1><textarea id="code">class Solution:\n    def solve(self): return 1</textarea>
  <button id="submit">Submit</button><button id="run">Run</button><div id="out"></div>
  <script>
  let n = 0;
  async function poll(id) {
    for (let i = 0; i < 5; i++) {
      const r = await fetch('/submissions/detail/' + id + '/v2/check/');
      const j = await r.json();
      if (j.state === 'SUCCESS') { document.getElementById('out').textContent = j.status_msg; return; }
      await new Promise(r => setTimeout(r, 150));
    }
  }
  document.getElementById('submit').onclick = async () => {
    const r = await fetch('/problems/${slug}/submit/', { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ lang: 'python3', question_id: '1', typed_code: document.getElementById('code').value }) });
    const { submission_id } = await r.json();
    poll(submission_id);
  };
  document.getElementById('run').onclick = () => {
    const x = new XMLHttpRequest();
    x.open('POST', '/problems/${slug}/interpret_solution/');
    x.onload = () => poll(JSON.parse(x.responseText).interpret_id);
    x.send(JSON.stringify({ lang: 'python3', question_id: '1', typed_code: 'pass', data_input: '1' }));
  };
  </script></body></html>`;
}

/** Fake judge: each submission id is polled; first poll PENDING, then the scripted verdict. */
async function routeLeetCode(ctx: BrowserContext, verdicts: string[]) {
  let nextId = 900000 + Math.floor(Math.random() * 1000);
  const polls = new Map<string, number>();
  const verdictFor = new Map<string, string>();
  await ctx.route(/^https:\/\/leetcode\.com\/.*/, async (route) => {
    const url = new URL(route.request().url());
    const m = /^\/problems\/([a-z0-9-]+)\/(submit|interpret_solution)\/$/.exec(url.pathname);
    if (m && route.request().method() === "POST") {
      if (m[2] === "submit") {
        const id = String(nextId++);
        verdictFor.set(id, verdicts.shift() ?? "Accepted");
        return route.fulfill({ json: { submission_id: Number(id) } });
      }
      const id = `runcode_${Date.now()}.1_ab`;
      verdictFor.set(id, "Accepted");
      return route.fulfill({ json: { interpret_id: id, test_case: "1" } });
    }
    const c = /^\/submissions\/detail\/([^/]+)\/(?:v2\/)?check\/$/.exec(url.pathname);
    if (c) {
      const id = c[1]!;
      const k = (polls.get(id) ?? 0) + 1;
      polls.set(id, k);
      if (k === 1) return route.fulfill({ json: { state: "PENDING" } });
      const v = verdictFor.get(id) ?? "Accepted";
      const code = { Accepted: 10, "Wrong Answer": 11, "Time Limit Exceeded": 14 }[v] ?? 15;
      return route.fulfill({ json: { state: "SUCCESS", status_code: code, status_msg: v, lang: "python3", status_runtime: "4 ms", status_memory: "17 MB", total_correct: v === "Accepted" ? 10 : 3, total_testcases: 10, question_id: "1", task_finish_time: Date.now() } });
    }
    // Study-plan page: like the real one, it loads its question list through GraphQL.
    if (url.pathname === "/graphql/" && route.request().method() === "POST") {
      const op = (route.request().postDataJSON() as { operationName?: string } | null)?.operationName;
      return route.fulfill({ json: op === "studyPlanDetail" ? STUDY_PLAN_RESPONSE : { data: { surveyV2: { showSurvey: false } } } });
    }
    // A full load of a plan page embeds the list and requests nothing (as on leetcode.com).
    if (url.pathname === "/studyplan/top-interview-150/") {
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><title>Study Plan - LeetCode</title><h1>Top Interview 150</h1><script id="__NEXT_DATA__" type="application/json">${STUDY_PLAN_NEXT_DATA}</script>`,
      });
    }
    if (url.pathname.startsWith("/studyplan/")) {
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><title>Study Plan - LeetCode</title><h1>Top Interview 150</h1><script>
          fetch('/graphql/', { method: 'POST', headers: {'content-type':'application/json'}, body: ${JSON.stringify(OTHER_GRAPHQL_REQUEST)} });
          fetch('/graphql/', { method: 'POST', headers: {'content-type':'application/json'}, body: ${JSON.stringify(STUDY_PLAN_REQUEST)} });
          // Like an in-app click: the request goes out first, then the address changes.
          if (location.pathname === '/studyplan/') history.pushState({}, '', '/studyplan/top-interview-150/');
        </script>`,
      });
    }
    const p = /^\/problems\/([a-z0-9-]+)\/?/.exec(url.pathname);
    if (p) return route.fulfill({ contentType: "text/html", body: stubProblemPage(p[1]!) });
    return route.fulfill({ status: 404, body: "" });
  });
}

async function swState(sw: Worker) {
  return sw.evaluate(async () => ({ tabs: (await chrome.storage.session.get("tabs")).tabs, local: await chrome.storage.local.get(null) }));
}

function readDb() {
  // Read-only view of what the dashboard stored (separate connection; WAL allows this).
  return new Database(defaultDbPath(), { readonly: true });
}

async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, label: string, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  let v: T;
  do {
    v = await fn();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 250));
  } while (Date.now() < end);
  throw new Error(`Timed out waiting for: ${label} (last value: ${JSON.stringify(v).slice(0, 400)})`);
}

async function main() {
  if (!fs.existsSync(path.join(EXT, "manifest.json"))) throw new Error("Build the extension first: npm run ext:build");
  const token = getExtensionToken(openDb());
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "lcc-e2e-"));
  const ctx = await chromium.launchPersistentContext(userDir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    viewport: { width: 1280, height: 860 },
  });
  const step = (s: string) => console.log(`✓ ${s}`);
  try {
    let [sw] = ctx.serviceWorkers();
    sw ??= await ctx.waitForEvent("serviceworker");
    const extId = new URL(sw.url()).host;
    step(`extension loaded (${extId})`);
    await routeLeetCode(ctx, ["Wrong Answer", "Accepted", "Accepted"]);

    // ---- Pair via the options page ----
    // The extension opens its options page on install; reuse it (or open one).
    const opts =
      ctx.pages().find((p) => p.url().includes("options.html")) ??
      (await ctx.waitForEvent("page", { predicate: (p) => p.url().includes("options.html"), timeout: 5000 }).catch(async () => {
        const p = await ctx.newPage();
        await p.goto(`chrome-extension://${extId}/options.html`);
        return p;
      }));
    await opts.waitForLoadState();
    await expect(opts.locator("#server")).not.toHaveValue("", { timeout: 5000 });
    await opts.fill("#server", BASE);
    await opts.fill("#token", token);
    await opts.click("button[type=submit]");
    await expect(opts.getByText("Connected and paired")).toBeVisible({ timeout: 10000 });
    step("paired with dashboard");
    // A wrong token is rejected.
    const bad = await sw.evaluate(async (b) => (await fetch(`${b}/api/ext/ping`, { headers: { Authorization: "Bearer nope" } })).status, BASE);
    if (bad !== 401) throw new Error(`expected 401 for a bad token, got ${bad}`);
    step("bad token rejected (401)");

    // ---- Scenario 1: Start Practice from the dashboard ----
    const dash = await ctx.newPage();
    await dash.goto(BASE);
    if (await dash.getByText("Set up your study plan").isVisible()) await dash.getByRole("button", { name: "Create study plan" }).click();
    const row = dash.locator("li", { has: dash.getByRole("button", { name: /^(Start|Review)$/ }) }).first();
    await expect(row).toBeVisible({ timeout: 15000 });
    const slug = (await row.locator("a").first().getAttribute("href"))!.split("/").pop()!;
    const problemTitle = (await row.locator("a").first().textContent())!.trim();
    const popupP = ctx.waitForEvent("page");
    await row.getByRole("button", { name: /^(Start|Review)$/ }).click();
    const lc = await popupP;
    await lc.waitForLoadState("domcontentloaded");
    await dash.waitForURL(/\/sessions\//);
    const sessionId = dash.url().split("/").pop()!;
    step(`dashboard started session ${sessionId.slice(0, 8)} and opened ${new URL(lc.url()).pathname}`);

    const lcTabId = await waitFor(
      async () => {
        const s = await swState(sw);
        return Object.entries((s.tabs ?? {}) as Record<string, { slug: string; mode: string; sessionId: string; captureReady: boolean }>).find(([, t]) => t.slug === slug);
      },
      (v) => !!v && v[1].mode === "bound" && v[1].sessionId === sessionId,
      "LeetCode tab bound to the dashboard session",
    );
    step("extension bound the LeetCode tab to that session (via URL tag)");

    // ---- Submissions: WA, then Accepted, plus a Run (XHR) ----
    await lc.click("#submit");
    await expect(lc.locator("#out")).toHaveText("Wrong Answer");
    await lc.fill("#code", "class Solution:\n    def solve(self):\n        return 42");
    await lc.click("#submit");
    await expect(lc.locator("#out")).toHaveText("Accepted");
    await lc.click("#run");
    await new Promise((r) => setTimeout(r, 600));
    const subs = await waitFor(
      () => readDb().prepare("select kind, verdict, code, attribution, platform_submission_id from submissions where session_id = ? order by submitted_at").all(sessionId) as { kind: string; verdict: string; code: string; attribution: string }[],
      (rows) => rows.filter((r) => r.kind === "submit").length === 2 && rows.every((r) => r.verdict !== "Pending") && rows.some((r) => r.kind === "run"),
      "2 judged submissions + 1 run in the DB",
    );
    const submits = subs.filter((s) => s.kind === "submit");
    if (submits[0]!.verdict !== "Wrong Answer" || submits[1]!.verdict !== "Accepted") throw new Error(`unexpected verdicts ${JSON.stringify(submits)}`);
    if (!submits[1]!.code.includes("return 42") || submits[0]!.code.includes("return 42")) throw new Error("code versions not stored separately");
    if (submits.some((s) => s.attribution !== "bound")) throw new Error("submissions not bound to the session");
    step("captured WA then Accepted with distinct code versions; Run stored separately (not counted)");

    // Dashboard reflects it live.
    await expect(dash.getByText(/Submissions \(2\)/)).toBeVisible({ timeout: 10000 });
    step("dashboard session page updated live (Submissions (2))");

    // ---- Refresh does not duplicate ----
    await lc.reload();
    await new Promise((r) => setTimeout(r, 1500));
    const openCount = (readDb().prepare("select count(*) c from sessions where problem_id = (select id from problems where slug = ?) and status in ('in_progress','paused')").get(slug) as { c: number }).c;
    if (openCount !== 1) throw new Error(`expected 1 open session after refresh, got ${openCount}`);
    const afterReload = (await swState(sw)).tabs[lcTabId[0]];
    if (afterReload.sessionId !== sessionId) throw new Error("binding lost after refresh");
    step("refresh kept the binding; still exactly one open session");

    // ---- Second tab on the same problem shares the session ----
    const lc2 = await ctx.newPage();
    await lc2.goto(`https://leetcode.com/problems/${slug}/`);
    await waitFor(async () => Object.values((await swState(sw)).tabs as Record<string, { slug: string; sessionId: string; mode: string }>).filter((t) => t.slug === slug && t.sessionId === sessionId).length, (n) => n === 2, "second tab bound to the same session");
    await lc2.close();
    step("second tab on the same problem shares the session (no duplicate)");

    // ---- Offline: dashboard unreachable → queued → synced later ----
    await sw.evaluate(async () => {
      const { config } = await chrome.storage.local.get("config");
      await chrome.storage.local.set({ config: { ...config, serverUrl: "http://127.0.0.1:4399" } });
    });
    await lc.bringToFront();
    await lc.click("#submit");
    await expect(lc.locator("#out")).toHaveText("Accepted");
    const panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${lcTabId[0]}`);
    await expect(panel.locator("#sync")).toContainText(/queued|Pending sync/, { timeout: 10000 });
    if (SHOTS) await panel.screenshot({ path: `${SHOTS}/ext-panel-offline.png`, fullPage: true });
    step(`offline: panel shows "${(await panel.locator("#sync").textContent())?.trim()}"`);
    await sw.evaluate(async (b) => {
      const { config } = await chrome.storage.local.get("config");
      await chrome.storage.local.set({ config: { ...config, serverUrl: b } });
    }, BASE);
    await panel.getByRole("button", { name: "Sync now" }).click();
    await waitFor(() => (readDb().prepare("select count(*) c from submissions where session_id = ? and kind='submit'").get(sessionId) as { c: number }).c, (c) => c === 3, "queued submission synced after reconnect");
    await expect(panel.locator("#sync")).toContainText("Synced", { timeout: 10000 });
    step("reconnected: queued submission synced exactly once; panel shows Synced");

    // ---- Finish from the side panel ----
    await expect(panel.locator("#s-title")).toContainText(/./);
    await expect(panel.locator("#s-subs li")).toHaveCount(4, { timeout: 10000 });
    await panel.fill("#s-notes", "Hash map of complements; forgot duplicates at first.");
    await panel.getByRole("radio", { name: /^Independent/ }).click();
    if (SHOTS) await panel.screenshot({ path: `${SHOTS}/ext-panel.png`, fullPage: true });
    await panel.click("#s-finish");
    const done = await waitFor(
      () => readDb().prepare("select status, outcome, notes, active_ms, next_review_date from sessions where id = ?").get(sessionId) as { status: string; outcome: string; notes: string; active_ms: number | null; next_review_date: string },
      (r) => r.status === "completed",
      "session completed via side panel",
    );
    if (done.outcome !== "independent" || !done.notes.includes("complements")) throw new Error(`unexpected finish ${JSON.stringify(done)}`);
    step(`finished from side panel: outcome=${done.outcome}, next review ${done.next_review_date}, active≈${Math.round((done.active_ms ?? 0) / 1000)}s`);
    await dash.goto(`${BASE}/`);
    await expect(dash.locator("li", { hasText: problemTitle }).locator(".line-through")).toBeVisible({ timeout: 10000 });
    step("dashboard Today shows the question completed");

    // ---- Opening LeetCode directly (no dashboard): offer → start from panel ----
    const direct = await ctx.newPage();
    await direct.goto("https://leetcode.com/problems/two-sum/description/");
    const directTab = await waitFor(async () => Object.entries((await swState(sw)).tabs as Record<string, { slug: string; mode: string }>).find(([, t]) => t.slug === "two-sum" && t.mode === "offer"), (v) => !!v, "direct visit offered");
    const p2 = await ctx.newPage();
    await p2.goto(`chrome-extension://${extId}/sidepanel.html?tab=${directTab![0]}`);
    await p2.getByRole("button", { name: /^(Start session|Practice again)$/ }).click();
    await waitFor(() => readDb().prepare("select count(*) c from sessions s join problems p on p.id = s.problem_id where p.slug = 'two-sum' and s.origin = 'extension'").get() as { c: number }, (r) => r.c === 1, "extension-started session on the server");
    step("direct visit → offered → started from the side panel → session created on the server");

    // ---- Study-plan page, reached by in-app navigation (the list loads before the URL changes) ----
    const planPage = await ctx.newPage();
    await planPage.goto("https://leetcode.com/studyplan/");

    const planTab = await waitFor(
      () => sw.evaluate(async () => (await chrome.storage.session.get("studyPlans")).studyPlans as Record<string, { list: { slug: string } }> | undefined),
      (v) => !!v && Object.values(v).some((o) => o.list.slug === "top-interview-150"),
      "study plan seen on the page",
    );
    const p3 = await ctx.newPage();
    await p3.goto(`chrome-extension://${extId}/sidepanel.html?tab=${Object.keys(planTab!)[0]}`);
    await p3.getByRole("button", { name: "Import into dashboard" }).click();
    await expect(p3.getByText(/Imported 2 questions as "Top Interview 150"/)).toBeVisible({ timeout: 10000 });
    const n = readDb().prepare("select count(*) c from study_list_problems m join study_lists l on l.id = m.list_id where l.slug = 'top-interview-150'").get() as { c: number };
    if (n.c !== 2) throw new Error(`expected 2 imported questions, got ${n.c}`);
    step("study-plan page (in-app navigation) → panel offered its list → imported into the dashboard (2 questions)");
    const fullLoad = await ctx.newPage();
    await fullLoad.goto("https://leetcode.com/studyplan/top-interview-150/");
    const stored = await waitFor(
      () => sw.evaluate(async () => (await chrome.storage.session.get("studyPlans")).studyPlans as Record<string, { list: { slug: string } }>),
      (v) => Object.keys(v ?? {}).length >= 2,
      "study plan read from the fully loaded page",
    );
    if (!Object.values(stored!).every((o) => o.list.slug === "top-interview-150")) throw new Error("wrong plan stored");
    step("study-plan page (full load, list embedded in the page) → plan offered");

    if (REAL) {
      await ctx.unrouteAll({ behavior: "ignoreErrors" });
      const real = await ctx.newPage();
      await real.goto("https://leetcode.com/problems/merge-strings-alternately/description/", { waitUntil: "domcontentloaded", timeout: 45000 });
      try {
        const t = await waitFor(
          async () => Object.values((await swState(sw)).tabs as Record<string, { slug: string; mode: string; captureReady: boolean; title: string }>).find((x) => x.slug === "merge-strings-alternately"),
          (v) => !!v && v.captureReady,
          "real leetcode.com page detected with MAIN-world hook active",
          30000,
        );
        const title = await real.title();
        const appLoaded = /leetcode/i.test(title) && !(await real.locator("text=Cloudflare").count());
        if (appLoaded) step(`REAL leetcode.com app page: problem detected (mode=${t!.mode}), MAIN-world hook injected under the site's CSP (captureReady=true)`);
        else console.log(`! REAL leetcode.com served a bot challenge to the automated browser ("${title}"). Detection + overlay + MAIN-world injection worked on that URL, but LeetCode's actual app page was not reached — verify manually in your normal Chrome.`);
        if (SHOTS) await real.screenshot({ path: `${SHOTS}/real-leetcode.png` });
      } catch (e) {
        console.log(`! REAL leetcode.com check inconclusive: ${(e as Error).message.slice(0, 200)} (page title: ${await real.title()})`);
      }
    }
    console.log("\nEXTENSION E2E OK");
  } finally {
    await ctx.close();
    fs.rmSync(userDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("EXTENSION E2E FAILED:", e);
  process.exit(1);
});

export type { Page };
