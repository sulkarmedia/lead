import { NextResponse, type NextRequest } from "next/server";
import { service, q } from "@/lib/db";
import { exchangeMetaCode } from "@/lib/integrations/meta-connect";
import { verifyState } from "@/lib/oauth-state";
import { log } from "@/lib/log";

export async function GET(req: NextRequest) {
  const st = verifyState(req.nextUrl.searchParams.get("state"));
  const code = req.nextUrl.searchParams.get("code");
  if (!st || !code) return NextResponse.redirect(new URL("/connect/meta?error=invalid_state", req.url));
  try {
    await exchangeMetaCode(service(), st.orgId, code);
    await q(service(), "insert into audit_log (org_id, actor, action, entity) values ($1, $2, 'connect', 'meta')", [st.orgId, `user:${st.userId}`]);
    return NextResponse.redirect(new URL("/connect/meta", req.url));
  } catch (e) {
    log.error("meta.connect_failed", { org_id: st.orgId, error: (e as Error).message });
    return NextResponse.redirect(new URL(`/connect/meta?error=${encodeURIComponent((e as Error).message)}`, req.url));
  }
}
