import { describe, expect, it } from "vitest";
import { one, q, service, withUserDb } from "@/lib/db";
import { seedDemo } from "@/lib/seed";
import { TABLES, useTestEnv } from "../helpers";

useTestEnv();

describe("row-level security", () => {
  it("a user in org A cannot read or write any org B row in any table", async () => {
    const a = await seedDemo(service(), { name: "Org A", slug: "org-a", ownerEmail: "a@x.test", repEmails: ["ra@x.test"], leads: 3 });
    const b = await seedDemo(service(), { name: "Org B", slug: "org-b", ownerEmail: "b@x.test", repEmails: ["rb@x.test"], leads: 3 });
    // Give org B a row in every org-scoped table.
    await q(service(), "insert into jobs (org_id, kind, run_at) values ($1, 'daily_digest', now() + interval '1 day')", [b.orgId]);
    await q(service(), "insert into ai_runs (org_id, lead_id, trigger, model, prompt_version) values ($1, $2, 'reply', 'x', 'v')", [b.orgId, b.leadIds[0]]);
    await q(service(), "insert into capi_events (org_id, lead_id, event_name, event_time) values ($1, $2, 'qualified', now())", [b.orgId, b.leadIds[0]]);
    await q(service(), "insert into audit_log (org_id, actor, action, entity) values ($1, 'x', 'y', 'z')", [b.orgId]);
    await q(service(), "insert into do_not_contact (org_id, phone_hash, reason) values ($1, 'h', 'r')", [b.orgId]);
    await q(service(), "insert into ad_spend_daily (org_id, day, campaign_id, spend) values ($1, '2026-10-01', 'c', 10)", [b.orgId]);
    await q(service(), "insert into notifications (org_id, user_id, channel, kind, body) values ($1, $2, 'in_app', 'x', 'y')", [b.orgId, b.ownerId]);

    const orgScoped = TABLES.filter((t) => !["platform_admins", "platform_state"].includes(t));
    for (const user of [a.ownerId, a.repIds[0]]) {
      for (const t of orgScoped) {
        const col = t === "organizations" ? "id" : "org_id";
        const seen = await withUserDb(user, (c) => q(c, `select 1 from ${t} where ${col} = $1`, [b.orgId]));
        expect(seen, `${t} visible across tenants`).toHaveLength(0);
        const updated = await withUserDb(user, (c) => q(c, `update ${t} set ${col} = ${col} where ${col} = $1 returning 1`, [b.orgId]).catch(() => []));
        expect(updated, `${t} updatable across tenants`).toHaveLength(0);
        const deleted = await withUserDb(user, (c) => q(c, `delete from ${t} where ${col} = $1 returning 1`, [b.orgId]).catch(() => []));
        expect(deleted, `${t} deletable across tenants`).toHaveLength(0);
      }
      // Inserting into org B is refused.
      await expect(withUserDb(user, (c) => q(c, "insert into leads (org_id, first_name) values ($1, 'x')", [b.orgId]))).rejects.toThrow(/row-level security/);
      await expect(withUserDb(user, (c) => q(c, "insert into messages (org_id, lead_id, channel, direction, author, body, status) values ($1, $2, 'note', 'internal', 'user', 'x', 'received')", [b.orgId, b.leadIds[0]]))).rejects.toThrow(/row-level security/);
    }
    // And they still see their own org.
    const own = await withUserDb(a.repIds[0], (c) => q(c, "select id from leads where org_id = $1", [a.orgId]));
    expect(own.length).toBe(3);
  });

  it("reps edit only leads assigned to them or unassigned; owners edit all", async () => {
    const a = await seedDemo(service(), { ownerEmail: "o@x.test", repEmails: ["r1@x.test", "r2@x.test"], leads: 4, withAppointments: false });
    const r1 = a.repIds[0];
    const leads = await q<{ id: string; assigned_user_id: string }>(service(), "select id, assigned_user_id from leads where org_id = $1", [a.orgId]);
    const mine = leads.find((l) => l.assigned_user_id === r1)!;
    const theirs = leads.find((l) => l.assigned_user_id !== r1)!;
    const upd = (user: string, id: string) => withUserDb(user, (c) => q(c, "update leads set summary = 'x' where id = $1 returning id", [id]));
    expect(await upd(r1, mine.id)).toHaveLength(1);
    expect(await upd(r1, theirs.id)).toHaveLength(0);
    expect(await upd(a.ownerId, theirs.id)).toHaveLength(1);
    await q(service(), "update leads set assigned_user_id = null where id = $1", [theirs.id]);
    expect(await upd(r1, theirs.id)).toHaveLength(1);
    // reps can't change their own role
    await expect(withUserDb(r1, (c) => q(c, "update memberships set role = 'owner' where user_id = $1 returning 1", [r1]))).rejects.toThrow(/row-level security/);
    // but can update their own notification settings
    await expect(withUserDb(r1, (c) => q(c, "update memberships set notify_sms = false where user_id = $1 returning 1", [r1]))).resolves.toHaveLength(1);
  });

  it("consent records can never be updated or deleted", async () => {
    const a = await seedDemo(service(), { leads: 1, withAppointments: false });
    const c = await one<{ id: string }>(service(), "select id from consent_records where org_id = $1 limit 1", [a.orgId]);
    await expect(q(service(), "update consent_records set disclosure_text = 'x' where id = $1", [c.id])).rejects.toThrow(/immutable/);
    await expect(q(service(), "delete from consent_records where id = $1", [c.id])).rejects.toThrow(/immutable/);
  });

  it("platform admins see across tenants", async () => {
    const a = await seedDemo(service(), { name: "A", slug: "aa", ownerEmail: "a1@x.test", repEmails: [], leads: 1, withAppointments: false });
    const b = await seedDemo(service(), { name: "B", slug: "bb", ownerEmail: "b1@x.test", repEmails: [], leads: 1, withAppointments: false });
    await q(service(), "insert into platform_admins (user_id) values ($1)", [a.ownerId]);
    const rows = await withUserDb(a.ownerId, (c) => q(c, "select id from organizations where id = $1", [b.orgId]));
    expect(rows).toHaveLength(1);
  });
});
