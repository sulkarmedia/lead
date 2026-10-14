import { NextResponse, type NextRequest } from "next/server";
import { service } from "@/lib/db";
import { exchangeGoogleCode } from "@/lib/integrations/google";
import { verifyState } from "@/lib/oauth-state";
import { log } from "@/lib/log";

export async function GET(req: NextRequest) {
  const st = verifyState(req.nextUrl.searchParams.get("state"));
  const code = req.nextUrl.searchParams.get("code");
  if (!st || !code) return NextResponse.redirect(new URL("/settings/integrations?google=invalid_state", req.url));
  try {
    await exchangeGoogleCode(service(), st.orgId, st.userId, code);
    return NextResponse.redirect(new URL("/settings/integrations?google=connected", req.url));
  } catch (e) {
    log.error("google.connect_failed", { org_id: st.orgId, user_id: st.userId, error: (e as Error).message });
    return NextResponse.redirect(new URL(`/settings/integrations?google=${encodeURIComponent((e as Error).message)}`, req.url));
  }
}
