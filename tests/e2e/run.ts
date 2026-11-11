/**
 * `npm run test:e2e` — builds the extension, starts the dashboard on a fresh
 * temporary data directory (port 4317 must be free), checks the local security
 * boundary, runs the dashboard UI flow and the extension flow, then shuts everything down.
 * Flags: --real-leetcode (also check detection/injection on the real, logged-out leetcode.com)
 *        --shots <dir>   (save screenshots)
 */
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname ?? __dirname, "..", "..");
const args = process.argv.slice(2);
const shotsIdx = args.indexOf("--shots");
const shots = shotsIdx >= 0 ? args[shotsIdx + 1] : undefined;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lcc-e2e-data-"));
const env = { ...process.env, LCC_DATA_DIR: dataDir, NEXT_TELEMETRY_DISABLED: "1" };

async function waitForServer(url: string, ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
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

async function main() {
  // The flows drive whatever answers on 4317. If that is the real dashboard, they would write to real data.
  const busy = await fetch("http://127.0.0.1:4317/", { signal: AbortSignal.timeout(1500) }).then(
    () => true,
    () => false,
  );
  if (busy) {
    console.error("Port 4317 is in use (is the dashboard running?). Stop it first; the end-to-end tests were NOT run.");
    process.exitCode = 1;
    return;
  }
  run("npm run ext:build");
  execSync("npx tsx scripts/db.ts migrate", { cwd: root, env, stdio: "inherit" });
  execSync("npx tsx scripts/db.ts sample", { cwd: root, env, stdio: "inherit" });
  const server = spawn("npx", ["next", "dev", "-H", "127.0.0.1", "-p", "4317"], { cwd: path.join(root, "apps", "web"), env, shell: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  try {
    await waitForServer("http://127.0.0.1:4317/api/revision");
    run("npx tsx tests/e2e/boundary.ts");
    run(`npx tsx tests/e2e/ui-flow.ts ${shots ?? ""}`);
    run(`npx tsx tests/e2e/extension-flow.ts ${args.includes("--real-leetcode") ? "--real-leetcode" : ""} ${shots ?? ""}`);
    console.log("\nAll E2E flows passed.");
  } catch (e) {
    console.error(log.split("\n").slice(-40).join("\n"));
    throw e;
  } finally {
    if (process.platform === "win32" && server.pid) {
      try {
        execSync(`taskkill /PID ${server.pid} /T /F`, { stdio: "ignore" });
      } catch {
        /* already gone */
      }
    } else server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

main().catch(() => process.exit(1));
