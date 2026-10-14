# Build status

Last updated 2026-10-14. `DRY_RUN=true` everywhere; nothing has been sent to a real person.

Verified locally: `npm run typecheck` clean · `npm test` 137/137 (unit + DB, local Postgres 16) · `npx playwright test` 8/8 (mobile + desktop) · `npm run build` OK · `npx tsx tests/agent-evals/run.ts --offline` runs all 47 eval cases (harness check only — see Phase 1).

## Phase 0: Foundation — done
- [x] RLS test: a user in org A cannot read or write any org B row in any table (`tests/db/rls.test.ts`)
- [x] With two workers running, each due job runs exactly once (`tests/db/worker.test.ts`, 200 jobs, 4 workers)
- [x] Seed creates the demo org (`npm run seed`)
- [ ] Staging deploys from `main` — needs HUMAN STEPs 1–3 (GitHub repo, Supabase, Railway)

## Phase 1: Text agent MVP — built, real-model eval gate pending
- [x] A Zapier test lead gets its first SMS in under 60 seconds (`tests/db/flows.test.ts`; the intake route runs first touch immediately)
- [x] A lead outside the window gets email now and SMS when the window opens
- [x] "STOP" and "don't text me" both end all future SMS, with one confirmation (none from us when Twilio Advanced Opt-Out already confirmed a carrier keyword)
- [x] A rep reply pauses the AI; hand-back resumes the cadence (DB test + Playwright)
- [ ] Agent evals pass at 90% or better — 47 cases written; needs `ANTHROPIC_API_KEY` (HUMAN STEP 4), then `npm run evals`
- [x] 30 simulated days produce exactly the scheduled touches, none outside the window

## Phase 2: Booking, handoff, CRM push — built
- [x] Two simultaneous bookings of one slot: exactly one succeeds
- [x] 24-hour and 2-hour reminders respect send windows
- [x] Handoff alert reaches the rep within 30 seconds; escalation fires at 10 minutes; AI resumes at 30
- [x] ADF email validates (unit test) — [ ] lands in a test CRM inbox (needs Postmark + a CRM address, HUMAN STEP 6)
- [ ] Pilot go-live checklist (attorney, carrier registration, consent text on every form, 20 reviewed simulator conversations, approve-before-send on for 2 weeks)

## Phase 3: Native Meta and the feedback loop — code built, untested against Meta
- Facebook Login for Business, Page/form selection, `leadgen` subscription, webhook, 7-day backfill, 15-minute poll, Leads Access Manager check (`/connect/meta`), Conversions API events per stage, daily ad-spend pull, cost per appointment on the dashboard.
- [ ] Lead from Meta's Lead Ads Testing Tool arrives by webhook — needs Meta app + review (HUMAN STEP 7)
- [ ] Stage events appear in Events Manager test events — needs a dataset + token (set `test_event_code` in the CAPI integration config)
- [ ] Dashboard shows cost per appointment by campaign — works on seeded spend rows (`tests/db/metrics.test.ts`); needs real spend

## Phase 4: Email domains, calendars, inventory — partial
- Google Calendar OAuth per rep, free/busy in slot calculation, event create/delete on booking/cancel: built, unit-tested with fake busy times; [ ] needs Google OAuth client (HUMAN STEP 8).
- [ ] Custom sending domain: wizard records the request; Postmark domain API (DKIM/Return-Path display + polling) not built yet.
- [ ] Inventory feed: URL is stored; nightly sync into knowledge items not built yet.

## Phase 5: Self-serve and resale — partial
- Onboarding wizard (10 steps, per-step state, go-live blockers incl. HIPAA BAA and Stripe when configured), playbook generator (site fetch → Haiku facts → Sonnet draft → owner approves), Stripe webhook recording subscription status.
- `lib/integrations/twilio-provisioning.ts`: subaccount, number search/purchase, Messaging Service — not wired into the wizard yet.
- [ ] Trust Hub brand/campaign registration via API: not built (twilio.com docs were unreachable from the build sandbox). For now a platform admin registers in the Twilio console and flips "texting enabled" in /admin.
- [ ] Stripe checkout/subscription creation, the Zapier app, agency tier (logo/subdomain): not built.

## Known gaps / decisions to revisit
- Cadence offsets are measured from lead creation (no-reply) or the last inbound message (went-quiet); "+2h, +1d, …" read as absolute offsets.
- The frequency cap (3 per 24h) is counted per channel (SMS and email separately). Rep-typed texts use the hard 08:00–21:00 limits, not the playbook window. Attorney to confirm both.
- `lib/compliance/state-rules.ts` has placeholder FL/OK/MD entries; attorney fills in the real overrides.
- Deletion requests scrub the lead row and keep consent records + message logs for the retention period; attorney to confirm.
- The pipeline-drag e2e test dispatches synthetic drag events (a mouse drag across the scrolling board was flaky); mobile uses the stage select.
- A platform admin with zero orgs gets a redirect loop between /admin and the app layout (only on an empty platform; the seed always creates an org).
- Simulator clock offset is platform-wide (dry-run only).
