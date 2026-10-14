import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { metaLoginUrl } from "@/lib/integrations/meta-connect";
import { signState } from "@/lib/oauth-state";

export async function GET() {
  const ctx = await requireAdmin();
  if (!env.metaAppId || !env.metaLoginConfigId) return new NextResponse("Meta app is not configured yet (META_APP_ID / META_LOGIN_CONFIG_ID). Use the Zapier bridge for now.", { status: 503 });
  return NextResponse.redirect(metaLoginUrl(signState({ orgId: ctx.org.id, userId: ctx.user.id })));
}
