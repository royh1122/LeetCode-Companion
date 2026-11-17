/**
 * Security boundary checks (run by `npm run test:e2e` against the dashboard it starts, in server mode with one extra address).
 * Plain HTTP requests, because browsers won't let a test set a foreign Host header.
 */
import http from "node:http";
import { E2E_PORT, E2E_SERVER_HOST } from "./port";

type Res = { status: number; headers: http.IncomingHttpHeaders };

type ResWithBody = Res & { body: string };

function request(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<ResWithBody> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: E2E_PORT, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        if (body.length < 4000) body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
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
  // Server actions (every dashboard change) from another site, or from a sandboxed page (Origin: null).
  // A dummy action id: the same-origin control gets past the origin check to "unknown action" (409),
  // so a different answer for the others shows the origin check refused them before any lookup.
  const action = (origin: string) =>
    request("/", { method: "POST", headers: { Host: host, Origin: origin, "Next-Action": "0".repeat(42), "Content-Type": "text/plain;charset=UTF-8" }, body: "[]" });
  const control = await action(`http://${host}`);
  if (control.status !== 409) throw new Error(`server action control: expected 409 (unknown action), got ${control.status}`);
  for (const [name, origin] of [["server action from another site", "https://evil.example"], ["server action with Origin: null", "null"]] as const) {
    const r = await action(origin);
    if (r.status < 400 || r.status === control.status) throw new Error(`${name}: not refused (status ${r.status})`);
    if (r.status !== 403 && !r.body.includes("Invalid Server Actions request")) throw new Error(`${name}: refused for another reason (${r.status}: ${r.body.slice(0, 200)})`);
    console.log(`✓ ${name} → refused (${r.status})`);
  }
  // Server mode: the runner starts the dashboard with one extra address (E2E_SERVER_HOST).
  const extra = E2E_SERVER_HOST;
  const extraName = extra.replace(/:\d+$/, "");
  expectStatus("server-mode address", await request("/", { headers: { Host: extra } }), 200);
  expectStatus("server-mode address on another port", await request("/", { headers: { Host: `${extraName}:1` } }), 403);
  expectStatus("a lookalike of the server-mode address", await request("/", { headers: { Host: `evil.${extra}` } }), 403);
  expectStatus("forwarded server-mode address (local proxy)", await request("/", { headers: { Host: host, "X-Forwarded-Host": extra } }), 200);
  expectStatus("forwarded foreign host", await request("/", { headers: { Host: host, "X-Forwarded-Host": "evil.example" } }), 403);
  expectStatus("dashboard API from the server-mode origin, Host rewritten by a proxy", await request("/api/revision", { headers: { Host: host, Origin: `https://${extra}`, "Sec-Fetch-Site": "same-origin" } }), 200);
  // Next's own server-action check reads allowedOrigins at start: an origin it lists passes to "unknown action".
  const viaProxy = await action(`http://${extra}`);
  if (viaProxy.status !== 409) throw new Error(`server action from the server-mode origin (Host rewritten): expected 409, got ${viaProxy.status}: ${viaProxy.body.slice(0, 200)}`);
  console.log("✓ server action from the server-mode origin passes the origin check (allowedOrigins read at start)");
  // Pairing endpoint: no key needed, but still extension-only.
  const pair = (headers: Record<string, string>, method = "POST") => request("/api/ext/pair", { method, headers: { Host: extra, ...json, ...headers }, body: method === "POST" ? '{"code":"0000-0000","name":"x"}' : undefined });
  expectStatus("pairing with no code waiting", await pair({}), 401);
  expectStatus("pairing from a web origin", await pair({ Origin: "https://evil.example" }), 403);
  expectStatus("CORS preflight to the pairing endpoint", await pair({ Origin: "https://evil.example" }, "OPTIONS"), 403);
  // Pages: another site may link to the dashboard, but not load a page as an image or a frame
  // (rendering Today plans the day).
  const fromSite = (mode: string, dest: string) => ({ Host: host, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": mode, "Sec-Fetch-Dest": dest });
  expectStatus("page loaded as an image by another site", await request("/", { headers: fromSite("no-cors", "image") }), 403);
  expectStatus("page framed by another site", await request("/", { headers: fromSite("navigate", "iframe") }), 403);
  expectStatus("link from another site (top-level navigation)", await request("/", { headers: fromSite("navigate", "document") }), 200);
  // Headers on a normal page.
  const page = await request("/", { headers: { Host: host } });
  expectStatus("dashboard page", page, 200);
  if (page.headers["x-frame-options"] !== "DENY") throw new Error(`X-Frame-Options: ${page.headers["x-frame-options"]}`);
  if (page.headers["access-control-allow-origin"]) throw new Error("CORS header sent");
  const csp = String(page.headers["content-security-policy"] ?? "");
  for (const d of ["connect-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'"]) if (!csp.includes(d)) throw new Error(`Content-Security-Policy lacks ${d}: ${csp}`);
  console.log("✓ X-Frame-Options: DENY, Content-Security-Policy, no CORS headers");
  console.log("Security boundary OK");
}

main().catch((e) => {
  console.error("SECURITY BOUNDARY FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
