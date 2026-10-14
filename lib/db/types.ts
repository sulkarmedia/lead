// Row types for the tables the app code touches. Kept by hand next to supabase/migrations.
export type LeadStage = "new" | "contacted" | "engaged" | "qualified" | "appointment_set" | "showed" | "sold" | "nurture" | "lost";
export const STAGES: LeadStage[] = ["new", "contacted", "engaged", "qualified", "appointment_set", "showed", "sold", "nurture", "lost"];
export type AiStatus = "active" | "paused" | "stopped";
export type Channel = "sms" | "email" | "note" | "system";
export type MsgStatus = "pending_approval" | "queued" | "sent" | "delivered" | "failed" | "blocked" | "received";
export type JobKind =
  | "first_touch" | "followup" | "reminder" | "handoff_sla" | "capi_event" | "crm_push" | "webhook_out"
  | "agent_reply" | "scheduled_send" | "appointment_check" | "daily_digest" | "meta_poll";

export interface Org {
  id: string;
  name: string;
  slug: string;
  industry: string;
  timezone: string;
  website_url: string | null;
  address: string | null;
  phone: string | null;
  intake_key: string;
  status: "onboarding" | "live" | "paused";
  texting_enabled: boolean;
  send_sundays: boolean;
  send_holidays: boolean;
  hipaa_baa_confirmed_at: Date | null;
  sms_from_number: string | null;
  twilio_messaging_service_sid: string | null;
  assignment_mode: "round_robin" | "single_owner";
  default_owner_user_id: string | null;
  backup_user_id: string | null;
  rr_cursor: number;
  capi_dataset_id: string | null;
  agent_split_percent: number;
  onboarding_progress: Record<string, unknown>;
  created_at: Date;
}

export interface Membership {
  id: string;
  org_id: string;
  user_id: string;
  role: "owner" | "admin" | "rep";
  display_name: string;
  email: string | null;
  mobile_phone: string | null;
  notify_sms: boolean;
  notify_email: boolean;
  round_robin_weight: number;
  active: boolean;
}

export interface QualificationField {
  label: string;
  options?: string[];
  required?: boolean;
  description?: string;
}

export interface CadenceStep {
  after: string;              // e.g. "2h", "1d"
  channel: "sms" | "email" | "both";
  angle: string;
}

export interface Playbook {
  id: string;
  org_id: string;
  name: string;
  version: number;
  goal: "appointment" | "call" | "quote" | "reservation";
  goal_detail: string | null;
  qualification_fields: Record<string, QualificationField>;
  warm_rule: string | null;
  handoff_triggers: string[];
  cadence: "default" | { no_reply?: CadenceStep[]; went_quiet?: CadenceStep[] };
  send_window: { start?: string; end?: string; sundays?: boolean };
  tone: string | null;
  never_say: string[];
  booking: { kinds?: string[]; slot_minutes?: number; min_notice_minutes?: number; days_ahead?: number };
  intro_template: string;
  bridge_message_allowed: boolean;
  max_touches: number;
  approve_before_send: boolean;
  approved_at: Date | null;
}

export interface LeadSource {
  id: string;
  org_id: string;
  kind: "meta_form" | "zapier" | "webhook" | "csv" | "manual";
  name: string;
  meta_page_id: string | null;
  meta_form_id: string | null;
  field_mapping: Record<string, string>;
  consent_text: string | null;
  consent_covers_automated: boolean;
  consent_verified_at: Date | null;
  playbook_id: string | null;
  active: boolean;
}

export interface KnowledgeItem {
  id: string;
  org_id: string;
  kind: string;
  title: string;
  body: string;
  source_url: string | null;
  active: boolean;
}

export interface Lead {
  id: string;
  org_id: string;
  source_id: string | null;
  meta_lead_id: string | null;
  meta_form_id: string | null;
  campaign_id: string | null; campaign_name: string | null;
  adset_id: string | null; adset_name: string | null;
  ad_id: string | null; ad_name: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  phone_e164: string | null;
  email: string | null;
  zip: string | null;
  us_state: string | null;
  timezone: string | null;
  timezone_candidates: string[] | null;
  answers: Record<string, unknown>;
  stage: LeadStage;
  score: number;
  warm: boolean;
  qualification: Record<string, unknown>;
  summary: string | null;
  assigned_user_id: string | null;
  ai_status: AiStatus;
  ai_paused_reason: string | null;
  split_arm: "agent" | "control";
  cadence_kind: "no_reply" | "went_quiet";
  cadence_step: number;
  touch_count: number;
  next_action_at: Date | null;
  last_inbound_at: Date | null;
  last_outbound_at: Date | null;
  first_outbound_at: Date | null;
  handoff_at: Date | null;
  low_confidence_streak: number;
  schema_failure_streak: number;
  opted_out_sms_at: Date | null;
  opted_out_email_at: Date | null;
  email_reply_token: string;
  unsubscribe_token: string;
  resubmitted_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
}

export interface Message {
  id: string;
  org_id: string;
  lead_id: string;
  channel: Channel;
  direction: "inbound" | "outbound" | "internal";
  author: "ai" | "user" | "lead" | "system";
  author_user_id: string | null;
  body: string;
  subject: string | null;
  status: MsgStatus;
  blocked_reason: string | null;
  provider_message_id: string | null;
  ai_run_id: string | null;
  consent_record_id: string | null;
  guard_result: unknown;
  is_automated: boolean;
  is_reply: boolean;
  purpose: string | null;
  to_address: string | null;
  from_address: string | null;
  dry_run: boolean;
  error: string | null;
  sent_at: Date | null;
  created_at: Date;
}

export interface Job {
  id: string;
  org_id: string;
  lead_id: string | null;
  kind: JobKind;
  run_at: Date;
  status: "queued" | "running" | "done" | "failed" | "canceled";
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  payload: Record<string, unknown>;
  dedupe_key: string | null;
}

export interface Appointment {
  id: string;
  org_id: string;
  lead_id: string;
  user_id: string | null;
  starts_at: Date;
  ends_at: Date;
  kind: "in_person" | "call" | "video";
  status: "booked" | "confirmed" | "showed" | "no_show" | "canceled";
  google_event_id: string | null;
  reminder_24h_sent_at: Date | null;
  reminder_2h_sent_at: Date | null;
  outcome_prompted_at: Date | null;
  created_by: string;
}

export interface Availability {
  id: string;
  org_id: string;
  user_id: string | null;
  weekly_hours: Record<string, Array<[string, string]>>;
  slot_minutes: number;
  buffer_minutes: number;
  min_notice_minutes: number;
  max_days_ahead: number;
  blackout_dates: string[];
}
