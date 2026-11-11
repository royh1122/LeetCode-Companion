/** Renders the toolbar icons once (committed under static/icons). */
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";

const dir = path.join(import.meta.dirname, "static", "icons");
fs.mkdirSync(dir, { recursive: true });
const browser = await chromium.launch();
for (const size of [16, 32, 48, 128]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const r = Math.round(size * 0.22);
  await page.setContent(`<html><body style="margin:0;background:transparent">
    <div style="width:${size}px;height:${size}px;border-radius:${r}px;background:#2a78d6;display:grid;place-items:center;color:#fff;
      font:700 ${Math.round(size * 0.5)}px/1 ui-monospace,Consolas,monospace;letter-spacing:-0.04em">lc</div></body></html>`);
  await page.screenshot({ path: path.join(dir, `${size}.png`), omitBackground: true });
  await page.close();
}
await browser.close();
console.log("icons written", fs.readdirSync(dir));
