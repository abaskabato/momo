// Claude as the web agent's planner and as the general answerer for messages
// that aren't errands ("what time does Costco close?").

import Anthropic from "@anthropic-ai/sdk";
import type { Block, Planner, Spent, ToolSpec, Turn } from "./agent.ts";

const DEFAULT_MODEL = "claude-opus-5-5";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** The model's safety filter declined to go on with an errand. */
export class PlannerRefused extends Error {}

export class ClaudePlanner implements Planner {
  private readonly client: Anthropic;
  private readonly model: string;
  /** How hard the model thinks at each step. Each step is a small move on a web page, so medium (MOMO_EFFORT to change). */
  private readonly effort: Effort;
  readonly spent: Spent = { input: 0, cached: 0, output: 0 };

  constructor(client = new Anthropic(), model = DEFAULT_MODEL, effort: Effort = "medium") {
    this.client = client;
    this.model = model;
    this.effort = effort;
  }

  /**
   * Claude's thinking blocks are only valid while everything before them is sent back exactly as it was,
   * so the errand's history must not be trimmed on this side. Old page views are cleared by the API instead.
   */
  readonly keepsOwnContext = true;
  /** Ask the API to drop thinking blocks that no longer match the conversation instead of failing the errand. */
  private dropMismatched = true;

  async next(system: string, history: Turn[], tools: ToolSpec[]): Promise<Block[]> {
    const ask = () =>
      this.client.beta.messages.create({
        model: this.model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01", "context-management-2025-06-27", ...(this.dropMismatched ? ["thinking-binding-controls-2026-08-01"] : [])],
        ...(this.dropMismatched && { thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } } as unknown as Anthropic.Beta.BetaThinkingConfigParam }),
        fallbacks: "default",
        output_config: { effort: this.effort },
        // Every step resends the whole errand. The instructions and tools are cached once for all errands
        // (the marker on the system prompt), and the errand so far is cached step to step (the top-level
        // marker), so each step pays full price only for what is new.
        cache_control: { type: "ephemeral" },
        // Old page views are cleared on the server, which doesn't count as editing the conversation. Each clear
        // rewrites the cache, so it waits until there is a lot to clear and then clears a lot at once.
        context_management: {
          edits: [{
            type: "clear_tool_uses_20250919",
            trigger: { type: "input_tokens", value: 50_000 },
            keep: { type: "tool_uses", value: 4 },
            clear_at_least: { type: "input_tokens", value: 20_000 },
          }],
        },
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools: tools as Anthropic.Beta.BetaTool[],
        // Thinking blocks are passed back unchanged, as the API requires.
        messages: history as Anthropic.Beta.BetaMessageParam[],
      });
    let response: Awaited<ReturnType<typeof ask>>;
    try {
      try {
        response = await ask();
      } catch (e) {
        // A model or platform that doesn't take that setting: carry on without it.
        if (!this.dropMismatched || !(e instanceof Anthropic.BadRequestError) || !/block_binding|thinking-binding-controls|anthropic-beta/i.test(e.message)) throw e;
        this.dropMismatched = false;
        response = await ask();
      }
    } catch (e) {
      // History from before this rule was kept (an errand saved by an older Momo, or one cut down to fit a
      // small allowance): the documented recovery is to drop the thinking blocks and ask once more.
      if (!(e instanceof Anthropic.BadRequestError) || !/thinking/i.test(e.message) || !/signature|bound to a different conversation/i.test(e.message)) throw e;
      for (const turn of history) {
        if (turn.role === "assistant") turn.content = turn.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
      }
      response = await ask();
    }
    const u = response.usage;
    if (u) {
      this.spent.input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      this.spent.cached += u.cache_read_input_tokens ?? 0;
      this.spent.output += u.output_tokens ?? 0;
    }
    // Say in the log when reasoning had to be dropped, and where, so the cause can be found.
    const dropped = (response as unknown as { input_transformations?: Array<{ type: string; path?: string; reason?: string }> }).input_transformations ?? [];
    if (dropped.length) console.warn(`claude: ${dropped.length} thinking block(s) no longer matched the conversation (first: ${dropped[0]!.path} ${dropped[0]!.reason ?? dropped[0]!.type})`);
    // The model's safety filter stopped the errand. End it and say so; returning a sentence here would be
    // taken as a question to the owner, and every reply would run into the same wall.
    if (response.stop_reason === "refusal") {
      const why = (response as unknown as { stop_details?: { category?: string | null } }).stop_details?.category;
      throw new PlannerRefused(`the AI declined to continue${why ? ` (${why})` : ""}`);
    }
    return response.content as Block[];
  }
}

const ANSWER_SYSTEM = `You are Momo, a personal assistant people text on Telegram or WhatsApp.
Answer in plain text, no Markdown, 1-4 short lines, the answer first. Use web search for anything current.
Don't offer to do things and wait for a "go ahead", and don't ask the owner to confirm what they already asked for.`;

export class ClaudeAnswerer {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(client = new Anthropic(), model = DEFAULT_MODEL) {
    this.client = client;
    this.model = model;
  }

  async answer(question: string, context: string): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4000,
      output_config: { effort: "low" },
      system: `${ANSWER_SYSTEM}\n${context}`,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
      messages: [{ role: "user", content: question }],
    });
    if (response.stop_reason === "refusal") return "I can't help with that one.";
    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }
}
