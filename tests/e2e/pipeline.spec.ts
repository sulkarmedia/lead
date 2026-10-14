import { expect, test } from "@playwright/test";
import { loginAs, sql } from "./helpers";

test("dragging a card to another stage writes a stage event", async ({ page, isMobile }) => {
  await loginAs(page, "owner@demo.leadline.test");
  await page.goto("/leads");
  const col = page.getByTestId("board-column-contacted");
  const card = col.getByTestId("lead-card").first();
  const href = await card.locator("a").first().getAttribute("href");
  const leadId = href!.split("/").pop()!;
  if (isMobile) {
    await card.getByTestId("card-stage-select").selectOption("qualified");
  } else {
    // HTML5 drag and drop across a horizontally scrolling board: dispatch the events with one DataTransfer.
    const dt = await page.evaluateHandle(() => new DataTransfer());
    await card.dispatchEvent("dragstart", { dataTransfer: dt });
    const target = page.getByTestId("board-column-qualified");
    await target.dispatchEvent("dragover", { dataTransfer: dt });
    await target.dispatchEvent("drop", { dataTransfer: dt });
    await card.dispatchEvent("dragend", { dataTransfer: dt });
  }
  await expect.poll(async () => (await sql<{ stage: string }>("select stage from leads where id = $1", [leadId]))[0].stage).toBe("qualified");
  const ev = await sql("select 1 from stage_events where lead_id = $1 and to_stage = 'qualified' and actor like 'user:%'", [leadId]);
  expect(ev.length).toBe(1);
});
