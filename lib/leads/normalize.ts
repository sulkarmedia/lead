// Normalization: phone → E.164, lowercase email, split names, map form answers to playbook fields.
import { parsePhoneNumberFromString } from "libphonenumber-js";
import type { QualificationField } from "../db/types";

export function normalizePhone(raw: unknown, defaultCountry: "US" = "US"): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const s = String(raw).trim();
  if (!s) return null;
  const p = parsePhoneNumberFromString(s, defaultCountry);
  if (!p || !p.isValid()) return null;
  return p.number;
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

const cap = (s: string) => s.replace(/\b([a-zà-ÿ])([a-zà-ÿ']*)/gi, (_, a: string, b: string) => a.toUpperCase() + b.toLowerCase());

export function splitName(full?: string | null, first?: string | null, last?: string | null) {
  let f = first?.trim() || null;
  let l = last?.trim() || null;
  if (!f && full?.trim()) {
    const parts = full.trim().split(/\s+/);
    f = parts[0];
    l = l ?? (parts.slice(1).join(" ") || null);
  }
  if (f && f === f.toUpperCase() || f && f === f.toLowerCase()) f = cap(f);
  if (l && (l === l.toUpperCase() || l === l.toLowerCase())) l = cap(l);
  const fullName = [f, l].filter(Boolean).join(" ") || full?.trim() || null;
  return { first_name: f, last_name: l, full_name: fullName };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/**
 * Map form answers onto qualification fields. Uses the source's explicit mapping first, then
 * matches answer keys to field keys/labels by slug. Values for option fields are matched
 * case-insensitively to an option when possible.
 */
export function mapAnswers(
  answers: Record<string, unknown>,
  fields: Record<string, QualificationField>,
  mapping: Record<string, string> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fieldBySlug = new Map<string, string>();
  for (const [key, f] of Object.entries(fields)) {
    fieldBySlug.set(slug(key), key);
    fieldBySlug.set(slug(f.label), key);
  }
  for (const [rawKey, rawVal] of Object.entries(answers)) {
    if (rawVal === null || rawVal === undefined || rawVal === "") continue;
    const target = mapping[rawKey] ?? fieldBySlug.get(slug(rawKey));
    if (!target || !fields[target]) continue;
    let val: unknown = Array.isArray(rawVal) ? rawVal.join(", ") : rawVal;
    const opts = fields[target].options;
    if (opts && typeof val === "string") {
      const v = val.trim().toLowerCase();
      const hit = opts.find((o) => o.toLowerCase() === v) ?? opts.find((o) => v.includes(o.toLowerCase()));
      if (hit) val = hit;
    }
    out[target] = val;
  }
  return out;
}
