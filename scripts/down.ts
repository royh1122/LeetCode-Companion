/**
 * `npm run down` — stop the dashboard started with `npm run up` / `npm run app`.
 * Only stops the process listening on 127.0.0.1:4317 if it is this project's
 * Next.js server; anything else on that port is left alone.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.LCC_PORT) || 4317;
const DRY = process.argv.includes("--dry-run");

function sh(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function listeners(): { pid: number; cmd: string }[] {
  if (process.platform === "win32") {
    const ps = `Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$_"; "$_\t$($p.CommandLine)" }`;
    return sh("powershell", ["-NoProfile", "-Command", ps])
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const [pid, ...rest] = l.split("\t");
        return { pid: Number(pid), cmd: rest.join("\t") };
      });
  }
  return sh("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN", "-t"])
    .split(/\s+/)
    .filter(Boolean)
    .map((pid) => ({ pid: Number(pid), cmd: sh("ps", ["-o", "command=", "-p", pid]).trim() }));
}

function main() {
  const found = listeners();
  if (!found.length) {
    console.log(`[down] Nothing is running on port ${PORT}.`);
    return;
  }
  const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
  let stopped = 0;
  for (const { pid, cmd } of found) {
    // Next runs from this repo's node_modules, so its command line always contains the repo path.
    const ours = /next/i.test(cmd) && norm(cmd).includes(norm(ROOT));
    if (!ours) {
      console.log(`[down] Port ${PORT} is used by another program (pid ${pid}); leaving it alone:\n  ${cmd || "(unknown command)"}`);
      continue;
    }
    if (DRY) {
      console.log(`[down] Would stop the dashboard (pid ${pid}): ${cmd}`);
      stopped++;
      continue;
    }
    if (process.platform === "win32") sh("taskkill", ["/PID", String(pid), "/T", "/F"]);
    else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    stopped++;
    console.log(`[down] Stopped the dashboard (pid ${pid}).`);
  }
  if (!stopped) process.exitCode = 1;
}

main();
