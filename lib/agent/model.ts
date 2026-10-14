// Model access behind an interface so tests and the simulator can run without the API.
// Real calls: structured outputs (output_config.format) parsed with zod; prompt caching on the
// system prompt + playbook + knowledge prefix; 20s timeout with one retry.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { env } from "../env";
import { AgentOutput, ClassifierOutput } from "./schema";
import { CLASSIFIER_PROMPT } from "./prompt";
import { offlineModel } from "./offline";

export interface AgentRequest {
  system: string;
  playbook: string;
  knowledge: string;
  live: string;
  /** Extra instruction appended when regenerating (e.g. "shorter"). */
  retryNote?: string;
}

export interface ModelUsage {
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  latencyMs: number;
}

export type ModelResult<T> = { ok: true; output: T; usage: ModelUsage } | { ok: false; error: string; kind: "schema" | "unavailable" | "refusal"; usage?: ModelUsage };

export interface AgentModel {
  generate(req: AgentRequest, opts?: { timeoutMs?: number }): Promise<ModelResult<AgentOutput>>;
  classifyOptOut(text: string): Promise<ModelResult<ClassifierOutput>>;
  /** Free-form short completion with the fast model (summaries, website extraction). */
  fast(system: string, user: string, maxTokens?: number): Promise<ModelResult<string>>;
  /** Free-form completion with the main model (playbook drafting). */
  draft<T>(system: string, user: string, schema: import("zod").ZodType<T>): Promise<ModelResult<T>>;
}

let client: Anthropic | null = null;
function anthropic() {
  if (!env.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  return (client ??= new Anthropic({ apiKey: env.anthropicApiKey, timeout: 20_000, maxRetries: 1 }));
}

function usageOf(model: string, started: number, u: Anthropic.Usage | undefined): ModelUsage {
  return {
    model,
    tokensIn: (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
    tokensOut: u?.output_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
    latencyMs: Date.now() - started,
  };
}

function classifyError(e: unknown): ModelResult<never> {
  if (e instanceof Anthropic.APIConnectionTimeoutError || e instanceof Anthropic.APIConnectionError) return { ok: false, kind: "unavailable", error: (e as Error).message };
  if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError) return { ok: false, kind: "unavailable", error: (e as Error).message };
  if (e instanceof Anthropic.APIError && (e.status ?? 0) >= 500) return { ok: false, kind: "unavailable", error: e.message };
  if (e instanceof Anthropic.APIError) return { ok: false, kind: "unavailable", error: `${e.status} ${e.message}` };
  return { ok: false, kind: "schema", error: (e as Error).message };
}

export const anthropicModel: AgentModel = {
  async generate(req, opts) {
    const model = env.agentModel;
    const started = Date.now();
    try {
      const res = await anthropic().messages.parse(
        {
          model,
          max_tokens: 4000,
          // Stable prefix first: system prompt, then the tenant's playbook and knowledge (cached).
          system: [
            { type: "text", text: req.system },
            { type: "text", text: req.playbook },
            { type: "text", text: req.knowledge, cache_control: { type: "ephemeral" } },
          ],
          messages: [{ role: "user", content: req.live + (req.retryNote ? `\n\nNOTE: ${req.retryNote}` : "") }],
          output_config: { format: zodOutputFormat(AgentOutput), effort: "low" },
        },
        { timeout: opts?.timeoutMs ?? 20_000 },
      );
      const usage = usageOf(model, started, res.usage);
      if (res.stop_reason === "refusal") return { ok: false, kind: "refusal", error: "model refused", usage };
      if (!res.parsed_output) return { ok: false, kind: "schema", error: `no parsed output (stop_reason=${res.stop_reason})`, usage };
      const parsed = AgentOutput.safeParse(res.parsed_output);
      if (!parsed.success) return { ok: false, kind: "schema", error: parsed.error.message, usage };
      return { ok: true, output: parsed.data, usage };
    } catch (e) {
      return classifyError(e);
    }
  },

  async classifyOptOut(text) {
    const model = env.fastModel;
    const started = Date.now();
    try {
      const res = await anthropic().messages.parse({
        model,
        max_tokens: 1000,
        system: CLASSIFIER_PROMPT,
        messages: [{ role: "user", content: `Message: """${text.slice(0, 1000)}"""` }],
        output_config: { format: zodOutputFormat(ClassifierOutput), effort: "low" },
      });
      const usage = usageOf(model, started, res.usage);
      const parsed = ClassifierOutput.safeParse(res.parsed_output);
      if (!parsed.success) return { ok: false, kind: "schema", error: "classifier parse failed", usage };
      return { ok: true, output: parsed.data, usage };
    } catch (e) {
      return classifyError(e);
    }
  },

  async fast(system, user, maxTokens = 2000) {
    const model = env.fastModel;
    const started = Date.now();
    try {
      const res = await anthropic().messages.create({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }], output_config: { effort: "low" } });
      const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
      return { ok: true, output: text, usage: usageOf(model, started, res.usage) };
    } catch (e) {
      return classifyError(e);
    }
  },

  async draft(system, user, schema) {
    const model = env.agentModel;
    const started = Date.now();
    try {
      const stream = anthropic().messages.stream(
        {
          model,
          max_tokens: 32000,
          system,
          messages: [{ role: "user", content: user }],
          output_config: { format: zodOutputFormat(schema as never), effort: "medium" },
        },
        { timeout: 300_000 },
      );
      const res = await stream.finalMessage();
      const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const parsed = schema.safeParse(JSON.parse(text));
      if (!parsed.success) return { ok: false, kind: "schema", error: parsed.error.message };
      return { ok: true, output: parsed.data, usage: usageOf(model, started, res.usage) };
    } catch (e) {
      return classifyError(e);
    }
  },
};

let override: AgentModel | null = null;
export function getModel(): AgentModel {
  if (override) return override;
  // Dry-run without a key (local dev, the simulator) uses the offline stand-in. Outside dry-run a
  // missing key is an outage: calls fail as "unavailable" and nothing is sent.
  if (!env.anthropicApiKey && env.dryRun) return offlineModel;
  return anthropicModel;
}
/** Tests and the offline simulator. */
export function setModel(m: AgentModel | null) {
  override = m;
}
