import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { supabaseServer } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const res = NextResponse.redirect(new URL("/login", req.url), 303);
  res.cookies.delete("dev_user");
  res.cookies.delete("org_id");
  if (!env.devLogin && env.supabaseUrl) await (await supabaseServer()).auth.signOut();
  return res;
}
