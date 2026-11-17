import { SESSION_TEXT_FIELDS, type ExtensionContext, type ProblemHint, type Reflection, type SessionText, type SyncEvent, type SyncEventType, type Verdict } from "@lcc/shared";
import { applyHeartbeat, displayActiveMs, isActive, type ActivityState } from "./activity";
import type { Api, ApiError } from "./api";
import { normalizeDashboardUrl } from "./dashboard-url";
import type { CapturedList, Intercepted } from "./intercept";
import type { KV } from "./storage";

/**
 * The extension's state machine. Every public method runs under a mutex and
 * reads/writes persistent storage, so a service-worker restart loses nothing.
 *
 * Storage:
 *   local (persistent): config, seq, queue, failed, sessions, conn, checks
 *   ephemeral (chrome.storage.session): tabs — tab ids are only valid per browser run
 */

export interface Config {
  serverUrl: string;
  /** This browser's own key, from pairing (Settings → Devices in the dashboard). */
  token: string;
  clientId: string;
  /** The dashboard's id for this browser (shown nowhere; for support/debugging). */
  deviceId?: string;
}

export interface LocalSubmission {
  platformId: string | null;
  kind: "submit" | "run";
  verdict: Verdict | string;
  submittedAt: number;
  lang: string | null;
  hasCode: boolean;
}

export type LocalStatus = "in_progress" | "paused" | "completed" | "abandoned";

export interface LocalSession {
  id: string;
  /** Server id if the server merged this session into an existing one. */
  serverId?: string;
  problem: ProblemHint;
  startedAt: number;
  status: LocalStatus;
  activity: ActivityState;
  notes: string;
  /** Only set once known (typed in the panel, or from the server), so an untouched panel never blanks them. */
  timeComplexity?: string;
  spaceComplexity?: string;
  isReview: boolean;
  submissions: LocalSubmission[];
  recommendations: Record<string, string> | null;
  outcome?: string | null;
  endedAt?: number | null;
  lastActivitySentAt?: number;
  lastActivitySentMs?: number;
  /** Server doesn't know this id (e.g. failed start). */
  missingOnServer?: boolean;
  /**
   * The text fields as the dashboard last had them, as far as the extension knows. Sent as the
   * base of a notes edit, so the dashboard can tell when its text changed in the meantime.
   */
  synced?: SessionText;
  /** When the dashboard last kept its own newer text next to an edit from here (both versions kept). */
  conflictAt?: number;
  updatedAt: number;
}

export type TabMode = "bound" | "offer" | "ignored" | "idle";

export interface TabState {
  slug: string | null;
  title: string | null;
  frontendId: string | null;
  mode: TabMode;
  sessionId: string | null;
  /** When offering: an open session (local or on the server) that could be resumed. */
  resumable: { id: string; startedAt: number; source: "local" | "server" } | null;
  context: (ExtensionContext & { recommendations?: Record<string, string> | null }) | null;
  /** When `context` was fetched; refreshed after a session for this problem finishes and syncs. */
  contextAt?: number;
  captureReady: boolean;
  /** Last typing in the side panel while it showed this tab (the page itself sees no input then). */
  panelInputAt?: number;
}


/** Chrome hides the address of pages the extension can't access (`undefined`): those aren't LeetCode either. */
export function isLeetCodeUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname === "leetcode.com";
  } catch {
    return false;
  }
}

const emptyText = (): SessionText => ({ notes: "", timeComplexity: "", spaceComplexity: "" });
/** The text fields as a dashboard session reports them (null = empty). */
function textOf(srv: { notes?: string | null; timeComplexity?: string | null; spaceComplexity?: string | null }): SessionText {
  return { notes: srv.notes ?? "", timeComplexity: srv.timeComplexity ?? "", spaceComplexity: srv.spaceComplexity ?? "" };
}

/** Warning shown in the panel when the offline queue hit its size limit. */
export interface QueueWarning {
  /** Captured submissions kept without their code. */
  codeDropped: number;
  /** Changes not kept at all. */
  dropped: number;
  at: number;
}

/** For display (type + error) only: the payload (code, notes) is left out. */
function brief(e: SyncEvent): SyncEvent {
  return { id: e.id, clientId: e.clientId, seq: e.seq, createdAt: e.createdAt, type: e.type, payload: {} } as unknown as SyncEvent;
}

/**
 * An event that left the queue without being applied.
 * - Rejected by the dashboard (it recorded why): display only, payload dropped.
 * - `held`: the dashboard kept failing on it, so it was set aside to let the rest sync. It keeps
 *   its full payload and can be sent again (`retryFailed`); it is never discarded.
 */
export interface FailedEvent {
  event: SyncEvent;
  error: string;
  at: number;
  held?: boolean;
}

/** Display-only entries are capped; held ones are all kept. */
function capFailed(list: FailedEvent[]): FailedEvent[] {
  const display = new Set(list.filter((f) => !f.held).slice(-20));
  return list.filter((f) => f.held || display.has(f));
}

export interface StudyPlanOffer {
  list: CapturedList;
  status: "new" | "imported" | "error";
  message: string | null;
}

export interface QueuedEvent {
  event: SyncEvent;
  attempts: number;
}

export type ConnStatus = "ok" | "offline" | "unauthorized" | "unpaired" | "unknown";
export interface Conn {
  status: ConnStatus;
  lastOkAt: number | null;
  lastError: string | null;
}

export interface Deps {
  local: KV;
  ephemeral: KV;
  api: Api;
  now?: () => number;
  uuid?: () => string;
  /** Notify a tab's content script that its state changed. */
  notifyTab?: (tabId: number, state: TabState) => void;
  /** Size limit of the offline queue, in JSON characters (tests use a small one). */
  queueMaxChars?: number;
}

const DEFAULT_CONFIG: Config = { serverUrl: "http://127.0.0.1:4317", token: "", clientId: "" };
const ACTIVITY_SYNC_MS = 60_000;
const MAX_BATCH = 50;
/**
 * chrome.storage.local holds 10 MB in all. Keep the queue to about half, leaving room for sessions,
 * set-aside events and the rest; past that, captures would fail to save without a word.
 */
export const QUEUE_MAX_CHARS = 5_000_000;
/** Typing in the side panel stands in for page focus this long (the page is unfocused while you type there). */
const PANEL_FOCUS_MS = 60_000;

export class Controller {
  private chain: Promise<unknown> = Promise.resolve();
  private flushing = false;
  private now: () => number;
  private uuid: () => string;

  constructor(private deps: Deps) {
    this.now = deps.now ?? (() => Date.now());
    this.uuid = deps.uuid ?? (() => crypto.randomUUID());
  }

  /** Serialize all state mutations (the SW handles many async events). */
  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // ---------- storage helpers ----------
  async getConfig(): Promise<Config> {
    const c = { ...DEFAULT_CONFIG, ...((await this.deps.local.get<Config>("config")) ?? {}) };
    if (!c.clientId) {
      c.clientId = this.uuid();
      await this.deps.local.set({ config: c });
    }
    return c;
  }
  async setConfig(patch: Partial<Config>) {
    // Code and notes go only to the dashboard the user entered: normalised to its origin, http(s) only.
    if (patch.serverUrl !== undefined) patch = { ...patch, serverUrl: normalizeDashboardUrl(patch.serverUrl) };
    return this.lock(async () => {
      const c = { ...(await this.getConfig()), ...patch };
      await this.deps.local.set({ config: c, conn: { status: c.token ? "unknown" : "unpaired", lastOkAt: null, lastError: null } satisfies Conn });
      return c;
    });
  }
  private async sessions() {
    return (await this.deps.local.get<Record<string, LocalSession>>("sessions")) ?? {};
  }
  private async tabs() {
    return (await this.deps.ephemeral.get<Record<string, TabState>>("tabs")) ?? {};
  }
  private async queue() {
    return (await this.deps.local.get<QueuedEvent[]>("queue")) ?? [];
  }
  private async failed() {
    return (await this.deps.local.get<FailedEvent[]>("failed")) ?? [];
  }
  /** True only when our dashboard answers: not during an outage, and not when the URL points at some other program. */
  private async dashboardAnswers(): Promise<boolean> {
    const p = await this.deps.api.ping();
    return p.ok && p.data?.ok === true;
  }
  async conn(): Promise<Conn> {
    const c = await this.deps.local.get<Conn>("conn");
    if (c) return c;
    const cfg = await this.getConfig();
    return { status: cfg.token ? "unknown" : "unpaired", lastOkAt: null, lastError: null };
  }
  private async setConn(status: ConnStatus, error: string | null = null) {
    const prev = await this.conn();
    await this.deps.local.set({ conn: { status, lastOkAt: status === "ok" ? this.now() : prev.lastOkAt, lastError: error } satisfies Conn });
  }

  private async enqueue(type: SyncEventType, payload: unknown, opts: { coalesceKey?: string } = {}) {
    const cfg = await this.getConfig();
    const seq = ((await this.deps.local.get<number>("seq")) ?? 0) + 1;
    const event = { id: this.uuid(), clientId: cfg.clientId, seq, createdAt: this.now(), type, payload } as SyncEvent;
    let q = await this.queue();
    if (opts.coalesceKey) {
      // Activity/notes are cumulative snapshots: only the latest unsent one matters.
      q = q.filter((x) => !(x.event.type === type && (x.event.payload as { sessionId?: string }).sessionId === opts.coalesceKey));
    }
    q.push({ event, attempts: 0 });
    const lost = this.fitQueue(q, event.id);
    if (lost) {
      const prev = await this.deps.local.get<QueueWarning>("queueWarning");
      const queueWarning: QueueWarning = { codeDropped: (prev?.codeDropped ?? 0) + lost.codeDropped, dropped: (prev?.dropped ?? 0) + lost.dropped, at: this.now() };
      await this.deps.local.set({ seq, queue: q, queueWarning });
    } else {
      await this.deps.local.set({ seq, queue: q });
    }
  }

  /**
   * Keep the queue under its size limit (it grows while the dashboard is unreachable). Gives up,
   * in order: activity snapshots (the dashboard has the time up to the last one it got), then the
   * code of the oldest captured submissions (the submission and its verdict are still recorded),
   * and only then the new change itself. Edits `q` in place; returns what was lost, if anything.
   */
  private fitQueue(q: QueuedEvent[], newId: string): { codeDropped: number; dropped: number } | null {
    const max = this.deps.queueMaxChars ?? QUEUE_MAX_CHARS;
    let size = JSON.stringify(q).length;
    if (size <= max) return null;
    let codeDropped = 0;
    let dropped = 0;
    for (let i = 0; i < q.length && size > max; ) {
      if (q[i]!.event.type === "session.activity" && q[i]!.event.id !== newId) {
        size -= JSON.stringify(q[i]).length + 1;
        q.splice(i, 1);
      } else i++;
    }
    for (const item of q) {
      if (size <= max) break;
      const p = item.event.payload as { code?: string | null };
      if (item.event.type !== "submission.captured" || !p.code) continue;
      size -= JSON.stringify(p.code).length - "null".length;
      p.code = null;
      codeDropped++;
    }
    if (size > max) {
      const i = q.findIndex((x) => x.event.id === newId);
      if (i >= 0) {
        q.splice(i, 1);
        dropped++;
      }
    }
    return codeDropped || dropped ? { codeDropped, dropped } : null;
  }

  private emptyActivity(): ActivityState {
    return { activeMs: 0, lastTickAt: null, lastActive: false, lastTabId: null };
  }

  private async saveTab(tabId: number, t: TabState) {
    const tabs = await this.tabs();
    tabs[String(tabId)] = t;
    await this.deps.ephemeral.set({ tabs });
    this.deps.notifyTab?.(tabId, t);
  }

  private async forgetStudyPlan(tabId: number) {
    const plans = (await this.deps.ephemeral.get<Record<string, StudyPlanOffer>>("studyPlans")) ?? {};
    if (!(String(tabId) in plans)) return;
    delete plans[String(tabId)];
    await this.deps.ephemeral.set({ studyPlans: plans });
  }

  private openLocalFor(sessions: Record<string, LocalSession>, slug: string) {
    return Object.values(sessions).find((s) => s.problem.slug === slug && (s.status === "in_progress" || s.status === "paused")) ?? null;
  }

  // ---------- page lifecycle ----------

  /**
   * A LeetCode page reported its problem (initial load, refresh, or SPA navigation).
   * Never creates a session by itself: it binds to an existing one or offers.
   */
  onPage(tabId: number, info: { slug: string | null; title?: string | null; frontendId?: string | null; hashSessionId?: string | null }) {
    return this.lock(async () => {
      const tabs = await this.tabs();
      const prev = tabs[String(tabId)];
      if (!info.slug) {
        const t: TabState = { slug: null, title: null, frontendId: null, mode: "idle", sessionId: null, resumable: null, context: null, captureReady: prev?.captureReady ?? false };
        await this.saveTab(tabId, t);
        return t;
      }
      const sessions = await this.sessions();
      // Same problem in the same tab (refresh / re-render): keep the binding.
      if (prev && prev.slug === info.slug && prev.mode !== "idle" && !(info.hashSessionId && info.hashSessionId !== prev.sessionId)) {
        const still = prev.sessionId ? sessions[prev.sessionId] : null;
        if (prev.mode !== "bound" || (still && (still.status === "in_progress" || still.status === "paused"))) {
          // After in-app navigation the page reports the title once it shows the new problem's.
          const t = { ...prev, title: info.title ?? prev.title, frontendId: info.frontendId ?? prev.frontendId };
          await this.saveTab(tabId, t);
          return t;
        }
      }
      const base: TabState = {
        slug: info.slug,
        title: info.title ?? null,
        frontendId: info.frontendId ?? null,
        mode: "offer",
        sessionId: null,
        resumable: null,
        context: null,
        captureReady: prev?.captureReady ?? false,
      };
      // Fetch server context (problem info, any open session). Offline is fine.
      const ctx = await this.deps.api.context(info.slug);
      if (ctx.ok) await this.setConn("ok");
      else await this.noteApiError(ctx.error);
      const context = ctx.ok ? ctx.data : null;
      base.context = context;
      base.contextAt = this.now();
      const hint: ProblemHint = {
        slug: info.slug,
        title: context?.problem?.title ?? info.title ?? null,
        frontendId: context?.problem?.frontendId ?? info.frontendId ?? null,
      };

      // 1. Opened from the dashboard's Start Practice (URL carries the session id).
      if (info.hashSessionId) {
        let s = sessions[info.hashSessionId];
        if (!s) {
          const server = context?.openSession?.id === info.hashSessionId ? context.openSession : null;
          s = this.newLocal(info.hashSessionId, hint, server?.startedAt ?? this.now(), context);
          if (server) {
            s.status = server.status === "paused" ? "paused" : "in_progress";
            s.notes = server.notes ?? "";
            if (server.timeComplexity) s.timeComplexity = server.timeComplexity;
            if (server.spaceComplexity) s.spaceComplexity = server.spaceComplexity;
            s.synced = textOf(server);
            s.activity.activeMs = server.activeMs ?? 0;
            s.isReview = server.isReview;
          }
          sessions[s.id] = s;
          await this.deps.local.set({ sessions });
        }
        if (s.status === "in_progress" || s.status === "paused") {
          const t = { ...base, mode: "bound" as const, sessionId: s.id };
          await this.saveTab(tabId, t);
          return t;
        }
      }
      // 2. Another tab is already working on this problem's open session → share it (no duplicate).
      const local = this.openLocalFor(sessions, info.slug);
      const boundElsewhere = local && Object.entries(tabs).some(([id, t]) => id !== String(tabId) && t.mode === "bound" && t.sessionId === local.id);
      if (local && boundElsewhere) {
        const t = { ...base, mode: "bound" as const, sessionId: local.id };
        await this.saveTab(tabId, t);
        return t;
      }
      // 3. Offer: resume an open session (local first, else server), start new, or ignore.
      if (local) base.resumable = { id: local.id, startedAt: local.startedAt, source: "local" };
      else if (context?.openSession) base.resumable = { id: context.openSession.id, startedAt: context.openSession.startedAt, source: "server" };
      await this.saveTab(tabId, base);
      return base;
    });
  }

  private newLocal(id: string, problem: ProblemHint, startedAt: number, ctx: ExtensionContext & { recommendations?: Record<string, string> | null } | null): LocalSession {
    return {
      id,
      problem,
      startedAt,
      status: "in_progress",
      activity: this.emptyActivity(),
      notes: "",
      isReview: (ctx?.problem?.sessionCount ?? 0) > 0,
      submissions: [],
      recommendations: ctx?.recommendations ?? null,
      updatedAt: this.now(),
    };
  }

  /** Start a brand-new session from the LeetCode page (or side panel). */
  startSession(tabId: number) {
    return this.lock(async () => {
      const tabs = await this.tabs();
      const t = tabs[String(tabId)];
      if (!t?.slug) throw new Error("Not on a LeetCode problem page");
      const sessions = await this.sessions();
      const existing = this.openLocalFor(sessions, t.slug);
      if (existing) {
        // Never two open sessions for one problem.
        const bound = { ...t, mode: "bound" as const, sessionId: existing.id, resumable: null };
        await this.saveTab(tabId, bound);
        return bound;
      }
      if (t.resumable?.source === "server") {
        return this.bindResumeUnlocked(tabId, t, t.resumable.id, sessions);
      }
      const hint: ProblemHint = { slug: t.slug, title: t.context?.problem?.title ?? t.title, frontendId: t.context?.problem?.frontendId ?? t.frontendId };
      const s = this.newLocal(this.uuid(), hint, this.now(), t.context);
      s.synced = emptyText(); // a new session starts with no text on the dashboard
      sessions[s.id] = s;
      await this.deps.local.set({ sessions });
      await this.enqueue("session.start", { sessionId: s.id, problem: hint, startedAt: s.startedAt });
      const bound = { ...t, mode: "bound" as const, sessionId: s.id, resumable: null };
      await this.saveTab(tabId, bound);
      void this.flush();
      return bound;
    });
  }

  private async bindResumeUnlocked(tabId: number, t: TabState, sessionId: string, sessions: Record<string, LocalSession>) {
    let s = sessions[sessionId];
    if (!s) {
      const srv = t.context?.openSession;
      s = this.newLocal(sessionId, { slug: t.slug!, title: t.context?.problem?.title ?? t.title, frontendId: t.context?.problem?.frontendId ?? t.frontendId }, srv?.startedAt ?? this.now(), t.context);
      if (srv) {
        s.notes = srv.notes ?? "";
        if (srv.timeComplexity) s.timeComplexity = srv.timeComplexity;
        if (srv.spaceComplexity) s.spaceComplexity = srv.spaceComplexity;
        s.synced = textOf(srv);
        s.activity.activeMs = srv.activeMs ?? 0;
        s.status = srv.status === "paused" ? "paused" : "in_progress";
        s.isReview = srv.isReview;
      }
      sessions[s.id] = s;
      await this.deps.local.set({ sessions });
    }
    const bound = { ...t, mode: "bound" as const, sessionId: s.id, resumable: null };
    await this.saveTab(tabId, bound);
    return bound;
  }

  resumeSession(tabId: number, sessionId: string) {
    return this.lock(async () => {
      const tabs = await this.tabs();
      const t = tabs[String(tabId)];
      if (!t?.slug) throw new Error("Not on a LeetCode problem page");
      return this.bindResumeUnlocked(tabId, t, sessionId, await this.sessions());
    });
  }

  ignore(tabId: number) {
    return this.lock(async () => {
      const tabs = await this.tabs();
      const t = tabs[String(tabId)];
      if (!t) return null;
      const next = { ...t, mode: "ignored" as const };
      await this.saveTab(tabId, next);
      return next;
    });
  }

  onTabClosed(tabId: number) {
    return this.lock(async () => {
      const tabs = await this.tabs();
      delete tabs[String(tabId)];
      await this.deps.ephemeral.set({ tabs });
      await this.forgetStudyPlan(tabId);
    });
  }

  /**
   * The tab moved to a page off LeetCode (its content script is gone, so it can't say so itself).
   * It stops being bound; the session stays open, and returning to the problem offers to resume it.
   */
  onTabLeft(tabId: number) {
    return this.lock(async () => {
      const t = (await this.tabs())[String(tabId)];
      if (t && (t.slug || t.mode !== "idle")) {
        await this.saveTab(tabId, { slug: null, title: null, frontendId: null, mode: "idle", sessionId: null, resumable: null, context: null, captureReady: false });
      }
      await this.forgetStudyPlan(tabId);
    });
  }

  /** The user typed in the side panel while it showed this tab. */
  onPanelInput(tabId: number) {
    return this.lock(async () => {
      const tabs = await this.tabs();
      const t = tabs[String(tabId)];
      if (!t) return;
      tabs[String(tabId)] = { ...t, panelInputAt: this.now() };
      await this.deps.ephemeral.set({ tabs });
    });
  }

  // ---------- activity ----------
  onHeartbeat(tabId: number, h: { visible: boolean; focused: boolean; lastInputAt: number; captureReady: boolean }) {
    return this.lock(async () => {
      const now = this.now();
      const tabs = await this.tabs();
      const t = tabs[String(tabId)];
      if (!t) return;
      if (t.captureReady !== h.captureReady) {
        tabs[String(tabId)] = { ...t, captureReady: h.captureReady };
        await this.deps.ephemeral.set({ tabs });
      }
      if (t.mode !== "bound" || !t.sessionId) return;
      const sessions = await this.sessions();
      const s = sessions[t.sessionId];
      if (!s || s.status === "completed" || s.status === "abandoned") return;
      const idle = t.context?.settings?.idleThresholdSec ?? 300;
      // Typing in the side panel takes focus from the page, which then sees no input: count it too.
      const panelInputAt = t.panelInputAt ?? 0;
      const typingInPanel = now - panelInputAt < PANEL_FOCUS_MS;
      const active = s.status === "in_progress" && isActive({ visible: h.visible, focused: h.focused || typingInPanel, lastInputAt: Math.max(h.lastInputAt, panelInputAt) }, now, idle);
      s.activity = applyHeartbeat(s.activity, tabId, now, active);
      s.updatedAt = now;
      sessions[s.id] = s;
      // Only report when active time actually grew: a paused or idle tab must not look active.
      const activeMs = Math.round(s.activity.activeMs);
      const send = activeMs !== s.lastActivitySentMs && (!s.lastActivitySentAt || now - s.lastActivitySentAt >= ACTIVITY_SYNC_MS);
      if (send) {
        s.lastActivitySentAt = now;
        s.lastActivitySentMs = activeMs;
      }
      await this.deps.local.set({ sessions });
      if (send) await this.enqueue("session.activity", { sessionId: s.id, activeMs, lastActivityAt: now }, { coalesceKey: s.id });
    });
  }

  // ---------- capture ----------
  onIntercepted(tabId: number, m: Intercepted) {
    if (m.type === "studyplan") return this.onStudyPlan(tabId, m.list);
    return this.lock(async () => {
      const now = this.now();
      const tabs = await this.tabs();
      const t = tabs[String(tabId)];
      const sessions = await this.sessions();
      const checks = (await this.deps.local.get<Record<string, { sessionId: string | null; kind: "submit" | "run"; problem: ProblemHint; at: number }>>("checks")) ?? {};
      const seen = (await this.deps.local.get<string[]>("seenResults")) ?? [];
      // Any script on the page can post these messages, so only trust ones that fit what the tab is doing:
      // a submit/run must be for the problem open in this tab, and a verdict must answer a submit/run we saw.
      if ((m.type === "submit" || m.type === "run") && m.slug !== t?.slug) return;
      if (m.type === "check" && !checks[m.id]) return;
      const slug = m.type === "check" ? checks[m.id]!.problem.slug : m.slug;
      // The session the tab is bound to — only if it is for this exact problem and open.
      const bound = t?.mode === "bound" && t.sessionId && t.slug === slug ? sessions[t.sessionId] : undefined;
      const sessionId = bound && (bound.status === "in_progress" || bound.status === "paused") ? bound.id : null;
      const problem: ProblemHint = {
        slug,
        title: t?.slug === slug ? (t.context?.problem?.title ?? t.title) : null,
        frontendId: t?.slug === slug ? (t.context?.problem?.frontendId ?? t.frontendId) : null,
        questionId: m.type !== "check" ? m.questionId : (m.result.questionId ?? null),
      };

      if (m.type === "submit" || m.type === "run") {
        const pid = m.type === "submit" ? m.submissionId : m.interpretId;
        await this.enqueue("submission.captured", {
          sessionId,
          problem,
          kind: m.type,
          platformSubmissionId: pid,
          lang: m.lang,
          code: m.code,
          submittedAt: now,
        });
        if (pid) checks[pid] = { sessionId, kind: m.type, problem, at: now };
        // Keep the map small.
        for (const [k, v] of Object.entries(checks)) if (now - v.at > 30 * 60_000) delete checks[k];
        await this.deps.local.set({ checks });
        if (bound) {
          bound.submissions.push({ platformId: pid, kind: m.type, verdict: "Pending", submittedAt: now, lang: m.lang, hasCode: !!m.code });
          bound.updatedAt = now;
          sessions[bound.id] = bound;
          await this.deps.local.set({ sessions });
        }
        void this.flush();
        return;
      }
      // check result — LeetCode polls this endpoint repeatedly; handle each id once.
      if (seen.includes(m.id)) return;
      const pending = checks[m.id]!;
      const sid = pending.sessionId;
      await this.enqueue("submission.result", {
        sessionId: sid,
        problem: pending?.problem ?? problem,
        kind: pending?.kind ?? m.kind,
        platformSubmissionId: m.id,
        verdict: m.result.verdict,
        statusCode: m.result.statusCode,
        runtime: m.result.runtime,
        memory: m.result.memory,
        totalCorrect: m.result.totalCorrect,
        totalTestcases: m.result.totalTestcases,
        lang: m.result.lang,
        judgedAt: m.result.finishedAt ?? now,
        details: m.result.details,
      });
      await this.deps.local.set({ seenResults: [...seen, m.id].slice(-200) });
      const s = sid ? sessions[sid] : undefined;
      if (s) {
        const sub = s.submissions.find((x) => x.platformId === m.id);
        if (sub) sub.verdict = m.result.verdict;
        else s.submissions.push({ platformId: m.id, kind: pending?.kind ?? m.kind, verdict: m.result.verdict, submittedAt: now, lang: m.result.lang, hasCode: false });
        s.updatedAt = now;
        sessions[s.id] = s;
        await this.deps.local.set({ sessions });
      }
      void this.flush();
    });
  }

  // ---------- session actions (side panel) ----------
  private async mutateSession(id: string, fn: (s: LocalSession) => void) {
    const sessions = await this.sessions();
    const s = sessions[id];
    if (!s) throw new Error("Unknown session");
    fn(s);
    s.updatedAt = this.now();
    sessions[id] = s;
    await this.deps.local.set({ sessions });
    return s;
  }

  /**
   * Save the session's text fields (any subset). The queued event carries only fields edited here
   * (these, plus those of an unsent earlier edit it replaces), so a field that was not touched in
   * the panel never overwrites what the dashboard has for it.
   */
  setNotes(id: string, patch: SessionText) {
    return this.lock(async () => {
      const s = await this.mutateSession(id, (x) => {
        for (const f of SESSION_TEXT_FIELDS) if (patch[f] !== undefined) x[f] = patch[f];
      });
      const unsent = (await this.queue()).find((x) => x.event.type === "session.notes" && (x.event.payload as { sessionId?: string }).sessionId === id);
      const prev = unsent?.event.payload as (SessionText & { base?: SessionText }) | undefined;
      const edited: SessionText & { sessionId: string; base?: SessionText } = { ...prev, sessionId: id };
      // The base is what the dashboard had before the first of the edits this event carries.
      const base: SessionText = { ...prev?.base };
      for (const f of SESSION_TEXT_FIELDS) {
        if (patch[f] === undefined) continue;
        edited[f] = patch[f];
        if (!(f in base) && s.synced?.[f] !== undefined) base[f] = s.synced[f];
      }
      if (Object.keys(base).length) edited.base = base;
      await this.enqueue("session.notes", edited, { coalesceKey: id });
      void this.flush();
    });
  }
  /** A stale panel (or a double click) must not act on a session that already ended. */
  private async isOpen(id: string) {
    const s = (await this.sessions())[id];
    return !!s && (s.status === "in_progress" || s.status === "paused");
  }

  pause(id: string) {
    return this.lock(async () => {
      if (!(await this.isOpen(id))) return;
      const at = this.now();
      await this.mutateSession(id, (s) => {
        s.status = "paused";
        s.activity = { ...s.activity, lastActive: false };
      });
      await this.enqueue("session.pause", { sessionId: id, at });
      void this.flush();
    });
  }
  resume(id: string) {
    return this.lock(async () => {
      if (!(await this.isOpen(id))) return;
      await this.mutateSession(id, (s) => (s.status = "in_progress"));
      await this.enqueue("session.resume", { sessionId: id, at: this.now() });
      void this.flush();
    });
  }
  finish(id: string, reflection: Reflection) {
    return this.lock(async () => {
      if (!(await this.isOpen(id))) return;
      const endedAt = this.now();
      const s = await this.mutateSession(id, (x) => {
        x.status = "completed";
        x.outcome = reflection.outcome;
        x.endedAt = endedAt;
        if (reflection.notes != null) x.notes = reflection.notes;
        if (reflection.timeComplexity != null) x.timeComplexity = reflection.timeComplexity;
        if (reflection.spaceComplexity != null) x.spaceComplexity = reflection.spaceComplexity;
      });
      // Final cumulative active time goes before the finish event.
      await this.enqueue("session.activity", { sessionId: id, activeMs: Math.round(s.activity.activeMs), lastActivityAt: endedAt }, { coalesceKey: id });
      await this.enqueue("session.finish", { sessionId: id, endedAt, reflection });
      await this.unbindSession(id, "ignored");
      void this.flush().then(() => this.reconcile());
    });
  }
  abandon(id: string) {
    return this.lock(async () => {
      if (!(await this.isOpen(id))) return;
      const at = this.now();
      await this.mutateSession(id, (x) => {
        x.status = "abandoned";
        x.endedAt = at;
      });
      await this.enqueue("session.abandon", { sessionId: id, at });
      await this.unbindSession(id, "ignored");
      void this.flush().then(() => this.reconcile());
    });
  }

  /**
   * Detach tabs from a session. After finishing/abandoning, tabs go quiet ("ignored": no
   * "Track this problem?" prompt on the page until you open another problem); the side panel
   * still shows the finished card and lets you start again. A session deleted in the
   * dashboard returns its tabs to "offer".
   */
  private async unbindSession(id: string, mode: "ignored" | "offer") {
    const tabs = await this.tabs();
    for (const [tid, t] of Object.entries(tabs)) {
      if (t.sessionId === id) {
        tabs[tid] = { ...t, mode, sessionId: null, resumable: null };
        this.deps.notifyTab?.(Number(tid), tabs[tid]!);
      }
    }
    await this.deps.ephemeral.set({ tabs });
  }

  // ---------- sync ----------
  private async noteApiError(e: ApiError) {
    await this.setConn(e.kind === "unauthorized" ? "unauthorized" : e.kind === "offline" || e.kind === "server" ? "offline" : "ok", e.message);
  }

  /** Send queued events in order. Safe to call any time; concurrent calls are no-ops. */
  async flush(): Promise<{ sent: number; remaining: number }> {
    if (this.flushing) return { sent: 0, remaining: (await this.queue()).length };
    this.flushing = true;
    let sent = 0;
    try {
      for (let round = 0; round < 10; round++) {
        const q0 = await this.queue();
        // After repeated server failures, go one event at a time to find the one the server can't take.
        const batch = q0.slice(0, q0[0] && q0[0].attempts >= 3 ? 1 : MAX_BATCH);
        if (!batch.length) break;
        const res = await this.deps.api.sendEvents(batch.map((b) => b.event));
        if (!res.ok) {
          await this.noteApiError(res.error);
          // Being offline or unpaired is not the events' fault; only server-side failures count.
          if (res.error.kind === "server" || res.error.kind === "bad_request") {
            const message = res.error.message;
            // ...and only while the dashboard itself answers. When it is broken (every request
            // fails), or the URL points at some other program, no event is at fault: keep them all.
            if (!(await this.dashboardAnswers())) {
              await this.setConn("offline", message);
              break;
            }
            await this.lock(async () => {
              const q = await this.queue();
              const ids = new Set(batch.map((b) => b.event.id));
              if (batch.length === 1 && batch[0]!.attempts >= 5) {
                // Set the culprit aside (visible in the panel) so everything behind it can sync.
                // It keeps its payload and can be sent again from the panel.
                const failed = await this.failed();
                failed.push({ event: batch[0]!.event, error: message, at: this.now(), held: true });
                await this.deps.local.set({ queue: q.filter((x) => !ids.has(x.event.id)), failed: capFailed(failed) });
              } else {
                await this.deps.local.set({ queue: q.map((x) => (ids.has(x.event.id) ? { ...x, attempts: x.attempts + 1 } : x)) });
              }
            });
          }
          break;
        }
        await this.setConn("ok");
        await this.lock(async () => {
          const byId = new Map(res.data.results.map((r) => [r.id, r]));
          const q = await this.queue();
          const failed = await this.failed();
          const sessions = await this.sessions();
          const keep: QueuedEvent[] = [];
          for (const item of q) {
            const r = byId.get(item.event.id);
            if (!r) {
              keep.push(item);
              continue;
            }
            sent++;
            if (r.status === "rejected") failed.push({ event: brief(item.event), error: r.error ?? "rejected", at: this.now() });
            const sid = (item.event.payload as { sessionId?: string }).sessionId;
            if (sid && r.sessionId && r.sessionId !== sid && sessions[sid]) sessions[sid]!.serverId = r.sessionId;
            if (sid && r.status === "rejected" && item.event.type === "session.start" && sessions[sid]) sessions[sid]!.missingOnServer = true;
          }
          // Notes edits: learn what the dashboard now has. Taken from the batch, not the queue: an
          // edit typed while this one was on its way has already replaced it in the queue.
          for (const item of batch) {
            const r = byId.get(item.event.id);
            if (item.event.type !== "session.notes" || !r || r.status === "rejected") continue;
            const p = item.event.payload as SessionText & { sessionId: string };
            const s = sessions[p.sessionId];
            if (!s) continue;
            // "duplicate" (sent before, answer lost) carries no text: assume it was applied as sent.
            const stored: SessionText = r.stored ?? Object.fromEntries(SESSION_TEXT_FIELDS.filter((f) => p[f] !== undefined).map((f) => [f, p[f]]));
            s.synced = { ...s.synced, ...stored };
            const next = keep.find((x) => x.event.type === "session.notes" && (x.event.payload as { sessionId?: string }).sessionId === p.sessionId);
            if (!next) {
              // Nothing newer typed here: show what the dashboard stored (on a conflict, both versions).
              for (const f of SESSION_TEXT_FIELDS) if (stored[f] !== undefined) s[f] = stored[f];
            } else if (!r.conflict) {
              // The newer edit was based on this one's text, which the dashboard now has.
              const np = next.event.payload as { base?: SessionText };
              for (const f of SESSION_TEXT_FIELDS) if (p[f] !== undefined && np.base && f in np.base) np.base[f] = stored[f] ?? p[f];
            }
            // On a conflict the newer edit keeps its old base, so it too is kept next to the dashboard's text, never over it.
            if (r.conflict) s.conflictAt = this.now();
          }
          const cleared = keep.length === 0 ? { queueWarning: null } : {};
          await this.deps.local.set({ queue: keep, failed: capFailed(failed), sessions, ...cleared });
        });
      }
    } finally {
      this.flushing = false;
    }
    return { sent, remaining: (await this.queue()).length };
  }

  /** Put set-aside events back in the queue, in their original order, to be sent again. */
  retryFailed() {
    return this.lock(async () => {
      const failed = await this.failed();
      const held = failed.filter((f) => f.held);
      if (!held.length) return 0;
      const q = [...held.map((f) => ({ event: f.event, attempts: 0 })), ...(await this.queue())].sort((a, b) => a.event.seq - b.event.seq);
      await this.deps.local.set({ queue: q, failed: failed.filter((f) => !f.held) });
      return held.length;
    });
  }

  /**
   * Pull server state for local sessions: if a session was finished or
   * abandoned in the dashboard, reflect it here and unbind tabs. Sessions (or submissions)
   * deleted in the dashboard are forgotten here too.
   */
  reconcile() {
    return this.lock(async () => {
      const sessions = await this.sessions();
      const q = await this.queue();
      const pendingFor = new Set(q.map((x) => (x.event.payload as { sessionId?: string }).sessionId));
      let reached = false;
      let confirmedDashboard = false;
      for (const s of Object.values(sessions)) {
        if (pendingFor.has(s.id)) continue; // our own changes haven't landed yet
        if (s.missingOnServer) continue; // its start was rejected; the server never had it
        const r = await this.deps.api.session(s.serverId ?? s.id);
        if (!r.ok) {
          await this.noteApiError(r.error);
          // Keep what earlier sessions in this pass already learned (their tabs are unbound by now).
          await this.deps.local.set({ sessions });
          return;
        }
        if (!r.data) {
          // "Not found" only means "deleted" when it is our dashboard saying so. Some other program
          // on that address would answer 404 for everything, and must not make us forget sessions.
          if (!confirmedDashboard && !(await this.dashboardAnswers())) {
            await this.setConn("offline", "The dashboard did not answer at this address.");
            await this.deps.local.set({ sessions });
            return;
          }
          confirmedDashboard = true;
          reached = true;
          // The server had this session (nothing is pending for it) but no longer does: it was deleted
          // in the dashboard. Forget it here too, so the panel doesn't keep showing it.
          delete sessions[s.id];
          await this.unbindSession(s.id, "offer");
          continue;
        }
        reached = true;
        const srv = r.data;
        // Nothing of ours is waiting to be sent, so the dashboard's text is the latest: show it in
        // the panel (it may have been typed there).
        if (typeof srv.notes === "string") s.notes = srv.notes;
        if (typeof srv.timeComplexity === "string") s.timeComplexity = srv.timeComplexity;
        if (typeof srv.spaceComplexity === "string") s.spaceComplexity = srv.spaceComplexity;
        // Older dashboards don't report the text: then what it has is unknown.
        if (srv.notes !== undefined) s.synced = textOf(srv);
        if (srv.status === "completed" || srv.status === "abandoned") {
          if (s.status === "in_progress" || s.status === "paused") await this.unbindSession(s.id, "ignored");
          s.status = srv.status;
          s.outcome = srv.outcome;
          s.endedAt = srv.endedAt;
        } else if (srv.status === "paused" || srv.status === "in_progress") {
          s.status = srv.status;
        }
        // Mirror the server's submissions: verdicts update, and ones deleted in the dashboard disappear.
        const onServer = new Map(srv.submissions.filter((x) => x.platformSubmissionId).map((x) => [x.platformSubmissionId!, x]));
        s.submissions = s.submissions.filter((x) => !x.platformId || onServer.has(x.platformId));
        for (const mine of s.submissions) {
          const sub = mine.platformId ? onServer.get(mine.platformId) : undefined;
          if (sub) mine.verdict = sub.verdict;
        }
        sessions[s.id] = s;
      }
      // A failure marks the dashboard unreachable; clear that once it answers again, even when
      // there is nothing to sync (otherwise the panel says "unreachable" while the dashboard is fine).
      if (!reached && (await this.conn()).status === "offline") {
        const p = await this.deps.api.ping();
        if (!p.ok) return void (await this.noteApiError(p.error));
        reached = true;
      }
      if (reached) await this.setConn("ok");
      // Problem info shown for a tab was fetched before a session for it finished (and synced):
      // refresh it, so the panel shows the real session count instead of "First time".
      const tabs = await this.tabs();
      let tabsChanged = false;
      for (const [tid, t] of Object.entries(tabs)) {
        if (!t.slug || t.mode === "bound" || t.mode === "idle") continue;
        const stale = Object.values(sessions).some(
          (x) => x.problem.slug === t.slug && (x.status === "completed" || x.status === "abandoned") && !pendingFor.has(x.id) && (x.endedAt ?? 0) >= (t.contextAt ?? 0),
        );
        if (!stale) continue;
        const ctx = await this.deps.api.context(t.slug);
        if (!ctx.ok) break;
        tabs[tid] = { ...t, context: ctx.data, contextAt: this.now() };
        this.deps.notifyTab?.(Number(tid), tabs[tid]!);
        tabsChanged = true;
      }
      if (tabsChanged) await this.deps.ephemeral.set({ tabs });
      // Forget finished sessions after a day.
      const cutoff = this.now() - 24 * 3_600_000;
      for (const [id, s] of Object.entries(sessions)) if ((s.status === "completed" || s.status === "abandoned") && (s.endedAt ?? s.updatedAt) < cutoff) delete sessions[id];
      await this.deps.local.set({ sessions });
    });
  }

  // ---------- study lists ----------
  /** Remembers the study plan the tab's page loaded; the panel offers to import it. Nothing is sent until the user clicks. */
  async onStudyPlan(tabId: number, list: CapturedList) {
    const plans = (await this.deps.ephemeral.get<Record<string, StudyPlanOffer>>("studyPlans")) ?? {};
    const prev = plans[String(tabId)];
    const same = prev?.list.slug === list.slug;
    plans[String(tabId)] = { list, status: same ? prev.status : "new", message: same ? prev.message : null };
    await this.deps.ephemeral.set({ studyPlans: plans });
  }

  async importStudyPlan(tabId: number) {
    const plans = (await this.deps.ephemeral.get<Record<string, StudyPlanOffer>>("studyPlans")) ?? {};
    const offer = plans[String(tabId)];
    if (!offer) return null;
    const r = await this.deps.api.importList(offer.list);
    const next: StudyPlanOffer = r.ok
      ? { ...offer, status: "imported", message: `Imported ${r.data.count} questions as "${r.data.name}".` }
      : { ...offer, status: "error", message: r.error.kind === "offline" ? "Dashboard unreachable. Start it and try again." : r.error.message };
    const latest = (await this.deps.ephemeral.get<Record<string, StudyPlanOffer>>("studyPlans")) ?? {};
    latest[String(tabId)] = next;
    await this.deps.ephemeral.set({ studyPlans: latest });
    return next;
  }

  // ---------- read models ----------
  async panelState(tabId: number | null) {
    const [tabs, sessions, q, failed, conn, cfg, plans, queueWarning] = await Promise.all([
      this.tabs(),
      this.sessions(),
      this.queue(),
      this.failed(),
      this.conn(),
      this.getConfig(),
      this.deps.ephemeral.get<Record<string, StudyPlanOffer>>("studyPlans"),
      this.deps.local.get<QueueWarning | null>("queueWarning"),
    ]);
    const offer = tabId != null ? plans?.[String(tabId)] : undefined;
    const tab = tabId != null ? (tabs[String(tabId)] ?? null) : null;
    const session = tab?.sessionId ? (sessions[tab.sessionId] ?? null) : null;
    const now = this.now();
    const pendingForSession = session ? q.filter((x) => (x.event.payload as { sessionId?: string }).sessionId === session.id).length : 0;
    return {
      tab,
      session: session ? { ...session, displayActiveMs: displayActiveMs(session.activity, now) } : null,
      recentlyFinished: Object.values(sessions)
        .filter((s) => (s.status === "completed" || s.status === "abandoned") && tab?.slug && s.problem.slug === tab.slug)
        .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0] ?? null,
      queueLength: q.length,
      /** The offline queue hit its size limit: what could not be kept. Clears once the queue is sent. */
      queueWarning: queueWarning ?? null,
      pendingForSession,
      // Payloads (code, notes) stay in the worker; the panel only needs what to show.
      failed: failed.slice(-5).map((f) => ({ ...f, event: brief(f.event) })),
      /** Set-aside events that still hold their data and can be sent again. */
      retryable: failed.filter((f) => f.held).length,
      conn,
      paired: !!cfg.token,
      serverUrl: cfg.serverUrl,
      studyPlan: offer
        ? { slug: offer.list.slug, name: offer.list.name, count: offer.list.planSubGroups.reduce((a, g) => a + g.questions.length, 0), status: offer.status, message: offer.message }
        : null,
      now,
    };
  }

  async tabState(tabId: number) {
    return (await this.tabs())[String(tabId)] ?? null;
  }
}
