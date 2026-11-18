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

import type { Block, Planner, Spent, ToolSpec, Turn } from "./skills/web/agent.ts";
import { ClaudeAnswerer, ClaudePlanner, type Effort } from "./skills/web/claude.ts";

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
  let model = spec.slice(slash + 1).trim();
  // "groq/groq/llama-…" happens when the provider is typed into the model name too; forgive it.
  if (model.toLowerCase().startsWith(`${provider}/`)) model = model.slice(provider.length + 1);
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
  // Hybrid: MOMO_FRONTIER_MODEL takes over the steps the main (usually local) model can't manage.
  const frontier = env.MOMO_FRONTIER_MODEL?.trim();
  if (frontier && frontier !== spec) return new HybridPlanner(createOnePlanner(spec, env, fetchImpl), createOnePlanner(frontier, env, fetchImpl), frontier);
  return createOnePlanner(spec, env, fetchImpl);
}

function createOnePlanner(spec: string, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): Planner {
  const s = parseModelSpec(spec, env);
  if (s.provider === "ollama") return new OllamaPlanner(s, localOptions(env), fetchImpl);
  const effort = (["low", "medium", "high", "xhigh", "max"].includes(env.MOMO_EFFORT ?? "") ? env.MOMO_EFFORT : "medium") as Effort;
  return s.provider === "anthropic" ? new ClaudePlanner(undefined, s.model, effort) : new OpenAICompatiblePlanner(s, fetchImpl);
}

/**
 * Small or local models (a few billion parameters, or anything served by Ollama or LM Studio without a size in
 * its name) get the light errand loop: shorter instructions, fewer tools, smaller page views.
 */
export function isSmallModel(spec: string): boolean {
  const s = spec.toLowerCase();
  const size = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z0-9])/.exec(s.slice(s.indexOf("/") + 1));
  if (size) return Number(size[1]) <= 9;
  return /^(ollama|lmstudio)\//.test(s);
}

export function createAnswerer(spec: string, env = process.env, fetchImpl: typeof fetch = fetch): Answerer {
  const s = parseModelSpec(spec, env);
  if (s.provider === "ollama") return new OllamaAnswerer(s, localOptions(env), fetchImpl);
  return s.provider === "anthropic" ? new ClaudeAnswerer(undefined, s.model) : new OpenAICompatibleAnswerer(s, fetchImpl);
}

// ---- OpenAI-compatible chat completions ------------------------------------

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> }
  | { role: "assistant"; content: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string }; extra_content?: unknown }> }
  | { role: "tool"; tool_call_id: string; content: string };

/** Momo's internal turns -> chat messages. Provider-specific blocks (e.g. thinking) are dropped. */
export function toChatMessages(system: string, history: Turn[], opts: { images?: boolean } = {}): ChatMessage[] {
  const withImages = opts.images !== false;
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const turn of history) {
    if (turn.role === "assistant") {
      const text = turn.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
      const calls = turn.content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
      out.push({
        role: "assistant",
        // An empty string, not null: some providers insist every message's content is a string.
        content: text,
        ...(calls.length && { tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.input) }, ...(c.extra !== undefined && { extra_content: c.extra }) })) }),
      });
    } else {
      // Tool messages must directly follow their calls; images go in one user message after them.
      const images: string[] = [];
      for (const b of turn.content) {
        if (b.type === "tool_result") {
          const r = b as Extract<Block, { type: "tool_result" }>;
          let text: string;
          if (Array.isArray(r.content)) {
            text = r.content.map((p) => (p.type === "text" ? p.text : withImages ? "[image attached below]" : "[This model can't see images. Use read_page or computer_read instead of screenshots.]")).join("\n");
            if (withImages) for (const p of r.content) if (p.type === "image") images.push(`data:${p.source.media_type};base64,${p.source.data}`);
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
export function fromChatChoice(message: { content?: string | null; tool_calls?: Array<{ id?: string; function: { name: string; arguments: string }; extra_content?: unknown }> }): Block[] {
  const blocks: Block[] = [];
  if (message.content?.trim()) blocks.push({ type: "text", text: message.content });
  type Call = { id?: string; function: { name: string; arguments: string }; extra_content?: unknown };
  const calls: Call[] = message.tool_calls?.length ? message.tool_calls : textToolCalls(message.content ?? "");
  if (!message.tool_calls?.length && calls.length) blocks.length = 0; // the text was the call, not a message
  for (const [i, c] of calls.entries()) {
    let input: Record<string, unknown>;
    try {
      input = c.function.arguments ? (JSON.parse(c.function.arguments) as Record<string, unknown>) : {};
    } catch {
      input = {};
    }
    // Gemini signs each call and refuses the next request unless the signature comes back with it.
    blocks.push({ type: "tool_use", id: c.id || `call_${Date.now()}_${i}`, name: c.function.name, input, ...(c.extra_content !== undefined && { extra: c.extra_content }) });
  }
  return blocks;
}

/** The request was bigger than this model or key allows (small free tiers, small context windows). */
export class RequestTooLarge extends Error {
  /** The allowance in tokens, when the provider says. */
  limit?: number;
  constructor(message: string, limit?: number) {
    super(message);
    this.limit = limit;
  }
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
  if (!res.ok) {
    const raw = await res.text();
    // The website's shared AI after the free week: its message (with the link to pay) is what the person reads.
    if (res.status === 402) {
      const said = (() => { try { return (JSON.parse(raw) as { message?: string }).message; } catch { return undefined; } })();
      throw new Error(said && /free week/i.test(said) ? said : `${s.provider} 402: ${raw.slice(0, 300)}`);
    }
    const text = raw.slice(0, 300);
    const message = `${s.provider} ${res.status}: ${text}`;
    if (res.status === 413 || (res.status === 400 && /too large|context.{0,12}length|maximum context|too many tokens|reduce (your|the) (message|prompt|length)/i.test(text))) {
      const limit = /limit:?\s*(\d{3,})/i.exec(text)?.[1];
      throw new RequestTooLarge(message, limit ? Number(limit) : undefined);
    }
    throw new Error(message);
  }
  const json = (await res.json()) as {
    choices: Array<{ message: Parameters<typeof fromChatChoice>[0] }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  };
  return { message: json.choices[0]!.message, usage: json.usage };
}

export class OpenAICompatiblePlanner implements Planner {
  private readonly s: ModelSpec;
  private readonly fetchImpl: typeof fetch;
  /** Turned off the first time the model refuses an image; many fast models are text-only. */
  private images = true;
  readonly spent: Spent = { input: 0, cached: 0, output: 0 };
  constructor(s: ModelSpec, fetchImpl: typeof fetch = fetch) {
    this.s = s;
    this.fetchImpl = fetchImpl;
  }
  async next(system: string, history: Turn[], tools: ToolSpec[]): Promise<Block[]> {
    const ask = async () => {
      const { message, usage } = await chat(this.s, this.fetchImpl, {
        messages: toChatMessages(system, history, { images: this.images }),
        tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
        tool_choice: "auto",
      });
      if (usage) {
        const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
        this.spent.input += (usage.prompt_tokens ?? 0) - cached;
        this.spent.cached += cached;
        this.spent.output += usage.completion_tokens ?? 0;
      }
      return fromChatChoice(message);
    };
    try {
      return await ask();
    } catch (e) {
      // A text-only model rejects the screenshot message. Carry on without pictures instead of failing the errand.
      if (!this.images || !/\b400\b/.test((e as Error).message) || !/content must be a string|image|vision|multimodal|multi-modal/i.test((e as Error).message)) throw e;
      this.images = false;
      return await ask();
    }
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
    const { message } = await chat(this.s, this.fetchImpl, {
      messages: [
        { role: "system", content: `You are Momo, a personal assistant people text. Plain text, no Markdown, 1-4 short lines, answer first. If they ask what happened with something, answer from the recent conversation below and be honest: never claim something was booked, bought or done unless the conversation shows it was.\n${context}` },
        { role: "user", content: question },
      ],
    });
    return (message.content ?? "").trim();
  }
}

/**
 * Small local models sometimes write a tool call out as text instead of making it, e.g.
 * <tool_call>{"name": "click", "arguments": {"ref": 3}}</tool_call>. Read those as the calls they are.
 */
export function textToolCalls(text: string): Array<{ function: { name: string; arguments: string } }> {
  const found: Array<{ function: { name: string; arguments: string } }> = [];
  const tagged = [...text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)].map((m) => m[1]!);
  const bare = text.trim().startsWith("{") && text.trim().endsWith("}") ? [text.trim()] : [];
  for (const raw of tagged.length ? tagged : bare) {
    try {
      const j = JSON.parse(raw) as { name?: unknown; arguments?: unknown; parameters?: unknown };
      if (typeof j.name !== "string") continue;
      const args = j.arguments ?? j.parameters ?? {};
      found.push({ function: { name: j.name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
    } catch {
      // Not a tool call after all.
    }
  }
  return found;
}

// ---- Ollama, through its own API -------------------------------------------
// Ollama's own /api/chat, not its OpenAI-style endpoint, because only here can Momo say how much context the
// model gets (Ollama gives 4k by default on most computers, which cuts off the start of an errand's prompt),
// turn thinking off (small Qwen models think at length before every step), and keep the model loaded between
// steps. See https://docs.ollama.com/api/chat and https://docs.ollama.com/context-length.

export interface LocalOptions {
  /** Context window in tokens (MOMO_LOCAL_CONTEXT, default 16384). */
  context: number;
  /** Let the model think before each step (MOMO_LOCAL_THINK=1). Off by default: much faster. */
  think: boolean;
  /** How long Ollama keeps the model in memory after a request. */
  keepAlive: string;
}

export function localOptions(env: NodeJS.ProcessEnv = process.env): LocalOptions {
  return {
    context: Math.max(4096, Number(env.MOMO_LOCAL_CONTEXT) || 16384),
    think: env.MOMO_LOCAL_THINK === "1",
    keepAlive: env.MOMO_LOCAL_KEEP_ALIVE || "30m",
  };
}

type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
};

/** Momo's turns -> Ollama messages: tool arguments as objects, images as bare base64, results named after their tool. */
export function toOllamaMessages(system: string, history: Turn[], opts: { images?: boolean } = {}): OllamaMessage[] {
  const names = new Map<string, string>();
  for (const turn of history) {
    for (const b of turn.content) if (b.type === "tool_use") names.set((b as Extract<Block, { type: "tool_use" }>).id, (b as Extract<Block, { type: "tool_use" }>).name);
  }
  const out: OllamaMessage[] = [];
  for (const m of toChatMessages(system, history, opts)) {
    if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content,
        ...(m.tool_calls?.length && { tool_calls: m.tool_calls.map((c) => ({ function: { name: c.function.name, arguments: safeJson(c.function.arguments) } })) }),
      });
    } else if (m.role === "tool") {
      out.push({ role: "tool", content: m.content, ...(names.has(m.tool_call_id) && { tool_name: names.get(m.tool_call_id) }) });
    } else if (m.role === "user" && Array.isArray(m.content)) {
      const text = m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
      const images = m.content.filter((p) => p.type === "image_url").map((p) => (p as { image_url: { url: string } }).image_url.url.replace(/^data:[^,]*,/, ""));
      out.push({ role: "user", content: text, ...(images.length && { images }) });
    } else {
      out.push({ role: m.role, content: m.content as string });
    }
  }
  return out;
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

type OllamaReply = {
  message?: { content?: string; thinking?: string; tool_calls?: Array<{ function: { name: string; arguments: unknown } }> };
  prompt_eval_count?: number;
  prompt_eval_cached_count?: number;
  eval_count?: number;
  error?: string;
};

async function ollamaChat(s: ModelSpec, o: LocalOptions, fetchImpl: typeof fetch, body: Record<string, unknown>): Promise<OllamaReply> {
  const base = s.baseUrl!.replace(/\/$/, "").replace(/\/v1$/, "");
  let res: Response;
  try {
    res = await fetchImpl(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: s.model, stream: false, keep_alive: o.keepAlive, options: { num_ctx: o.context }, ...body }),
      // A small model on an ordinary computer can take a while on a long page.
      signal: AbortSignal.timeout(600_000),
    });
  } catch (e) {
    if (/ECONNREFUSED|fetch failed/i.test(String((e as Error).cause ?? e))) throw new Error(`Ollama isn't running at ${base}. Start the Ollama app (or run: ollama serve).`);
    throw e;
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    if (res.status === 404 && /not found/i.test(text)) throw new Error(`Ollama doesn't have ${s.model} yet. Run: ollama pull ${s.model}`);
    throw new Error(`ollama ${res.status}: ${text}`);
  }
  return (await res.json()) as OllamaReply;
}

export class OllamaPlanner implements Planner {
  private readonly s: ModelSpec;
  private readonly o: LocalOptions;
  private readonly fetchImpl: typeof fetch;
  private images = true;
  /** Turned off the first time the model says it has no thinking setting. */
  private sendThink = true;
  readonly spent: Spent = { input: 0, cached: 0, output: 0 };
  constructor(s: ModelSpec, o: LocalOptions = localOptions({}), fetchImpl: typeof fetch = fetch) {
    this.s = s;
    this.o = o;
    this.fetchImpl = fetchImpl;
  }
  async next(system: string, history: Turn[], tools: ToolSpec[]): Promise<Block[]> {
    const ask = () =>
      ollamaChat(this.s, this.o, this.fetchImpl, {
        messages: toOllamaMessages(system, history, { images: this.images }),
        tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
        ...(this.sendThink && { think: this.o.think }),
      });
    let reply: OllamaReply;
    for (;;) {
      try {
        reply = await ask();
        break;
      } catch (e) {
        const msg = (e as Error).message;
        if (this.sendThink && /\b400\b/.test(msg) && /think/i.test(msg)) this.sendThink = false;
        else if (this.images && /\b(400|500)\b/.test(msg) && /image|vision|multimodal/i.test(msg)) this.images = false;
        else throw e;
      }
    }
    this.spent.input += reply.prompt_eval_count ?? 0;
    this.spent.cached += reply.prompt_eval_cached_count ?? 0;
    this.spent.output += reply.eval_count ?? 0;
    const m = reply.message ?? {};
    return fromChatChoice({
      content: m.content ?? "",
      tool_calls: (m.tool_calls ?? []).map((c) => ({ function: { name: c.function.name, arguments: typeof c.function.arguments === "string" ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}) } })),
    });
  }
}

export class OllamaAnswerer implements Answerer {
  private readonly s: ModelSpec;
  private readonly o: LocalOptions;
  private readonly fetchImpl: typeof fetch;
  constructor(s: ModelSpec, o: LocalOptions = localOptions({}), fetchImpl: typeof fetch = fetch) {
    this.s = s;
    this.o = o;
    this.fetchImpl = fetchImpl;
  }
  async answer(question: string, context: string): Promise<string> {
    const reply = await ollamaChat(this.s, this.o, this.fetchImpl, {
      think: false,
      messages: [
        { role: "system", content: `You are Momo, a personal assistant people text. Plain text, no Markdown, 1-4 short lines, answer first. If they ask what happened with something, answer from the recent conversation below and be honest: never claim something was booked, bought or done unless the conversation shows it was.\n${context}` },
        { role: "user", content: question },
      ],
    }).catch(async (e: Error) => {
      if (!/\b400\b/.test(e.message) || !/think/i.test(e.message)) throw e;
      return ollamaChat(this.s, this.o, this.fetchImpl, { messages: [{ role: "user", content: `${context}\n\n${question}` }] });
    });
    return (reply.message?.content ?? "").trim();
  }
}

// ---- Hybrid: a local model for the steps, a frontier model when it's beyond it ----------------------------------

/** Steps the frontier model keeps once it has taken over, before the local model gets another go. */
const HELP_STEPS = 3;

/**
 * The local model does each step; the frontier model takes the steps it can't: when the local model fails to
 * answer, answers with no usable tool call, repeats itself, or keeps hitting errors, and before anything final
 * (finishing the errand, spending money, placing a call), so "done" is only ever said after a second look.
 */
export class HybridPlanner implements Planner {
  readonly local: Planner;
  readonly frontier: Planner;
  private readonly frontierName: string;
  /** Per errand (keyed by its first turn): frontier steps left. */
  private readonly boost = new WeakMap<Turn, number>();
  /** How many steps each model took (for the log). */
  readonly steps = { local: 0, frontier: 0 };
  constructor(local: Planner, frontier: Planner, frontierName = "the frontier model") {
    this.local = local;
    this.frontier = frontier;
    this.frontierName = frontierName;
  }
  get spent(): Spent {
    const a = this.local.spent ?? { input: 0, cached: 0, output: 0 };
    const b = this.frontier.spent ?? { input: 0, cached: 0, output: 0 };
    return { input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output };
  }
  async next(system: string, history: Turn[], tools: ToolSpec[]): Promise<Block[]> {
    const key = history[0]!;
    const left = this.boost.get(key) ?? 0;
    if (left > 0) {
      this.boost.set(key, left - 1);
      return this.help(system, history, tools);
    }
    const why = stuck(history);
    if (why) return this.takeOver(key, why, system, history, tools);
    let blocks: Block[];
    try {
      blocks = await this.local.next(system, history, tools);
    } catch (e) {
      return this.takeOver(key, `the local model failed (${(e as Error).message.slice(0, 120)})`, system, history, tools);
    }
    const bad = unusable(blocks, tools);
    if (bad) return this.takeOver(key, bad, system, history, tools);
    const final = blocks.find((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use" && FINAL_STEPS.has(String(b.name)));
    // Something final: the frontier model looks at the errand once and makes (or corrects) that step itself.
    if (final) {
      console.log(`hybrid: ${this.frontierName} checks the local model's ${final.name}`);
      return this.help(system, history, tools);
    }
    this.steps.local++;
    return blocks;
  }
  private takeOver(key: Turn, why: string, system: string, history: Turn[], tools: ToolSpec[]): Promise<Block[]> {
    console.log(`hybrid: ${this.frontierName} takes over for ${HELP_STEPS} steps: ${why}`);
    this.boost.set(key, HELP_STEPS - 1);
    return this.help(system, history, tools);
  }
  private help(system: string, history: Turn[], tools: ToolSpec[]): Promise<Block[]> {
    this.steps.frontier++;
    return this.frontier.next(system, history, tools);
  }
}

/** Steps that end the errand or can't be taken back. */
const FINAL_STEPS = new Set(["finish", "request_approval", "fill_card", "call_phone"]);

/** Why the errand looks stuck from its history, or "" if it doesn't. */
export function stuck(history: Turn[]): string {
  const results = history.filter((t) => t.role === "user" && t.content.some((b) => b.type === "tool_result"));
  const failed = (t: Turn) => t.content.some((b) => b.type === "tool_result" && (b as { is_error?: boolean }).is_error);
  if (results.length >= 2 && results.slice(-2).every(failed)) return "two steps in a row went wrong";
  const last = history.at(-1);
  if (last?.role === "user" && last.content.some((b) => b.type === "text" && /^You returned nothing/.test((b as { text: string }).text))) return "the local model returned nothing";
  const moves = history.filter((t) => t.role === "assistant").slice(-3).map((t) =>
    JSON.stringify(t.content.filter((b) => b.type === "tool_use").map((b) => [(b as { name: string }).name, (b as { input: unknown }).input])),
  );
  if (moves.length === 3 && moves[0] !== "[]" && moves.every((m) => m === moves[0])) return "the local model is repeating the same step";
  return "";
}

/** Why a reply can't be used as the next step, or "" if it can. */
export function unusable(blocks: Block[], tools: ToolSpec[]): string {
  const calls = blocks.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
  const text = blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("").trim();
  if (!calls.length && !text) return "the local model returned nothing";
  for (const c of calls) {
    const spec = tools.find((t) => t.name === c.name);
    if (!spec) return `the local model called a tool that doesn't exist (${c.name})`;
    const required = (spec.input_schema.required as string[] | undefined) ?? [];
    const missing = required.filter((k) => c.input[k] === undefined || c.input[k] === "");
    if (missing.length) return `the local model left out ${missing.join(", ")} for ${c.name}`;
  }
  return "";
}
