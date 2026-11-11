/** Dev helper: screenshot dashboard pages. Usage: tsx tests/e2e/shot.ts <outDir> [dark] path1 path2 ... */
import { chromium } from "playwright";

const [outDir, ...rest] = process.argv.slice(2);
const dark = rest[0] === "dark";
const paths = dark ? rest.slice(1) : rest;
async function main() {
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: dark ? "dark" : "light" });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
for (const p of paths) {
  const mobile = p.startsWith("m:");
  const raw = mobile ? p.slice(2) : p;
  const path = raw === "home" ? "/" : "/" + raw.replace(/^\/+/, "");
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1360, height: 900 });
  const r = await page.goto(`${process.env.LCC_URL ?? "http://127.0.0.1:4317"}${path}`, { waitUntil: "networkidle" });
  const name = `${mobile ? "m-" : ""}${dark ? "dark-" : ""}${path.replace(/[^a-z0-9]+/gi, "_") || "home"}.png`;
  await page.screenshot({ path: `${outDir}/${name}`, fullPage: true });
  console.log(r?.status(), name);
}
await browser.close();
}
void main();
