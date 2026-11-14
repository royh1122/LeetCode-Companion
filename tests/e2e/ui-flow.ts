/**
 * Dashboard E2E (no extension): create plan → start practice → notes autosave →
 * finish with reflection → dashboard reflects it → history/detail/analytics render.
 * Requires a running dashboard on the e2e port (see port.ts) backed by an EMPTY data dir.
 *   npm run test:e2e starts one; or point LCC_URL at a dashboard you started yourself.
 */
import { chromium, expect, type Page } from "@playwright/test";
import { E2E_BASE } from "./port";

const BASE = process.env.LCC_URL ?? E2E_BASE;

async function main() {
  const shots = process.argv[2];
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  // Never hit the real LeetCode from tests.
  await ctx.route("https://leetcode.com/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<html><body>stub leetcode</body></html>" }));
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const shot = async (p: Page, name: string) => shots && (await p.screenshot({ path: `${shots}/${name}.png`, fullPage: true }));

  // 1. Create a plan (first run)
  await page.goto(BASE);
  await page.waitForLoadState("networkidle");
  // A click that lands before the page is interactive does nothing (dev server, first compile): retry.
  await expect(async () => {
    if (await page.getByText("Set up your study plan").isVisible()) await page.getByRole("button", { name: "Create study plan" }).click();
    await expect(page.getByRole("heading", { name: "Today's questions" })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30000 });
  const newSection = page.locator("div.rounded-lg", { has: page.getByRole("heading", { name: /New questions/ }) });
  const rows = newSection.locator("li");
  const count = await rows.count();
  console.log(`today: ${count} new question rows`);
  await shot(page, "01-today");

  // 2. Start the first question
  const target = rows.filter({ has: page.getByRole("button", { name: /^(Start|Review)$/ }) }).first();
  const firstTitle = (await target.locator("a").first().textContent())?.trim();
  const slugHref = await target.locator("a").first().getAttribute("href");
  const popup = ctx.waitForEvent("page");
  await target.getByRole("button", { name: /Start|Review/ }).click();
  const lc = await popup;
  console.log("opened:", lc.url());
  if (!/leetcode\.com\/problems\/.+#lcc-session=/.test(lc.url())) throw new Error("LeetCode tab not opened with session tag");
  await page.waitForURL(/\/sessions\//);
  await expect(page.getByRole("heading", { name: firstTitle! })).toBeVisible();

  // 3. Notes autosave
  await page.locator("#s-notes").fill("Two pointers from both ends; forgot the empty-string case.");
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible({ timeout: 5000 });
  await page.getByRole("button", { name: "+ Log a submission manually" }).click();
  await page.getByLabel("Verdict").selectOption("Wrong Answer");
  await page.getByLabel("Code").fill("def f(a):\n    return a");
  await page.getByRole("button", { name: "Save submission" }).click();
  await expect(page.getByText("Submissions (1)")).toBeVisible({ timeout: 5000 });
  await shot(page, "02-session");

  // 4. Reflection: keyboard shortcut 3 = Struggled
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("3");
  await expect(page.getByRole("radio", { name: /Struggled/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("(recommended)")).toBeVisible();
  await page.getByRole("button", { name: "Finish session" }).click();
  await page.waitForURL(BASE + "/");
  await expect(newSection.locator("li", { hasText: firstTitle! }).locator(".line-through")).toBeVisible({ timeout: 10000 });
  console.log("finished session; today progress updated");

  // 5. Detail page shows the session, notes and submission
  await page.goto(BASE + slugHref);
  await expect(page.getByText("Two pointers from both ends")).toBeVisible();
  await expect(page.getByText("Struggled").first()).toBeVisible();
  await page.locator("#n-insight").fill("Merge by alternating indices.");
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible({ timeout: 5000 });
  await shot(page, "03-problem");

  // 6. Other pages render
  for (const p of ["/reviews", "/plan", "/library?q=two", "/history", "/analytics", "/settings"]) {
    const r = await page.goto(BASE + p);
    if (!r?.ok()) throw new Error(`${p} → ${r?.status()}`);
    await page.waitForLoadState("networkidle");
    await shot(page, `page${p.replace(/[^a-z]+/g, "-")}`);
  }
  await page.goto(BASE + "/history");
  await expect(page.getByRole("link", { name: firstTitle! }).first()).toBeVisible();

  // 7. Changing schedule settings
  await page.goto(BASE + "/plan");
  await page.getByLabel("New questions on Mon").fill("4");
  await page.getByRole("button", { name: "Save plan settings" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  // 8. Mobile + dark render
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(BASE);
  await shot(page, "04-mobile-dark");

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("UI flow OK");
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
