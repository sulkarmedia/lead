import { describe, expect, it } from "vitest";
import { buildAdf } from "@/lib/integrations/adf";
import { buildCapiEvent } from "@/lib/integrations/capi";

describe("ADF/XML", () => {
  const xml = buildAdf({
    requestDate: new Date("2026-10-14T17:00:00Z"),
    lead: { id: "L1", firstName: "Maria", lastName: "O'Neil & Co", phone: "+16305550199", email: "m@example.com", zip: "60126" },
    vehicle: { make: "BMW", model: "X5", trim: "M Sport", interest: "lease" },
    tradeIn: "2019 Audi Q5, 40k miles",
    vendorName: "BMW of Elmhurst", providerName: "Leadline", comments: "Wants <spring> delivery", appointmentAt: new Date("2026-10-16T15:00:00Z"), threadUrl: "https://app/leads/L1",
  });
  it("is well-formed ADF 1.0 with escaped content", () => {
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<\?adf version="1.0"\?>/);
    expect(xml).toContain("<requestdate>2026-10-14T17:00:00Z</requestdate>");
    expect(xml).toContain('<name part="last">O&apos;Neil &amp; Co</name>');
    expect(xml).toContain("Wants &lt;spring&gt; delivery");
    expect(xml).toContain('<vehicle interest="lease" status="new">');
    expect(xml).toContain('<vehicle interest="trade-in" status="used">');
    // balanced tags
    const open = (xml.match(/<(?!\?|\/)[a-z]+[^>]*[^/]>/g) ?? []).length;
    const close = (xml.match(/<\/[a-z]+>/g) ?? []).length;
    expect(open).toBe(close);
  });
});

describe("Conversions API event", () => {
  it("matches the CRM lead event shape", () => {
    expect(buildCapiEvent({ stage: "qualified", at: new Date("2026-10-14T17:00:00Z"), metaLeadId: "1234567890" })).toEqual({
      event_name: "qualified", event_time: 1791997200, action_source: "system_generated",
      user_data: { lead_id: 1234567890 }, custom_data: { event_source: "crm", lead_event_source: "Leadline" },
    });
  });
});
