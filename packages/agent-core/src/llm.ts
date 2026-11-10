// Any model can drive Momo. Pick one with a "provider/model" string:
//   anthropic/claude-opus-5-5         native Anthropic API
//   openai/<model>                    OpenAI
//   gemini/<model>                    Google (OpenAI-compatible endpoint)
//   openrouter/<vendor>/<model>       hundreds of models via OpenRouter
//   groq/… together/… deepseek/… mistral/… xai/… fireworks/…
//   ollama/<model>  lmstudio/<model>  local open models, no key
//   custom/<model>                    any OpenAI-compatible server
//                                     (MOMO_MODEL_BASE_URL, MOMO_MODEL_API_KEY)
// Non-Anthropic providers use OpenAI-style chat completions with tools.

import type { Block, Planner, ToolSpec, Turn } from "./skills/web/agent.ts";
import { ClaudeAnswerer, ClaudePlanner } from "./skills/web/claude.ts";

export interface Answerer {
  answer(question: string, context: string): Promise<string>;
}

interface Provider {
  baseUrl: string;
  keyEnv?: string;
}

export const PROVIDERS: Record<string, Provider> = {
  openai: { baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: "GEMINI_API_KEY" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY" },
  together: { baseUrl: "https://api.together.xyz/v1", keyEnv: "TOGETHER_API_KEY" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY" },
  mistral: { baseUrl: "https://api.mistral.ai/v1", keyEnv: "MISTRAL_API_KEY" },
  xai: { baseUrl: "https://api.x.ai/v1", keyEnv: "XAI_API_KEY" },
  fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1", keyEnv: "FIREWORKS_API_KEY" },
  ollama: { baseUrl: "http://127.0.0.1:11434/v1" },
  lmstudio: { baseUrl: "http://127.0.0.1:1234/v1" },
};

export interface ModelSpec {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

export function parseModelSpec(spec: string, env: NodeJS.ProcessEnv = process.env): ModelSpec {
  const slash = spec.indexOf("/");
  if (slash < 1) throw new Error(`model must look like "provider/model", got "${spec}"`);
  const provider = spec.slice(0, slash).toLowerCase();
  const model = spec.slice(slash + 1);
  if (provider === "anthropic") return { provider, model };
  if (provider === "custom") {
    if (!env.MOMO_MODEL_BASE_URL) throw new Error("custom/ models need MOMO_MODEL_BASE_URL");
    return { provider, model, baseUrl: env.MOMO_MODEL_BASE_URL, apiKey: env.MOMO_MODEL_API_KEY };
  }
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider "${provider}" (known: anthropic, custom, ${Object.keys(PROVIDERS).join(", ")})`);
  return { provider, model, baseUrl: env.MOMO_MODEL_BASE_URL ?? p.baseUrl, apiKey: p.keyEnv ? env[p.keyEnv] : undefined };
}

export function createPlanner(spec: string, env = process.env, fetchImpl: typeof fetch = fetch): Planner {
  const s = parseModelSpec(spec, env);
  return s.provider === "anthropic" ? new ClaudePlanner(undefined, s.model) : new OpenAICompatiblePlanner(s, fetchImpl);
}

export function createAnswerer(spec: string, env = process.env, fetchImpl: typeof fetch = fetch): Answerer {
  const s = parseModelSpec(spec, env);
  return s.provider === "anthropic" ? new ClaudeAnswerer(undefined, s.model) : new OpenAICompatibleAnswerer(s, fetchImpl);
}

// ---- OpenAI-compatible chat completions ------------------------------------

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

/** Momo's internal turns -> chat messages. Provider-specific blocks (e.g. thinking) are dropped. */
export function toChatMessages(system: string, history: Turn[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const turn of history) {
    if (turn.role === "assistant") {
      const text = turn.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
      const calls = turn.content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length && { tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.input) } })) }),
      });
    } else {
      // Tool messages must directly follow their calls; images go in one user message after them.
      const images: string[] = [];
      for (const b of turn.content) {
        if (b.type === "tool_result") {
          const r = b as Extract<Block, { type: "tool_result" }>;
          let text: string;
          if (Array.isArray(r.content)) {
            text = r.content.map((p) => (p.type === "text" ? p.text : "[image attached below]")).join("\n");
            for (const p of r.content) if (p.type === "image") images.push(`data:${p.source.media_type};base64,${p.source.data}`);
          } else {
            text = r.content;
          }
          out.push({ role: "tool", tool_call_id: r.tool_use_id, content: r.is_error ? `ERROR: ${text}` : text });
        } else if (b.type === "text") {
          out.push({ role: "user", content: (b as { text: string }).text });
        }
      }
      if (images.length) {
        out.push({ role: "user", content: [{ type: "text", text: "Screenshot:" }, ...images.map((url) => ({ type: "image_url" as const, image_url: { url } }))] });
      }
    }
  }
  return out;
}

/** A chat completion -> Momo blocks. Tolerates models that return malformed tool JSON. */
export function fromChatChoice(message: { content?: string | null; tool_calls?: Array<{ id?: string; function: { name: string; arguments: string } }> }): Block[] {
  const blocks: Block[] = [];
  if (message.content?.trim()) blocks.push({ type: "text", text: message.content });
  for (const [i, c] of (message.tool_calls ?? []).entries()) {
    let input: Record<string, unknown>;
    try {
      input = c.function.arguments ? (JSON.parse(c.function.arguments) as Record<string, unknown>) : {};
    } catch {
      input = {};
    }
    blocks.push({ type: "tool_use", id: c.id || `call_${Date.now()}_${i}`, name: c.function.name, input });
  }
  return blocks;
}

/** Rate limits and overloads are routine (especially on free tiers): retry with backoff. */
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRIES = 5;

async function chat(s: ModelSpec, fetchImpl: typeof fetch, body: Record<string, unknown>, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetchImpl(`${s.baseUrl!.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(s.apiKey && { authorization: `Bearer ${s.apiKey}` }) },
      body: JSON.stringify({ model: s.model, ...body }),
      signal: AbortSignal.timeout(180_000),
    });
    if (res.ok || !RETRY_STATUS.has(res.status) || attempt >= RETRIES) break;
    const after = Number(res.headers.get("retry-after"));
    await res.body?.cancel();
    await sleep(after > 0 ? Math.min(after, 60) * 1000 : Math.min(2 ** attempt * 2000, 30_000) * (0.75 + Math.random() / 2));
  }
  if (!res.ok) throw new Error(`${s.provider} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { choices: Array<{ message: Parameters<typeof fromChatChoice>[0] }> };
  return json.choices[0]!.message;
}

export class OpenAICompatiblePlanner implements Planner {
  private readonly s: ModelSpec;
  private readonly fetchImpl: typeof fetch;
  constructor(s: ModelSpec, fetchImpl: typeof fetch = fetch) {
    this.s = s;
    this.fetchImpl = fetchImpl;
  }
  async next(system: string, history: Turn[], tools: ToolSpec[]): Promise<Block[]> {
    const message = await chat(this.s, this.fetchImpl, {
      messages: toChatMessages(system, history),
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
      tool_choice: "auto",
    });
    return fromChatChoice(message);
  }
}

export class OpenAICompatibleAnswerer implements Answerer {
  private readonly s: ModelSpec;
  private readonly fetchImpl: typeof fetch;
  constructor(s: ModelSpec, fetchImpl: typeof fetch = fetch) {
    this.s = s;
    this.fetchImpl = fetchImpl;
  }
  async answer(question: string, context: string): Promise<string> {
    const message = await chat(this.s, this.fetchImpl, {
      messages: [
        { role: "system", content: `You are Momo, a personal assistant people text. Plain text, no Markdown, 1-4 short lines, answer first.\n${context}` },
        { role: "user", content: question },
      ],
    });
    return (message.content ?? "").trim();
  }
}
