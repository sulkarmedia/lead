import { expect, test } from "@playwright/test";
import { loginAs, sql } from "./helpers";

test("rep takes over a thread from the AI and hands it back", async ({ page }) => {
  await loginAs(page, "sam@demo.leadline.test");
  const [lead] = await sql<{ id: string }>(
    `select l.id from leads l join auth.users u on u.id = l.assigned_user_id
      where u.email = 'sam@demo.leadline.test' and l.ai_status = 'active' and l.phone_e164 is not null order by l.created_at limit 1`);
  await page.goto(`/leads/${lead.id}`);
  await expect(page.getByTestId("ai-status")).toHaveText(/AI active/);
  await page.getByTestId("composer").fill("Hi, this is Sam. I can help with that.");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("ai-status")).toHaveText(/AI paused/);
  await expect(page.getByTestId("thread")).toContainText("Hi, this is Sam.");
  await page.getByTestId("hand-back").click();
  await expect(page.getByTestId("ai-status")).toHaveText(/AI active/);
  const [jobs] = await sql<{ n: number }>("select count(*)::int as n from jobs where lead_id = $1 and kind = 'followup' and status = 'queued'", [lead.id]);
  expect(jobs.n).toBe(1);
});

test("inbox lists handoffs waiting on a rep", async ({ page }) => {
  await loginAs(page, "owner@demo.leadline.test");
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByText("Waiting on a rep")).toBeVisible();
});
