import { describe, expect, it } from "vitest";
import { pairWithDashboard } from "../src/lib/api";
import { isLoopbackUrl, normalizeDashboardUrl, splitPairingInput } from "../src/lib/dashboard-url";
import { deviceNameFromUserAgent } from "../src/lib/device-name";
import { interpret } from "../src/lib/intercept";
import { setup } from "./helpers";
import * as F from "./fixtures";

describe("dashboard address", () => {
  it("normalises to an origin; a bare host gets http://", () => {
    expect(normalizeDashboardUrl("http://127.0.0.1:4317/")).toBe("http://127.0.0.1:4317");
    expect(normalizeDashboardUrl(" my-laptop.tail1234.ts.net:8443 ")).toBe("http://my-laptop.tail1234.ts.net:8443");
    expect(normalizeDashboardUrl("HTTPS://My-Laptop.ts.net/settings?x=1")).toBe("https://my-laptop.ts.net");
    expect(() => normalizeDashboardUrl("")).toThrow(/Enter/);
    expect(() => normalizeDashboardUrl("javascript:alert(1)")).toThrow();
    expect(() => normalizeDashboardUrl("file:///etc/passwd")).toThrow(/http/);
  });

  it("knows which addresses are on this computer", () => {
    expect(isLoopbackUrl("http://127.0.0.1:4317")).toBe(true);
    expect(isLoopbackUrl("http://localhost:4317")).toBe(true);
    expect(isLoopbackUrl("http://192.168.1.20:4317")).toBe(false);
    expect(isLoopbackUrl("nope")).toBe(false);
  });

  it("splits the dashboard's 'address  CODE' line pasted into either field", () => {
    expect(splitPairingInput("https://laptop.ts.net:8443  K7Q4-MX2P", "")).toEqual({ address: "https://laptop.ts.net:8443", code: "K7Q4-MX2P" });
    expect(splitPairingInput("", "https://laptop.ts.net:8443  K7Q4-MX2P")).toEqual({ address: "https://laptop.ts.net:8443", code: "K7Q4-MX2P" });
    expect(splitPairingInput("http://127.0.0.1:4317", "k7q4mx2p")).toEqual({ address: "http://127.0.0.1:4317", code: "k7q4mx2p" });
    expect(splitPairingInput("http://127.0.0.1:4317", "")).toEqual({ address: "http://127.0.0.1:4317", code: "" });
  });
});

describe("default device name", () => {
  it.each([
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36", {}, "Chrome on Windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0", {}, "Edge on Windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36", { brave: true }, "Brave on Windows"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0", {}, "Firefox on Linux"],
    ["Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0", {}, "Firefox on Android"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", { maxTouchPoints: 5 }, "Safari on iPadOS"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", { maxTouchPoints: 0 }, "Safari on macOS"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", {}, "Safari on iOS"],
    ["something else", {}, "Browser"],
  ])("%s → %s", (ua, hints, name) => {
    expect(deviceNameFromUserAgent(ua, hints)).toBe(name);
  });
});

describe("pairWithDashboard", () => {
  const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("posts the code and name, and returns the key", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ token: "k", deviceId: "d", name: "Edge on Windows" }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await pairWithDashboard("https://laptop.ts.net/", "K7Q4-MX2P", "Edge on Windows", "0.3.0", fetchImpl)).toEqual({ ok: true, token: "k", deviceId: "d", name: "Edge on Windows" });
    expect(seen!.url).toBe("https://laptop.ts.net/api/ext/pair");
    expect(JSON.parse(String(seen!.init.body))).toEqual({ code: "K7Q4-MX2P", name: "Edge on Windows" });
    expect((seen!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("explains each failure", async () => {
    expect(await pairWithDashboard("http://x", "c", "n", "v", respond(401, { hint: "That pairing code has expired." }))).toEqual({ ok: false, message: "That pairing code has expired." });
    expect(await pairWithDashboard("http://x", "c", "n", "v", respond(403, "Forbidden host"))).toMatchObject({ ok: false, message: expect.stringMatching(/server mode/) });
    expect(await pairWithDashboard("http://x", "c", "n", "v", respond(404, {}))).toMatchObject({ ok: false, message: expect.stringMatching(/not a LeetCode Companion/) });
    const offline = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await pairWithDashboard("http://x", "c", "n", "v", offline)).toMatchObject({ ok: false, message: expect.stringMatching(/Can't reach.*ECONNREFUSED/) });
  });
});

describe("re-pairing", () => {
  it("keeps the offline queue and delivers it with the new key", async () => {
    const env = setup({ online: false });
    await env.ctl.setConfig({ token: "old" });
    await env.ctl.onPage(1, { slug: "3sum" });
    await env.ctl.startSession(1);
    await env.ctl.onIntercepted(1, interpret("POST", "https://leetcode.com/problems/3sum/submit/", F.SUBMIT_BODY, F.SUBMIT_RESPONSE)!);
    await env.ctl.flush();
    const queued = ((await env.local.get<unknown[]>("queue")) ?? []).length;
    expect(queued).toBeGreaterThan(0);
    // Removed in the dashboard, paired again (new address form, new key): nothing queued is lost.
    await env.ctl.setConfig({ serverUrl: "http://127.0.0.1:4317/", token: "new", deviceId: "d2" });
    expect(((await env.local.get<unknown[]>("queue")) ?? []).length).toBe(queued);
    env.state.online = true;
    for (let i = 0; i < 10 && ((await env.local.get<unknown[]>("queue")) ?? []).length; i++) await env.ctl.flush();
    expect(env.sent.some((e) => e.type === "submission.captured")).toBe(true);
    expect((await env.ctl.getConfig()).token).toBe("new");
  });
});
