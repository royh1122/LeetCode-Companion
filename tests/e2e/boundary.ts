/**
 * Local security boundary checks (run by `npm run test:e2e` against the dashboard it starts).
 * Plain HTTP requests, because browsers won't let a test set a foreign Host header.
 */
import http from "node:http";
import { E2E_PORT } from "./port";

type Res = { status: number; headers: http.IncomingHttpHeaders };

function request(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: E2E_PORT, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

function expectStatus(name: string, r: Res, status: number) {
  if (r.status !== status) throw new Error(`${name}: expected ${status}, got ${r.status}`);
  console.log(`✓ ${name} → ${status}`);
}

async function main() {
  const host = `127.0.0.1:${E2E_PORT}`;
  // DNS rebinding: a page on evil.example resolved to 127.0.0.1 still sends its own Host.
  expectStatus("foreign Host header", await request("/", { headers: { Host: `evil.example:${E2E_PORT}` } }), 403);
  expectStatus("foreign Host on an API", await request("/api/export", { headers: { Host: "evil.example" } }), 403);
  // Cross-site reads of dashboard APIs.
  expectStatus("cross-site API request", await request("/api/export", { headers: { Host: host, "Sec-Fetch-Site": "cross-site" } }), 403);
  expectStatus("API request from another origin", await request("/api/revision", { headers: { Host: host, Origin: "https://evil.example" } }), 403);
  // Extension API: token required, web origins and preflights refused.
  const json = { "Content-Type": "application/json" };
  expectStatus("extension API without a token", await request("/api/ext/events", { method: "POST", headers: { Host: host, ...json }, body: '{"events":[]}' }), 401);
  expectStatus("extension API with a wrong token", await request("/api/ext/ping", { headers: { Host: host, Authorization: "Bearer wrong" } }), 401);
  expectStatus("extension API from a web origin", await request("/api/ext/ping", { headers: { Host: host, Origin: "https://evil.example", Authorization: "Bearer x" } }), 403);
  expectStatus("CORS preflight to the extension API", await request("/api/ext/events", { method: "OPTIONS", headers: { Host: host, Origin: "https://evil.example" } }), 403);
  // Headers on a normal page.
  const page = await request("/", { headers: { Host: host } });
  expectStatus("dashboard page", page, 200);
  if (page.headers["x-frame-options"] !== "DENY") throw new Error(`X-Frame-Options: ${page.headers["x-frame-options"]}`);
  if (page.headers["access-control-allow-origin"]) throw new Error("CORS header sent");
  console.log("✓ X-Frame-Options: DENY, no CORS headers");
  console.log("Security boundary OK");
}

main().catch((e) => {
  console.error("SECURITY BOUNDARY FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
