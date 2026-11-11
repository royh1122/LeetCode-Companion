/**
 * Side panel: the quick in-LeetCode workflow (timer, captured verdicts, notes,
 * confidence, finish). Works offline — actions queue and sync later — and is
 * explicit about sync state. Never claims "Synced" unless the queue is empty
 * and the last server contact succeeded.
 */
import { addDays, formatClock } from "@lcc/shared/dates";
import { OUTCOMES, OUTCOME_LABELS, type Outcome } from "@lcc/shared/enums";
import type { Controller } from "../lib/controller";
import { send } from "../lib/messages";

type PanelState = Awaited<ReturnType<Controller["panelState"]>>;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const main = $("main");
const section = $("session");
let state: PanelState | null = null;
let activeTabId: number | null = null;
let outcome: Outcome | null = null;
let notesTimer: ReturnType<typeof setTimeout> | null = null;
let renderedSessionId: string | null = null;
/** Text fields the panel edits, by session field → input element id. */
const TEXT_FIELDS = { notes: "s-notes", timeComplexity: "s-tc", spaceComplexity: "s-sc" } as const;
type TextField = keyof typeof TEXT_FIELDS;
const fieldEl = (f: TextField) => $<HTMLInputElement | HTMLTextAreaElement>(TEXT_FIELDS[f]);
/** Local edits not yet handed to the background — never overwrite them on re-render. */
const dirty = new Set<TextField>();

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string | null)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v as EventListener);
    else if (k === "className") e.className = String(v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

// `sidepanel.html?tab=<id>` pins the panel to one tab (used when opened as a page, e.g. in automated tests).
const pinnedTab = Number(new URLSearchParams(location.search).get("tab")) || null;

async function currentTab() {
  if (pinnedTab != null) return chrome.tabs.get(pinnedTab).catch(() => null);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

async function refresh() {
  const tab = await currentTab();
  activeTabId = tab?.id ?? null;
  try {
    state = await send<PanelState>({ type: "panel:get", tabId: activeTabId });
  } catch {
    state = null;
  }
  render(tab?.url ?? "");
}

function verdictChip(v: string, kind: string) {
  if (kind === "run") return h("span", { className: "chip neutral" }, `Run · ${v === "Pending" ? "…" : v}`);
  if (v === "Accepted") return h("span", { className: "chip good" }, "Accepted");
  if (v === "Pending") return h("span", { className: "chip neutral" }, "Judging…");
  if (v === "Unknown") return h("span", { className: "chip neutral" }, "Unknown");
  return h("span", { className: "chip bad" }, v);
}

function renderSync() {
  const el = $("sync");
  el.replaceChildren();
  if (!state) {
    el.append(h("span", { className: "dot", style: "background:var(--bad)" }), "Extension error");
    return;
  }
  const { conn, queueLength, paired, failed } = state;
  let color = "var(--good)";
  let text = "Synced";
  if (!paired) {
    color = "var(--warn)";
    text = "Not paired — open the extension options";
  } else if (conn.status === "unauthorized") {
    color = "var(--bad)";
    text = "Pairing token rejected — re-pair in options";
  } else if (conn.status === "offline") {
    color = "var(--warn)";
    text = queueLength ? `Dashboard unreachable — ${queueLength} change(s) queued` : "Dashboard unreachable";
  } else if (queueLength) {
    color = "var(--warn)";
    text = `Pending sync (${queueLength})`;
  } else if (conn.status === "unknown") {
    color = "var(--subtle)";
    text = "Not connected yet";
  }
  el.append(h("span", { className: "dot", style: `background:${color}` }), text);
  if (failed.length) el.append(h("span", { className: "chip bad", title: failed.map((f) => `${f.event.type}: ${f.error}`).join("\n") }, `${failed.length} rejected`));
  if (!paired || conn.status === "unauthorized") el.append(h("button", { onclick: () => chrome.runtime.openOptionsPage() }, "Options"));
  else el.append(h("button", { onclick: async () => (await send({ type: "sync:now" }), refresh()) }, "Sync now"));
}

function render(url: string) {
  renderSync();
  main.replaceChildren();
  const tab = state?.tab;
  const s = state?.session;
  if (!tab || !tab.slug) {
    section.hidden = true;
    renderedSessionId = null;
    const sp = state?.studyPlan;
    if (sp && onStudyPlanPage(url, sp.slug)) {
      main.append(studyPlanCard(sp));
      return;
    }
    main.append(
      h(
        "div",
        { className: "empty" },
        /leetcode\.com/.test(url) ? "Open a problem page (leetcode.com/problems/…) to track it." : "Open a LeetCode problem to start tracking. Your dashboard's Start Practice button opens it for you.",
      ),
    );
    if (state?.recentlyFinished) main.append(finishedCard(state.recentlyFinished));
    return;
  }
  if (tab.mode !== "bound" || !s) {
    section.hidden = true;
    renderedSessionId = null;
    if (state?.recentlyFinished) main.append(finishedCard(state.recentlyFinished));
    const p = tab.context?.problem;
    const name = p?.title ?? tab.title ?? tab.slug;
    const card = h(
      "div",
      { className: "card" },
      h("div", { className: "ptitle" }, `${p?.frontendId ? `#${p.frontendId} ` : ""}${name}`),
      h("div", { className: "muted small" }, p ? (p.sessionCount ? `${p.sessionCount} previous session(s) · ${p.mastery.replace("_", " ")}${p.nextReviewDate ? ` · review due ${p.nextReviewDate}` : ""}` : "Not practiced yet") : tab.context === null ? "Dashboard unreachable — a new session will be queued and synced later." : ""),
    );
    const btns = h("div", { className: "btns" });
    if (tab.resumable) {
      btns.append(h("button", { className: "primary", onclick: async () => (await send({ type: "resume", tabId: activeTabId!, sessionId: tab.resumable!.id }), refresh()) }, "Resume session"));
    } else {
      btns.append(h("button", { className: "primary", onclick: async () => (await send({ type: "start", tabId: activeTabId! }), refresh()) }, state?.recentlyFinished ? "Practice again" : "Start session"));
    }
    btns.append(h("button", { onclick: () => send({ type: "open-dashboard", path: `/problems/${tab.slug}` }) }, "History"));
    card.append(btns);
    // After finishing, the tab is quiet on purpose; "Ignored" only describes an explicit Ignore click.
    if (tab.mode === "ignored" && !state?.recentlyFinished) card.append(h("div", { className: "muted small" }, "Ignored for this visit."));
    main.append(card);
    return;
  }

  // Bound to a session
  section.hidden = false;
  const fresh = renderedSessionId !== s.id;
  renderedSessionId = s.id;
  $("s-title").textContent = `${s.problem.frontendId ? `#${s.problem.frontendId} ` : ""}${s.problem.title ?? s.problem.slug}`;
  $("s-meta").textContent = `${s.isReview ? "Review" : "First attempt"} · started ${new Date(s.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${s.status === "paused" ? " · paused" : ""}`;
  const pauseBtn = $<HTMLButtonElement>("s-pause");
  pauseBtn.textContent = s.status === "paused" ? "Resume" : "Pause";
  pauseBtn.onclick = async () => (await send({ type: s.status === "paused" ? "unpause" : "pause", sessionId: s.id }), refresh());

  const cap = $("s-capture");
  cap.replaceChildren(
    tab.captureReady
      ? h("span", { className: "chip good" }, "Submission capture active")
      : h("span", { className: "chip warn", title: "Reload the LeetCode tab. If it persists, log submissions manually in the dashboard." }, "Capture unavailable on this page — reload the tab, or log manually in the dashboard"),
  );
  const subs = $("s-subs");
  subs.replaceChildren(
    ...(s.submissions.length
      ? s.submissions.map((x, i) =>
          h("li", {}, h("span", { className: "muted" }, String(i + 1)), verdictChip(String(x.verdict), x.kind), h("span", { className: "muted small" }, `${x.lang ?? ""} · ${new Date(x.submittedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`)),
        )
      : [h("li", { className: "muted small" }, "None yet — Submit on LeetCode and it appears here.")]),
  );
  if (fresh) dirty.clear();
  for (const f of Object.keys(TEXT_FIELDS) as TextField[]) {
    const el = fieldEl(f);
    if (fresh || (!dirty.has(f) && document.activeElement !== el)) el.value = s[f] ?? "";
  }
  if (fresh) {
    outcome = null;
    ($<HTMLInputElement>("s-hints")).checked = false;
  }
  renderOutcomes(s.recommendations);
  $("s-history").onclick = () => send({ type: "open-dashboard", path: `/problems/${s.problem.slug}` });
  tick();
}

function onStudyPlanPage(url: string, slug: string) {
  try {
    const u = new URL(url);
    return u.hostname === "leetcode.com" && u.pathname.split("/")[1] === "studyplan" && u.pathname.split("/")[2] === slug;
  } catch {
    return false;
  }
}

function studyPlanCard(sp: NonNullable<PanelState["studyPlan"]>) {
  const card = h(
    "div",
    { className: "card" },
    h("div", { className: "ptitle" }, sp.name),
    h("div", { className: "muted small" }, `${sp.count} questions on this study plan. Import them into your dashboard as a list; your history is not touched.`),
  );
  const btn = h("button", { className: "primary" }, sp.status === "imported" ? "Import again" : "Import into dashboard") as HTMLButtonElement;
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "Importing…";
    await send({ type: "list:import", tabId: activeTabId! }).catch(() => null);
    void refresh();
  };
  card.append(h("div", { className: "btns" }, btn));
  if (sp.message) card.append(h("div", { className: "small", style: `color:var(${sp.status === "error" ? "--bad" : "--muted"})` }, sp.message));
  return card;
}

function renderOutcomes(recs: Record<string, string> | null) {
  const box = $("s-outcomes");
  box.replaceChildren(
    ...OUTCOMES.map((o) =>
      h(
        "button",
        { role: "radio", "aria-checked": outcome === o ? "true" : "false", onclick: () => ((outcome = o), renderOutcomes(recs)) },
        `${OUTCOME_LABELS[o].label}`,
        h("span", { className: "d" }, OUTCOME_LABELS[o].description),
      ),
    ),
  );
  const today = new Date().toLocaleDateString("en-CA");
  const sel = $<HTMLSelectElement>("s-review");
  const prev = sel.value;
  const rec = outcome && recs ? recs[outcome] : null;
  const opts: [string, string][] = [["", rec ? `Recommended: ${rec}` : outcome ? "Recommended by the dashboard" : "Pick an outcome first"]];
  for (const [l, n] of [["Tomorrow", 1], ["In 3 days", 3], ["In 1 week", 7], ["In 3 weeks", 21]] as const) opts.push([addDays(today, n), `${l} (${addDays(today, n)})`]);
  sel.replaceChildren(...opts.map(([v, l]) => h("option", { value: v }, l)));
  sel.value = opts.some(([v]) => v === prev) ? prev : "";
  $<HTMLButtonElement>("s-finish").disabled = !outcome;
}

function finishedCard(s: NonNullable<PanelState["recentlyFinished"]>) {
  return h(
    "div",
    { className: "card" },
    h("div", { className: "ptitle" }, `${s.status === "completed" ? "Finished" : "Abandoned"}: ${s.problem.title ?? s.problem.slug}`),
    h("div", { className: "muted small" }, s.outcome ? `Outcome: ${OUTCOME_LABELS[s.outcome as Outcome]?.label ?? s.outcome} · ${s.submissions.filter((x) => x.kind === "submit").length} submission(s)` : ""),
    h("div", { className: "btns" }, h("button", { onclick: () => send({ type: "open-dashboard", path: "/" }) }, "Next question ↗")),
  );
}

function tick() {
  const s = state?.session;
  if (!s || section.hidden) return;
  const now = Date.now();
  const live = s.status === "in_progress" && s.activity.lastActive && s.activity.lastTickAt ? Math.min(now - s.activity.lastTickAt, 45_000) : 0;
  $("s-active").textContent = `≈${formatClock(s.activity.activeMs + live)}`;
  $("s-elapsed").textContent = formatClock(now - s.startedAt);
}

for (const f of Object.keys(TEXT_FIELDS) as TextField[]) {
  fieldEl(f).addEventListener("input", () => {
    const s = state?.session;
    if (!s) return;
    $("s-notes-status").textContent = "· unsaved";
    dirty.add(f);
    if (notesTimer) clearTimeout(notesTimer);
    notesTimer = setTimeout(async () => {
      // Send only the fields edited here, so an untouched field never blanks what the dashboard has.
      const sent = Object.fromEntries([...dirty].map((k) => [k, fieldEl(k).value])) as Partial<Record<TextField, string>>;
      await send({ type: "notes", sessionId: s.id, ...sent });
      for (const [k, v] of Object.entries(sent)) if (fieldEl(k as TextField).value === v) dirty.delete(k as TextField);
      $("s-notes-status").textContent = "· saved locally";
    }, 700);
  });
}

$("s-finish").addEventListener("click", async () => {
  const s = state?.session;
  if (!s || !outcome) return;
  const btn = $<HTMLButtonElement>("s-finish");
  btn.disabled = true;
  if (notesTimer) clearTimeout(notesTimer); // the finish event carries the text fields
  const notes = fieldEl("notes").value;
  // Complexity goes along only if known (typed now or earlier), never as an accidental blank.
  const known = (f: "timeComplexity" | "spaceComplexity") => (dirty.has(f) || s[f] !== undefined || fieldEl(f).value ? fieldEl(f).value : undefined);
  const timeComplexity = known("timeComplexity");
  const spaceComplexity = known("spaceComplexity");
  dirty.clear();
  const review = ($<HTMLSelectElement>("s-review")).value || null;
  await send({ type: "finish", sessionId: s.id, reflection: { outcome, hintsUsed: ($<HTMLInputElement>("s-hints")).checked || outcome === "hints", notes, timeComplexity, spaceComplexity, nextReviewDate: review } });
  outcome = null;
  await refresh();
});

$("s-abandon").addEventListener("click", async () => {
  const s = state?.session;
  if (!s || !confirm("Abandon this session? It stays in your history; the task returns to your list.")) return;
  await send({ type: "abandon", sessionId: s.id });
  await refresh();
});

$("open-dash").addEventListener("click", () => send({ type: "open-dashboard", path: "/" }));

window.addEventListener("keydown", (e) => {
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" || section.hidden) return;
  const o = OUTCOMES.find((x) => OUTCOME_LABELS[x].key === e.key);
  if (o) {
    outcome = o;
    renderOutcomes(state?.session?.recommendations ?? null);
  }
});

chrome.storage.onChanged.addListener(() => void refresh());
chrome.tabs.onActivated.addListener(() => void refresh());
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.status === "complete") void refresh();
});
setInterval(tick, 1000);
setInterval(() => void refresh(), 5000);
void refresh();
