import { afterEach, describe, expect, it } from "vitest";
import { one, q, service } from "@/lib/db";
import { seedDemo } from "@/lib/seed";
import { computeSteps, goLive, goLiveBlockers, goLiveStatus, loadStepFacts, saveStepProgress, setProgressKey } from "@/lib/onboarding";
import { approvePlaybook, defaultPlaybookInput, insertKnowledgeItems, playbookToInput, savePlaybookVersion } from "@/lib/playbook-generator";
import { loadPlaybook } from "@/lib/agent/context";
import { useTestEnv } from "../helpers";

useTestEnv();

const codes = async (orgId: string) => (await goLiveBlockers(service(), orgId)).map((b) => b.code).sort();
const setup = () => seedDemo(service(), { leads: 0, withAppointments: false, live: false });

describe("goLiveBlockers", () => {
  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
  });

  it("the demo org (verified consent, approved playbook, address) has none and can go live", async () => {
    const d = await setup();
    expect(await codes(d.orgId)).toEqual([]);
    expect(await goLive(service(), d.orgId)).toEqual({ ok: true });
    expect((await one<{ status: string }>(service(), "select status from organizations where id = $1", [d.orgId])).status).toBe("live");
  });

  it("medical industries need the BAA confirmation", async () => {
    const d = await setup();
    await q(service(), "update organizations set industry = 'med_spa' where id = $1", [d.orgId]);
    expect(await codes(d.orgId)).toEqual(["hipaa_baa_missing"]);
    const r = await goLive(service(), d.orgId);
    expect(r.ok).toBe(false);
    expect((await one<{ status: string }>(service(), "select status from organizations where id = $1", [d.orgId])).status).toBe("onboarding");
    await q(service(), "update organizations set hipaa_baa_confirmed_at = now() where id = $1", [d.orgId]);
    expect(await codes(d.orgId)).toEqual([]);
  });

  it("needs a lead source with verified consent text", async () => {
    const d = await setup();
    await q(service(), "update lead_sources set consent_verified_at = null where org_id = $1", [d.orgId]);
    expect(await codes(d.orgId)).toEqual(["no_verified_consent"]);
    await q(service(), "update lead_sources set consent_verified_at = now(), consent_text = '  ' where org_id = $1", [d.orgId]);
    expect(await codes(d.orgId)).toEqual(["no_verified_consent"]);
    await q(service(), "update lead_sources set consent_text = 'Texts ok', active = false where org_id = $1", [d.orgId]);
    expect(await codes(d.orgId)).toEqual(["no_verified_consent"]);
  });

  it("needs an approved playbook and a business address", async () => {
    const d = await setup();
    await q(service(), "update playbooks set approved_at = null where org_id = $1", [d.orgId]);
    await q(service(), "update organizations set address = '' where id = $1", [d.orgId]);
    expect(await codes(d.orgId)).toEqual(["address_missing", "playbook_not_approved"]);
  });

  it("requires an active Stripe subscription only when STRIPE_SECRET_KEY is set", async () => {
    const d = await setup();
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    expect(await codes(d.orgId)).toEqual(["subscription_inactive"]);
    await setProgressKey(service(), d.orgId, "stripe_subscription_status", "past_due");
    expect(await codes(d.orgId)).toEqual(["subscription_inactive"]);
    await setProgressKey(service(), d.orgId, "stripe_subscription_status", "trialing");
    expect(await codes(d.orgId)).toEqual([]);
    delete process.env.STRIPE_SECRET_KEY;
    await setProgressKey(service(), d.orgId, "stripe_subscription_status", "canceled");
    expect(await codes(d.orgId)).toEqual([]);
  });

  it("reports (does not block on) texting being off", async () => {
    const d = await setup();
    await q(service(), "update organizations set texting_enabled = false where id = $1", [d.orgId]);
    const s = await goLiveStatus(service(), d.orgId);
    expect(s.blockers).toEqual([]);
    expect(s.textingEnabled).toBe(false);
  });
});

describe("onboarding progress and step states", () => {
  it("saves per step and merges into onboarding_progress", async () => {
    const d = await setup();
    await saveStepProgress(service(), d.orgId, "phone", { registration: { legal_name: "X LLC" } });
    await saveStepProgress(service(), d.orgId, "phone", { submitted_at: "2026-10-14T17:00:00.000Z" });
    await setProgressKey(service(), d.orgId, "inventory_feed_url", "https://example.com/feed.xml");
    const { onboarding_progress: p } = await one<{ onboarding_progress: any }>(service(), "select onboarding_progress from organizations where id = $1", [d.orgId]);
    expect(p.phone.registration.legal_name).toBe("X LLC");
    expect(p.phone.submitted_at).toBe("2026-10-14T17:00:00.000Z");
    expect(p.inventory_feed_url).toBe("https://example.com/feed.xml");

    await q(service(), "update organizations set texting_enabled = false where id = $1", [d.orgId]);
    const steps = computeSteps(await loadStepFacts(service(), d.orgId));
    const by = Object.fromEntries(steps.map((s) => [s.key, s.state]));
    expect(by).toMatchObject({ basics: "connected", consent: "connected", phone: "pending", hours: "connected", team: "connected", playbook: "connected", crm: "optional", golive: "todo" });
  });

  it("shows the medical blocker on basics and go-live", async () => {
    const d = await setup();
    await q(service(), "update organizations set industry = 'plastic surgery' where id = $1", [d.orgId]);
    const steps = computeSteps(await loadStepFacts(service(), d.orgId));
    expect(steps.find((s) => s.key === "basics")!.state).toBe("blocked");
    expect(steps.find((s) => s.key === "golive")!.state).toBe("blocked");
  });
});

describe("playbook versions", () => {
  it("saving bumps the version and clears approval; approve sets it again", async () => {
    const d = await setup();
    const before = await one<any>(service(), "select * from playbooks where id = $1", [d.playbookId]);
    expect(before.approved_at).not.toBeNull();
    const input = { ...playbookToInput(before), tone: "Short and kind." };
    const saved = await savePlaybookVersion(service(), d.orgId, d.playbookId, input);
    expect(saved.version).toBe(before.version + 1);
    expect(saved.approved_at).toBeNull();
    expect(saved.tone).toBe("Short and kind.");
    expect(saved.qualification_fields).toEqual(before.qualification_fields);
    // The agent keeps using the latest playbook (via the source link) while it awaits approval.
    const src = await one<any>(service(), "select * from lead_sources where id = $1", [d.sourceId]);
    expect((await loadPlaybook(service(), src)).version).toBe(saved.version);
    expect(await goLiveBlockers(service(), d.orgId)).toHaveLength(1);
    const approved = await approvePlaybook(service(), d.orgId, d.playbookId, d.ownerId);
    expect(approved!.approved_at).not.toBeNull();
    expect((approved as unknown as { approved_by: string }).approved_by).toBe(d.ownerId);
  });

  it("is scoped by org: another org's playbook can't be saved or approved", async () => {
    const a = await setup();
    const b = await seedDemo(service(), { leads: 0, withAppointments: false, slug: "other-org", ownerEmail: "o2@x.test", repEmails: [] });
    await expect(savePlaybookVersion(service(), b.orgId, a.playbookId, defaultPlaybookInput({ name: "B" }))).rejects.toThrow(/not found/);
    expect(await approvePlaybook(service(), b.orgId, a.playbookId, b.ownerId)).toBeNull();
  });

  it("a new playbook links to sources without one; knowledge drafts insert", async () => {
    const d = await setup();
    await q(service(), "update lead_sources set playbook_id = null where org_id = $1", [d.orgId]);
    await q(service(), "delete from playbooks where org_id = $1", [d.orgId]);
    const pb = await savePlaybookVersion(service(), d.orgId, null, defaultPlaybookInput({ name: "BMW of Elmhurst" }));
    expect(pb.version).toBe(1);
    expect(pb.approved_at).toBeNull();
    expect((await one<any>(service(), "select playbook_id from lead_sources where id = $1", [d.sourceId])).playbook_id).toBe(pb.id);
    const n = await insertKnowledgeItems(service(), d.orgId, [{ kind: "offer", title: "Brakes", body: "$20 off brakes", source_url: null }]);
    expect(n).toBe(1);
    expect(await q(service(), "select 1 from knowledge_items where org_id = $1 and title = 'Brakes'", [d.orgId])).toHaveLength(1);
  });
});
