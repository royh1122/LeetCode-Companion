/** Builds the extension into ./dist (load it unpacked in chrome://extensions). */
import { build, context, type BuildOptions } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const root = import.meta.dirname;
const out = path.join(root, "dist");
const watch = process.argv.includes("--watch");

const common: BuildOptions = { bundle: true, target: "chrome116", sourcemap: watch ? "inline" : false, minify: !watch, logLevel: "info", legalComments: "none" };
const entries: BuildOptions[] = [
  { ...common, entryPoints: [path.join(root, "src/background.ts")], outfile: path.join(out, "background.js"), format: "esm" },
  { ...common, entryPoints: [path.join(root, "src/content/main-world.ts")], outfile: path.join(out, "main-world.js"), format: "iife" },
  { ...common, entryPoints: [path.join(root, "src/content/isolated.ts")], outfile: path.join(out, "content.js"), format: "iife" },
  { ...common, entryPoints: [path.join(root, "src/sidepanel/sidepanel.ts")], outfile: path.join(out, "sidepanel.js"), format: "esm" },
  { ...common, entryPoints: [path.join(root, "src/options/options.ts")], outfile: path.join(out, "options.js"), format: "esm" },
];

function copyStatic() {
  fs.mkdirSync(path.join(out, "icons"), { recursive: true });
  for (const f of fs.readdirSync(path.join(root, "static"), { recursive: true }) as string[]) {
    const src = path.join(root, "static", f);
    if (fs.statSync(src).isDirectory()) continue;
    fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true });
    fs.copyFileSync(src, path.join(out, f));
  }
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
copyStatic();
if (watch) {
  for (const e of entries) await (await context(e)).watch();
  console.log("Watching… (reload the extension in chrome://extensions after changes)");
} else {
  await Promise.all(entries.map((e) => build(e)));
  console.log(`Extension built → ${out}`);
}
