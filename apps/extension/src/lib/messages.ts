import type { Reflection } from "@lcc/shared";
import type { Config } from "./controller";

/** Messages sent to the service worker (from content scripts, side panel and options page). */
export type BgRequest =
  | { type: "page"; slug: string | null; title?: string | null; frontendId?: string | null; hashSessionId?: string | null }
  | { type: "heartbeat"; visible: boolean; focused: boolean; lastInputAt: number; captureReady: boolean }
  | { type: "intercepted"; payload: unknown }
  | { type: "start"; tabId?: number }
  | { type: "resume"; tabId?: number; sessionId: string }
  | { type: "ignore"; tabId?: number }
  | { type: "pause"; sessionId: string }
  | { type: "unpause"; sessionId: string }
  | { type: "notes"; sessionId: string; notes?: string; timeComplexity?: string; spaceComplexity?: string }
  | { type: "finish"; sessionId: string; reflection: Reflection }
  | { type: "abandon"; sessionId: string }
  | { type: "panel:get"; tabId?: number | null }
  | { type: "sync:now" }
  | { type: "list:import"; tabId?: number }
  | { type: "config:get" }
  | { type: "config:set"; config: Partial<Config> }
  | { type: "ping" }
  | { type: "open-dashboard"; path?: string };

export async function send<T = unknown>(msg: BgRequest): Promise<T> {
  const r = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; data?: T; error?: string } | undefined;
  if (!r) throw new Error("No response from extension background");
  if (!r.ok) throw new Error(r.error ?? "Extension error");
  return r.data as T;
}
