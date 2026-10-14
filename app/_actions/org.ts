"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getOrgContext, audit } from "@/lib/auth";

export async function switchOrg(form: FormData) {
  const ctx = await getOrgContext();
  const id = String(form.get("org_id"));
  if (!ctx.orgs.some((o) => o.id === id)) return;
  (await cookies()).set("org_id", id, { httpOnly: true, sameSite: "lax", path: "/" });
  if (ctx.isPlatformAdmin) {
    const next = await getOrgContext();
    if (!next.membership) await audit(next, "impersonate", "organization", id);
  }
  redirect("/inbox");
}
