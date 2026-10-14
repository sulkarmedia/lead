// Database access. Two paths:
//  - service():      the owner connection used by webhooks and the worker. Bypasses RLS, so every
//                    write must set org_id explicitly.
//  - withUserDb():   runs inside a transaction as the `authenticated` role with the user's JWT
//                    claims, so Postgres RLS applies exactly as through Supabase's API.
import pg from "pg";
import { env } from "../env";

// Return timestamps as Date, bigints/numerics as numbers where safe.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v); // date stays 'YYYY-MM-DD'

export type Db = pg.Pool | pg.PoolClient;

let pool: pg.Pool | null = null;
let poolUrl: string | null = null;

export function service(): pg.Pool {
  const url = env.databaseUrl;
  if (!pool || poolUrl !== url) {
    pool = new pg.Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 10) });
    poolUrl = url;
  }
  return pool;
}

export async function closePool() {
  if (pool) await pool.end();
  pool = null;
}

export async function q<T extends pg.QueryResultRow = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query<T>(sql, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T> {
  const rows = await q<T>(db, sql, params);
  if (rows.length === 0) throw new NotFoundError(sql);
  return rows[0];
}

export async function maybeOne<T extends pg.QueryResultRow = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(db, sql, params);
  return rows[0] ?? null;
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`not found: ${what.slice(0, 80)}`);
  }
}

/** Run fn in a transaction on a dedicated client. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>, pool_: pg.Pool = service()): Promise<T> {
  const c = await pool_.connect();
  try {
    await c.query("begin");
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Run fn as a signed-in user with RLS enforced. */
export async function withUserDb<T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>, pool_: pg.Pool = service()): Promise<T> {
  return tx(async (c) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
    await c.query("set local role authenticated");
    return fn(c);
  }, pool_);
}
