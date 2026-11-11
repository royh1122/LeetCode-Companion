/**
 * `npm run shortcuts` (Windows) — create "LeetCode Companion" and
 * "Stop LeetCode Companion" shortcuts on the Desktop and in the Start menu.
 * They run scripts/windows/start.vbs / stop.vbs through wscript, so no window
 * or taskbar entry appears; the server runs hidden in the background.
 * Existing taskbar pins with the same names are updated too.
 * Re-run after moving the project folder. `npm run shortcuts -- --remove` deletes them.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const WIN = path.join(ROOT, "scripts", "windows");
const ICON = path.join(WIN, "leetcode-companion.ico");
const NAMES = { start: "LeetCode Companion", stop: "Stop LeetCode Companion" };

/** Build a .ico that embeds the extension's PNG icons (supported since Windows Vista). */
function writeIcon() {
  const pngs = [16, 32, 48, 128].map((s) => ({ size: s, data: fs.readFileSync(path.join(ROOT, "apps/extension/static/icons", `${s}.png`)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = header.length + dir.length;
  pngs.forEach((p, i) => {
    const o = i * 16;
    dir.writeUInt8(p.size >= 256 ? 0 : p.size, o);
    dir.writeUInt8(p.size >= 256 ? 0 : p.size, o + 1);
    dir.writeUInt8(0, o + 2); // palette
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(p.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += p.data.length;
  });
  fs.writeFileSync(ICON, Buffer.concat([header, dir, ...pngs.map((p) => p.data)]));
}

function ps(script: string): string {
  return execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8" }).trim();
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

function main() {
  if (process.platform !== "win32") {
    console.log("Shortcuts are Windows-only. Use `npm run up` / `npm run down` instead.");
    return;
  }
  const remove = process.argv.includes("--remove");
  const folders = ps("[Environment]::GetFolderPath('Desktop'); [Environment]::GetFolderPath('Programs')").split(/\r?\n/).filter(Boolean);
  // Taskbar pins are separate copies of the shortcut; update them only if they already exist.
  const pinned = path.join(process.env.APPDATA ?? "", "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar");
  if (!remove) writeIcon();
  for (const folder of [...folders, pinned]) {
    for (const [kind, name] of Object.entries(NAMES)) {
      const lnk = path.join(folder, `${name}.lnk`);
      if (folder === pinned && !fs.existsSync(lnk)) continue;
      if (remove) {
        if (fs.existsSync(lnk)) {
          fs.unlinkSync(lnk);
          console.log(`Removed ${lnk}`);
        }
        continue;
      }
      const target = path.join(WIN, `${kind}.vbs`);
      ps(
        [
          `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(lnk)})`,
          `$s.TargetPath = (Join-Path $env:WINDIR 'System32\\wscript.exe')`,
          `$s.Arguments = '"' + ${q(target)} + '"'`,
          `$s.WorkingDirectory = ${q(ROOT)}`,
          `$s.IconLocation = ${q(ICON + ",0")}`,
          `$s.Description = ${q(kind === "start" ? "Start the LeetCode Companion dashboard and open it" : "Stop the LeetCode Companion dashboard")}`,
          `$s.Save()`,
        ].join("; "),
      );
      console.log(`Created ${lnk}`);
    }
  }
  if (!remove) console.log('\nDouble-click "LeetCode Companion" to start. Right-click it → "Pin to taskbar" / "Pin to Start" if you like.');
}

main();
