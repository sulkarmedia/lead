import { NextResponse } from "next/server";
export const json = (body: unknown, status = 200) => NextResponse.json(body, { status });
/** The externally visible URL of this request (Twilio signs the public URL, not the proxy's). */
export function publicUrl(req: Request): string {
  const u = new URL(req.url);
  const app = process.env.APP_URL;
  if (!app) return u.toString();
  const base = new URL(app);
  return `${base.origin}${u.pathname}${u.search}`;
}
