// A deterministic stand-in for the model. Used by tests and by the simulator when no
// ANTHROPIC_API_KEY is set, so the whole pipeline (guards, compliance, cadence, booking) can be
// exercised offline. It is intentionally simple; real conversations use Claude.
import type { AgentModel, AgentRequest, ModelResult } from "./model";
import type { AgentOutput, ClassifierOutput } from "./schema";

function section(live: string, name: string): string {
  const i = live.indexOf(`\n${name}`);
  if (i === -1) return "";
  const rest = live.slice(i + name.length + 1);
  const end = rest.search(/\n[A-Z][A-Z ]+(\(|\n)/);
  return end === -1 ? rest : rest.slice(0, end);
}

export function offlineDecide(req: AgentRequest): AgentOutput {
  const live = req.live;
  const business = /Name: (.+)/.exec(req.playbook)?.[1]?.trim() ?? "our team";
  const first = /first name: ([^)]+)\)/.exec(live)?.[1]?.trim();
  const name = first && first !== "(unknown)" ? first : "there";
  const channel = (/message\.channel = "(sms|email)"/.exec(live)?.[1] ?? "sms") as "sms" | "email";
  const slots = [...section(live, "OPEN SLOTS").matchAll(/- (slot_[\w]+): (.+)/g)].map((m) => ({ id: m[1], label: m[2] }));
  const convo = section(live, "CONVERSATION");
  const leadLines = convo.split("\n").filter((l) => / LEAD via /.test(l));
  const lastLead = (leadLines.at(-1) ?? "").replace(/^.*? LEAD via \w+(?: \(subject: [^)]*\))?: /, "");
  const lower = lastLead.toLowerCase();
  const mk = (o: Partial<AgentOutput>): AgentOutput => ({
    action: "reply", message: null, extracted: [], intent: "other", warm: false, book_slot_id: null, handoff_reason: null,
    stage_suggestion: null, confidence: 0.9, summary: `${name}: lead from form. Last said: ${lastLead.slice(0, 60) || "(nothing yet)"}`, ...o,
  });
  const msg = (body: string, subject: string | null = null) => ({ channel, subject: channel === "email" ? subject ?? `Following up from ${business}` : null, body });

  if (/FIRST message/.test(live)) {
    const stop = channel === "sms" ? " Reply STOP to opt out." : "";
    return mk({ message: msg(`Hi ${name}, this is the virtual assistant at ${business}. Thanks for your interest! Are you hoping to come in this week or just exploring for now?${stop}`, `Thanks for reaching out to ${business}`) });
  }
  if (/missed their appointment|hasn't replied in time/.test(live) && slots.length >= 2) {
    return mk({ message: msg(`${/missed their/.test(live) ? "Sorry we missed you!" : "Sorry for the wait!"} Would ${slots[0].label} or ${slots[1].label} work instead?`) });
  }
  if (/The lead hasn't replied/.test(live)) {
    const angle = /Angle: (.+?)\./.exec(live)?.[1] ?? "check in";
    return mk({ message: msg(angle.includes("close your file") ? `Hi ${name}, should I close your file for now, or are you still interested?` : `Hi ${name}, just checking in from ${business}. Is there anything I can answer for you?`) });
  }
  if (/\b(bot|robot|real person|human|ai)\b\??/.test(lower)) {
    return mk({ intent: "question", message: msg(`Yes, I'm the virtual assistant for ${business}. Happy to connect you with someone on the team. Would that help?`) });
  }
  if (/\b(person|someone|manager|call me)\b/.test(lower)) {
    return mk({ action: "handoff", intent: "human_requested", handoff_reason: "lead asked for a person", message: null });
  }
  if (/(price|cost|how much|payment|apr|lease|deposit|\$)/.test(lower)) {
    return mk({ action: "handoff", intent: "question", handoff_reason: "price question not in knowledge", message: null });
  }
  if (/(angry|ridiculous|terrible|worst|complain)/.test(lower)) {
    return mk({ action: "handoff", intent: "other", handoff_reason: "frustrated lead", message: null });
  }
  if (/(bought|purchased) (one|elsewhere|already)|went with another/.test(lower)) {
    return mk({ action: "stop", intent: "bought_elsewhere", stage_suggestion: "lost", message: msg("Congratulations on the new purchase! Thanks for letting us know.") });
  }
  if (/not interested|no thanks/.test(lower)) {
    return mk({ action: "stop", intent: "not_interested", stage_suggestion: "lost", message: msg("No problem at all, thanks for letting me know!") });
  }
  // Picking a slot: "the first one", "thursday", "10am"
  const offered = convo.match(/Would (.+?) or (.+?) work/);
  if (offered && slots.length) {
    const pick = /(first|1st|^1\b)/.test(lower) ? slots[0] : /(second|2nd|^2\b|later)/.test(lower) ? slots[1] : slots.find((s) => s.label.toLowerCase().split(" ").some((w) => w.length > 2 && lower.includes(w.replace(/[^a-z0-9:]/g, ""))));
    if (pick && /(yes|works|book|first|second|that|ok|sure|perfect|great|\d)/.test(lower)) {
      return mk({ action: "book", intent: "ready_to_book", book_slot_id: pick.id, stage_suggestion: "appointment_set", warm: true, message: msg(`You're all set for ${pick.label}. See you then!`) });
    }
  }
  if (/(come in|visit|appointment|test drive|schedule|book|this week|tomorrow|today)/.test(lower) && slots.length >= 2) {
    return mk({ intent: "ready_to_book", stage_suggestion: "engaged", message: msg(`Great! Would ${slots[0].label} or ${slots[1].label} work for you?`) });
  }
  if (/[áéíóúñ¿¡]|\b(hola|gracias|quiero)\b/.test(lower)) {
    return mk({ intent: "interested", message: msg(`¡Hola ${name}! Con gusto te ayudo. ¿Te gustaría venir a visitarnos esta semana?`) });
  }
  if (!lastLead.trim() || /^(ok|thanks|thank you|k|👍)\.?$/.test(lower.trim())) return mk({ action: "no_reply", intent: "other" });
  return mk({ intent: "interested", stage_suggestion: "engaged", message: msg(`Thanks ${name}! When would be a good time for you to stop by?`) });
}

export const offlineModel: AgentModel = {
  async generate(req) {
    return { ok: true, output: offlineDecide(req), usage: { model: "offline", tokensIn: 0, tokensOut: 0, cacheRead: 0, latencyMs: 0 } };
  },
  async classifyOptOut(): Promise<ModelResult<ClassifierOutput>> {
    return { ok: true, output: { opt_out: false, scope: "none", wrong_number: false, confidence: 0 }, usage: { model: "offline", tokensIn: 0, tokensOut: 0, cacheRead: 0, latencyMs: 0 } };
  },
  async fast(_s, user) {
    return { ok: true, output: user.slice(0, 200), usage: { model: "offline", tokensIn: 0, tokensOut: 0, cacheRead: 0, latencyMs: 0 } };
  },
  async draft() {
    return { ok: false, kind: "unavailable", error: "offline model cannot draft playbooks" };
  },
};
