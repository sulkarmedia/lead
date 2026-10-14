import type { Page } from "@playwright/test";
import pg from "pg";

export const db = () => new pg.Client({ connectionString: "postgres://postgres@127.0.0.1:54329/leadline_e2e" });

export async function sql<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = db();
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

export async function loginAs(page: Page, email: string) {
  const [u] = await sql<{ id: string }>("select id from auth.users where email = $1", [email]);
  await page.goto(`/auth/dev?user=${u.id}`);
}
