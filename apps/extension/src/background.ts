/**
 * MV3 service worker. Thin wiring around Controller: chrome events in,
 * persisted state + local-dashboard HTTP out. The worker may be killed at any
 * time; nothing important lives only in memory.
 */
import type { Reflection } from "@lcc/shared";
import { httpApi } from "./lib/api";
import { Controller, type TabState } from "./lib/controller";
import type { Intercepted } from "./lib/intercept";
import type { BgRequest } from "./lib/messages";
import { chromeKV } from "./lib/storage";

const VERSION = chrome.runtime.getManifest().version;
const local = chromeKV(chrome.storage.local);
// Tab bindings only make sense for this browser run; session storage is cleared on restart.
const ephemeral = chromeKV(chrome.storage.session);

const controller: Controller = new Controller({
  local,
  ephemeral,
  api: httpApi(async () => {
    const c = await controller.getConfig();
    return { serverUrl: c.serverUrl, token: c.token, version: VERSION };
  }),
  notifyTab: (tabId: number, state: TabState) => {
    chrome.tabs.sendMessage(tabId, { type: "tab:state", state }).catch(() => undefined);
  },
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  await chrome.alarms.create("lcc-sync", { periodInMinutes: 0.5 });
  if (details.reason === "install") chrome.runtime.openOptionsPage().catch(() => undefined);
});
chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create("lcc-sync", { periodInMinutes: 0.5 });
  void controller.flush();
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== "lcc-sync") return;
  await controller.flush();
  await controller.reconcile();
});

chrome.tabs.onRemoved.addListener((tabId) => void controller.onTabClosed(tabId));

/** What content scripts on leetcode.com may ask for. Everything else (settings, token, sync, finishing…) is for extension pages only. */
const CONTENT_SCRIPT_MESSAGES = new Set<BgRequest["type"]>(["page", "heartbeat", "intercepted", "start", "resume", "ignore", "open-dashboard"]);

async function handle(msg: BgRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const fromExtensionPage = !!sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`);
  if (!fromExtensionPage && !CONTENT_SCRIPT_MESSAGES.has(msg.type)) throw new Error("Not allowed from a web page");
  // Explicit tabId (side panel acting on a LeetCode tab) wins over the sender's own tab.
  const explicit = "tabId" in msg && typeof msg.tabId === "number" ? msg.tabId : undefined;
  const tabId = explicit ?? sender.tab?.id;
  switch (msg.type) {
    case "page":
      if (tabId == null) return null;
      return controller.onPage(tabId, msg);
    case "heartbeat":
      if (tabId != null) await controller.onHeartbeat(tabId, msg);
      return null;
    case "intercepted":
      if (tabId != null) await controller.onIntercepted(tabId, msg.payload as Intercepted);
      return null;
    case "start":
      return controller.startSession(tabId!);
    case "resume":
      return controller.resumeSession(tabId!, msg.sessionId);
    case "ignore":
      return controller.ignore(tabId!);
    case "pause":
      return controller.pause(msg.sessionId);
    case "unpause":
      return controller.resume(msg.sessionId);
    case "notes":
      return controller.setNotes(msg.sessionId, { notes: msg.notes, timeComplexity: msg.timeComplexity, spaceComplexity: msg.spaceComplexity });
    case "finish":
      return controller.finish(msg.sessionId, msg.reflection as Reflection);
    case "abandon":
      return controller.abandon(msg.sessionId);
    case "panel:get":
      return controller.panelState(msg.tabId ?? null);
    case "list:import":
      return tabId != null ? controller.importStudyPlan(tabId) : null;
    case "sync:now": {
      const r = await controller.flush();
      await controller.reconcile();
      return r;
    }
    case "config:get":
      return controller.getConfig();
    case "config:set": {
      const c = await controller.setConfig(msg.config);
      return c;
    }
    case "ping": {
      const cfg = await controller.getConfig();
      const r = await httpApi(async () => ({ serverUrl: cfg.serverUrl, token: cfg.token, version: VERSION })).ping();
      return r;
    }
    case "open-dashboard": {
      const cfg = await controller.getConfig();
      await chrome.tabs.create({ url: `${cfg.serverUrl.replace(/\/+$/, "")}${msg.path ?? "/"}` });
      return null;
    }
    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((msg: BgRequest, sender, sendResponse) => {
  // Only accept messages from our own extension contexts / content scripts.
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg, sender).then(
    (r) => sendResponse({ ok: true, data: r }),
    (e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
  return true;
});
