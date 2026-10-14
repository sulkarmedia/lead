// Refreshes the Supabase session cookie and sends signed-out users to /login.
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

const PUBLIC = [/^\/login/, /^\/auth\//, /^\/api\//, /^\/u\//, /^\/_next\//, /^\/favicon/, /^\/icon/, /^\/manifest/, /^\/sw\.js/, /^\/no-access/];

export async function middleware(req: NextRequest) {
  if (PUBLIC.some((r) => r.test(req.nextUrl.pathname))) return NextResponse.next();
  const devLogin = process.env.DEV_LOGIN === "true" && process.env.NODE_ENV !== "production";
  if (devLogin) {
    if (!req.cookies.get("dev_user")) return NextResponse.redirect(new URL("/login", req.url));
    return NextResponse.next();
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.redirect(new URL("/login", req.url));
  let res = NextResponse.next({ request: req });
  const sb = createServerClient(url, key, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list) => {
        for (const c of list) req.cookies.set(c.name, c.value);
        res = NextResponse.next({ request: req });
        for (const c of list) res.cookies.set(c.name, c.value, c.options);
      },
    },
  });
  const { data } = await sb.auth.getUser();
  if (!data.user) return NextResponse.redirect(new URL("/login", req.url));
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
