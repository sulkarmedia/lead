// npm run seed — creates the demo dealership (and a platform admin) in DATABASE_URL.
// On Supabase, users are created through the Auth Admin API first so they can sign in.
import { service, closePool, maybeOne, q } from "../lib/db";
import { ensureUser, seedDemo } from "../lib/seed";

async function supabaseUser(email: string): Promise<string | undefined> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return undefined;
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ email, email_confirm: true }),
  });
  const json = await res.json();
  if (res.ok) return json.id as string;
  // already exists: look it up
  const list = await fetch(`${url}/auth/v1/admin/users?per_page=1000`, { headers: { apikey: key, authorization: `Bearer ${key}` } }).then((r) => r.json());
  return (list.users as Array<{ id: string; email: string }>).find((u) => u.email === email)?.id;
}

async function main() {
  const db = service();
  const owner = process.env.SEED_OWNER_EMAIL ?? "owner@demo.leadline.test";
  const reps = (process.env.SEED_REP_EMAILS ?? "sam@demo.leadline.test,alex@demo.leadline.test").split(",");
  const admin = process.env.SEED_PLATFORM_ADMIN_EMAIL ?? "admin@leadline.test";
  for (const e of [owner, ...reps, admin]) {
    const id = await supabaseUser(e);
    await ensureUser(db, e, id);
  }
  const adminId = await ensureUser(db, admin);
  await q(db, "insert into platform_admins (user_id) values ($1) on conflict do nothing", [adminId]);
  if (await maybeOne(db, "select 1 from organizations where slug = 'bmw-elmhurst-demo'")) {
    console.log("Demo org already exists; nothing to do.");
  } else {
    const r = await seedDemo(db, { ownerEmail: owner, repEmails: reps });
    console.log(`Seeded demo org ${r.orgId}\nZapier intake URL: ${process.env.APP_URL ?? "http://localhost:3000"}/api/intake/zapier/${r.intakeKey}`);
  }
  await closePool();
}
main().catch((e) => { console.error(e); process.exit(1); });
