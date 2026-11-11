/**
 * `npm run up` — start the dashboard the convenient way:
 *  1. If something is already serving on 127.0.0.1:4317, just open the browser.
 *  2. Rebuild the dashboard only if its source changed since the last build
 *     (and the extension, if its source changed — it then needs a reload in Chrome).
 *  3. Start the production server (migrations run first, with a backup),
 *     wait until it answers, and open the dashboard in the default browser.
 * By default the server keeps running in this terminal; press Ctrl+C (or run
 * `npm run down`) to stop.
 *
 * `--background` (used by the Windows shortcut): the server is started as a
 * hidden, detached process that writes to data/server.log, and this script
 * exits once the dashboard answers. Stop it with `npm run down` / the Stop shortcut.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const BACKGROUND = process.argv.includes("--background");
const DATA_DIR = process.env.LCC_DATA_DIR ? path.resolve(process.env.LCC_DATA_DIR) : path.join(ROOT, "data");
// LCC_PORT / LCC_NO_BROWSER exist for testing; normal use is port 4317 (the extension expects it).
const PORT = Number(process.env.LCC_PORT) || 4317;
const URL_ = `http://127.0.0.1:${PORT}/`;

function log(msg: string) {
  console.log(`[up] ${msg}`);
}

async function isServing(): Promise<boolean> {
  try {
    const res = await fetch(URL_, { signal: AbortSignal.timeout(1500), redirect: "manual" });
    return res.status > 0;
  } catch {
    return false;
  }
}

/** Newest modification time under the given files/directories (skips node_modules, build output). */
function newestMtime(entries: string[]): number {
  let newest = 0;
  const walk = (p: string) => {
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      const base = path.basename(p);
      if (base === "node_modules" || base === ".next" || base === "dist" || base === "test") return;
      for (const e of fs.readdirSync(p)) walk(path.join(p, e));
    } else if (st.mtimeMs > newest) newest = st.mtimeMs;
  };
  for (const e of entries) walk(path.join(ROOT, e));
  return newest;
}

function mtime(rel: string): number {
  try {
    return fs.statSync(path.join(ROOT, rel)).mtimeMs;
  } catch {
    return 0;
  }
}

const WEB_INPUTS = [
  "apps/web/src",
  "apps/web/public",
  "apps/web/next.config.ts",
  "apps/web/postcss.config.mjs",
  "apps/web/tsconfig.json",
  "apps/web/package.json",
  "packages/shared/src",
  "packages/scheduler/src",
  "packages/db/src",
  "package-lock.json",
  "tsconfig.base.json",
];
const EXT_INPUTS = ["apps/extension/src", "apps/extension/static", "apps/extension/build.ts", "packages/shared/src", "tsconfig.base.json"];
// Written only after a build succeeds (Next's own BUILD_ID appears before the build has finished).
const BUILD_STAMP = "apps/web/.next/.lcc-built";

function run(cmd: string): void {
  log(`> ${cmd}`);
  const r = spawnSync(cmd, { cwd: ROOT, stdio: "inherit", shell: true });
  if (r.status !== 0) throw new Error(`"${cmd}" failed (exit ${r.status ?? r.signal})`);
}

/** In background mode there is no window, so say "this will take a while" with a self-closing popup. */
function notify(msg: string) {
  log(msg);
  if (!BACKGROUND || process.platform !== "win32" || process.env.LCC_NO_BROWSER) return;
  const text = msg.replace(/'/g, "''");
  spawn("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", `(New-Object -ComObject WScript.Shell).Popup('${text}', 10, 'LeetCode Companion', 64) | Out-Null`], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}

function openBrowser() {
  if (process.env.LCC_NO_BROWSER) return log(`(not opening a browser) ${URL_}`);
  const opener =
    process.platform === "win32"
      ? spawn("rundll32", ["url.dll,FileProtocolHandler", URL_], { detached: true, stdio: "ignore" })
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [URL_], { detached: true, stdio: "ignore" });
  opener.on("error", () => log(`Open ${URL_} in your browser.`));
  opener.unref();
}

async function main() {
  if (await isServing()) {
    if (newestMtime(WEB_INPUTS) > mtime(BUILD_STAMP)) notify("LeetCode Companion is running an older version. Stop it, then start it again to update.");
    else log(`Already running — opening ${URL_}`);
    openBrowser();
    return;
  }

  const builtAt = mtime(BUILD_STAMP);
  if (!builtAt || newestMtime(WEB_INPUTS) > builtAt) {
    notify(
      builtAt
        ? "Updating LeetCode Companion. The dashboard will open in about a minute."
        : "Building LeetCode Companion for the first time. The dashboard will open in about a minute.",
    );
    run("npm run build -w @lcc/web");
    fs.writeFileSync(path.join(ROOT, BUILD_STAMP), "");
  } else {
    log("Build is up to date.");
  }

  const extBuiltAt = mtime("apps/extension/dist/background.js");
  if (!extBuiltAt || newestMtime(EXT_INPUTS) > extBuiltAt) {
    log("Extension code changed — rebuilding it.");
    run("npm run ext:build");
    notify("The LeetCode Companion extension was updated. Reload it in chrome://extensions to use the new version.");
  }

  run("npm run db:migrate"); // backs up first if a migration is pending
  log("Starting the dashboard…");
  const nextBin = require.resolve("next/dist/bin/next", { paths: [path.join(ROOT, "apps/web")] });
  const args = [nextBin, "start", "-H", "127.0.0.1", "-p", String(PORT)];
  const cwd = path.join(ROOT, "apps/web");
  let ready = false;
  let server: ChildProcess;
  let logFile: string | null = null;
  if (BACKGROUND) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    logFile = path.join(DATA_DIR, "server.log");
    try {
      fs.renameSync(logFile, path.join(DATA_DIR, "server.prev.log"));
    } catch {
      /* first run */
    }
    const fd = fs.openSync(logFile, "a");
    server = spawn(process.execPath, args, { cwd, detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
    fs.closeSync(fd);
  } else {
    server = spawn(process.execPath, args, { cwd, stdio: "inherit" });
    const stop = () => server.kill();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }
  // Note: no process.exit() after spawning — on Windows, Node can crash on exit (0xC0000409) once a
  // detached child exists, turning a successful start into a failure code. Set exitCode and let it end.
  let failed = false;
  const onExit = (code: number | null) => {
    // Foreground: after a successful start, any exit (Ctrl+C, `npm run down`) is a normal stop.
    if (ready) return;
    failed = true;
    console.error(`[up] The dashboard failed to start (exit ${code}). ${logFile ? `See ${logFile}.` : "See the output above."}`);
    process.exitCode = 1;
  };
  server.on("exit", onExit);

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && !failed) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isServing()) {
      ready = true;
      openBrowser();
      if (BACKGROUND) {
        log(`Ready → ${URL_}  (running in the background, pid ${server.pid}; log: ${logFile}; stop with "npm run down")`);
        server.off("exit", onExit);
        server.unref();
        process.exitCode = 0;
        return;
      }
      log(`Ready → ${URL_}  (press Ctrl+C or run "npm run down" to stop)`);
      return;
    }
  }
  if (failed) return;
  console.error("[up] The dashboard did not respond within 2 minutes.");
  server.kill();
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(`[up] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
