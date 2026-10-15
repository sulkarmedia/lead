// Single place that reads process.env. Values are read lazily so tests can override them.
export const env = {
  get appUrl() { return v("APP_URL") ?? "http://localhost:3000"; },
  get appName() { return v("APP_NAME") ?? "Leadline"; },
  /** Anything other than the literal string "false" keeps dry-run on. Only a human flips this. */
  get dryRun() { return process.env.DRY_RUN !== "false"; },
  get databaseUrl() { return required("DATABASE_URL"); },
  get workerPollSeconds() { return Number(v("WORKER_POLL_SECONDS") ?? 15); },
  get anthropicApiKey() { return v("ANTHROPIC_API_KEY"); },
  get agentModel() { return v("AGENT_MODEL") ?? "claude-sonnet-5-5"; },
  get fastModel() { return v("FAST_MODEL") ?? "claude-haiku-5-5"; },
  get twilioAccountSid() { return v("TWILIO_ACCOUNT_SID"); },
  get twilioAuthToken() { return v("TWILIO_AUTH_TOKEN"); },
  get twilioAlertNumber() { return v("TWILIO_ALERT_NUMBER"); },
  get postmarkServerToken() { return v("POSTMARK_SERVER_TOKEN"); },
  get postmarkSendingDomain() { return v("POSTMARK_SENDING_DOMAIN") ?? "mail.example.com"; },
  get postmarkInboundDomain() { return v("POSTMARK_INBOUND_DOMAIN") ?? "inbound.example.com"; },
  get postmarkInboundWebhookSecret() { return v("POSTMARK_INBOUND_WEBHOOK_SECRET"); },
  get metaAppId() { return v("META_APP_ID"); },
  get metaAppSecret() { return v("META_APP_SECRET"); },
  get metaLoginConfigId() { return v("META_LOGIN_CONFIG_ID"); },
  get metaWebhookVerifyToken() { return v("META_WEBHOOK_VERIFY_TOKEN"); },
  get metaGraphVersion() { return v("META_GRAPH_VERSION") ?? "v24.0"; },
  get googleClientId() { return v("GOOGLE_CLIENT_ID"); },
  get googleClientSecret() { return v("GOOGLE_CLIENT_SECRET"); },
  get supabaseUrl() { return v("NEXT_PUBLIC_SUPABASE_URL") ?? v("SUPABASE_URL"); },
  get supabaseServiceRoleKey() { return v("SUPABASE_SERVICE_ROLE_KEY"); },
  get supabaseAnonKey() { return v("NEXT_PUBLIC_SUPABASE_ANON_KEY") ?? v("SUPABASE_ANON_KEY"); },
  get devLogin() { return v("DEV_LOGIN") === "true" && v("NODE_ENV") !== "production"; },
  get stripeSecretKey() { return v("STRIPE_SECRET_KEY"); },
  get sentryDsn() { return v("SENTRY_DSN"); },
};

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** Empty values in .env count as unset, so defaults still apply. */
function v(name: string): string | undefined {
  const x = process.env[name];
  return x === undefined || x.trim() === "" ? undefined : x;
}
