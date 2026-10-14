// Every provider sits behind a Sender. With DRY_RUN=true the fake is used: nothing leaves the
// building, and the message row is flagged dry_run so the simulator can show it.
import { randomUUID } from "node:crypto";
import { env } from "../env";
import { twilioSend } from "../integrations/twilio";
import { postmarkSend, type EmailSendInput } from "../integrations/postmark";
import { log } from "../log";

export interface SmsPayload { to: string; from?: string | null; messagingServiceSid?: string | null; body: string; statusCallback?: string }
export interface Senders {
  dryRun: boolean;
  sms(p: SmsPayload): Promise<{ providerId: string }>;
  email(p: EmailSendInput): Promise<{ providerId: string }>;
}

export const realSenders: Senders = {
  dryRun: false,
  async sms(p) {
    const r = await twilioSend(p);
    return { providerId: r.sid };
  },
  async email(p) {
    const r = await postmarkSend(p);
    return { providerId: r.messageId };
  },
};

/** Records what would have been sent. `outbox` is inspectable in tests. */
export function createFakeSenders() {
  const outbox: Array<{ channel: "sms" | "email"; payload: SmsPayload | EmailSendInput; providerId: string }> = [];
  const senders: Senders & { outbox: typeof outbox } = {
    dryRun: true,
    outbox,
    async sms(p) {
      const providerId = `dry_${randomUUID()}`;
      outbox.push({ channel: "sms", payload: p, providerId });
      log.info("dry_run.sms", { to: p.to, body: p.body });
      return { providerId };
    },
    async email(p) {
      const providerId = `dry_${randomUUID()}`;
      outbox.push({ channel: "email", payload: p, providerId });
      log.info("dry_run.email", { to: p.to, subject: p.subject });
      return { providerId };
    },
  };
  return senders;
}

let override: Senders | null = null;
let fake: ReturnType<typeof createFakeSenders> | null = null;

export function getSenders(): Senders {
  if (override) return override;
  if (env.dryRun) return (fake ??= createFakeSenders());
  return realSenders;
}

/** Tests only. */
export function setSenders(s: Senders | null) {
  override = s;
}
