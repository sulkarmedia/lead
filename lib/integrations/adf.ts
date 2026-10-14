// ADF 1.0 (Auto-lead Data Format) XML, emailed to the dealer CRM's lead address.
// Nearly every dealer CRM ingests this. Spec: https://adfxml.info/ (ADF 1.0).
const x = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export interface AdfInput {
  requestDate: Date;
  lead: { id: string; firstName?: string | null; lastName?: string | null; phone?: string | null; email?: string | null; zip?: string | null };
  vehicle?: { year?: string | null; make?: string | null; model?: string | null; trim?: string | null; interest?: "buy" | "lease" | "sell" | "trade-in" | "test-drive" } | null;
  tradeIn?: string | null;
  service?: string | null;
  vendorName: string;
  providerName: string;
  providerUrl?: string;
  comments: string;
  appointmentAt?: Date | null;
  threadUrl: string;
}

export function buildAdf(i: AdfInput): string {
  const v = i.vehicle;
  const vehicle = v
    ? `    <vehicle interest="${x(v.interest ?? "buy")}" status="new">
${v.year ? `      <year>${x(v.year)}</year>\n` : ""}${v.make ? `      <make>${x(v.make)}</make>\n` : ""}${v.model ? `      <model>${x(v.model)}</model>\n` : ""}${v.trim ? `      <trim>${x(v.trim)}</trim>\n` : ""}    </vehicle>\n`
    : "";
  const trade = i.tradeIn ? `    <vehicle interest="trade-in" status="used">\n      <comments>${x(i.tradeIn)}</comments>\n    </vehicle>\n` : "";
  const comments = [
    i.comments,
    i.service ? `Interested in: ${i.service}` : null,
    i.appointmentAt ? `Appointment: ${i.appointmentAt.toISOString()}` : null,
    `Conversation: ${i.threadUrl}`,
  ].filter(Boolean).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<?adf version="1.0"?>
<adf>
  <prospect status="new">
    <id sequence="1" source="${x(i.providerName)}">${x(i.lead.id)}</id>
    <requestdate>${i.requestDate.toISOString().replace(/\.\d{3}Z$/, "Z")}</requestdate>
${vehicle}${trade}    <customer>
      <contact>
        <name part="first">${x(i.lead.firstName)}</name>
        <name part="last">${x(i.lead.lastName)}</name>
${i.lead.email ? `        <email>${x(i.lead.email)}</email>\n` : ""}${i.lead.phone ? `        <phone type="voice">${x(i.lead.phone)}</phone>\n` : ""}${i.lead.zip ? `        <address><postalcode>${x(i.lead.zip)}</postalcode></address>\n` : ""}      </contact>
      <comments>${x(comments)}</comments>
    </customer>
    <vendor>
      <vendorname>${x(i.vendorName)}</vendorname>
    </vendor>
    <provider>
      <name part="full">${x(i.providerName)}</name>
${i.providerUrl ? `      <url>${x(i.providerUrl)}</url>\n` : ""}    </provider>
  </prospect>
</adf>
`;
}
