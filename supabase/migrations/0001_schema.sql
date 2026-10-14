-- Leadline core schema. Every tenant table carries org_id; RLS lives in 0002_rls.sql.
create extension if not exists pgcrypto;

create type org_status as enum ('onboarding', 'live', 'paused');
create type member_role as enum ('owner', 'admin', 'rep');
create type integration_kind as enum ('meta', 'twilio', 'postmark_domain', 'google_calendar', 'crm_webhook', 'adf_email', 'zapier', 'capi');
create type integration_status as enum ('not_connected', 'pending', 'connected', 'error', 'blocked');
create type source_kind as enum ('meta_form', 'zapier', 'webhook', 'csv', 'manual');
create type playbook_goal as enum ('appointment', 'call', 'quote', 'reservation');
create type knowledge_kind as enum ('service', 'faq', 'policy', 'offer', 'inventory', 'location');
create type lead_stage as enum ('new', 'contacted', 'engaged', 'qualified', 'appointment_set', 'showed', 'sold', 'nurture', 'lost');
create type ai_status as enum ('active', 'paused', 'stopped');
create type msg_channel as enum ('sms', 'email', 'note', 'system');
create type msg_direction as enum ('inbound', 'outbound', 'internal');
create type msg_author as enum ('ai', 'user', 'lead', 'system');
create type msg_status as enum ('pending_approval', 'queued', 'sent', 'delivered', 'failed', 'blocked', 'received');
create type appt_kind as enum ('in_person', 'call', 'video');
create type appt_status as enum ('booked', 'confirmed', 'showed', 'no_show', 'canceled');
create type job_kind as enum ('first_touch', 'followup', 'reminder', 'handoff_sla', 'capi_event', 'crm_push', 'webhook_out', 'agent_reply', 'scheduled_send', 'appointment_check', 'daily_digest', 'meta_poll');
create type job_status as enum ('queued', 'running', 'done', 'failed', 'canceled');
create type capi_status as enum ('pending', 'sent', 'failed', 'skipped');

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  industry text not null default 'automotive',
  timezone text not null default 'America/Chicago',
  website_url text,
  address text,
  phone text,
  intake_key text not null unique default encode(gen_random_bytes(18), 'hex'),
  status org_status not null default 'onboarding',
  -- compliance switches (see lib/compliance)
  texting_enabled boolean not null default false,     -- flips on when carrier registration is approved
  send_sundays boolean not null default true,
  send_holidays boolean not null default false,
  hipaa_baa_confirmed_at timestamptz,
  -- messaging identity
  sms_from_number text,                               -- E.164 number registered to this tenant
  twilio_messaging_service_sid text,
  -- routing
  assignment_mode text not null default 'round_robin' check (assignment_mode in ('round_robin', 'single_owner')),
  default_owner_user_id uuid,
  backup_user_id uuid,
  rr_cursor integer not null default 0,
  -- feedback loop
  capi_dataset_id text,
  -- 50/50 measurement split (pilot): share of leads the agent works, 0-100
  agent_split_percent integer not null default 100 check (agent_split_percent between 0 and 100),
  onboarding_progress jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table platform_admins (
  user_id uuid primary key,
  created_at timestamptz not null default now()
);

create table memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null,
  role member_role not null default 'rep',
  display_name text not null,
  email text,
  mobile_phone text,
  notify_sms boolean not null default true,
  notify_email boolean not null default true,
  round_robin_weight integer not null default 1 check (round_robin_weight >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create index on memberships (user_id);

create table integrations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  kind integration_kind not null,
  user_id uuid,                                       -- per-rep integrations (google_calendar)
  status integration_status not null default 'not_connected',
  config jsonb not null default '{}',
  secret_enc text,                                    -- AES-GCM, lib/crypto.ts
  last_error text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create unique index integrations_org_kind_user on integrations (org_id, kind, coalesce(user_id, '00000000-0000-0000-0000-000000000000'));

create table playbooks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  version integer not null default 1,
  goal playbook_goal not null default 'appointment',
  goal_detail text,
  qualification_fields jsonb not null default '{}',   -- { key: { label, options?, required? } }
  warm_rule text,
  handoff_triggers jsonb not null default '[]',
  cadence jsonb not null default '"default"',
  send_window jsonb not null default '{"start":"09:00","end":"20:00","sundays":true}',
  tone text,
  never_say jsonb not null default '[]',
  booking jsonb not null default '{}',
  intro_template text not null default 'Hi {first_name}, this is the virtual assistant at {business_name}. Thanks for reaching out. What can I help you with? Reply STOP to opt out.',
  bridge_message_allowed boolean not null default true,
  max_touches integer not null default 14,
  approve_before_send boolean not null default true,
  approved_at timestamptz,
  approved_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table lead_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  kind source_kind not null,
  name text not null,
  meta_page_id text,
  meta_form_id text,
  field_mapping jsonb not null default '{}',          -- form question key -> qualification field key
  consent_text text,
  consent_covers_automated boolean not null default false,
  consent_verified_at timestamptz,
  playbook_id uuid references playbooks(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index lead_sources_meta_form on lead_sources (org_id, meta_form_id) where meta_form_id is not null;

create table knowledge_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  kind knowledge_kind not null,
  title text not null,
  body text not null,
  source_url text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table leads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  source_id uuid references lead_sources(id) on delete set null,
  meta_lead_id text,
  meta_form_id text,
  campaign_id text, campaign_name text,
  adset_id text, adset_name text,
  ad_id text, ad_name text,
  first_name text,
  last_name text,
  full_name text,
  phone_e164 text,
  email text,
  zip text,
  us_state text,
  timezone text,
  timezone_candidates jsonb,                          -- when the zone is a guess: all candidates; compliance uses the strictest
  answers jsonb not null default '{}',
  stage lead_stage not null default 'new',
  score integer not null default 0,
  warm boolean not null default false,
  qualification jsonb not null default '{}',
  summary text,
  assigned_user_id uuid,
  ai_status ai_status not null default 'active',
  ai_paused_reason text,
  split_arm text not null default 'agent' check (split_arm in ('agent', 'control')),
  cadence_kind text not null default 'no_reply' check (cadence_kind in ('no_reply', 'went_quiet')),
  cadence_step integer not null default 0,
  touch_count integer not null default 0,
  next_action_at timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  first_outbound_at timestamptz,
  handoff_at timestamptz,
  low_confidence_streak integer not null default 0,
  schema_failure_streak integer not null default 0,
  opted_out_sms_at timestamptz,
  opted_out_email_at timestamptz,
  email_reply_token text not null unique default encode(gen_random_bytes(12), 'hex'),
  unsubscribe_token text not null unique default encode(gen_random_bytes(16), 'hex'),
  resubmitted_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index leads_org_meta_lead on leads (org_id, meta_lead_id) where meta_lead_id is not null;
create index leads_org_phone on leads (org_id, phone_e164, created_at desc);
create index leads_org_stage on leads (org_id, stage);
create index leads_assigned on leads (org_id, assigned_user_id);

create table ai_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  lead_id uuid references leads(id) on delete cascade,
  trigger text not null,
  model text not null,
  prompt_version text not null,
  output jsonb,
  guard_result jsonb,
  error text,
  tokens_in integer,
  tokens_out integer,
  cache_read_tokens integer,
  latency_ms integer,
  created_at timestamptz not null default now()
);
create index on ai_runs (lead_id, created_at desc);

create table consent_records (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  lead_id uuid references leads(id) on delete set null,
  channel msg_channel not null,
  source text not null,
  disclosure_text text not null,
  covers_automated boolean not null default false,
  captured_at timestamptz not null,
  evidence jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index on consent_records (lead_id);

create table messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  channel msg_channel not null,
  direction msg_direction not null,
  author msg_author not null,
  author_user_id uuid,
  body text not null,
  subject text,
  status msg_status not null,
  blocked_reason text,
  provider_message_id text,
  ai_run_id uuid references ai_runs(id) on delete set null,
  consent_record_id uuid references consent_records(id) on delete set null,
  guard_result jsonb,
  is_automated boolean not null default false,        -- counts toward the frequency cap
  is_reply boolean not null default false,            -- answering the lead's own message (excluded from the cap)
  purpose text,                                       -- first_touch, followup, reply, bridge, confirmation, reminder, opt_out_confirmation, rep
  to_address text,
  from_address text,
  dry_run boolean not null default false,
  error text,
  sent_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);
create index messages_lead_created on messages (lead_id, created_at);
create index messages_org_status on messages (org_id, status);
create unique index messages_provider_id on messages (provider_message_id) where provider_message_id is not null;

create table appointments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  user_id uuid,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  kind appt_kind not null default 'in_person',
  status appt_status not null default 'booked',
  google_event_id text,
  reminder_24h_sent_at timestamptz,
  reminder_2h_sent_at timestamptz,
  outcome_prompted_at timestamptz,
  created_by text not null default 'ai',
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index on appointments (org_id, starts_at);
-- One live booking per rep per start time. The booking transaction also locks, this is the backstop.
create unique index appointments_no_double_book on appointments (org_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'), starts_at)
  where status in ('booked', 'confirmed');

create table availability (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid,                                       -- null = whole org
  weekly_hours jsonb not null default '{"mon":[["09:00","18:00"]],"tue":[["09:00","18:00"]],"wed":[["09:00","18:00"]],"thu":[["09:00","18:00"]],"fri":[["09:00","18:00"]],"sat":[["10:00","16:00"]],"sun":[]}',
  slot_minutes integer not null default 45,
  buffer_minutes integer not null default 15,
  min_notice_minutes integer not null default 120,
  max_days_ahead integer not null default 7,
  blackout_dates jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create unique index availability_org_user on availability (org_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'));

create table jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  lead_id uuid references leads(id) on delete cascade,
  kind job_kind not null,
  run_at timestamptz not null,
  status job_status not null default 'queued',
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  last_error text,
  payload jsonb not null default '{}',
  dedupe_key text,
  locked_at timestamptz,
  locked_by text,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create index jobs_due on jobs (run_at) where status = 'queued';
create index jobs_lead on jobs (lead_id, kind, status);
create unique index jobs_dedupe on jobs (dedupe_key) where dedupe_key is not null and status in ('queued', 'running');

create table stage_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  from_stage lead_stage,
  to_stage lead_stage not null,
  actor text not null,
  created_at timestamptz not null default now()
);
create index on stage_events (org_id, created_at);
create index on stage_events (lead_id, created_at);

create table capi_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  stage_event_id uuid references stage_events(id) on delete set null,
  event_name text not null,
  event_time timestamptz not null,
  status capi_status not null default 'pending',
  attempts integer not null default 0,
  response jsonb,
  created_at timestamptz not null default now()
);
create index on capi_events (lead_id);

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) on delete cascade,
  actor text not null,
  action text not null,
  entity text not null,
  entity_id text,
  diff jsonb,
  created_at timestamptz not null default now()
);
create index on audit_log (org_id, created_at desc);

-- Hashed phones of leads whose data was deleted; checked at intake so they are never contacted again.
create table do_not_contact (
  org_id uuid not null references organizations(id) on delete cascade,
  phone_hash text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  primary key (org_id, phone_hash)
);

-- Ad spend pulled from Meta (phase 3) for cost per appointment.
create table ad_spend_daily (
  org_id uuid not null references organizations(id) on delete cascade,
  day date not null,
  campaign_id text not null,
  campaign_name text,
  spend numeric(12, 2) not null default 0,
  primary key (org_id, day, campaign_id)
);

-- Platform-level singletons: worker heartbeat, dry-run simulation clock offset.
create table platform_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Consent records are immutable proof: no updates or deletes, by anyone, ever.
create or replace function forbid_consent_mutation() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.lead_id is not null and new.lead_id is null
     and old.disclosure_text = new.disclosure_text and old.captured_at = new.captured_at then
    return new; -- the FK's ON DELETE SET NULL when a lead row is hard-deleted
  end if;
  raise exception 'consent_records are immutable';
end $$;
create trigger consent_records_immutable before update or delete on consent_records
  for each row execute function forbid_consent_mutation();

create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger leads_updated before update on leads for each row execute function touch_updated_at();
create trigger playbooks_updated before update on playbooks for each row execute function touch_updated_at();
create trigger knowledge_updated before update on knowledge_items for each row execute function touch_updated_at();
