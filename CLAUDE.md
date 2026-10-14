# Leadline — AI lead agent + mini CRM

Source of truth: `docs/SPEC.md` (the build spec). This file holds the stack, the hard rules, and where the build stands.

## Current phase

**Phases 0–2 built and tested locally; 3–5 partly built.** Blocked on HUMAN STEPs (docs/HUMAN_STEPS.md): deploy, API keys, real-model eval gate, carrier registration, Meta review, attorney sign-off. Details in docs/STATUS.md.

## Stack (pinned — don't swap without writing the reason here)

- Next.js 15 (App Router) + Tailwind 4, hand-rolled shadcn-style components in `app/_components/ui`.
- Supabase Postgres + Supabase Auth (magic link + Google). Realtime for live inbox.
- Worker: plain Node process (`worker/index.ts`, run with `tsx`) polling `jobs` every `WORKER_POLL_SECONDS` with `FOR UPDATE SKIP LOCKED`.
- Twilio (SMS), Postmark (email), Anthropic API (`@anthropic-ai/sdk`), zod for every payload.
- Railway: `web` (`npm run build && npm start`) and `worker` (`npm run worker`) services.
- Tests: Vitest (unit + DB tests against a local Postgres), Playwright (e2e).

### Deviations from the spec, with reasons

- **Database access goes through `pg`, not supabase-js.** The worker needs `FOR UPDATE SKIP LOCKED`, which PostgREST can't express. User-facing requests also use `pg`, but inside `withUserDb()` (`lib/db/index.ts`), which runs `set local role authenticated` + `request.jwt.claims` so Postgres RLS applies exactly as it would through PostgREST. Supabase Auth (via `@supabase/ssr`) still owns login and sessions. Needs `DATABASE_URL` (Supabase pooler, session mode) in addition to the spec's Supabase vars.
- **Agent structure is forced with structured outputs (`output_config.format` + zod), not a forced tool call.** `claude-sonnet-5-5` rejects `tool_choice: {type: "tool"}` with a 400. Structured outputs give the same guarantee; zod still parses the result.
- **Twilio and Postmark are called with `fetch`, not their SDKs.** Two endpoints each; keeps the `Sender` fakes trivial and the signature checks are our own, unit-tested code.
- **Local dev/test DB is plain Postgres 16** (`npm run db:local`) with `supabase/local-shim.sql` providing the `auth` schema, `auth.uid()` and the `anon`/`authenticated`/`service_role` roles. The shim is never applied to Supabase.
- **`DEV_LOGIN=true`** (refused when `NODE_ENV=production`) lets local dev and Playwright sign in as a seeded user without Supabase Auth.

## Hard rules (enforced in code — `lib/compliance`; never weaken to make the agent "smarter")

1. Automated SMS only with a `consent_records` row (channel sms) whose source disclosure covers automated texts. No record → email only. Disclosure is snapshotted per lead.
2. Opt-outs are instant and sticky. Carrier keywords + plain-language classifier. SMS opt-out stops SMS; "stop contacting me" stops all channels. One confirmation, then silence. Only the lead texting START/UNSTOP re-enables SMS; the app never does.
3. Send window default 09:00–20:00 lead-local, configurable but clamped to 08:00–21:00. Unknown time zone → the stricter (intersection) of the guesses. Sundays/holidays can be turned off per org.
4. Max 3 automated messages per lead per rolling 24h; replies to the lead's own inbound messages excluded.
5. `lib/compliance/state-rules.ts` per-state overrides (attorney fills in).
6. First message names the business. Texting stays off until the tenant's carrier registration is approved (`organizations.texting_enabled`).
7. Agent introduces itself as the business's virtual assistant and answers truthfully if asked whether it's a bot.
8. Every email: one-click List-Unsubscribe header + link + business physical address.
9. Agent never requests SSN, DOB, income or credit details (guard blocks it).
10. Every outbound message stores `ai_run_id`, consent reference and guard results. Consent records are immutable (DB trigger). Lead deletion keeps a hashed phone on `do_not_contact`.
11. Medical industries cannot go live without BAAs (`organizations.hipaa_baa_confirmed_at`).
- Compliance runs when a send is scheduled AND again at the moment of sending (`lib/messaging/send.ts`).
- `DRY_RUN=true` until a human flips it. In dry-run, the fake `Sender` writes to `messages` (dry_run=true) and nothing leaves the building.
- All time reads go through `now()` from `lib/clock.ts`. Never `new Date()` / `Date.now()` in business logic.
- The agent returns JSON; plain code decides what is sent. The agent never sends anything itself.
- Webhooks/worker use the service connection and set `org_id` explicitly on every write.

## Layout

```
app/                 Next.js routes, UI, API routes (webhooks, intake)
worker/              job loop: cadence, reminders, CAPI, CRM push
lib/agent            context builder, prompts, output schema, guards
lib/compliance       consent, send windows, opt-out, rate limits, state rules
lib/integrations     meta, capi, twilio, postmark, google, adf, webhooks
lib/messaging        Sender interface (real + dry-run), send pipeline
lib/leads            intake, normalization, dedupe, stages, assignment
supabase/migrations  schema + RLS policies
tests/               unit, db, agent-evals, e2e
```

## Commands

- `npm run db:local` — start local Postgres (port 54329) · `npm run db:migrate` — apply migrations to `DATABASE_URL`
- `npm test` — unit + DB tests (needs `npm run db:local`) · `npm run typecheck`
- `npm run seed` — demo dealership · `npm run dev` / `npm run worker`
- `npm run evals` — agent evals against the real model (needs `ANTHROPIC_API_KEY`; gate is 90%); `--offline` checks the harness
- `npx playwright test` — e2e on its own DB (`leadline_e2e`) and port 3201

## Phase status

See `docs/STATUS.md` for the checklist with what is verified and what is waiting on a HUMAN STEP.
