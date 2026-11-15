import type { BgRequest } from "./messages";

/** What content scripts on leetcode.com may ask for. Everything else (settings, token, sync, finishing…) is for extension pages only. */
export const CONTENT_SCRIPT_MESSAGES = new Set<BgRequest["type"]>(["page", "heartbeat", "intercepted", "start", "resume", "ignore", "open-dashboard"]);

/** Extension pages may send anything; any other sender (a web page's content script) only the messages above. */
export function isAllowedMessage(type: BgRequest["type"], senderUrl: string | undefined, extensionId: string): boolean {
  const fromExtensionPage = !!senderUrl?.startsWith(`chrome-extension://${extensionId}/`);
  return fromExtensionPage || CONTENT_SCRIPT_MESSAGES.has(type);
}
