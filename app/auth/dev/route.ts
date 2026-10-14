import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";

export async function GET(req: NextRequest) {
  if (!env.devLogin) return new NextResponse("Not found", { status: 404 });
  const user = req.nextUrl.searchParams.get("user") ?? "";
  const res = NextResponse.redirect(new URL(req.nextUrl.searchParams.get("next") ?? "/inbox", req.url));
  res.cookies.set("dev_user", user, { httpOnly: true, sameSite: "lax", path: "/" });
  res.cookies.delete("org_id");
  return res;
}
