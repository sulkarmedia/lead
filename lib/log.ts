// Structured JSON logs. Every send attempt and webhook is logged with its tenant (org_id).
type Fields = Record<string, unknown>;

function emit(level: "info" | "warn" | "error", msg: string, fields: Fields = {}) {
  if (process.env.NODE_ENV === "test" && !process.env.LOG_IN_TESTS) return;
  const line = JSON.stringify({ level, msg, time: new Date().toISOString(), ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, f?: Fields) => emit("info", msg, f),
  warn: (msg: string, f?: Fields) => emit("warn", msg, f),
  error: (msg: string, f?: Fields) => {
    emit("error", msg, f);
    reportError(msg, f);
  },
};

// Sentry hook: posts to the Sentry store endpoint when SENTRY_DSN is set (no SDK dependency).
function reportError(msg: string, f?: Fields) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace("/", "");
    const url = `${u.protocol}//${u.host}/api/${projectId}/store/?sentry_key=${u.username}&sentry_version=7`;
    void fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: msg, level: "error", extra: f, platform: "node", timestamp: Date.now() / 1000 }),
    }).catch(() => {});
  } catch {
    /* never let error reporting throw */
  }
}
