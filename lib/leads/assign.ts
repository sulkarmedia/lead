// Rep assignment: weighted round-robin over active reps with weight > 0, or a single owner.
import type { Db } from "../db";
import { maybeOne, q } from "../db";

export function pickRoundRobin(reps: Array<{ user_id: string; round_robin_weight: number }>, cursor: number): { userId: string | null; next: number } {
  const slots: string[] = [];
  for (const r of reps) for (let i = 0; i < r.round_robin_weight; i++) slots.push(r.user_id);
  if (slots.length === 0) return { userId: null, next: cursor };
  return { userId: slots[cursor % slots.length], next: (cursor + 1) % slots.length };
}

/** Must run inside a transaction: locks the org row so concurrent leads advance the cursor safely. */
export async function assignRep(db: Db, orgId: string): Promise<string | null> {
  const org = await maybeOne<{ assignment_mode: string; default_owner_user_id: string | null; rr_cursor: number }>(
    db, "select assignment_mode, default_owner_user_id, rr_cursor from organizations where id = $1 for update", [orgId]);
  if (!org) return null;
  if (org.assignment_mode === "single_owner" && org.default_owner_user_id) return org.default_owner_user_id;
  const reps = await q<{ user_id: string; round_robin_weight: number }>(
    db, `select user_id, round_robin_weight from memberships where org_id = $1 and active and round_robin_weight > 0 order by created_at, user_id`, [orgId]);
  const { userId, next } = pickRoundRobin(reps, org.rr_cursor);
  await q(db, "update organizations set rr_cursor = $2 where id = $1", [orgId, next]);
  return userId ?? org.default_owner_user_id;
}
