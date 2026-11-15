// Claude's rules for an errand's history: send it back untouched, let the API
// clear old page views, and recover once if thinking blocks no longer match.
import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { ClaudePlanner } from "../src/skills/web/claude.ts";
import type { Turn } from "../src/skills/web/agent.ts";

test("Claude: history is not trimmed on this side; a thinking-block mismatch is recovered by dropping the blocks once", async () => {
  const bodies: Array<{ messages: Turn[]; betas: string[]; context_management: unknown }> = [];
  let fail = true;
  const client = {
    beta: {
      messages: {
        create: async (body: { messages: Turn[]; betas: string[]; context_management: unknown }) => {
          bodies.push(JSON.parse(JSON.stringify(body)));
          if (fail) {
            fail = false;
            throw new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation." } }, undefined, new Headers());
          }
          return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "read_page", input: {} }] };
        },
      },
    },
  } as unknown as Anthropic;
  const planner = new ClaudePlanner(client, "claude-haiku-5-5");
  assert.equal(planner.keepsOwnContext, true, "the agent must not trim this planner's history");

  const history: Turn[] = [
    { role: "user", content: [{ type: "text", text: "Errand: book a table" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "t1", name: "goto", input: { url: "https://example.com" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Opened." }] },
  ];
  const blocks = await planner.next("system", history, []);
  assert.equal((blocks[0] as { name: string }).name, "read_page");
  assert.equal(bodies.length, 2, "asked once more");
  assert.ok(bodies[0]!.messages[1]!.content.some((b) => b.type === "thinking"), "first sent as it was");
  assert.ok(!bodies[1]!.messages[1]!.content.some((b) => b.type === "thinking"), "then without the thinking blocks");
  assert.ok(bodies[1]!.messages[1]!.content.some((b) => b.type === "tool_use"), "tool calls stay");
  assert.ok(bodies[0]!.betas.includes("context-management-2025-06-27"));
  assert.deepEqual(bodies[0]!.context_management, { edits: [{ type: "clear_tool_uses_20250919" }] });

  // Other errors are not swallowed.
  const broken = new ClaudePlanner({ beta: { messages: { create: async () => { throw new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "max_tokens: too large" } }, undefined, new Headers()); } } } } as unknown as Anthropic);
  await assert.rejects(broken.next("system", history, []), /max_tokens/);
});
