// Meta Conversions API for CRM lead events (conversion leads optimization).
// Docs: https://developers.facebook.com/docs/marketing-api/conversions-api/conversion-leads-integration
// One event per stage change: event_name = stage, action_source = system_generated,
// user_data.lead_id = Meta lead id, custom_data = { event_source: "crm", lead_event_source: app name }.
import { env } from "../env";

export interface CapiEvent {
  event_name: string;
  event_time: number; // unix seconds
  action_source: "system_generated";
  user_data: { lead_id: number | string };
  custom_data: { event_source: "crm"; lead_event_source: string };
}

export function buildCapiEvent(input: { stage: string; at: Date; metaLeadId: string }): CapiEvent {
  return {
    event_name: input.stage,
    event_time: Math.floor(input.at.getTime() / 1000),
    action_source: "system_generated",
    // Meta lead ids are numeric strings; send as a number when it is safely representable.
    user_data: { lead_id: /^\d{1,15}$/.test(input.metaLeadId) ? Number(input.metaLeadId) : input.metaLeadId },
    custom_data: { event_source: "crm", lead_event_source: env.appName },
  };
}

export async function sendCapiEvents(datasetId: string, accessToken: string, events: CapiEvent[], testEventCode?: string) {
  const url = `https://graph.facebook.com/${env.metaGraphVersion}/${encodeURIComponent(datasetId)}/events`;
  const body: Record<string, unknown> = { data: events, access_token: accessToken };
  if (testEventCode) body.test_event_code = testEventCode;
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`capi ${res.status}: ${json?.error?.message ?? ""}`), { response: json });
  return json as { events_received?: number; fbtrace_id?: string };
}
