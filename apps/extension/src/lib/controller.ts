import type { ExtensionContext, ProblemHint, Reflection, SyncEvent, SyncEventType, Verdict } from "@lcc/shared";
import { applyHeartbeat, displayActiveMs, isActive, type ActivityState } from "./activity";
import type { Api, ApiError } from "./api";
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
  token: string;
  clientId: string;
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
}

/** Only http(s) on 127.0.0.1 or localhost. */
export function isLocalDashboardUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && ["127.0.0.1", "localhost"].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Rejected events are kept only for display (type + error); their payload (code, notes) is dropped. */
function brief(e: SyncEvent): SyncEvent {
  return { id: e.id, clientId: e.clientId, seq: e.seq, createdAt: e.createdAt, type: e.type, payload: {} } as unknown as SyncEvent;
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
}

const DEFAULT_CONFIG: Config = { serverUrl: "http://127.0.0.1:4317", token: "", clientId: "" };
const ACTIVITY_SYNC_MS = 60_000;
const MAX_BATCH = 50;

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
    // Code and notes must only ever go to a dashboard on this computer.
    if (patch.serverUrl !== undefined && !isLocalDashboardUrl(patch.serverUrl)) throw new Error("The dashboard must run on this computer (localhost / 127.0.0.1).");
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
    await this.deps.local.set({ seq, queue: q });
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
          const t = { ...prev, title: info.title ?? prev.title };
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
      const active = s.status === "in_progress" && isActive(h, now, idle);
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

  /** Save the session's text fields (any subset). The queued event is a snapshot of every field known locally. */
  setNotes(id: string, patch: { notes?: string; timeComplexity?: string; spaceComplexity?: string }) {
    return this.lock(async () => {
      const s = await this.mutateSession(id, (x) => {
        if (patch.notes !== undefined) x.notes = patch.notes;
        if (patch.timeComplexity !== undefined) x.timeComplexity = patch.timeComplexity;
        if (patch.spaceComplexity !== undefined) x.spaceComplexity = patch.spaceComplexity;
      });
      await this.enqueue(
        "session.notes",
        {
          sessionId: id,
          notes: s.notes,
          ...(s.timeComplexity !== undefined ? { timeComplexity: s.timeComplexity } : {}),
          ...(s.spaceComplexity !== undefined ? { spaceComplexity: s.spaceComplexity } : {}),
        },
        { coalesceKey: id },
      );
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
            await this.lock(async () => {
              const q = await this.queue();
              const ids = new Set(batch.map((b) => b.event.id));
              if (batch.length === 1 && batch[0]!.attempts >= 5) {
                // Set the culprit aside (visible in the panel) so everything behind it can sync.
                const failed = (await this.deps.local.get<{ event: SyncEvent; error: string; at: number }[]>("failed")) ?? [];
                failed.push({ event: brief(batch[0]!.event), error: message, at: this.now() });
                await this.deps.local.set({ queue: q.filter((x) => !ids.has(x.event.id)), failed: failed.slice(-20) });
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
          const failed = (await this.deps.local.get<{ event: SyncEvent; error: string; at: number }[]>("failed")) ?? [];
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
          await this.deps.local.set({ queue: keep, failed: failed.slice(-20), sessions });
        });
      }
    } finally {
      this.flushing = false;
    }
    return { sent, remaining: (await this.queue()).length };
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
      for (const s of Object.values(sessions)) {
        if (pendingFor.has(s.id)) continue; // our own changes haven't landed yet
        if (s.missingOnServer) continue; // its start was rejected; the server never had it
        const r = await this.deps.api.session(s.serverId ?? s.id);
        if (!r.ok) {
          await this.noteApiError(r.error);
          return;
        }
        reached = true;
        if (!r.data) {
          // The server had this session (nothing is pending for it) but no longer does: it was deleted
          // in the dashboard. Forget it here too, so the panel doesn't keep showing it.
          delete sessions[s.id];
          await this.unbindSession(s.id, "offer");
          continue;
        }
        const srv = r.data;
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
    const [tabs, sessions, q, failed, conn, cfg, plans] = await Promise.all([
      this.tabs(),
      this.sessions(),
      this.queue(),
      this.deps.local.get<{ event: SyncEvent; error: string; at: number }[]>("failed"),
      this.conn(),
      this.getConfig(),
      this.deps.ephemeral.get<Record<string, StudyPlanOffer>>("studyPlans"),
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
      pendingForSession,
      failed: (failed ?? []).slice(-5),
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
