// Rep and owner alerts. SMS comes from the platform alert number (never the tenant's lead-facing
// number) so an alert can't land in a lead thread. Respects DRY_RUN via the Sender.
import type { Db } from "./db";
import { maybeOne, one, q } from "./db";
import type { Membership } from "./db/types";
import { env } from "./env";
import { now } from "./clock";
import { log } from "./log";
import { getSenders } from "./messaging/sender";

export async function notifyUser(db: Db, input: { orgId: string; userId: string; leadId?: string | null; kind: string; subject: string; body: string; channels?: Array<"sms" | "email" | "in_app"> }) {
  const m = await maybeOne<Membership>(db, "select * from memberships where org_id = $1 and user_id = $2 and active", [input.orgId, input.userId]);
  if (!m) return;
  const channels = input.channels ?? ["in_app", "sms", "email"];
  const senders = getSenders();
  for (const ch of channels) {
    if (ch === "sms" && !(m.notify_sms && m.mobile_phone)) continue;
    if (ch === "email" && !(m.notify_email && m.email)) continue;
    const to = ch === "sms" ? m.mobile_phone : ch === "email" ? m.email : null;
    const n = await one<{ id: string }>(
      db,
      `insert into notifications (org_id, user_id, lead_id, channel, kind, to_address, subject, body, status, dry_run, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [input.orgId, input.userId, input.leadId ?? null, ch, input.kind, to, input.subject, input.body, ch === "in_app" ? "sent" : "queued", senders.dryRun, now()],
    );
    if (ch === "in_app") continue;
    try {
      if (ch === "sms") {
        if (!env.twilioAlertNumber && !senders.dryRun) throw new Error("TWILIO_ALERT_NUMBER is not set");
        await senders.sms({ to: to!, from: env.twilioAlertNumber ?? "alert-dry-run", body: `${input.subject}\n${input.body}`.slice(0, 600) });
      } else {
        await senders.email({
          from: `"${env.appName}" <alerts@${env.postmarkSendingDomain}>`, to: to!, subject: input.subject, text: input.body, stream: "transactional",
        });
      }
      await q(db, "update notifications set status = 'sent' where id = $1", [n.id]);
    } catch (e) {
      await q(db, "update notifications set status = 'failed', error = $2 where id = $1", [n.id, (e as Error).message]);
      log.error("notify.failed", { org_id: input.orgId, user_id: input.userId, kind: input.kind, error: (e as Error).message });
    }
  }
}

export function leadLink(leadId: string) {
  return `${env.appUrl}/leads/${leadId}`;
}
