# AI Lead Agent + Mini CRM: Build Spec for Claude Code

Oct 14, 2026 · @Kyle

## How Claude Code should use this spec

Build this end to end, phase by phase, and stop only at the HUMAN STEP checkpoints. Everything that isn't a login, a credential or a legal approval is Claude Code's job.

1. Read the whole spec before writing code. Then create `CLAUDE.md` at the repo root with the stack, the hard rules from "Compliance rules enforced in code," and the current phase. Update it as each phase completes.
2. Build in the order of "Build phases." A phase is done when its acceptance criteria pass in tests or in the simulator. Commit at each milestone.
3. Keep `DRY_RUN=true` until a human sets it to false. In dry-run, outbound SMS and email are written to the `messages` table and shown in the simulator, never sent to a real person.
4. Before implementing any third-party API (Meta Graph API, Conversions API, Twilio, Postmark, Google Calendar, Anthropic), read that provider's current docs. Versions, scopes and permission names change; this spec defines the shape, not the version.
5. When you need a credential or an account action, stop and print a block titled HUMAN STEP: what to do, where, and which env var receives the result. Keep building anything that doesn't depend on it.
6. Compliance rules live in code, not in the prompt. If a rule conflicts with making the agent "smarter," the rule wins.
7. Prefer boring, explicit code. The scheduler is a database poll, not a workflow engine. The agent returns structured JSON; plain code decides what actually gets sent.

## Product overview

A business connects its Facebook lead forms, a phone number and a calendar; from then on, every lead gets a text within 60 seconds, an AI agent qualifies it, and warm leads are booked or handed to a rep. Working name: Leadline (rename freely).

The app is a mini CRM built around Facebook lead ads. It holds the leads, the conversations, the pipeline and the appointments, and it sends each lead's outcome back to Meta so the ads learn what a buyer looks like.

**Who it's for:** any business that buys leads with Meta lead forms and books appointments: car dealers first, then med spas, home services, clinics, real estate. Phase 1 serves two managed pilot accounts; the data model is multi-tenant from day one so self-serve signup is an add-on, not a rewrite.

**Goals**

- Speed to lead under 60 seconds, 24/7, for every lead with SMS consent.
- Turn form fills into booked, shown appointments without a rep working cold leads.
- Hand warm leads to a named rep instantly, in the same thread, with a summary.
- Feed lead stages (qualified, appointment set, showed, sold) back to Meta for conversion leads optimization.
- Setup a non-technical owner can finish in under 30 minutes, once the platform is live.

**Non-goals for v1**

- Outbound AI voice calls. Text and email only; voice is a later module.
- Full CRM replacement (deals, invoicing, inventory management). The app pushes to the customer's real CRM.
- Leads from sources other than Meta forms, beyond a generic webhook, CSV import and manual entry.
- Healthcare tenants handling protected health information (see compliance).

## What a human has to connect

Ten one-time platform steps (done once by the owner of the product) and a ten-step in-app wizard per customer. Everything else is built and automated by Claude Code. Start the two slow approvals on day one: carrier texting registration (days to weeks) and Meta app review (weeks); the Zapier bridge covers lead intake until Meta review clears.

**One-time platform setup (HUMAN STEPs)**

| Step | Where | What to do | Result goes to |
| --- | --- | --- | --- |
| Database | Supabase | Create a project | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
| Hosting | Railway | Create a project, connect the GitHub repo, add a web service and a worker service | Deploy target |
| Domain | Registrar | Buy the app domain, point it at Railway | `APP_URL` |
| AI | Anthropic Console | Create an API key | `ANTHROPIC_API_KEY` |
| Texting | Twilio | Upgrade the account, complete the ISV primary business profile in Trust Hub | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` |
| Email | Postmark | Create a server, verify a sending domain (e.g. `mail.<appdomain>`), turn on an inbound stream pointed at `/api/webhooks/postmark/inbound` | `POSTMARK_SERVER_TOKEN`, `POSTMARK_INBOUND_DOMAIN` |
| Meta | Meta for Developers | Create a Business app; add Facebook Login for Business, Webhooks, Marketing API; finish business verification; submit app review for lead retrieval and page permissions | `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` |
| Calendar | Google Cloud | Create an OAuth client with the Calendar API enabled; submit the consent screen for verification | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Lead bridge | Zapier | Per pilot account: a Zap from Facebook Lead Ads to a Webhooks POST at `/api/intake/zapier/<org intake key>` | Used until Meta review clears |
| Legal | TCPA attorney | Review consent language, opt-out handling, quiet hours and the customer terms | Sign-off before `DRY_RUN=false` |

**Per-customer onboarding (in-app wizard, about 30 minutes)**

1. Business basics: name, website, time zone, industry, address.
2. Facebook: log in, pick the Page and the lead forms to watch. Phase 1 shows the Zapier intake URL instead.
3. Consent: confirm each form shows an SMS consent disclosure, paste its text. The app stores a snapshot per form and refuses automated texts for forms without one.
4. Phone number: the app buys a local number and collects carrier registration details (legal name, EIN, address, contact, sample messages pre-filled). Texting turns on when registration is approved.
5. Email: by default the agent emails from the app's domain under the business name; optional custom domain shows the DNS records to add.
6. Hours and calendar: bookable hours, slot length, buffer; each rep can connect Google Calendar.
7. Team: invite reps with mobile numbers for handoff alerts; set round-robin or a single owner.
8. Playbook: enter the website URL; Claude drafts the playbook and knowledge base; the owner edits and approves.
9. CRM push (optional): an ADF/XML lead email address or a webhook URL.
10. Test: text yourself as a fake lead from the simulator, then go live.

## Tech stack (pinned)

TypeScript end to end: a Next.js web app and a separate worker on Railway, Supabase for Postgres and auth, Twilio for SMS, Postmark for email, and the Anthropic API for the agent. Don't swap these without a reason written into `CLAUDE.md`.

| Layer | Choice | Notes |
| --- | --- | --- |
| Web app | Next.js (App Router), Tailwind, shadcn/ui | Mobile-first; installable as a PWA so reps can work the inbox from their phone |
| Database and auth | Supabase Postgres, Supabase Auth (magic link + Google) | Row-level security on every tenant table; Realtime for live inbox updates |
| Background jobs | Node worker process | Polls due jobs every 15 seconds with `FOR UPDATE SKIP LOCKED`; runs cadence, reminders, retries |
| Hosting | Railway (web service + worker service) | Never a home machine: webhooks must stay up |
| SMS | Twilio Messaging Service per tenant | Subaccount per tenant from phase 5; inbound via signed webhook |
| Email | Postmark | Outbound plus inbound stream; per-lead reply addresses |
| AI | Anthropic API, `@anthropic-ai/sdk` | `claude-sonnet-5-5` for replies and playbook drafting; `claude-haiku-5-5` for classification, opt-out detection and summaries; prompt caching on the playbook prefix. Verify model IDs in the [Claude API docs](https://docs.claude.com/en/api/overview) |
| Validation | zod | Every webhook payload and every model response is parsed, never trusted |
| Secrets | App-level AES-GCM with `ENCRYPTION_KEY` | Tenant OAuth tokens and API keys encrypted at rest |
| Monitoring | Sentry, structured logs | Every send attempt and every webhook is logged with its tenant |
| Billing | Stripe (phase 5) | Per-location subscription plus usage |
| Tests | Vitest, Playwright | Unit tests for rules, end-to-end for wizard and inbox |

**Repo layout**

```
/app                 Next.js routes, UI, API routes (webhooks, intake)
/worker              job loop: cadence, reminders, CAPI, CRM push
/lib/agent           context builder, prompts, output schema, guards
/lib/compliance      consent, send windows, opt-out, rate limits
/lib/integrations    meta, capi, twilio, postmark, google, adf, webhooks
/supabase/migrations schema + RLS policies
/tests               unit, agent evals, e2e
```

## Data model

Sixteen tables, every one keyed by `org_id`, with row-level security so a user only ever sees rows for organizations they belong to. Webhooks and the worker use the service role and must set `org_id` explicitly on every write.

| Table | Key columns | Purpose |
| --- | --- | --- |
| `organizations` | name, slug, industry, timezone, website\_url, address, intake\_key, status (onboarding, live, paused) | One customer business (one rooftop or location) |
| `memberships` | user\_id, role (owner, admin, rep), display\_name, mobile\_phone, notify\_sms, notify\_email, round\_robin\_weight, active | Who can log in and who gets handoffs |
| `integrations` | kind (meta, twilio, postmark\_domain, google\_calendar, crm\_webhook, adf\_email, zapier), status, config jsonb, secret\_enc, last\_error | Connection state per tenant |
| `lead_sources` | kind (meta\_form, zapier, webhook, csv, manual), meta\_page\_id, meta\_form\_id, name, consent\_text, consent\_verified\_at, playbook\_id | Each lead form or feed, with its consent snapshot |
| `playbooks` | version, goal (appointment, call, quote, reservation), qualification\_fields, warm\_rule, handoff\_triggers, cadence, send\_window, tone, never\_say, booking, approve\_before\_send, approved\_at | How the agent behaves for a source |
| `knowledge_items` | kind (service, faq, policy, offer, inventory, location), title, body, source\_url, active | The only facts the agent may state |
| `leads` | source\_id, meta\_lead\_id, campaign/ad set/ad ids and names, name, phone\_e164, email, zip, timezone, answers jsonb, stage, score, qualification jsonb, summary, assigned\_user\_id, ai\_status (active, paused, stopped), cadence\_step, next\_action\_at, last\_inbound\_at, last\_outbound\_at, opted\_out\_sms\_at, opted\_out\_email\_at | The pipeline. Unique on (org\_id, meta\_lead\_id); dedupe on phone within 30 days |
| `messages` | lead\_id, channel (sms, email, note, system), direction, author (ai, user, lead, system), body, subject, status (pending\_approval, queued, sent, delivered, failed, blocked, received), blocked\_reason, provider\_message\_id, ai\_run\_id | Full conversation history |
| `ai_runs` | lead\_id, model, prompt\_version, output jsonb, guard\_result jsonb, tokens\_in, tokens\_out, latency\_ms | Audit trail and eval data for every agent call |
| `appointments` | lead\_id, user\_id, starts\_at, ends\_at, kind (in\_person, call, video), status (booked, confirmed, showed, no\_show, canceled), google\_event\_id, reminder\_24h\_sent\_at, reminder\_2h\_sent\_at, created\_by | Bookings |
| `availability` | user\_id (nullable = whole org), weekly\_hours, slot\_minutes, buffer\_minutes, min\_notice\_minutes, max\_days\_ahead, blackout\_dates | Bookable time |
| `jobs` | lead\_id, kind (first\_touch, followup, reminder, handoff\_sla, capi\_event, crm\_push, webhook\_out), run\_at, status, attempts, last\_error, payload | The worker's queue |
| `stage_events` | lead\_id, from\_stage, to\_stage, actor | Feeds the dashboard and the Conversions API |
| `capi_events` | lead\_id, event\_name, event\_time, status, attempts, response | What was sent to Meta and whether it landed |
| `consent_records` | lead\_id, channel, source, disclosure\_text, captured\_at, evidence | Immutable proof of consent, never updated or deleted |
| `audit_log` | actor, action, entity, entity\_id, diff | Settings and manual changes |

**Lead stages:** `new` → `contacted` → `engaged` → `qualified` → `appointment_set` → `showed` → `sold`, plus `nurture` and `lost` as side exits. Opt-outs are flags on the lead, not stages, so the pipeline history stays intact.

**Access rules:** owners and admins see and edit everything in their org; reps see all org leads but only edit leads assigned to them or unassigned. A `platform_admins` table grants the product owner cross-tenant access for managed onboarding, and every cross-tenant action is written to `audit_log`.

## Core flows

Seven flows make up the product. Each one ends by writing a `stage_events` row and scheduling the next job, so the worker always knows what happens next and nothing depends on a process staying in memory.

&#91;embedded content: lead lifecycle · 7 stages, 2 side exits\]

Qualified, appointment set, showed and sold each send an event to Meta's Conversions API.

### 1. Intake

1. A lead arrives from a Meta `leadgen` webhook (fetch the full lead by ID), the Zapier bridge, a generic signed webhook, CSV import or manual entry.
2. Normalize: phone to E.164 with libphonenumber, lowercase email, split the name, map form answers onto the playbook's qualification fields using the source's field mapping.
3. Dedupe: a repeat `meta_lead_id` is ignored; the same phone within 30 days attaches to the existing lead as a re-submission and reactivates it if it was `lost` or `nurture`.
4. Consent: if the source has verified SMS consent text, write a `consent_records` row; otherwise the lead is email-only.
5. Time zone: from ZIP, else area code, else the org's time zone.
6. Create the lead at `new`, assign a rep by round-robin, enqueue `first_touch` with `run_at = now`.

### 2. First touch (target: under 60 seconds)

1. The worker picks up `first_touch` and runs the compliance check (consent, opt-out, send window).
2. Inside the send window: the agent writes an intro that references what the lead asked about and ends with one easy question. Send the SMS and an intro email; stage becomes `contacted`.
3. Outside the window: send the email now and schedule the SMS for the moment the window opens.

### 3. Conversation loop

1. Inbound SMS or email hits its webhook. Verify the signature, match the lead by phone plus receiving number (or by per-lead reply address), store the message.
2. Opt-out check first: carrier keywords (STOP, UNSUBSCRIBE, QUIT and friends) and a fast classifier for plain-language versions ("don't text me," "wrong number"). An opt-out stops all automated texts at once and sends one confirmation.
3. If `ai_status` is `paused`, a human owns the thread: notify the assigned rep and do nothing else.
4. Otherwise wait 20 seconds for more messages (people send in bursts), then run the agent on the full thread. Its output passes the guards, then is sent or held for approval.
5. Save extracted qualification fields, update score and stage (`engaged` on the first reply), cancel pending follow-ups and schedule a "went quiet" follow-up.

### 4. Follow-up cadence

1. Default when a lead never replies: +2 hours, +1 day, +3 days, +7 days, +14 days, +30 days, then monthly for up to 6 months in `nurture`.
2. Default when a lead replied, then went quiet: +1 day, +3 days, +7 days, then `nurture`.
3. Each step names a channel (SMS, email or both) and an angle for the agent: a simple question, a matching offer or vehicle, an incentive, trade or value, social proof, and a final "should I close your file?" message.
4. Stop the cadence on any reply, an appointment, an opt-out, `lost`, AI stopped, or the playbook's max-touch count.
5. Every scheduled send re-checks lead state and compliance at send time, because things change between scheduling and sending.

### 5. Handoff to a human

1. Triggers, configurable per playbook: the warm rule is met; the lead asks for a price, payment or term the knowledge base doesn't contain; the lead asks for a person; anger or a complaint; a legal or medical question; low agent confidence twice in a row.
2. If the playbook allows, the agent sends a short bridge message naming the rep ("I'm looping in Sam, who'll text you here shortly").
3. Set `ai_status = paused`; stage moves to `qualified` when the warm rule is met. Alert the rep by SMS from the platform alert number and by email: lead name, a three-line summary, link to the thread.
4. Enqueue `handoff_sla`: no rep reply in 10 business-hour minutes alerts the backup or manager; at 30 minutes the AI resumes and offers times to book.
5. The rep replies from the inbox on the same number in the same thread. One button hands the thread back to the AI.

### 6. Booking and reminders

1. The agent receives up to 6 open slots over the next 7 days, in the lead's time zone: availability minus existing appointments minus Google Calendar busy times.
2. It offers two specific times in the text. When the lead picks one, it returns `book_slot`; code re-checks the slot inside a transaction, creates the appointment and calendar event, and sends a confirmation with address and what to bring.
3. Reminders go out 24 hours and 2 hours before, inside the send window. Confirmations and reschedules are handled by the agent.
4. After the appointment time, the rep gets a prompt to mark showed or no-show. A no-show gets a reschedule message the next morning.
5. `appointment_set`, `showed` and `sold` each enqueue a Conversions API event and a CRM push.

### 7. Outcome feedback

1. Every stage change writes `stage_events`.
2. The worker sends the mapped event to Meta's Conversions API (see integrations) and retries with backoff on failure.
3. Qualified and appointment-set leads are pushed to the customer's CRM by ADF/XML email or webhook.

## The AI agent

The agent is one function, `runAgent(leadId, trigger)`: it builds context, calls Claude once, and returns validated JSON. It never sends anything itself; code checks the output against the guards and then sends, holds for approval, or hands off.

### Context, in this order

1. **System prompt** (versioned in the repo; its version is saved on every `ai_runs` row). The agent texts on behalf of the business as its virtual assistant. Rules: SMS under 300 characters, one question per message, plain language, no emoji unless the lead uses them. If asked whether it's a bot, it says yes. It states facts only from knowledge items and the lead's own data. It never asks for SSN, date of birth, income or credit details. It never promises anything for staff beyond a booked time.
2. **Playbook** (cached): goal, qualification fields with descriptions, warm rule, handoff triggers, tone, never-say list, booking rules.
3. **Knowledge items** (cached).
4. **Live context**: current time in the lead's time zone, whether the business is open, the lead record and form answers, ad name, qualification so far, open slots, cadence step and angle for follow-ups, the last 30 messages.

### Output schema

Force structure with a single tool the model must call, then parse with zod.

```json
{
  "action": "reply | no_reply | handoff | book | stop",
  "message": { "channel": "sms | email", "subject": "string or null", "body": "string" },
  "extracted": { "<qualification_field_key>": "value" },
  "intent": "question | interested | ready_to_book | reschedule | not_interested | bought_elsewhere | wrong_number | opt_out | human_requested | other",
  "warm": true,
  "book_slot_id": "string or null",
  "handoff_reason": "string or null",
  "stage_suggestion": "engaged | qualified | appointment_set | nurture | lost | null",
  "confidence": 0.0,
  "summary": "three lines max, for the rep"
}
```

### Guards (code, after every call)

Any failed guard blocks the send, writes `blocked_reason` on the message, and falls back to a handoff or no send.

- Compliance check passes (consent, opt-out, send window, daily cap); see the compliance section.
- SMS body is 320 characters or fewer; regenerate once if longer.
- Money check: any dollar amount, percentage, APR, "per month" figure or discount must appear word for word in a knowledge item. Otherwise block and hand off.
- No never-say terms and no requests for sensitive data (SSN, social, date of birth, income, credit score).
- `book_slot_id` must be one of the slots offered in this run.
- No more than one unanswered AI message per 2 hours outside the scheduled cadence.
- `approve_before_send` on the playbook puts the message in the inbox approval queue instead of sending.
- Two schema failures in a row hand off with reason `agent_error`.

### Models and reliability

- `claude-sonnet-5-5` writes replies and drafts playbooks. `claude-haiku-5-5` handles the fast inbound classifier, rep summaries and website extraction.
- Prompt caching on the system prompt, playbook and knowledge base, which are identical across a tenant's leads.
- 20-second timeout, one retry. If the model is unavailable, nothing is sent and the job retries. The one exception is first touch: after 45 seconds without a model reply, it sends the playbook's fixed intro template, so speed to lead never depends on an API being up.

### Playbook generator

On onboarding, fetch up to 10 pages from the customer's site (home, about, services, specials, FAQ, contact, hours). Haiku extracts facts; Sonnet drafts the playbook and knowledge items; the owner edits and approves. Nothing goes live unapproved. Dealers can add an inventory feed URL later, synced nightly into knowledge items.

## Compliance rules enforced in code

These rules live in `/lib/compliance`, run when a send is scheduled and again at the moment of sending, and cannot be switched off from the UI. They are engineering defaults, not legal advice: the attorney sign-off in setup comes before `DRY_RUN=false`.

1. **Consent before automated texts.** A lead gets automated SMS only if it has a `consent_records` row from a source whose stored disclosure covers automated texts. No record means email only. The disclosure text is snapshotted per lead, so later edits to a form never rewrite history.
2. **Opt-outs are instant and sticky.** Carrier keywords plus the plain-language classifier. An SMS opt-out stops SMS; "stop contacting me" stops every channel. One confirmation text, then silence. Only the lead texting START or UNSTOP turns SMS back on; the app never re-enables it.
3. **Send window.** Default 9am to 8pm in the lead's local time, configurable but clamped to 8am to 9pm. Unknown time zone uses the stricter of the guesses. Sundays and holidays can be turned off per org.
4. **Frequency cap.** Default maximum of 3 automated messages per lead per 24 hours, replies to the lead's own messages excluded.
5. **State overrides.** A `state_rules` config file holds per-state send windows and caps, applied by the lead's ZIP or area code. Claude Code ships it with the defaults above; the attorney fills in the overrides.
6. **Identification.** The first message names the business. Every text comes from a number registered to that tenant's brand, and texting stays off until its carrier registration is approved.
7. **AI disclosure.** The agent introduces itself as the business's virtual assistant (on by default) and always answers truthfully if asked.
8. **Email law.** Every email carries a one-click unsubscribe header and link plus the business's physical address.
9. **Sensitive data.** The agent never requests SSN, date of birth, income or credit details; credit applications go through the business's own secure link. Data is encrypted at rest, admins use MFA, and access is logged, which also covers dealers' obligations under the FTC Safeguards Rule.
10. **Records.** Every outbound message stores its `ai_run_id`, consent reference and guard results. Consent records and message logs are kept at least 4 years (the TCPA claim window); the attorney confirms the period. Lead deletion requests remove personal data but keep a hashed phone on a do-not-contact list.
11. **Healthcare is blocked.** Orgs whose industry is medical (including plastic surgery and medical spas) cannot go live until signed HIPAA business associate agreements are in place with every vendor that touches lead data (Twilio, Postmark, Anthropic, Supabase, hosting). Onboarding shows this as a blocker.

## Mini CRM screens

Thirteen screens, mobile-first. Reps land on the inbox and mostly live there; owners live on the pipeline and dashboard. Every list updates live through Supabase Realtime.

| Route | Main user | What it does |
| --- | --- | --- |
| `/onboarding` | Owner | The 10-step wizard from "What a human has to connect." Saves per step; each step shows connected, pending approval or blocked, with the fix |
| `/inbox` | Reps | Needs-attention queue: handoffs waiting on a rep (with SLA timer), new replies on paused threads, messages awaiting approval, failed sends. Default page on mobile |
| `/leads` | Owner, reps | Pipeline board by stage (dragging a card writes a stage event) and a table view with filters for source, campaign, ad, rep, stage, AI status and date; search; CSV export |
| `/leads/[id]` | Reps | The thread (SMS, email and notes, AI messages badged), a composer that sends as the rep and pauses the AI, AI controls (pause, resume, stop, hand back), qualification panel (filled and missing fields, score, warm), ad attribution, appointments, stage timeline with Conversions API status |
| `/calendar` | Reps | Week view of appointments; mark showed, no-show or sold; reschedule |
| `/dashboard` | Owner | Median speed to lead, reply rate, qualified rate, appointment rate, show rate, sold; split by form, campaign, ad and rep; AI-handled vs human-handled. Cost per appointment once ad spend is pulled (phase 3) |
| `/settings/playbook` | Owner | Goal, qualification fields, warm rule, handoff triggers, cadence steps, tone, never-say list, approve-before-send; a test chat beside the editor |
| `/settings/knowledge` | Owner | Knowledge items, re-scan website, inventory feed URL |
| `/settings/team` | Owner | Invites, roles, rep mobile numbers, round-robin, backup handler for missed handoffs |
| `/settings/hours` | Owner | Bookable hours, slot length, buffer, notice, blackout dates |
| `/settings/integrations` | Owner | Status cards for Meta, phone number, email, calendar, CRM push, outbound webhooks; reconnect buttons; last error |
| `/simulator` | Everyone | Create a fake lead and chat as them in a phone mockup; in dry-run, an "advance 1 day" button fast-forwards the cadence |
| `/admin` | Platform owner | All orgs, health (failed jobs, webhook errors, opt-out and block rates), create orgs for managed onboarding, audited impersonation |

**Notifications:** rep SMS and email for handoffs and SLA misses; a 6pm daily email to the owner with new leads, appointments set, shows and any handoff still waiting.

## Integration details

Six integrations, each in its own folder under `/lib/integrations` with a status check the settings page can call. Confirm endpoint versions, scopes and payload fields against each provider's current docs before coding.

### Meta lead ads (native, phase 3)

- Facebook Login for Business with a configuration ID. Request the lead retrieval and page permissions Meta currently requires for lead ads webhooks (at the time of writing these include `leads_retrieval`, `pages_show_list`, `pages_read_engagement` and `pages_manage_metadata`).
- Exchange for a long-lived token, list the user's Pages, store Page tokens encrypted, list `leadgen_forms` so the owner picks which forms to watch.
- Subscribe the app to each Page's `leadgen` field. Webhook: answer the GET verification with `META_WEBHOOK_VERIFY_TOKEN`; verify `X-Hub-Signature-256` on every POST with the app secret.
- On each event, fetch the lead by `leadgen_id` with field data, form, ad, ad set and campaign ids and names.
- Backfill the last 7 days on connect, and poll each form every 15 minutes as a safety net for missed webhooks.
- Common blocker: the Page's Leads Access Manager can deny CRM access. The wizard checks for it and explains the fix.

### Zapier bridge (phase 1)

`POST /api/intake/zapier/<intake_key>` with the Meta lead ID, form ID, campaign and ad names, name, phone, email and all form answers. Keeping the Meta lead ID means Conversions API feedback works even before native intake.

### Meta Conversions API (phase 3)

- The wizard asks for the dataset (pixel) tied to the ad account; events go to its `/events` endpoint.
- One event per stage change: `event_name` is the stage (`qualified`, `appointment_set`, `showed`, `sold`), `action_source` is `system_generated`, `user_data.lead_id` is the Meta lead ID, and `custom_data` carries `event_source: crm` and `lead_event_source` set to the app name.
- Retry with backoff; show status per lead in its timeline. The owner then maps stages in Events Manager and switches campaigns to the conversion leads goal.

### Twilio

- Phase 1: one number per pilot org in the platform's Twilio account, registered by hand. A Messaging Service per org with Advanced Opt-Out on; inbound to `/api/webhooks/twilio/sms`, status callbacks to `/api/webhooks/twilio/status`; verify `X-Twilio-Signature`.
- Phase 5: a subaccount per org, number search and purchase by area code through the API, and carrier registration through the Trust Hub API (customer profile, brand, campaign) with status polling. Texting turns on only when the campaign is approved.
- Rep alerts come from a separate platform alert number so alerts never land in a lead thread.

### Postmark email

- Send as the business name from `<org-slug>@mail.<appdomain>` with Reply-To `lead-<token>@<inbound domain>`. The inbound webhook matches the token to the lead and uses the stripped reply text.
- Put cadence emails on the stream type Postmark requires for marketing-style mail; keep confirmations and reminders on the transactional stream.
- Optional custom domain: show the DKIM and Return-Path records from Postmark's domain API and poll for verification.

### Google Calendar

OAuth per rep for events and free/busy. Free/busy feeds slot calculation; booking inserts an event with the lead's name, phone and thread link; reschedules and cancels update or delete it.

### CRM push

- **ADF/XML email:** build an ADF 1.0 document (customer contact, vehicle or service of interest, provider name, comments with the AI summary, appointment time and thread link) and email it to the CRM's lead address on `qualified` and `appointment_set`. Nearly every dealer CRM accepts this.
- **Webhooks:** signed JSON (HMAC-SHA256 header) for `lead.created`, `lead.qualified`, `appointment.set`, `appointment.showed`, `lead.opted_out`; retries for 24 hours.
- **Zapier app** (phase 5): triggers built on the same events, so any CRM can connect without custom code.

## Testing, simulator and dry-run

Nothing reaches a real person until the rules pass unit tests, the agent passes its eval set at 90% or better, and a pilot owner has reviewed 20 simulated conversations.

- **Dry-run:** every provider sits behind a `Sender` interface with a real and a fake implementation. With `DRY_RUN=true`, the fake writes the message with a `dry_run` flag and shows it in the simulator.
- **Injectable clock:** all code reads time through `now()`, so tests and the simulator's "advance 1 day" button can move time for cadence and reminders.
- **Unit tests (Vitest):** send windows across time zones and daylight saving, frequency caps, opt-out keywords, consent gating, dedupe, slot calculation (availability minus busy times minus appointments, minimum notice), cadence scheduling and cancellation, the money guard, the ADF builder, and webhook signature checks for Meta, Twilio and Postmark.
- **Agent evals:** `/tests/agent-evals/*.yaml`, at least 40 scripted conversations, each with a lead profile, the messages so far, and expectations (action, intent, warm, phrases that must not appear, guard outcome). `npm run evals` runs them against the real model; a prompt change ships only at 90% or better. Required cases: price asked with no price in the knowledge base (hand off), "wrong number" (stop), "stop texting me" (opt-out), ready to book (offers two times), picks a time (books), "are you a bot?" (honest yes), trade-in details (extracted), bought elsewhere (lost), angry lead (hand off), a lead writing in Spanish (replies in Spanish).
- **End-to-end (Playwright):** the onboarding wizard against mocked providers, inbox take-over and hand-back, pipeline drag.
- **Seed data:** `npm run seed` creates a demo dealership with a playbook, knowledge base, 25 leads across stages and a week of appointments.
- **Pilot go-live checklist:** attorney sign-off, carrier registration approved, consent text verified on every connected form, 20 simulator conversations reviewed by the owner, approve-before-send on for the first two weeks.

## Build phases

Six phases; the first pilot goes live after phase 2 on Zapier intake, while Meta app review and carrier registration run in the background. Each phase is done only when every box below it is checked.

### Phase 0: Foundation

Repo, Next.js app, Supabase migrations for every table with RLS, auth, orgs and memberships, platform admin, the `Sender` interface with dry-run, injectable clock, worker loop, seed data, CI, Railway staging.

- [ ] RLS test: a user in org A cannot read or write any org B row in any table
- [ ] With two workers running, each due job runs exactly once
- [ ] Seed creates the demo org; staging deploys from `main`

### Phase 1: Text agent MVP

Zapier, manual and CSV intake; normalization, dedupe, consent; Twilio send and receive; Postmark on the shared domain; opt-outs, send windows, caps; the agent with guards and evals; first touch, conversation loop, cadence; inbox, lead detail, take-over, approve-before-send; simulator.

- [ ] A Zapier test lead gets its first SMS in under 60 seconds
- [ ] A lead outside the window gets email now and SMS when the window opens
- [ ] "STOP" and "don't text me" both end all future SMS, with one confirmation
- [ ] A rep reply pauses the AI; hand-back resumes the cadence
- [ ] Agent evals pass at 90% or better
- [ ] 30 simulated days produce exactly the scheduled touches, none outside the window

### Phase 2: Booking, handoff, CRM push

Availability, slots, booking, reminders, showed and no-show; handoff triggers, rep alerts, SLA escalation; pipeline board; dashboard v1; daily owner email; ADF/XML and webhook CRM push.

- [ ] Two simultaneous bookings of one slot: exactly one succeeds
- [ ] 24-hour and 2-hour reminders respect send windows
- [ ] Handoff alert reaches the rep within 30 seconds; escalation fires at 10 minutes
- [ ] ADF email validates and lands in a test CRM inbox
- [ ] Pilot go-live checklist complete (see testing section), then launch the first pilot

### Phase 3: Native Meta and the feedback loop

Facebook Login, Page and form selection, `leadgen` webhooks, backfill and polling, Conversions API stage events, ad spend pull for cost per appointment.

- [ ] A lead from Meta's Lead Ads Testing Tool arrives by webhook and gets first touch
- [ ] Stage events appear in Events Manager test events
- [ ] Dashboard shows cost per appointment by campaign

### Phase 4: Email domains, calendars, inventory

Custom sending domains, Google Calendar OAuth with free/busy, inventory feed sync into knowledge items.

- [ ] Booking skips a rep's Google busy time and creates the event on their calendar
- [ ] A custom domain verifies and replies route back to the right lead

### Phase 5: Self-serve and resale

The full onboarding wizard with Twilio subaccounts, number purchase and Trust Hub registration; the playbook generator; Stripe billing; the Zapier app; an agency tier with logo and subdomain so other media buyers can resell it.

- [ ] A new business finishes the wizard in under 30 minutes on staging with mocked approvals
- [ ] An active Stripe subscription is required to go live
- [ ] The Zapier app's triggers fire for all webhook events

## Pilot playbook: BMW of Elmhurst pre-orders

The first live account runs the pre-order lead forms for the new i3, iX3 and X5 against the dealer's goal of 30 orders. Claude Code ships this as a seed file at `/supabase/seed/playbooks/bmw-preorder.yaml`; the open questions below must be answered by the dealer before go-live.

```yaml
name: BMW pre-order reservations
goal: appointment
goal_detail: Book a showroom visit or a call with a product specialist to configure and reserve
qualification_fields:
  model_interest: { label: "Model", options: [i3, iX3, X5], required: true }
  configuration: { label: "Trim, color or packages wanted" }
  timeline: { label: "When they want to decide or take delivery", required: true }
  payment_type: { label: "Cash, finance or lease", options: [cash, finance, lease] }
  trade_in: { label: "Trade-in year, make, model, miles" }
  current_bmw_owner: { label: "Currently drives a BMW" }
warm_rule: "model_interest AND timeline within 90 days AND (payment_type OR trade_in)"
handoff_triggers:
  - asks for a price, payment, allocation date or deposit term not in knowledge
  - wants to place the reservation now
  - asks for a person
  - complaint or frustration
cadence: default
send_window: { start: "09:00", end: "20:00", sundays: false }
tone: "Premium, concise, warm. No hype. First name only. One question per text."
never_say:
  - guaranteed delivery date
  - lowest price
  - best deal
booking: { kinds: [in_person, call], slot_minutes: 45, min_notice_minutes: 120, days_ahead: 7 }
approve_before_send: true   # first two weeks
intro_template: "Hi {first_name}, this is the virtual assistant at BMW of Elmhurst. Thanks for your interest in the new {model_interest}. Are you focused on timing, configuration or pricing right now? Reply STOP to opt out."
```

**Open questions for the dealer (knowledge items)**

- [ ] Reservation deposit amount and whether it's refundable
- [ ] Expected arrival windows by model, and how firm they are
- [ ] Configurations and packages open for pre-order
- [ ] Current incentives or loyalty offers allowed in writing
- [ ] Showroom hours, address, and product specialists' names and mobile numbers for handoff
- [ ] Secure credit application link
- [ ] Whether any pricing may be quoted by text, or all pricing goes to a rep
- [ ] SMS consent disclosure on each pre-order lead form
- [ ] CRM name and its ADF lead intake address

**How to measure it:** split leads 50/50 by lead ID between the agent and the dealer's usual process for 4 weeks or 100 leads per side. Compare reply rate, appointment rate, show rate and orders.

## Environment variables and deployment

One repo deploys as two Railway services, `web` and `worker`, in staging and production environments. Only a human flips production to `DRY_RUN=false`.

```
# App
APP_URL=
DRY_RUN=true
ENCRYPTION_KEY=                 # 32 bytes, base64
WORKER_POLL_SECONDS=15

# Supabase
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Anthropic
ANTHROPIC_API_KEY=
AGENT_MODEL=claude-sonnet-5-5
FAST_MODEL=claude-haiku-5-5

# Twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_ALERT_NUMBER=            # platform number for rep alerts

# Postmark
POSTMARK_SERVER_TOKEN=
POSTMARK_SENDING_DOMAIN=
POSTMARK_INBOUND_DOMAIN=
POSTMARK_INBOUND_WEBHOOK_SECRET=

# Meta
META_APP_ID=
META_APP_SECRET=
META_LOGIN_CONFIG_ID=
META_WEBHOOK_VERIFY_TOKEN=
META_GRAPH_VERSION=

# Google
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Stripe (phase 5)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# Monitoring
SENTRY_DSN=
```

**Webhook URLs to register:** `/api/webhooks/meta`, `/api/webhooks/twilio/sms`, `/api/webhooks/twilio/status`, `/api/webhooks/postmark/inbound`, `/api/intake/zapier/:intake_key`, `/api/webhooks/stripe`.

**Deploy rules**

- CI runs unit tests, agent evals (on prompt changes) and Supabase migrations before each deploy.
- `/api/health` checks the database, the worker heartbeat (last poll under 60 seconds) and provider status. A heartbeat older than 2 minutes or a spike in failed jobs alerts the platform owner by text and Sentry.
- Production has daily backups and point-in-time recovery turned on in Supabase.
