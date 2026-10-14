// Applies supabase/migrations/*.sql in order, tracking applied files in public.schema_migrations.
// With --shim (local/test only) it first applies supabase/local-shim.sql.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

export async function migrate(databaseUrl: string, opts: { shim?: boolean; log?: boolean } = {}) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    if (opts.shim) await client.query(readFileSync(join(process.cwd(), "supabase/local-shim.sql"), "utf8"));
    await client.query("create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const dir = join(process.cwd(), "supabase/migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const { rows } = await client.query<{ name: string }>("select name from public.schema_migrations");
    const done = new Set(rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      await client.query("begin");
      try {
        await client.query(readFileSync(join(dir, f), "utf8"));
        await client.query("insert into public.schema_migrations (name) values ($1)", [f]);
        await client.query("commit");
        if (opts.log) console.log(`applied ${f}`);
      } catch (e) {
        await client.query("rollback");
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  migrate(url, { shim: process.argv.includes("--shim"), log: true }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
