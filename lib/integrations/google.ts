// Google Calendar per rep: OAuth (offline), free/busy for slot calculation, events for bookings.
// Docs: https://developers.google.com/identity/protocols/oauth2/web-server,
// https://developers.google.com/calendar/api/v3/reference/freebusy/query
import type { Db } from "../db";
import { maybeOne, q } from "../db";
import { decrypt, encrypt } from "../crypto";
import { env } from "../env";
import { log } from "../log";
import type { Interval } from "../booking/slots";

export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.freebusy"];

interface Tokens { access_token: string; refresh_token?: string; expires_at: number }

export function googleAuthUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: env.googleClientId ?? "",
    redirect_uri: `${env.appUrl}/api/integrations/google/callback`,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function tokenRequest(body: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.googleClientId ?? "", client_secret: env.googleClientSecret ?? "", ...body }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`google token ${res.status}: ${json.error ?? ""} ${json.error_description ?? ""}`);
  return json;
}

export async function exchangeGoogleCode(db: Db, orgId: string, userId: string, code: string) {
  const t = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: `${env.appUrl}/api/integrations/google/callback` });
  const tokens: Tokens = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000 };
  await q(
    db,
    `insert into integrations (org_id, kind, user_id, status, secret_enc, config, last_error, updated_at)
     values ($1, 'google_calendar', $2, 'connected', $3, '{"calendar_id":"primary"}', null, now())
     on conflict (org_id, kind, coalesce(user_id, '00000000-0000-0000-0000-000000000000'))
     do update set status = 'connected', secret_enc = excluded.secret_enc, last_error = null, updated_at = now()`,
    [orgId, userId, encrypt(JSON.stringify(tokens))],
  );
}

async function accessToken(db: Db, orgId: string, userId: string): Promise<{ token: string; calendarId: string } | null> {
  const row = await maybeOne<{ id: string; secret_enc: string | null; config: { calendar_id?: string } }>(
    db, "select id, secret_enc, config from integrations where org_id = $1 and kind = 'google_calendar' and user_id = $2 and status = 'connected'", [orgId, userId]);
  if (!row?.secret_enc) return null;
  let tokens = JSON.parse(decrypt(row.secret_enc)) as Tokens;
  if (tokens.expires_at - 60_000 < Date.now()) {
    if (!tokens.refresh_token) return null;
    try {
      const t = await tokenRequest({ refresh_token: tokens.refresh_token, grant_type: "refresh_token" });
      tokens = { ...tokens, access_token: t.access_token, expires_at: Date.now() + t.expires_in * 1000 };
      await q(db, "update integrations set secret_enc = $2, updated_at = now() where id = $1", [row.id, encrypt(JSON.stringify(tokens))]);
    } catch (e) {
      await q(db, "update integrations set status = 'error', last_error = $2, updated_at = now() where id = $1", [row.id, (e as Error).message]);
      return null;
    }
  }
  return { token: tokens.access_token, calendarId: row.config.calendar_id ?? "primary" };
}

/** Busy intervals from the rep's calendar. Not connected (or an error) means no extra busy time. */
export async function getBusy(db: Db, orgId: string, userId: string, from: Date, to: Date): Promise<Interval[]> {
  if (process.env.NODE_ENV === "test" && !process.env.GOOGLE_IN_TESTS) return testBusy.get(userId) ?? [];
  const auth = await accessToken(db, orgId, userId).catch(() => null);
  if (!auth) return [];
  try {
    const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
      body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: auth.calendarId }] }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`freeBusy ${res.status}`);
    const busy = (json.calendars?.[auth.calendarId]?.busy ?? []) as Array<{ start: string; end: string }>;
    return busy.map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  } catch (e) {
    log.warn("google.freebusy_failed", { org_id: orgId, user_id: userId, error: (e as Error).message });
    return [];
  }
}

/** Tests: fake busy times per user. */
export const testBusy = new Map<string, Interval[]>();

export async function createCalendarEvent(db: Db, orgId: string, userId: string, ev: { summary: string; description: string; start: Date; end: Date; location?: string | null }): Promise<string | null> {
  const auth = await accessToken(db, orgId, userId);
  if (!auth) return null;
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(auth.calendarId)}/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
    body: JSON.stringify({ summary: ev.summary, description: ev.description, location: ev.location ?? undefined, start: { dateTime: ev.start.toISOString() }, end: { dateTime: ev.end.toISOString() } }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`google events.insert ${res.status}: ${json.error?.message ?? ""}`);
  return json.id as string;
}

export async function updateCalendarEvent(db: Db, orgId: string, userId: string, eventId: string, ev: { start: Date; end: Date }) {
  const auth = await accessToken(db, orgId, userId);
  if (!auth) return;
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(auth.calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
    body: JSON.stringify({ start: { dateTime: ev.start.toISOString() }, end: { dateTime: ev.end.toISOString() } }),
  });
  if (!res.ok) throw new Error(`google events.patch ${res.status}`);
}

export async function deleteCalendarEvent(db: Db, orgId: string, userId: string, eventId: string) {
  const auth = await accessToken(db, orgId, userId);
  if (!auth) return;
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(auth.calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${auth.token}` },
  });
  if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`google events.delete ${res.status}`);
}
