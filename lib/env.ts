// Single place that reads process.env. Values are read lazily so tests can override them.
export const env = {
  get appUrl() { return process.env.APP_URL ?? "http://localhost:3000"; },
  get appName() { return process.env.APP_NAME ?? "Leadline"; },
  /** Anything other than the literal string "false" keeps dry-run on. Only a human flips this. */
  get dryRun() { return process.env.DRY_RUN !== "false"; },
  get databaseUrl() { return required("DATABASE_URL"); },
  get workerPollSeconds() { return Number(process.env.WORKER_POLL_SECONDS ?? 15); },
  get anthropicApiKey() { return process.env.ANTHROPIC_API_KEY; },
  get agentModel() { return process.env.AGENT_MODEL ?? "claude-sonnet-5-5"; },
  get fastModel() { return process.env.FAST_MODEL ?? "claude-haiku-5-5"; },
  get twilioAccountSid() { return process.env.TWILIO_ACCOUNT_SID; },
  get twilioAuthToken() { return process.env.TWILIO_AUTH_TOKEN; },
  get twilioAlertNumber() { return process.env.TWILIO_ALERT_NUMBER; },
  get postmarkServerToken() { return process.env.POSTMARK_SERVER_TOKEN; },
  get postmarkSendingDomain() { return process.env.POSTMARK_SENDING_DOMAIN ?? "mail.example.com"; },
  get postmarkInboundDomain() { return process.env.POSTMARK_INBOUND_DOMAIN ?? "inbound.example.com"; },
  get postmarkInboundWebhookSecret() { return process.env.POSTMARK_INBOUND_WEBHOOK_SECRET; },
  get metaAppId() { return process.env.META_APP_ID; },
  get metaAppSecret() { return process.env.META_APP_SECRET; },
  get metaLoginConfigId() { return process.env.META_LOGIN_CONFIG_ID; },
  get metaWebhookVerifyToken() { return process.env.META_WEBHOOK_VERIFY_TOKEN; },
  get metaGraphVersion() { return process.env.META_GRAPH_VERSION ?? "v24.0"; },
  get googleClientId() { return process.env.GOOGLE_CLIENT_ID; },
  get googleClientSecret() { return process.env.GOOGLE_CLIENT_SECRET; },
  get supabaseUrl() { return process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL; },
  get supabaseServiceRoleKey() { return process.env.SUPABASE_SERVICE_ROLE_KEY; },
  get supabaseAnonKey() { return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY; },
  get devLogin() { return process.env.DEV_LOGIN === "true" && process.env.NODE_ENV !== "production"; },
  get sentryDsn() { return process.env.SENTRY_DSN; },
};

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
