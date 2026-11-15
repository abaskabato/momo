// Claude as the web agent's planner and as the general answerer for messages
// that aren't errands ("what time does Costco close?").

import Anthropic from "@anthropic-ai/sdk";
import type { Block, Planner, ToolSpec, Turn } from "./agent.ts";

const DEFAULT_MODEL = "claude-opus-5-5";

export class ClaudePlanner implements Planner {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(client = new Anthropic(), model = DEFAULT_MODEL) {
    this.client = client;
    this.model = model;
  }

  /**
   * Claude's thinking blocks are only valid while everything before them is sent back exactly as it was,
   * so the errand's history must not be trimmed on this side. Old page views are cleared by the API instead.
   */
  readonly keepsOwnContext = true;

  async next(system: string, history: Turn[], tools: ToolSpec[]): Promise<Block[]> {
    const ask = () =>
      this.client.beta.messages.create({
        model: this.model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01", "context-management-2025-06-27"],
        fallbacks: "default",
        output_config: { effort: "high" },
        // Server-side clearing of old tool results doesn't count as editing the conversation.
        context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
        system,
        tools: tools as Anthropic.Beta.BetaTool[],
        // Thinking blocks are passed back unchanged, as the API requires.
        messages: history as Anthropic.Beta.BetaMessageParam[],
      });
    let response: Awaited<ReturnType<typeof ask>>;
    try {
      response = await ask();
    } catch (e) {
      // History from before this rule was kept (an errand saved by an older Momo, or one cut down to fit a
      // small allowance): the documented recovery is to drop the thinking blocks and ask once more.
      if (!(e instanceof Anthropic.BadRequestError) || !/thinking/i.test(e.message) || !/signature|bound to a different conversation/i.test(e.message)) throw e;
      for (const turn of history) {
        if (turn.role === "assistant") turn.content = turn.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
      }
      response = await ask();
    }
    if (response.stop_reason === "refusal") return [{ type: "text", text: "I can't help with that one." }];
    return response.content as Block[];
  }
}

const ANSWER_SYSTEM = `You are Momo, a personal assistant people text on Telegram or WhatsApp.
Answer in plain text, no Markdown, 1-4 short lines, the answer first. Use web search for anything current.
If the message is an errand you could do on a website, say what you'd do and ask them to confirm by saying "go ahead".`;

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
