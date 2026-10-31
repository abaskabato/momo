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

  async next(system: string, history: Turn[], tools: ToolSpec[]): Promise<Block[]> {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "high" },
      system,
      tools: tools as Anthropic.Beta.BetaTool[],
      // Thinking blocks are passed back unchanged, as the API requires.
      messages: history as Anthropic.Beta.BetaMessageParam[],
    });
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
