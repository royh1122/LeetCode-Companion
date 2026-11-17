import { describe, expect, it } from "vitest";
import { decideRequest, effectiveBaseUrl, parseServerConfig, type RequestFacts } from "../src";

const off = parseServerConfig(null);
const on = parseServerConfig({ hosts: ["laptop.tail.ts.net", "192.168.1.20:4317"] });

function req(over: Partial<RequestFacts>): RequestFacts {
  return { host: "127.0.0.1:4317", path: "/", method: "GET", origin: null, secFetchSite: null, secFetchMode: null, secFetchDest: null, forwardedHost: null, ...over };
}
const allowed = (r: Partial<RequestFacts>, c = on) => decideRequest(req(r), c).allow;

describe("decideRequest: hosts", () => {
  it("server mode off: only loopback, exactly as before", () => {
    expect(allowed({ host: "127.0.0.1:4317" }, off)).toBe(true);
    expect(allowed({ host: "localhost:4317" }, off)).toBe(true);
    expect(allowed({ host: "[::1]:4317" }, off)).toBe(true);
    expect(allowed({ host: "laptop.tail.ts.net" }, off)).toBe(false);
    expect(allowed({ host: "evil.example" }, off)).toBe(false);
    expect(allowed({ host: "" }, off)).toBe(false);
  });

  it("server mode on: configured hosts too, nothing else", () => {
    expect(allowed({ host: "laptop.tail.ts.net" })).toBe(true);
    expect(allowed({ host: "192.168.1.20:4317" })).toBe(true);
    expect(allowed({ host: "192.168.1.20:8080" })).toBe(false);
    expect(allowed({ host: "rebind.evil.example" })).toBe(false);
  });

  it("a forwarded host must be allowed as well", () => {
    expect(allowed({ host: "127.0.0.1:4317", forwardedHost: "laptop.tail.ts.net" })).toBe(true);
    expect(allowed({ host: "127.0.0.1:4317", forwardedHost: "evil.example" })).toBe(false);
    expect(allowed({ host: "127.0.0.1:4317", forwardedHost: "evil.example, laptop.tail.ts.net" })).toBe(false);
    expect(allowed({ host: "127.0.0.1:4317", forwardedHost: "laptop.tail.ts.net" }, off)).toBe(false);
  });
});

describe("decideRequest: extension API", () => {
  it("allows the extension or no Origin, nothing else; never preflight", () => {
    expect(allowed({ path: "/api/ext/events", method: "POST", origin: "chrome-extension://abc" })).toBe(true);
    expect(allowed({ host: "laptop.tail.ts.net", path: "/api/ext/events", method: "POST" })).toBe(true);
    expect(allowed({ path: "/api/ext/events", method: "POST", origin: "https://evil.example" })).toBe(false);
    expect(allowed({ path: "/api/ext/events", method: "OPTIONS", origin: "chrome-extension://abc" })).toBe(false);
  });
});

describe("decideRequest: pages", () => {
  it("cross-site only as a top-level navigation", () => {
    expect(allowed({ secFetchSite: "cross-site", secFetchMode: "navigate", secFetchDest: "document" })).toBe(true);
    expect(allowed({ secFetchSite: "cross-site", secFetchMode: "no-cors", secFetchDest: "image" })).toBe(false);
    expect(allowed({ secFetchSite: "cross-site", secFetchMode: "navigate", secFetchDest: "iframe" })).toBe(false);
  });
});

describe("decideRequest: dashboard API", () => {
  it("same origin passes, directly and behind a proxy", () => {
    expect(allowed({ path: "/api/revision", origin: "http://127.0.0.1:4317", secFetchSite: "same-origin" })).toBe(true);
    expect(allowed({ host: "laptop.tail.ts.net", path: "/api/revision", origin: "https://laptop.tail.ts.net", secFetchSite: "same-origin" })).toBe(true);
    // Proxy keeps Host as 127.0.0.1 and sends X-Forwarded-Host.
    expect(allowed({ host: "127.0.0.1:4319", forwardedHost: "laptop.tail.ts.net:8443", path: "/api/revision", origin: "https://laptop.tail.ts.net:8443", secFetchSite: "same-origin" })).toBe(true);
    // Proxy rewrites Host to 127.0.0.1 and sends no forwarded host.
    expect(allowed({ host: "127.0.0.1:4319", path: "/api/revision", origin: "https://laptop.tail.ts.net:8443", secFetchSite: "same-origin" })).toBe(true);
  });

  it("other origins and cross-site requests are refused", () => {
    expect(allowed({ path: "/api/revision", origin: "https://evil.example" })).toBe(false);
    expect(allowed({ path: "/api/revision", origin: "http://localhost:3000" })).toBe(false);
    expect(allowed({ path: "/api/revision", secFetchSite: "cross-site" })).toBe(false);
    expect(allowed({ path: "/api/revision", secFetchSite: "same-site" })).toBe(false);
    expect(allowed({ path: "/api/revision", origin: "not a url" })).toBe(false);
    expect(allowed({ host: "laptop.tail.ts.net", path: "/api/revision", origin: "https://laptop.tail.ts.net" }, off)).toBe(false);
  });
});

describe("effectiveBaseUrl", () => {
  it("uses Host by default and trusted forwarded values behind a proxy", () => {
    expect(effectiveBaseUrl("127.0.0.1:4317", null, null, off)).toBe("http://127.0.0.1:4317");
    expect(effectiveBaseUrl("127.0.0.1:4319", "laptop.tail.ts.net:8443", "https", on)).toBe("https://laptop.tail.ts.net:8443");
    expect(effectiveBaseUrl("127.0.0.1:4319", "evil.example", "https", on)).toBe("https://127.0.0.1:4319");
    expect(effectiveBaseUrl("laptop.tail.ts.net", null, "gopher", on)).toBe("http://laptop.tail.ts.net");
  });
});
