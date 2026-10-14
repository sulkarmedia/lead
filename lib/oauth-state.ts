// Signed OAuth state: org + user + expiry, HMAC'd with ENCRYPTION_KEY so callbacks can't be forged.
import { createHmac } from "node:crypto";
import { safeEqual } from "./crypto";

const key = () => process.env.ENCRYPTION_KEY ?? "";
export function signState(data: { orgId: string; userId: string }, ttlMs = 15 * 60_000) {
  const body = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + ttlMs })).toString("base64url");
  return `${body}.${createHmac("sha256", key()).update(body).digest("base64url")}`;
}
export function verifyState(state: string | null): { orgId: string; userId: string } | null {
  if (!state) return null;
  const [body, sig] = state.split(".");
  if (!body || !sig || !safeEqual(sig, createHmac("sha256", key()).update(body).digest("base64url"))) return null;
  const d = JSON.parse(Buffer.from(body, "base64url").toString());
  return d.exp > Date.now() ? { orgId: d.orgId, userId: d.userId } : null;
}
