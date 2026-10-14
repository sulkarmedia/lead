import { afterEach, describe, expect, it } from "vitest";
import {
  extractFacts, extractLinks, extractTitle, fallbackKnowledge, fetchSitePages, htmlToText, introTemplateProblems, normalizeDraft, PlaybookInput,
  defaultPlaybookInput, selectLinks, draftPlaybook, type DraftOutput,
} from "@/lib/playbook-generator";
import { setModel, type AgentModel } from "@/lib/agent/model";
import { offlineModel } from "@/lib/agent/offline";

const HOME = `<!doctype html><html><head><title>Lake Auto &amp; Service | Elmhurst</title>
<style>.x{color:red}</style><script>var tracking = "<a href='/secret'>no</a>";</script></head>
<body>
<nav><a href="/about-us">About</a><a href="/service">Service</a></nav>
<header><h1>Welcome to Lake&nbsp;Auto</h1></header>
<main>
  <p>Family owned since 1982.<br>Open Mon&ndash;Sat.</p>
  <ul><li>Oil change: $49.95</li><li>Free tire rotation &#8212; with any service</li></ul>
  <!-- <p>hidden comment</p> -->
  <a href="/specials/">This month's <b>specials</b></a>
  <a href="https://www.lakeauto.example/faq#top">FAQ</a>
  <a href='/contact'>Contact us</a>
  <a href="/hours">Hours</a>
  <a href="/new-vehicles/inventory">Shop</a>
  <a href="/financing">Get pre-approved</a>
  <a href="/offers?model=x5">Offers</a>
  <a href="/blog/post-1">Blog</a>
  <a href="/brochure.pdf">Services brochure</a>
  <a href="https://facebook.com/lakeauto">Our services on Facebook</a>
  <a href="mailto:hi@lakeauto.example">Email</a>
  <a href="/login">My account</a>
  <a href=/about-us>About again</a>
</main>
<footer><address>100 W Lake St<br/>Elmhurst, IL</address></footer>
</body></html>`;

describe("htmlToText", () => {
  it("drops scripts, styles, nav and comments, decodes entities, keeps one block per line", () => {
    const t = htmlToText(HOME);
    expect(t).not.toMatch(/tracking|color:red|hidden comment|<|>/);
    expect(t).toContain("Welcome to Lake Auto");
    expect(t).toContain("Family owned since 1982.\nOpen Mon–Sat.");
    expect(t).toContain("Oil change: $49.95");
    expect(t).toContain("Free tire rotation — with any service");
    expect(t).toContain("100 W Lake St\nElmhurst, IL");
    expect(t.split("\n").every((l) => l === l.trim() && l.length > 0)).toBe(true);
  });

  it("extracts and decodes the title", () => {
    expect(extractTitle(HOME)).toBe("Lake Auto & Service | Elmhurst");
    expect(extractTitle("<p>none</p>")).toBe("");
  });
});

describe("link selection", () => {
  const base = "https://lakeauto.example/";

  it("keeps same-site http(s) links only, resolved and without fragments", () => {
    const links = extractLinks(HOME, base);
    const urls = links.map((l) => l.url);
    expect(urls).toContain("https://lakeauto.example/specials/");
    expect(urls).toContain("https://www.lakeauto.example/faq");
    expect(urls.some((u) => u.includes("facebook.com"))).toBe(false);
    expect(urls.some((u) => u.startsWith("mailto"))).toBe(false);
    expect(urls.some((u) => u.includes("/secret"))).toBe(false); // inside <script>
    expect(links.find((l) => l.url.endsWith("/specials/"))!.text).toBe("This month's specials");
  });

  it("picks keyword pages, one per kind first, skipping files, logins and duplicates", () => {
    const picked = selectLinks(extractLinks(HOME, base), base, 9);
    expect(picked).toEqual([
      "https://lakeauto.example/about-us",
      "https://lakeauto.example/service",
      "https://lakeauto.example/specials/",
      "https://lakeauto.example/offers?model=x5",
      "https://www.lakeauto.example/faq",
      "https://lakeauto.example/contact",
      "https://lakeauto.example/hours",
      "https://lakeauto.example/new-vehicles/inventory",
      "https://lakeauto.example/financing",
    ]);
    expect(picked.some((u) => /blog|pdf|login/.test(u))).toBe(false);
    expect(new Set(picked).size).toBe(picked.length);
  });

  it("caps the number of pages", () => {
    expect(selectLinks(extractLinks(HOME, base), base, 3)).toHaveLength(3);
  });

  it("matches on link text when the path says nothing", () => {
    const html = `<a href="/p/123">Frequently Asked Questions</a><a href="/p/456">Random</a>`;
    expect(selectLinks(extractLinks(html, base), base)).toEqual(["https://lakeauto.example/p/123"]);
  });
});

describe("fetchSitePages", () => {
  const pages: Record<string, { status?: number; body?: string; type?: string; location?: string }> = {
    "https://lakeauto.example/": { body: HOME },
    "https://lakeauto.example/about-us": { body: "<title>About</title><p>We fix cars.</p>" },
    "https://lakeauto.example/specials/": { status: 301, location: "/specials-2026" },
    "https://lakeauto.example/specials-2026": { body: "<title>Specials</title><p>$20 off brakes through Oct 31.</p>" },
    "https://lakeauto.example/contact": { status: 500 },
    "https://lakeauto.example/hours": { body: "%PDF", type: "application/pdf" },
  };
  const fakeFetch = (async (url: string) => {
    const p = pages[url] ?? { status: 404 };
    return new Response(p.body ?? "", { status: p.status ?? 200, headers: { "content-type": p.type ?? "text/html; charset=utf-8", ...(p.location ? { location: p.location } : {}) } });
  }) as unknown as typeof fetch;

  it("fetches home plus keyword pages, follows redirects, skips failures and non-HTML", async () => {
    const got = await fetchSitePages("lakeauto.example", { fetchImpl: fakeFetch, checkHost: async () => {} });
    expect(got.map((p) => p.url)).toEqual(["https://lakeauto.example/", "https://lakeauto.example/about-us", "https://lakeauto.example/specials-2026"]);
    expect(got[2].text).toContain("$20 off brakes through Oct 31.");
    expect(got[0].title).toBe("Lake Auto & Service | Elmhurst");
  });

  it("caps page size", async () => {
    const got = await fetchSitePages("https://lakeauto.example/", { fetchImpl: fakeFetch, checkHost: async () => {}, maxBytes: 200 });
    expect(got[0].text.length).toBeLessThan(200);
  });

  it("refuses private hosts by default", async () => {
    await expect(fetchSitePages("http://127.0.0.1/", { fetchImpl: fakeFetch })).rejects.toThrow(/refusing/);
    await expect(fetchSitePages("http://localhost:3000/", { fetchImpl: fakeFetch })).rejects.toThrow(/refusing/);
  });

  it("reports when the home page can't be loaded", async () => {
    await expect(fetchSitePages("https://nope.example/", { fetchImpl: fakeFetch, checkHost: async () => {} })).rejects.toThrow(/Couldn't load/);
  });
});

describe("drafting", () => {
  afterEach(() => setModel(null));
  const org = { name: "Lake Auto", industry: "automotive", website_url: "https://lakeauto.example", address: null, phone: null, timezone: "America/Chicago" };

  it("intro template must name the business, disclose the assistant and offer opt-out", () => {
    expect(introTemplateProblems(defaultPlaybookInput(org).intro_template, org.name)).toEqual([]);
    expect(introTemplateProblems("Hi {first_name}! Want a car?", org.name)).toHaveLength(3);
  });

  it("normalizes a model draft: snake_case keys, no sensitive fields, standard intro when unsafe", () => {
    const d: DraftOutput = {
      name: "Service leads", goal: "appointment", goal_detail: "Book a service visit",
      qualification_fields: [
        { key: "Vehicle Model", label: "Vehicle", options: [], required: true, description: null },
        { key: "credit_score", label: "Credit", options: [], required: false, description: null },
        { key: "vehicle_model", label: "dup", options: [], required: false, description: null },
      ],
      warm_rule: "vehicle_model AND timeline", handoff_triggers: ["asks for a manager"], tone: "Friendly", never_say: ["guaranteed"],
      booking_kinds: ["in_person"], slot_minutes: 500, intro_template: "Hey! Wanna book?",
      knowledge_items: [],
    };
    const { playbook, warnings } = normalizeDraft(org, d);
    expect(PlaybookInput.safeParse(playbook).success).toBe(true);
    expect(playbook.qualification_fields.map((f) => f.key)).toEqual(["vehicle_model"]);
    expect(playbook.booking.slot_minutes).toBe(240);
    expect(playbook.intro_template).toContain("{business_name}");
    expect(playbook.handoff_triggers).toContain("asks for a person");
    expect(warnings.join(" ")).toMatch(/intro/);
  });

  it("falls back to a starter draft when the model can't draft (offline)", async () => {
    setModel(offlineModel);
    const facts = await extractFacts([{ url: "https://lakeauto.example/specials", title: "Specials", text: "$20 off brakes" }]);
    const d = await draftPlaybook(org, facts);
    expect(d.fallback).toBe(true);
    expect(d.knowledge_items).toEqual(fallbackKnowledge(facts));
    expect(d.knowledge_items[0].kind).toBe("offer");
    expect(PlaybookInput.safeParse(d.playbook).success).toBe(true);
  });

  it("uses the model's structured draft when available", async () => {
    const fake: AgentModel = {
      ...offlineModel,
      async fast() { return { ok: true, output: "- Oil change $49.95", usage: { model: "fake", tokensIn: 0, tokensOut: 0, cacheRead: 0, latencyMs: 0 } }; },
      async draft<T>(_s: string, _u: string, schema: import("zod").ZodType<T>) {
        const out = schema.parse({
          name: "Lake Auto service", goal: "appointment", goal_detail: null, qualification_fields: [], warm_rule: null, handoff_triggers: [], tone: "Warm",
          never_say: [], booking_kinds: ["in_person"], slot_minutes: 60,
          intro_template: "Hi {first_name}, this is the virtual assistant at {business_name}. What can I help with? Reply STOP to opt out.",
          knowledge_items: [{ kind: "offer", title: "Oil change", body: "Oil change $49.95", source_url: "https://lakeauto.example/" }, { kind: "faq", title: "", body: "x", source_url: null }],
        });
        return { ok: true, output: out, usage: { model: "fake", tokensIn: 0, tokensOut: 0, cacheRead: 0, latencyMs: 0 } };
      },
    };
    setModel(fake);
    const facts = await extractFacts([{ url: "https://lakeauto.example/", title: "Home", text: "Oil change $49.95" }]);
    expect(facts[0]).toMatchObject({ extracted: true, facts: "- Oil change $49.95" });
    const d = await draftPlaybook(org, facts);
    expect(d.fallback).toBe(false);
    expect(d.playbook.booking.slot_minutes).toBe(60);
    expect(d.knowledge_items).toEqual([{ kind: "offer", title: "Oil change", body: "Oil change $49.95", source_url: "https://lakeauto.example/" }]);
  });
});
