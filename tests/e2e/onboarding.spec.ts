import { expect, test } from "@playwright/test";
import { loginAs, sql } from "./helpers";

test("owner works through onboarding: basics save, consent step, medical blocker", async ({ page }) => {
  await loginAs(page, "owner@demo.leadline.test");
  await page.goto("/onboarding?step=basics");
  await expect(page.getByTestId("steps")).toBeVisible();
  await page.locator('input[name="phone"]').fill("+1 630 555 0100");
  await page.locator('input[name="address"]').fill("100 W Lake St, Elmhurst, IL 60126");
  await page.locator("form", { has: page.locator('input[name="address"]') }).locator('button[type="submit"]').first().click();
  await expect.poll(async () => (await sql("select onboarding_progress from organizations where slug = 'bmw-elmhurst-demo'"))[0].onboarding_progress).toBeTruthy();

  await page.goto("/onboarding?step=consent");
  await expect(page.locator('textarea[name="consent_text"]').first()).toBeVisible();

  // Switching to a medical industry shows the BAA blocker.
  await page.goto("/onboarding?step=basics");
  await page.locator('select[name="industry"]').selectOption({ index: (await page.locator('select[name="industry"] option').allTextContents()).findIndex((t) => /med/i.test(t)) });
  await page.locator("form", { has: page.locator('input[name="address"]') }).locator('button[type="submit"]').first().click();
  await expect(page.getByTestId("baa-blocker")).toBeVisible();
  await sql("update organizations set industry = 'automotive' where slug = 'bmw-elmhurst-demo'");
});
