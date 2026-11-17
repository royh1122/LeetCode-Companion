/**
 * `npm run test:e2e` — builds the extension, starts the dashboard on a fresh
 * temporary data directory on its own port (4327 by default, see port.ts; the real
 * dashboard on 4317 can keep running) in server mode with one extra address (port.ts), checks
 * the security boundary, runs the dashboard UI flow and the extension flow (which pairs through
 * that address), then shuts everything down.
 * The flows load a temporary copy of the built extension with test-only access to *.localhost.
 * Flags: --real-leetcode (also check detection/injection on the real, logged-out leetcode.com)
 *        --shots <dir>   (save screenshots)
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { E2E_BASE, E2E_PORT, E2E_SERVER_HOST } from "./port";

const root = path.resolve(import.meta.dirname ?? __dirname, "..", "..");
const args = process.argv.slice(2);
const shotsIdx = args.indexOf("--shots");
const shots = shotsIdx >= 0 ? args[shotsIdx + 1] : undefined;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lcc-e2e-data-"));
// LCC_DB_PATH would take priority over the temporary data directory: never pass it on.
const { LCC_DB_PATH: _dbPath, ...inherited } = process.env;
// A copy of the built extension for the flows (see grantTestHostAccess); apps/extension/dist stays as built.
const testExtDir = path.join(dataDir, "extension");
// Server mode on, with one extra address (see port.ts), as `npm run up` would pass it from server.json.
const env = {
  ...inherited,
  LCC_DATA_DIR: dataDir,
  LCC_URL: E2E_BASE,
  NEXT_TELEMETRY_DISABLED: "1",
  LCC_ALLOWED_HOSTS: E2E_SERVER_HOST,
  LCC_LISTEN: "loopback",
  LCC_E2E_EXT: testExtDir,
  // Its own Next build folder, emptied at the start of each run (see main), never shared with dev:demo.
  LCC_NEXT_DIST_DIR: ".next-e2e",
};

/**
 * Headless Chrome can't click the extension's permission prompt. The test copy of the extension
 * therefore already holds access to *.localhost, so chrome.permissions.request() for the
 * server-mode address resolves at once; the options page still makes the same call.
 */
function grantTestHostAccess() {
  fs.cpSync(path.join(root, "apps", "extension", "dist"), testExtDir, { recursive: true });
  const file = path.join(testExtDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as { host_permissions: string[] };
  manifest.host_permissions.push("http://*.localhost/*");
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
}

/**
 * True if anything accepts a connection on the port. A raw TCP check: an HTTP request that
 * hangs (a stuck server) must count as "taken", not "free".
 */
function portTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (taken: boolean) => {
      sock.destroy();
      resolve(taken);
    };
    sock.setTimeout(1500, () => done(true));
    sock.once("connect", () => done(true));
    sock.once("error", (e: NodeJS.ErrnoException) => done(e.code !== "ECONNREFUSED"));
  });
}

/**
 * Waits for our own child to answer. The port was free when it started, and if another server
 * grabbed it first, `next dev` fails to bind and exits: so a live child plus an answer means
 * the flows talk to the server this run started, on the temp data directory.
 */
async function waitForServer(url: string, server: ChildProcess, ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error(`the test server exited early (${server.exitCode ?? server.signalCode})`);
    try {
      const r = await fetch(url);
      // Checked again after the answer: a dead child means someone else answered.
      if (r.ok && server.exitCode === null && server.signalCode === null) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("dashboard did not start");
}

function run(cmd: string) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd: root, env, stdio: "inherit" });
}

let server: ChildProcess | undefined;
let cleaning: Promise<void> | undefined;

/**
 * Stops the test server (its whole process tree) and removes the temp data. Every caller (the
 * Ctrl+C handler, main's finally) awaits the same run, so none of them exits half-way through.
 */
function cleanup(): Promise<void> {
  return (cleaning ??= stopAndRemove());
}

async function stopAndRemove() {
  if (server?.pid && server.exitCode === null) {
    if (process.platform === "win32") {
      try {
        execSync(`taskkill /PID ${server.pid} /T /F`, { stdio: "ignore" });
      } catch {
        /* already gone */
      }
    } else {
      // The server was started in its own process group: signal the group, not just the shell.
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {
        server.kill("SIGTERM");
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

async function main() {
  // The flows drive whatever answers on the e2e port; refuse if something else is on it.
  if (await portTaken(E2E_PORT)) {
    console.error(`Port ${E2E_PORT} is in use. Stop whatever is on it, or set LCC_E2E_PORT; the end-to-end tests were NOT run.`);
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.exitCode = 1;
    return;
  }
  // Ctrl+C would otherwise leave the server running on the e2e port.
  process.once("SIGINT", () => {
    console.error("\nInterrupted: stopping the test server.");
    void cleanup().finally(() => process.exit(130));
  });
  let log = "";
  try {
    run("npm run ext:build");
    grantTestHostAccess();
    execSync("npx tsx scripts/db.ts migrate", { cwd: root, env, stdio: "inherit" });
    execSync("npx tsx scripts/db.ts sample", { cwd: root, env, stdio: "inherit" });
    // A plan with new questions every day, so the flows don't depend on the weekday.
    execSync("npx tsx tests/e2e/setup-plan.ts", { cwd: root, env, stdio: "inherit" });
    // Start from an empty build folder: a dev cache left from an earlier run with older sources made
    // the first pages reload over and over while it caught up, longer than the flows wait.
    fs.rmSync(path.join(root, "apps", "web", env.LCC_NEXT_DIST_DIR), { recursive: true, force: true });
    server = spawn("npx", ["next", "dev", "-H", "127.0.0.1", "-p", String(E2E_PORT)], {
      cwd: path.join(root, "apps", "web"),
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    server.stdout!.on("data", (d) => (log += d));
    server.stderr!.on("data", (d) => (log += d));
    await waitForServer(`${E2E_BASE}/api/revision`, server);
    run("npx tsx tests/e2e/boundary.ts");
    run(`npx tsx tests/e2e/ui-flow.ts ${shots ?? ""}`);
    run(`npx tsx tests/e2e/extension-flow.ts ${args.includes("--real-leetcode") ? "--real-leetcode" : ""} ${shots ?? ""}`);
    console.log("\nAll E2E flows passed.");
  } catch (e) {
    if (log) console.error(log.split("\n").slice(-40).join("\n"));
    throw e;
  } finally {
    await cleanup();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
