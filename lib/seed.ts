// Demo data: a dealership with a playbook, knowledge base, team, 25 leads across stages and a
// week of appointments. Used by `npm run seed`, tests and the simulator.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { DateTime } from "luxon";
import type { Db } from "./db";
import { maybeOne, one, q } from "./db";
import type { LeadStage } from "./db/types";
import { now } from "./clock";

export function loadPlaybookYaml(file = "bmw-preorder.yaml") {
  return parse(readFileSync(join(process.cwd(), "supabase/seed/playbooks", file), "utf8")) as Record<string, any>;
}

export async function insertPlaybook(db: Db, orgId: string, y: Record<string, any>, approved = true) {
  return one<{ id: string }>(
    db,
    `insert into playbooks (org_id, name, goal, goal_detail, qualification_fields, warm_rule, handoff_triggers, cadence, send_window, tone, never_say, booking, intro_template, approve_before_send, approved_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id`,
    [
      orgId, y.name, y.goal ?? "appointment", y.goal_detail ?? null, JSON.stringify(y.qualification_fields ?? {}), y.warm_rule ?? null,
      JSON.stringify(y.handoff_triggers ?? []), JSON.stringify(y.cadence ?? "default"), JSON.stringify(y.send_window ?? {}), y.tone ?? null,
      JSON.stringify(y.never_say ?? []), JSON.stringify(y.booking ?? {}), y.intro_template, y.approve_before_send ?? true, approved ? now() : null,
    ],
  );
}

/** Local/test: users live in the shim's auth.users. On Supabase, scripts/seed.ts creates them via the Admin API first. */
export async function ensureUser(db: Db, email: string, id?: string): Promise<string> {
  const existing = await maybeOne<{ id: string }>(db, "select id from auth.users where email = $1", [email]);
  if (existing) return existing.id;
  return (await one<{ id: string }>(db, "insert into auth.users (id, email) values (coalesce($2::uuid, gen_random_uuid()), $1) returning id", [email, id ?? null])).id;
}

export const DEMO_KNOWLEDGE = [
  { kind: "location", title: "Showroom address and hours", body: "BMW of Elmhurst (DEMO DATA), 100 W Lake St, Elmhurst, IL 60126. Showroom hours: Mon–Fri 9am–8pm, Sat 9am–6pm, closed Sunday." },
  { kind: "policy", title: "Pre-order reservations", body: "DEMO DATA. Pre-orders for the new i3, iX3 and X5 are reserved with a product specialist in the showroom or by phone. A specialist confirms deposit terms in person." },
  { kind: "faq", title: "Configurations", body: "DEMO DATA. All three models can be configured with any factory color and package at the time of reservation. A specialist can walk through trims and options." },
  { kind: "faq", title: "Trade-ins", body: "DEMO DATA. We accept trade-ins of any make. Bring the vehicle in for an appraisal; a specialist will give you a written offer." },
  { kind: "policy", title: "Credit applications", body: "DEMO DATA. Credit applications are completed through our secure online form: https://example.com/credit-app (placeholder)." },
];

export interface DemoOptions { name?: string; slug?: string; leads?: number; withAppointments?: boolean; ownerEmail?: string; repEmails?: string[]; live?: boolean }

export async function seedDemo(db: Db, opts: DemoOptions = {}) {
  const ownerEmail = opts.ownerEmail ?? "owner@demo.leadline.test";
  const repEmails = opts.repEmails ?? ["sam@demo.leadline.test", "alex@demo.leadline.test"];
  const ownerId = await ensureUser(db, ownerEmail);
  const repIds = [];
  for (const e of repEmails) repIds.push(await ensureUser(db, e));

  const org = await one<{ id: string; intake_key: string }>(
    db,
    `insert into organizations (name, slug, industry, timezone, website_url, address, phone, status, texting_enabled, send_sundays, sms_from_number, default_owner_user_id, backup_user_id)
     values ($1, $2, 'automotive', 'America/Chicago', 'https://example.com', '100 W Lake St, Elmhurst, IL 60126', '+16305550100', $3, true, false, '+16305550100', $4, $4)
     returning id, intake_key`,
    [opts.name ?? "BMW of Elmhurst", opts.slug ?? "bmw-elmhurst-demo", opts.live === false ? "onboarding" : "live", ownerId],
  );
  await q(db, "insert into memberships (org_id, user_id, role, display_name, email, mobile_phone, round_robin_weight) values ($1, $2, 'owner', 'Jordan Owner', $3, '+16305550111', 0)", [org.id, ownerId, ownerEmail]);
  const repNames = ["Sam Rivera", "Alex Chen", "Rep Three", "Rep Four"];
  for (let i = 0; i < repIds.length; i++) {
    await q(db, "insert into memberships (org_id, user_id, role, display_name, email, mobile_phone, round_robin_weight) values ($1, $2, 'rep', $3, $4, $5, 1)",
      [org.id, repIds[i], repNames[i] ?? `Rep ${i + 1}`, repEmails[i], `+1630555012${i}`]);
  }
  const pb = await insertPlaybook(db, org.id, loadPlaybookYaml());
  for (const k of DEMO_KNOWLEDGE) await q(db, "insert into knowledge_items (org_id, kind, title, body) values ($1, $2, $3, $4)", [org.id, k.kind, k.title, k.body]);
  const consent = "By submitting, you agree that BMW of Elmhurst may send you automated marketing and informational text messages at the number provided. Consent is not a condition of purchase. Msg & data rates may apply. Reply STOP to opt out.";
  const source = await one<{ id: string }>(
    db,
    `insert into lead_sources (org_id, kind, name, meta_form_id, consent_text, consent_covers_automated, consent_verified_at, playbook_id)
     values ($1, 'zapier', 'Pre-order form (Zapier)', 'demo_form_1', $2, true, $3, $4) returning id`,
    [org.id, consent, now(), pb.id],
  );
  await q(db, `insert into availability (org_id, user_id, weekly_hours, slot_minutes, buffer_minutes, min_notice_minutes, max_days_ahead)
               values ($1, null, '{"mon":[["09:00","20:00"]],"tue":[["09:00","20:00"]],"wed":[["09:00","20:00"]],"thu":[["09:00","20:00"]],"fri":[["09:00","20:00"]],"sat":[["09:00","18:00"]],"sun":[]}', 45, 15, 120, 7)`, [org.id]);
  await q(db, "insert into integrations (org_id, kind, status, config) values ($1, 'zapier', 'connected', '{}')", [org.id]);

  const n = opts.leads ?? 25;
  const stages: LeadStage[] = ["new", "contacted", "contacted", "engaged", "engaged", "qualified", "appointment_set", "showed", "sold", "nurture", "lost"];
  const firsts = ["Maria", "James", "Priya", "Daniel", "Sofia", "Michael", "Aisha", "Robert", "Elena", "David", "Grace", "Kevin", "Laura", "Omar", "Hannah", "Victor", "Nina", "Tom", "Rosa", "Ben", "Chloe", "Marcus", "Ivy", "Leo", "Zoe"];
  const lasts = ["Garcia", "Smith", "Patel", "Kim", "Rossi", "Brown", "Khan", "Johnson", "Novak", "Lee"];
  const models = ["i3", "iX3", "X5"];
  const campaigns = ["Pre-order | i3 launch", "Pre-order | X5 conquest", "Pre-order | iX3 EV"];
  const leadIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const stage = stages[i % stages.length];
    const created = new Date(now().getTime() - (i * 7 + 1) * 3600_000);
    const model = models[i % 3];
    const qual: Record<string, string> = { model_interest: model };
    if (["engaged", "qualified", "appointment_set", "showed", "sold"].includes(stage)) qual.timeline = i % 2 ? "within 30 days" : "next 60 days";
    if (["qualified", "appointment_set", "showed", "sold"].includes(stage)) qual.payment_type = i % 2 ? "lease" : "finance";
    const lead = await one<{ id: string }>(
      db,
      `insert into leads (org_id, source_id, meta_lead_id, meta_form_id, campaign_name, ad_name, first_name, last_name, full_name, phone_e164, email, zip, us_state,
                          timezone, timezone_candidates, answers, stage, qualification, assigned_user_id, ai_status, warm, score, summary, created_at, last_inbound_at, last_outbound_at, first_outbound_at)
       values ($1,$2,$3,'demo_form_1',$4,$5,$6,$7,$8,$9,$10,'60126','IL','America/Chicago','["America/Chicago"]',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) returning id`,
      [
        org.id, source.id, `demo_${100000 + i}`, campaigns[i % 3], `${model} — carousel ${1 + (i % 4)}`, firsts[i % firsts.length], lasts[i % lasts.length],
        `${firsts[i % firsts.length]} ${lasts[i % lasts.length]}`, `+1630555${String(2000 + i).padStart(4, "0")}`, `${firsts[i % firsts.length].toLowerCase()}.${i}@example.com`,
        JSON.stringify({ which_model_are_you_interested_in: model }), stage, JSON.stringify(qual), repIds[i % repIds.length],
        stage === "lost" ? "stopped" : stage === "qualified" ? "paused" : "active", ["qualified", "appointment_set", "showed", "sold"].includes(stage),
        stage === "new" ? 10 : 20 + stages.indexOf(stage) * 8,
        `${firsts[i % firsts.length]} wants the ${model}.${qual.timeline ? ` Timeline: ${qual.timeline}.` : ""}`,
        created, stage === "new" || stage === "contacted" ? null : new Date(created.getTime() + 40 * 60_000), stage === "new" ? null : new Date(created.getTime() + 45_000), stage === "new" ? null : new Date(created.getTime() + 45_000),
      ],
    );
    leadIds.push(lead.id);
    await q(db, "insert into consent_records (org_id, lead_id, channel, source, disclosure_text, covers_automated, captured_at) values ($1, $2, 'sms', $3, $4, true, $5)", [org.id, lead.id, `zapier:${source.id}`, consent, created]);
    await q(db, "insert into stage_events (org_id, lead_id, from_stage, to_stage, actor, created_at) values ($1, $2, null, 'new', 'seed', $3)", [org.id, lead.id, created]);
    if (stage !== "new") await q(db, "insert into stage_events (org_id, lead_id, from_stage, to_stage, actor, created_at) values ($1, $2, 'new', $3, 'seed', $4)", [org.id, lead.id, stage, new Date(created.getTime() + 3600_000)]);
    if (stage !== "new") {
      const first = firsts[i % firsts.length];
      await q(db, `insert into messages (org_id, lead_id, channel, direction, author, body, status, is_automated, purpose, dry_run, sent_at, created_at)
                   values ($1, $2, 'sms', 'outbound', 'ai', $3, 'sent', true, 'first_touch', true, $4, $4)`,
        [org.id, lead.id, `Hi ${first}, this is the virtual assistant at BMW of Elmhurst. Thanks for your interest in the new ${model}. Are you focused on timing, configuration or pricing right now? Reply STOP to opt out.`, new Date(created.getTime() + 45_000)]);
      if (!["contacted"].includes(stage)) {
        await q(db, `insert into messages (org_id, lead_id, channel, direction, author, body, status, created_at) values ($1, $2, 'sms', 'inbound', 'lead', $3, 'received', $4)`,
          [org.id, lead.id, ["Timing mostly, hoping to have it by spring", "Configuration, I want the M Sport package", "Mostly pricing honestly"][i % 3], new Date(created.getTime() + 40 * 60_000)]);
      }
    }
  }
  if (opts.withAppointments !== false) {
    const tz = "America/Chicago";
    const base = DateTime.fromJSDate(now(), { zone: tz }).startOf("day");
    let k = 0;
    for (let d = 0; d < 7; d++) {
      const day = base.plus({ days: d });
      if (day.weekday === 7) continue;
      for (const hour of [10, 15]) {
        const leadId = leadIds[(k * 3 + 6) % leadIds.length];
        const start = day.set({ hour, minute: 0 }).toJSDate();
        await q(db, `insert into appointments (org_id, lead_id, user_id, starts_at, ends_at, kind, status, created_by) values ($1, $2, $3, $4, $5, $6, 'booked', 'seed') on conflict do nothing`,
          [org.id, leadId, repIds[k % repIds.length], start, new Date(start.getTime() + 45 * 60_000), k % 3 === 2 ? "call" : "in_person"]);
        k++;
      }
    }
  }
  return { orgId: org.id, intakeKey: org.intake_key, ownerId, repIds, playbookId: pb.id, sourceId: source.id, leadIds };
}
