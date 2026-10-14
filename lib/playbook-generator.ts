// Playbook generator: fetch up to 10 pages of the customer's website, have the fast model (Haiku)
// pull facts per page, then have the main model (Sonnet, structured output) draft a playbook and
// knowledge items. Nothing goes live unapproved: drafts are returned to the UI and saved only when
// the owner approves (savePlaybookVersion / approvePlaybook below).
//
// Also home to the editable-playbook contract (PlaybookInput) shared by the settings editor, the
// onboarding wizard and the draft, so all three validate the same way.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import type { Db } from "./db";
import { maybeOne, one, q } from "./db";
import type { CadenceStep, Org, Playbook, QualificationField } from "./db/types";
import { now } from "./clock";
import { getModel } from "./agent/model";
import { parseOffset } from "./cadence";

// ---------------------------------------------------------------------------------------------
// Editable playbook contract
// ---------------------------------------------------------------------------------------------

export const GOALS = ["appointment", "call", "quote", "reservation"] as const;
export const KNOWLEDGE_KINDS = ["service", "faq", "policy", "offer", "inventory", "location"] as const;
export const BOOKING_KINDS = ["in_person", "call", "video"] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM (24h)");
const offset = z.string().trim().refine((s) => {
  try { return parseOffset(s) > 0; } catch { return false; }
}, "use a number plus m, h, d or w (e.g. 2h, 1d)");

export const CadenceStepInput = z.object({
  after: offset,
  channel: z.enum(["sms", "email", "both"]),
  angle: z.string().trim().min(3, "describe the angle").max(300),
});

export const QualificationFieldInput = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{0,40}$/, "keys are lowercase letters, digits and underscores"),
  label: z.string().trim().min(1).max(120),
  options: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  required: z.boolean().default(false),
  description: z.string().trim().max(300).nullable().default(null),
});

export const PlaybookInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    goal: z.enum(GOALS),
    goal_detail: z.string().trim().max(500).nullable(),
    qualification_fields: z.array(QualificationFieldInput).max(20),
    warm_rule: z.string().trim().max(500).nullable(),
    handoff_triggers: z.array(z.string().trim().min(1).max(200)).max(20),
    cadence: z.union([
      z.literal("default"),
      z.object({ no_reply: z.array(CadenceStepInput).min(1).max(12), went_quiet: z.array(CadenceStepInput).min(1).max(8) }),
    ]),
    send_window: z.object({ start: hhmm, end: hhmm, sundays: z.boolean() }),
    tone: z.string().trim().max(500).nullable(),
    never_say: z.array(z.string().trim().min(1).max(120)).max(50),
    booking: z.object({
      kinds: z.array(z.enum(BOOKING_KINDS)).min(1),
      slot_minutes: z.number().int().min(10).max(240),
      min_notice_minutes: z.number().int().min(0).max(10080),
      days_ahead: z.number().int().min(1).max(60),
    }),
    intro_template: z.string().trim().min(10).max(320),
    bridge_message_allowed: z.boolean(),
    max_touches: z.number().int().min(1).max(30),
    approve_before_send: z.boolean(),
  })
  .superRefine((p, ctx) => {
    const keys = p.qualification_fields.map((f) => f.key);
    const dup = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dup) ctx.addIssue({ code: "custom", path: ["qualification_fields"], message: `duplicate field key "${dup}"` });
    if (p.send_window.end <= p.send_window.start) ctx.addIssue({ code: "custom", path: ["send_window"], message: "the send window must end after it starts" });
  });
export type PlaybookInput = z.infer<typeof PlaybookInput>;

/**
 * The intro template is the fixed first touch sent when the model is slow (no guards run on it), so
 * it must carry the identification, AI-disclosure and opt-out language itself (rules 6 and 7).
 */
export function introTemplateProblems(tpl: string, orgName: string): string[] {
  const out: string[] = [];
  const t = tpl.toLowerCase();
  if (!tpl.includes("{business_name}") && !t.includes(orgName.toLowerCase())) out.push("must name the business ({business_name})");
  if (!/assistant/i.test(tpl)) out.push('must introduce itself as the business\'s "virtual assistant"');
  if (!/\bstop\b/i.test(tpl)) out.push('must tell the lead how to opt out ("Reply STOP to opt out.")');
  return out;
}

export function defaultPlaybookInput(org: Pick<Org, "name">): PlaybookInput {
  return {
    name: `${org.name} playbook`,
    goal: "appointment",
    goal_detail: null,
    qualification_fields: [],
    warm_rule: null,
    handoff_triggers: ["asks for a price or term not in knowledge", "asks for a person", "complaint or frustration"],
    cadence: "default",
    send_window: { start: "09:00", end: "20:00", sundays: true },
    tone: "Friendly, concise, professional.",
    never_say: [],
    booking: { kinds: ["in_person", "call"], slot_minutes: 45, min_notice_minutes: 120, days_ahead: 7 },
    intro_template: "Hi {first_name}, this is the virtual assistant at {business_name}. Thanks for reaching out. What can I help you with? Reply STOP to opt out.",
    bridge_message_allowed: true,
    max_touches: 14,
    approve_before_send: true,
  };
}

function bookingKinds(kinds: string[] | undefined): Array<(typeof BOOKING_KINDS)[number]> {
  const k = (kinds ?? []).filter((x): x is (typeof BOOKING_KINDS)[number] => (BOOKING_KINDS as readonly string[]).includes(x));
  return k.length ? k : ["in_person"];
}

export function playbookToInput(pb: Playbook): PlaybookInput {
  const cad = pb.cadence;
  return {
    name: pb.name,
    goal: pb.goal,
    goal_detail: pb.goal_detail,
    qualification_fields: Object.entries(pb.qualification_fields ?? {}).map(([key, f]) => ({
      key, label: f.label, options: f.options ?? [], required: !!f.required, description: f.description ?? null,
    })),
    warm_rule: pb.warm_rule,
    handoff_triggers: pb.handoff_triggers ?? [],
    cadence: cad === "default" || !cad || typeof cad !== "object" ? "default" : {
      no_reply: (cad.no_reply ?? []) as CadenceStep[],
      went_quiet: (cad.went_quiet ?? []) as CadenceStep[],
    },
    send_window: { start: pb.send_window?.start ?? "09:00", end: pb.send_window?.end ?? "20:00", sundays: pb.send_window?.sundays !== false },
    tone: pb.tone,
    never_say: pb.never_say ?? [],
    booking: {
      kinds: bookingKinds(pb.booking?.kinds),
      slot_minutes: pb.booking?.slot_minutes ?? 45,
      min_notice_minutes: pb.booking?.min_notice_minutes ?? 120,
      days_ahead: pb.booking?.days_ahead ?? 7,
    },
    intro_template: pb.intro_template,
    bridge_message_allowed: pb.bridge_message_allowed,
    max_touches: pb.max_touches,
    approve_before_send: pb.approve_before_send,
  };
}

function fieldsRecord(fields: PlaybookInput["qualification_fields"]): Record<string, QualificationField> {
  const out: Record<string, QualificationField> = {};
  for (const f of fields) {
    out[f.key] = { label: f.label, ...(f.options.length ? { options: f.options } : {}), ...(f.required ? { required: true } : {}), ...(f.description ? { description: f.description } : {}) };
  }
  return out;
}

const COLS = `name, goal, goal_detail, qualification_fields, warm_rule, handoff_triggers, cadence, send_window, tone, never_say, booking, intro_template, bridge_message_allowed, max_touches, approve_before_send`;
function colValues(p: PlaybookInput): unknown[] {
  return [
    p.name, p.goal, p.goal_detail, JSON.stringify(fieldsRecord(p.qualification_fields)), p.warm_rule, JSON.stringify(p.handoff_triggers),
    JSON.stringify(p.cadence), JSON.stringify(p.send_window), p.tone, JSON.stringify(p.never_say), JSON.stringify(p.booking), p.intro_template,
    p.bridge_message_allowed, p.max_touches, p.approve_before_send,
  ];
}

/**
 * Save a playbook edit. Updating bumps `version` and clears the approval until the owner approves
 * again; with no id a new playbook (version 1, unapproved) is created and linked to any of the
 * org's lead sources that have no playbook yet. Always scoped by orgId.
 */
export async function savePlaybookVersion(db: Db, orgId: string, playbookId: string | null, input: PlaybookInput): Promise<Playbook> {
  const p = PlaybookInput.parse(input);
  const vals = colValues(p);
  if (playbookId) {
    const sets = COLS.split(", ").map((c, i) => `${c} = $${i + 3}`).join(", ");
    const row = await maybeOne<Playbook>(db,
      `update playbooks set ${sets}, version = version + 1, approved_at = null, approved_by = null where id = $1 and org_id = $2 returning *`,
      [playbookId, orgId, ...vals]);
    if (!row) throw new Error("Playbook not found");
    return row;
  }
  const placeholders = vals.map((_, i) => `$${i + 2}`).join(", ");
  const row = await one<Playbook>(db, `insert into playbooks (org_id, ${COLS}) values ($1, ${placeholders}) returning *`, [orgId, ...vals]);
  await q(db, "update lead_sources set playbook_id = $2 where org_id = $1 and playbook_id is null", [orgId, row.id]);
  return row;
}

export async function approvePlaybook(db: Db, orgId: string, playbookId: string, userId: string): Promise<Playbook | null> {
  return maybeOne<Playbook>(db, "update playbooks set approved_at = $3, approved_by = $4 where id = $1 and org_id = $2 returning *", [playbookId, orgId, now(), userId]);
}

// ---------------------------------------------------------------------------------------------
// Website fetch: HTML → text and link selection (no deps, regex-based)
// ---------------------------------------------------------------------------------------------

export interface SitePage { url: string; title: string; text: string }
export interface SiteLink { url: string; text: string }

const ENTITIES: Record<string, string> = {
  nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘",
  ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™", bull: "•", middot: "·", deg: "°", eacute: "é", egrave: "è",
  aacute: "á", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ", ccedil: "ç", times: "×", frac12: "½", cent: "¢", dollar: "$",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (m, n: string) => safeCodePoint(Number(n)) ?? m)
    .replace(/&#x([0-9a-f]+);/gi, (m, n: string) => safeCodePoint(parseInt(n, 16)) ?? m)
    .replace(/&([a-z][a-z0-9]*);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/&amp;/gi, "&");
}
function safeCodePoint(n: number): string | null {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : null;
}

const BLOCK = /<\/?(?:p|div|br|hr|li|ul|ol|dl|dt|dd|h[1-6]|tr|table|thead|tbody|section|article|header|footer|main|aside|blockquote|pre|form|address|figure|figcaption|fieldset|details|summary)\b[^>]*>/gi;

/** Readable text from an HTML page: drops scripts, styles, nav and markup; one block per line. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|select|button)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(?:script|style|link|meta|img|input|source)\b[^>]*\/?>/gi, " ");
  s = s.replace(BLOCK, "\n").replace(/<\/?(?:td|th)\b[^>]*>/gi, " ").replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  const lines = s.split(/\r?\n/).map((l) => l.replace(/[ \t\f\v ]+/g, " ").trim()).filter(Boolean);
  const out: string[] = [];
  for (const l of lines) if (out[out.length - 1] !== l) out.push(l);
  return out.join("\n");
}

export function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

const sameSite = (a: URL, b: URL) => a.protocol.startsWith("http") && a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "");
const canonical = (u: URL) => `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "") || "/"}${u.search}`;

/** Same-site http(s) links on a page, resolved against `base`, without fragments. */
export function extractLinks(html: string, base: string): SiteLink[] {
  const baseUrl = new URL(base);
  const out: SiteLink[] = [];
  const clean = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ");
  for (const m of clean.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1]);
    const raw = decodeEntities((href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim());
    if (!raw || raw.startsWith("#") || /^(mailto|tel|javascript|sms|data):/i.test(raw)) continue;
    let u: URL;
    try { u = new URL(raw, baseUrl); } catch { continue; }
    if (!sameSite(u, baseUrl)) continue;
    u.hash = "";
    out.push({ url: u.toString(), text: htmlToText(m[2]).replace(/\s+/g, " ").trim() });
  }
  return out;
}

/** Page kinds worth reading, in priority order. Each matches the link's path or its text. */
export const PAGE_KEYWORDS: Array<[string, RegExp]> = [
  ["about", /\babout|who[-_ ]we[-_ ]are|our[-_ ]story/i],
  ["services", /\bservices?\b|what[-_ ]we[-_ ]do|treatments?|menu/i],
  ["specials", /\bspecials?\b|\bdeals?\b|promotions?/i],
  ["offers", /\boffers?\b|incentives?|coupons?/i],
  ["faq", /\bfaqs?\b|frequently[-_ ]asked|questions/i],
  ["contact", /\bcontact|directions|location/i],
  ["hours", /\bhours\b|schedule/i],
  ["inventory", /\binventory|new[-_ ]vehicles|used[-_ ]vehicles|pre[-_ ]?owned|showroom/i],
  ["financing", /\bfinanc|\bcredit\b|\blease\b|payment/i],
];
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|svg|webp|ico|zip|docx?|xlsx?|pptx?|mp4|mov|mp3|css|js|json|xml|txt)$/i;
const SKIP_PATH = /\/(wp-admin|wp-login|login|signin|sign-in|account|cart|checkout|privacy|terms|cookie|feed)\b/i;

/** Pick up to `max` same-site links matching the page keywords, one per kind first, then fill. */
export function selectLinks(links: SiteLink[], homeUrl: string, max = 9): string[] {
  const home = new URL(homeUrl);
  const seen = new Set<string>([canonical(home)]);
  const buckets: string[][] = PAGE_KEYWORDS.map(() => []);
  for (const l of links) {
    let u: URL;
    try { u = new URL(l.url); } catch { continue; }
    if (!sameSite(u, home) || SKIP_EXT.test(u.pathname) || SKIP_PATH.test(u.pathname)) continue;
    const key = canonical(u);
    if (seen.has(key)) continue;
    let path = u.pathname;
    try { path = decodeURIComponent(path); } catch { /* keep raw */ }
    const idx = PAGE_KEYWORDS.findIndex(([, re]) => re.test(path) || re.test(l.text));
    if (idx === -1) continue;
    seen.add(key);
    buckets[idx].push(u.toString());
  }
  const out: string[] = [];
  for (let round = 0; out.length < max && buckets.some((b) => b.length > round); round++) {
    for (const b of buckets) if (b[round] && out.length < max) out.push(b[round]);
  }
  return out;
}

function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === "::" || l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80");
}

/** Refuse hosts that resolve to private/loopback addresses (the URL comes from a customer). */
export async function assertPublicHost(hostname: string): Promise<void> {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) throw new Error(`refusing to fetch ${hostname}`);
  const addrs = isIP(h) ? [{ address: h }] : await lookup(h, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) throw new Error(`refusing to fetch ${hostname} (private address)`);
}

export interface FetchOptions {
  fetchImpl?: typeof fetch;
  maxPages?: number;
  timeoutMs?: number;
  maxBytes?: number;
  maxChars?: number;
  /** Host check before every request (default: refuse private addresses). Tests pass a no-op. */
  checkHost?: (hostname: string) => Promise<void>;
}

export function normalizeSiteUrl(raw: string): string {
  const s = raw.trim();
  const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("website must be http(s)");
  u.hash = "";
  return u.toString();
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return buf.subarray(0, maxBytes).toString("utf8");
}

async function fetchHtml(url: string, o: Required<Omit<FetchOptions, "maxPages" | "maxChars">>): Promise<{ url: string; html: string }> {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(current);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("not http(s)");
    await o.checkHost(u.hostname);
    const res = await o.fetchImpl(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(o.timeoutMs),
      headers: { "user-agent": "LeadlinePlaybookBot/1.0 (+onboarding website scan)", accept: "text/html,application/xhtml+xml" },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get("content-type") ?? "text/html";
    if (!/html|text\/plain/i.test(ct)) throw new Error(`not a web page (${ct})`);
    return { url: current, html: await readCapped(res, o.maxBytes) };
  }
  throw new Error("too many redirects");
}

/** Home page plus up to 9 same-site pages that look like about/services/specials/FAQ/contact/hours/etc. */
export async function fetchSitePages(siteUrl: string, opts: FetchOptions = {}): Promise<SitePage[]> {
  const o = {
    fetchImpl: opts.fetchImpl ?? fetch,
    timeoutMs: opts.timeoutMs ?? 10_000,
    maxBytes: opts.maxBytes ?? 1_000_000,
    checkHost: opts.checkHost ?? assertPublicHost,
  };
  const maxPages = Math.min(opts.maxPages ?? 10, 10);
  const maxChars = opts.maxChars ?? 15_000;
  const start = normalizeSiteUrl(siteUrl);
  let home: { url: string; html: string };
  try {
    home = await fetchHtml(start, o);
  } catch (e) {
    throw new Error(`Couldn't load ${start}: ${(e as Error).message}`);
  }
  const page = (url: string, html: string): SitePage => ({ url, title: extractTitle(html), text: htmlToText(html).slice(0, maxChars) });
  const pages: SitePage[] = [page(home.url, home.html)];
  const targets = selectLinks(extractLinks(home.html, home.url), home.url, maxPages - 1);
  const results = await Promise.allSettled(targets.map((t) => fetchHtml(t, o)));
  const seen = new Set([canonical(new URL(home.url))]);
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const key = canonical(new URL(r.value.url));
    if (seen.has(key)) continue;
    seen.add(key);
    pages.push(page(r.value.url, r.value.html));
  }
  return pages.slice(0, maxPages);
}

// ---------------------------------------------------------------------------------------------
// Extraction (Haiku) and drafting (Sonnet)
// ---------------------------------------------------------------------------------------------

export interface PageFacts { url: string; title: string; facts: string; extracted: boolean }

export const FACTS_PROMPT = `You read one page of a local business's website and list the facts a virtual assistant could use to answer customer questions.
Write short bullet points ("- ") only. Include: services and products, current specials and offers with their exact figures and fine print, policies, financing/credit statements, hours, address, phone, booking options, inventory highlights, and FAQ answers.
Copy every price, percentage, date and term exactly as written. Do not add anything that is not on the page. Skip navigation, legal boilerplate and marketing fluff. If the page has no useful facts, write "- (none)".`;

export async function extractFacts(pages: SitePage[]): Promise<PageFacts[]> {
  const model = getModel();
  return Promise.all(
    pages.map(async (p) => {
      if (!p.text.trim()) return { url: p.url, title: p.title, facts: "- (none)", extracted: false };
      const r = await model.fast(FACTS_PROMPT, `URL: ${p.url}\nTITLE: ${p.title}\n\nPAGE TEXT\n${p.text.slice(0, 12_000)}`, 1500);
      return r.ok
        ? { url: p.url, title: p.title, facts: r.output.trim() || "- (none)", extracted: true }
        // Model unavailable: keep the raw text (trimmed) so the owner still has something to review.
        : { url: p.url, title: p.title, facts: p.text.slice(0, 1500), extracted: false };
    }),
  );
}

/** What Sonnet returns. Closed objects with nullable (not optional) fields, as structured outputs require. */
export const DraftOutput = z.object({
  name: z.string(),
  goal: z.enum(GOALS),
  goal_detail: z.string().nullable(),
  qualification_fields: z.array(z.object({ key: z.string(), label: z.string(), options: z.array(z.string()), required: z.boolean(), description: z.string().nullable() })),
  warm_rule: z.string().nullable(),
  handoff_triggers: z.array(z.string()),
  tone: z.string(),
  never_say: z.array(z.string()),
  booking_kinds: z.array(z.enum(BOOKING_KINDS)),
  slot_minutes: z.number(),
  intro_template: z.string(),
  knowledge_items: z.array(z.object({ kind: z.enum(KNOWLEDGE_KINDS), title: z.string(), body: z.string(), source_url: z.string().nullable() })),
});
export type DraftOutput = z.infer<typeof DraftOutput>;

export const KnowledgeDraft = z.object({
  kind: z.enum(KNOWLEDGE_KINDS),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
  source_url: z.string().trim().max(1000).nullable(),
});
export type KnowledgeDraft = z.infer<typeof KnowledgeDraft>;

export interface PlaybookDraft {
  playbook: PlaybookInput;
  knowledge_items: KnowledgeDraft[];
  /** True when the model couldn't draft and this is a starter template built from the page facts. */
  fallback: boolean;
  warnings: string[];
}

export const DRAFT_PROMPT = `You set up an AI lead assistant for a local business. From the business details and the facts pulled from its website, draft:
1. A playbook: the goal (usually "appointment"), qualification fields the assistant should learn in conversation (snake_case keys, short labels, options when there is a fixed set; mark the 1-3 most important as required), a warm rule written in terms of those keys, handoff triggers (when a person must take over), a tone description, a never-say list (promises or claims the business must not make), the booking kinds, the appointment length in minutes, and an intro template.
2. Knowledge items: the facts the assistant may state, one topic per item, each with a kind (service, faq, policy, offer, inventory, location), a short title, a body, and the source page URL.

Rules
- Knowledge items contain ONLY facts that appear in the website facts. Copy every price, percentage, rate, date and offer term word for word, including fine print. Never invent or round numbers.
- Never ask leads for SSN, date of birth, income or credit details; do not create qualification fields for them.
- The intro template is the first text a lead gets. Under 300 characters. It must name the business using {business_name}, introduce itself as the business's virtual assistant, greet {first_name}, ask one easy question, and end with "Reply STOP to opt out."
- Handoff triggers should include: asks for a price or term not in knowledge, asks for a person, complaint or frustration.
- Write in plain, specific language for this business. No emoji.`;

function businessBlock(org: Pick<Org, "name" | "industry" | "website_url" | "address" | "phone" | "timezone">): string {
  return `BUSINESS\nName: ${org.name}\nIndustry: ${org.industry}\nWebsite: ${org.website_url ?? "(none)"}\nAddress: ${org.address ?? "(none)"}\nPhone: ${org.phone ?? "(none)"}\nTime zone: ${org.timezone}`;
}

function factsBlock(facts: PageFacts[], budget = 40_000): string {
  let out = "";
  for (const f of facts) {
    const chunk = `\n\n## ${f.title || f.url}\nURL: ${f.url}\n${f.facts}`;
    if (out.length + chunk.length > budget) break;
    out += chunk;
  }
  return `WEBSITE FACTS${out || "\n(none)"}`;
}

const kindForUrl = (url: string): KnowledgeKind => {
  const p = url.toLowerCase();
  if (/special|offer|deal|incentive|promo|coupon/.test(p)) return "offer";
  if (/faq|question/.test(p)) return "faq";
  if (/contact|hours|location|direction/.test(p)) return "location";
  if (/inventory|vehicles|pre-?owned|showroom/.test(p)) return "inventory";
  if (/financ|credit|lease|polic|warrant/.test(p)) return "policy";
  return "service";
};

/** Starter knowledge items when the model can't structure them: one per page with useful facts. */
export function fallbackKnowledge(facts: PageFacts[]): KnowledgeDraft[] {
  return facts
    .filter((f) => f.facts.trim() && !/^-?\s*\(none\)\s*$/.test(f.facts.trim()))
    .map((f) => ({ kind: kindForUrl(f.url), title: (f.title || new URL(f.url).pathname).slice(0, 200), body: f.facts.slice(0, 5000), source_url: f.url }));
}

function cleanKnowledge(items: DraftOutput["knowledge_items"]): KnowledgeDraft[] {
  return items.flatMap((k) => {
    const r = KnowledgeDraft.safeParse(k);
    return r.success ? [r.data] : [];
  });
}

/** Turn the model's draft into a valid PlaybookInput, repairing anything that fails validation. */
export function normalizeDraft(org: Pick<Org, "name">, d: DraftOutput): { playbook: PlaybookInput; warnings: string[] } {
  const base = defaultPlaybookInput(org);
  const warnings: string[] = [];
  const keys = new Set<string>();
  const fields = d.qualification_fields.flatMap((f) => {
    const key = f.key.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^[^a-z]+/, "").slice(0, 41);
    if (!key || keys.has(key) || /ssn|social|birth|dob|income|salary|credit/.test(key)) return [];
    keys.add(key);
    const r = QualificationFieldInput.safeParse({ ...f, key });
    return r.success ? [r.data] : [];
  }).slice(0, 20);
  let intro = d.intro_template.trim();
  const problems = introTemplateProblems(intro, org.name);
  if (problems.length || intro.length > 320 || intro.length < 10) {
    warnings.push(`The drafted intro message ${problems.join(", ") || "was the wrong length"}; using the standard intro instead.`);
    intro = base.intro_template;
  }
  const candidate: PlaybookInput = {
    ...base,
    name: d.name.trim().slice(0, 100) || base.name,
    goal: d.goal,
    goal_detail: d.goal_detail?.trim().slice(0, 500) || null,
    qualification_fields: fields,
    warm_rule: d.warm_rule?.trim().slice(0, 500) || null,
    handoff_triggers: [...new Set([...d.handoff_triggers.map((t) => t.trim().slice(0, 200)).filter(Boolean), ...base.handoff_triggers])].slice(0, 20),
    tone: d.tone.trim().slice(0, 500) || base.tone,
    never_say: [...new Set(d.never_say.map((t) => t.trim().slice(0, 120)).filter(Boolean))].slice(0, 50),
    booking: {
      ...base.booking,
      kinds: d.booking_kinds.length ? [...new Set(d.booking_kinds)] : base.booking.kinds,
      slot_minutes: Number.isFinite(d.slot_minutes) ? Math.min(240, Math.max(10, Math.round(d.slot_minutes))) : base.booking.slot_minutes,
    },
    intro_template: intro,
  };
  const ok = PlaybookInput.safeParse(candidate);
  if (!ok.success) {
    warnings.push(`Parts of the draft were invalid and were replaced with defaults: ${ok.error.issues.map((i) => i.message).join("; ")}`);
    return { playbook: { ...base, name: candidate.name }, warnings };
  }
  return { playbook: ok.data, warnings };
}

export async function draftPlaybook(
  org: Pick<Org, "name" | "industry" | "website_url" | "address" | "phone" | "timezone">,
  facts: PageFacts[],
): Promise<PlaybookDraft> {
  const r = await getModel().draft(DRAFT_PROMPT, `${businessBlock(org)}\n\n${factsBlock(facts)}`, DraftOutput);
  if (!r.ok) {
    return {
      playbook: defaultPlaybookInput(org),
      knowledge_items: fallbackKnowledge(facts),
      fallback: true,
      warnings: [`The AI couldn't draft the playbook (${r.error}). This is a starter playbook with one knowledge item per page; edit before approving.`],
    };
  }
  const { playbook, warnings } = normalizeDraft(org, r.output);
  return { playbook, knowledge_items: cleanKnowledge(r.output.knowledge_items), fallback: false, warnings };
}

const KNOWLEDGE_ONLY = z.object({ knowledge_items: DraftOutput.shape.knowledge_items });

/** Re-scan: propose knowledge items from fresh website facts, skipping titles the org already has. */
export async function proposeKnowledge(
  org: Pick<Org, "name" | "industry" | "website_url" | "address" | "phone" | "timezone">,
  facts: PageFacts[],
  existingTitles: string[],
): Promise<{ items: KnowledgeDraft[]; fallback: boolean; warning: string | null }> {
  const have = new Set(existingTitles.map((t) => t.trim().toLowerCase()));
  const r = await getModel().draft(
    `${DRAFT_PROMPT}\n\nOnly return knowledge items (no playbook). Skip topics already covered by these existing titles: ${existingTitles.join("; ") || "(none)"}.`,
    `${businessBlock(org)}\n\n${factsBlock(facts)}`,
    KNOWLEDGE_ONLY,
  );
  const items = r.ok ? cleanKnowledge(r.output.knowledge_items) : fallbackKnowledge(facts);
  return {
    items: items.filter((k) => !have.has(k.title.trim().toLowerCase())),
    fallback: !r.ok,
    warning: r.ok ? null : `The AI couldn't structure the facts (${r.error}); showing one item per page instead.`,
  };
}

/** The whole generator: fetch → extract → draft. Returns a draft; nothing is saved. */
export async function generatePlaybookDraft(
  org: Pick<Org, "name" | "industry" | "website_url" | "address" | "phone" | "timezone">,
  siteUrl: string,
  opts?: FetchOptions,
): Promise<PlaybookDraft & { pages: Array<{ url: string; title: string }> }> {
  const pages = await fetchSitePages(siteUrl, opts);
  const facts = await extractFacts(pages);
  const draft = await draftPlaybook({ ...org, website_url: org.website_url ?? siteUrl }, facts);
  return { ...draft, pages: pages.map((p) => ({ url: p.url, title: p.title })) };
}

/** Save approved/edited knowledge drafts for an org (service connection; scoped by orgId). */
export async function insertKnowledgeItems(db: Db, orgId: string, items: KnowledgeDraft[]): Promise<number> {
  let n = 0;
  for (const raw of items) {
    const k = KnowledgeDraft.parse(raw);
    await q(db, "insert into knowledge_items (org_id, kind, title, body, source_url, active) values ($1, $2, $3, $4, $5, true)", [orgId, k.kind, k.title, k.body, k.source_url]);
    n++;
  }
  return n;
}
