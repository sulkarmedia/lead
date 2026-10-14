// Email envelope: sent as the business name from the app's domain, replies routed back per lead,
// and every message carries a one-click unsubscribe header and link plus the physical address.
import { env } from "../env";
import type { Lead, Org } from "../db/types";

export function fromAddress(org: Pick<Org, "name" | "slug">) {
  const name = org.name.replace(/["<>]/g, "");
  return `"${name}" <${org.slug}@${env.postmarkSendingDomain}>`;
}

export function replyToAddress(lead: Pick<Lead, "email_reply_token">) {
  return `lead-${lead.email_reply_token}@${env.postmarkInboundDomain}`;
}

export function unsubscribeUrl(lead: Pick<Lead, "unsubscribe_token">) {
  return `${env.appUrl}/u/${lead.unsubscribe_token}`;
}

export function oneClickUnsubscribeUrl(lead: Pick<Lead, "unsubscribe_token">) {
  return `${env.appUrl}/api/unsubscribe/${lead.unsubscribe_token}`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function buildEmail(org: Pick<Org, "name" | "slug" | "address">, lead: Pick<Lead, "email_reply_token" | "unsubscribe_token">, body: string) {
  const unsub = unsubscribeUrl(lead);
  const footer = `\n\n--\n${org.name}\n${org.address ?? ""}\nUnsubscribe: ${unsub}`;
  const html =
    `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">${esc(body).replace(/\n/g, "<br>")}</div>` +
    `<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 8px"><div style="font-size:12px;color:#666">${esc(org.name)}<br>${esc(org.address ?? "")}<br>` +
    `<a href="${unsub}">Unsubscribe</a></div>`;
  return {
    from: fromAddress(org),
    replyTo: replyToAddress(lead),
    text: body + footer,
    html,
    headers: {
      "List-Unsubscribe": `<${oneClickUnsubscribeUrl(lead)}>, <${unsub}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
