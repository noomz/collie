import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { installApiStub } from "./fixtures/api";

const text = readFileSync(new URL("../src/fixtures/split/claude--partial-sidebar.txt", import.meta.url), "utf8");

test.use({ serviceWorkers: "block" });

test("the partial sidebar leaves wrapping prose inside the viewport", async ({ page }, testInfo) => {
  await installApiStub(page);
  await page.route(/\/api\/pane\/w1%3Ap1(?:\?.*)?$/, (route) => route.fulfill({
    json: { paneId: "w1:p1", text, truncated: false, revision: 1 },
  }));
  await page.goto("/pane/w1:p1");
  await expect(page.locator("pre").first()).toBeVisible();
  const mirror = page.locator("pre").first();
  await expect(mirror).not.toContainText("✕");
  await page.evaluate(() => document.fonts.ready);
  const dimensions = await mirror.evaluate((element) => ({
    width: element.clientWidth,
    content: element.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
  await page.screenshot({ path: testInfo.outputPath("partial-sidebar.png"), fullPage: true });
});
