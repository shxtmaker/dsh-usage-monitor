import { test, expect } from "@playwright/test";

test("settings trap keyboard focus, preserve organization, and retain a rejected draft", async ({ page }) => {
  await page.goto("/");
  const opener = page.locator(".qm-card-btn");
  await opener.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  const buttons = dialog.locator("button:visible");
  await buttons.last().focus(); await page.keyboard.press("Tab");
  await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
  await opener.click();
  await page.locator(".qm-page-main").click();
  const orgInput = page.getByLabel("org id（可选）", { exact: true });
  await expect(orgInput).toHaveValue("org-original");
  const warning = page.locator('input[type="number"][max="99"]');
  await warning.fill("150");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(warning).toHaveValue("150");
  await expect(orgInput).toHaveValue("org-original");
  await warning.fill("80");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".qm-page-main")).toBeVisible();
  await page.locator(".qm-page-main").click();
  await expect(page.locator('[value="org-original"]')).toHaveValue("org-original");
});

test("rail opens a detail dialog that fits the viewport and returns focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?rail");
  const opener = page.locator(".qm-rail");
  await opener.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
});
