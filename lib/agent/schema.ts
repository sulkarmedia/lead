// The agent's output contract. Structured outputs force this shape; zod parses it again anyway.
// `extracted` is a list of {field, value} pairs because structured outputs need closed objects.
import { z } from "zod";

export const INTENTS = ["question", "interested", "ready_to_book", "reschedule", "not_interested", "bought_elsewhere", "wrong_number", "opt_out", "human_requested", "other"] as const;
export const ACTIONS = ["reply", "no_reply", "handoff", "book", "stop"] as const;
export const STAGE_SUGGESTIONS = ["engaged", "qualified", "appointment_set", "nurture", "lost"] as const;

export const AgentOutput = z.object({
  action: z.enum(ACTIONS),
  message: z
    .object({
      channel: z.enum(["sms", "email"]),
      subject: z.string().nullable(),
      body: z.string(),
    })
    .nullable(),
  extracted: z.array(z.object({ field: z.string(), value: z.string() })),
  intent: z.enum(INTENTS),
  warm: z.boolean(),
  book_slot_id: z.string().nullable(),
  handoff_reason: z.string().nullable(),
  stage_suggestion: z.enum(STAGE_SUGGESTIONS).nullable(),
  confidence: z.number(),
  summary: z.string(),
});
export type AgentOutput = z.infer<typeof AgentOutput>;

export function extractedToRecord(o: AgentOutput, allowed: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { field, value } of o.extracted) if (allowed.includes(field) && value.trim()) out[field] = value.trim();
  return out;
}

/** Fast classifier output (Haiku): opt-out detection for plain-language messages. */
export const ClassifierOutput = z.object({
  opt_out: z.boolean(),
  scope: z.enum(["sms", "all", "none"]),
  wrong_number: z.boolean(),
  confidence: z.number(),
});
export type ClassifierOutput = z.infer<typeof ClassifierOutput>;
