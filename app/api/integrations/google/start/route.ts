import { NextResponse } from "next/server";
import { getOrgContext } from "@/lib/auth";
import { env } from "@/lib/env";
import { googleAuthUrl } from "@/lib/integrations/google";
import { signState } from "@/lib/oauth-state";

// Each rep connects their own calendar.
export async function GET() {
  const ctx = await getOrgContext();
  if (!env.googleClientId) return new NextResponse("Google Calendar is not configured yet (GOOGLE_CLIENT_ID).", { status: 503 });
  return NextResponse.redirect(googleAuthUrl(signState({ orgId: ctx.org.id, userId: ctx.user.id })));
}
