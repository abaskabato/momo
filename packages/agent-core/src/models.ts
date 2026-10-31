// Model routing. Open models run on the device (Ollama) and handle the bulk:
// intent extraction, short replies, and writing minimal-disclosure queries.
// The frontier model is reserved for hard reasoning, and every call to it
// goes through the privacy layer (privacy.ts): redacted + optionally
// rewritten on-device, sent over a pluggable transport/payment, rehydrated
// locally. Vault values are never part of any prompt.

import Anthropic from "@anthropic-ai/sdk";
import {
  directTransport,
  minimize,
  MINIMAL_DISCLOSURE_SYSTEM,
  recordReceipt,
  rehydrateDeep,
  type CredentialSource,
  type Entity,
  type PrivacyReceipt,
  type Transport,
} from "./privacy.ts";
import type { Doc } from "./store.ts";

export type Tier = "local" | "frontier";

export interface JsonRequest {
  tier: Tier;
  system: string;
  prompt: string;
  /** JSON Schema the reply must satisfy. */
  schema: Record<string, unknown>;
}

export interface ModelRouterConfig {
  /** Ollama base URL, e.g. http://127.0.0.1:11434. Unset = no local model. */
  ollamaUrl?: string;
  ollamaModel?: string;
  /** Use the frontier model at all (needs Anthropic credentials). */
  frontier?: boolean;
  frontierModel?: string;
  privacy?: {
    /** Owner/contacts/places to hide; usually loaded from local memory. */
    entities?: () => Promise<Entity[]>;
    transport?: Transport;
    /** Payment layer; default is the SDK's own credential resolution. */
    credentials?: CredentialSource;
    /** Let the local model rewrite outbound prompts (hides writing style). */
    localRewrite?: boolean;
    rewriteBudgetMs?: number;
    receipts?: Doc<PrivacyReceipt[]>;
  };
}

export class ModelRouter {
  private readonly cfg: ModelRouterConfig;
  private anthropic: Anthropic | null = null;

  constructor(cfg: ModelRouterConfig) {
    this.cfg = cfg;
  }

  get available(): Tier[] {
    const t: Tier[] = [];
    if (this.cfg.ollamaUrl) t.push("local");
    if (this.cfg.frontier) t.push("frontier");
    return t;
  }

  /** Falls through to the other tier if the requested one isn't configured. */
  async json<T>(req: JsonRequest): Promise<T> {
    const tiers = this.available;
    if (tiers.length === 0) throw new Error("no model configured");
    const tier = tiers.includes(req.tier) ? req.tier : tiers[0]!;
    return tier === "local" ? this.ollamaJson<T>(req) : this.claude<T>(req);
  }

  private async ollamaChat(system: string, prompt: string, format?: Record<string, unknown>): Promise<string> {
    const res = await fetch(`${this.cfg.ollamaUrl!.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.cfg.ollamaModel ?? "qwen3:8b",
        stream: false,
        format,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    return ((await res.json()) as { message: { content: string } }).message.content;
  }

  private async ollamaJson<T>(req: JsonRequest): Promise<T> {
    return JSON.parse(await this.ollamaChat(req.system, req.prompt, req.schema)) as T;
  }

  private async claude<T>(req: JsonRequest): Promise<T> {
    const p = this.cfg.privacy ?? {};
    const transport = p.transport ?? directTransport;
    this.anthropic ??= new Anthropic({ fetch: transport.fetch });

    const canRewrite = p.localRewrite && this.cfg.ollamaUrl;
    const outbound = await minimize(req.prompt, {
      entities: (await p.entities?.()) ?? [],
      rewrite: canRewrite ? (t) => this.ollamaChat(MINIMAL_DISCLOSURE_SYSTEM, t) : undefined,
      rewriteBudgetMs: p.rewriteBudgetMs,
    });

    const model = this.cfg.frontierModel ?? "claude-opus-5-5";
    const headers = (await p.credentials?.headersFor()) ?? undefined;
    const response = await this.anthropic.beta.messages.create(
      {
        model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "high", format: { type: "json_schema", schema: req.schema } },
        system: `${req.system}\nTokens like [PERSON_1] stand for private values; use them verbatim where needed.`,
        messages: [{ role: "user", content: outbound.text }],
      },
      headers ? { headers } : undefined,
    );

    if (p.receipts) {
      await recordReceipt(p.receipts, {
        at: Date.now(),
        destination: `anthropic:${model}`,
        transport: transport.name,
        payment: p.credentials?.name ?? "api-key",
        rewritten: outbound.rewritten,
        redactedKinds: [...new Set([...outbound.map.keys()].map((k) => k.replace(/_\d+\]$/, "").slice(1)))],
        sentChars: outbound.text.length,
        sent: outbound.text,
      });
    }

    if (response.stop_reason === "refusal") throw new Error("the model declined this request");
    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new Error("no text in model response");
    return rehydrateDeep(JSON.parse(text.text), outbound.map) as T;
  }
}
