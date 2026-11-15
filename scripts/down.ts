/**
 * `npm run down` — stop the dashboard started with `npm run up` / `npm run app`.
 * Only stops the process listening on 127.0.0.1:4317 if it is this project's
 * Next.js server; anything else on that port is left alone.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
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

const has = (cmd: string) => !!sh("sh", ["-c", `command -v ${cmd}`]).trim();

/** A process's working directory (POSIX), or "" if unknown. */
function cwdOf(pid: number): string {
  if (process.platform === "linux") {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return "";
    }
  }
  const line = sh("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).split("\n").find((l) => l.startsWith("n"));
  return line ? line.slice(1) : "";
}

/** Listening processes, or null if they can't be listed (neither ss nor lsof). */
function listeners(): { pid: number; cmd: string; cwd: string }[] | null {
  if (process.platform === "win32") {
    const ps = `Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$_"; "$_\t$($p.CommandLine)" }`;
    return sh("powershell", ["-NoProfile", "-Command", ps])
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const [pid, ...rest] = l.split("\t");
        return { pid: Number(pid), cmd: rest.join("\t"), cwd: "" };
      });
  }
  let pids: number[];
  if (process.platform === "linux" && has("ss")) {
    // ss, not lsof: under WSL lsof doesn't list the server's socket.
    const out = sh("ss", ["-ltnpH", `sport = :${PORT}`]);
    pids = [...out.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
  } else if (has("lsof")) {
    pids = sh("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN", "-t"]).split(/\s+/).filter(Boolean).map(Number);
  } else return null;
  return [...new Set(pids)].map((pid) => ({ pid, cmd: sh("ps", ["-o", "command=", "-p", String(pid)]).trim(), cwd: cwdOf(pid) }));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function main() {
  const found = listeners();
  if (found === null) {
    console.log(`[down] Can't check port ${PORT}: neither ss nor lsof is installed. Stop the dashboard from its terminal (Ctrl+C).`);
    process.exitCode = 1;
    return;
  }
  if (!found.length) {
    console.log(`[down] Nothing is running on port ${PORT}.`);
    return;
  }
  const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
  // With the separator, so the main folder (…/leetcode-prep) doesn't also match …/leetcode-prep-dev.
  const root = norm(ROOT).replace(/\/$/, "") + "/";
  let stopped = 0;
  let failed = 0;
  for (const { pid, cmd, cwd } of found) {
    // On Windows Next's command line contains this repo's node_modules path. On Linux and macOS
    // Next renames its process title to "next-server (vX)", so check its working directory
    // (the server runs in apps/web) instead.
    const ours = /next/i.test(cmd) && (norm(cmd).includes(root) || (cwd !== "" && norm(cwd + "/").startsWith(root)));
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
    // Report what happened, not what was asked for.
    const deadline = Date.now() + 5000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    if (alive(pid)) {
      failed++;
      console.error(`[down] Could not stop the dashboard (pid ${pid}); it is still running.`);
    } else {
      stopped++;
      console.log(`[down] Stopped the dashboard (pid ${pid}).`);
    }
  }
  if (!stopped || failed) process.exitCode = 1;
}

void main();
