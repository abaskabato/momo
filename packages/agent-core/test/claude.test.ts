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
  // Old page views are cleared on the server, in large batches so the cache isn't rewritten every step.
  assert.deepEqual(bodies[0]!.context_management, { edits: [{ type: "clear_tool_uses_20250919", trigger: { type: "input_tokens", value: 50_000 }, keep: { type: "tool_uses", value: 4 }, clear_at_least: { type: "input_tokens", value: 20_000 } }] });
  // The instructions and tools are cached across errands, and each errand's history step to step.
  assert.deepEqual((bodies[0] as unknown as { system: unknown }).system, [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }]);
  assert.deepEqual((bodies[0] as unknown as { cache_control: unknown }).cache_control, { type: "ephemeral" });
  assert.deepEqual((bodies[0] as unknown as { output_config: unknown }).output_config, { effort: "medium" });
  // Every request asks the API to drop reasoning that no longer matches, rather than fail the errand.
  assert.ok(bodies[0]!.betas.includes("thinking-binding-controls-2026-08-01"));
  assert.deepEqual((bodies[0] as unknown as { thinking: unknown }).thinking, { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });

  // A model that doesn't accept that setting: Momo stops sending it and carries on.
  const seen: Array<{ thinking?: unknown }> = [];
  const old = new ClaudePlanner({ beta: { messages: { create: async (body: { thinking?: unknown }) => {
    seen.push(body);
    if (body.thinking) throw new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "thinking.block_binding: Extra inputs are not permitted" } }, undefined, new Headers());
    return { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] };
  } } } } as unknown as Anthropic);
  assert.equal(((await old.next("system", history, []))[0] as { text: string }).text, "ok");
  await old.next("system", history, []);
  assert.equal(seen.filter((b) => b.thinking).length, 1, "only tried once");

  // Other errors are not swallowed.
  const broken = new ClaudePlanner({ beta: { messages: { create: async () => { throw new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "max_tokens: too large" } }, undefined, new Headers()); } } } } as unknown as Anthropic);
  await assert.rejects(broken.next("system", history, []), /max_tokens/);

  // A refusal ends the errand with an explanation instead of becoming a question that loops.
  const refusing = new ClaudePlanner({ beta: { messages: { create: async () => ({ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] }) } } } as unknown as Anthropic);
  await assert.rejects(refusing.next("system", history, []), /the AI declined to continue \(cyber\)/);
  const { failureText, STOP } = await import("../src/assistant.ts");
  assert.match(failureText(new Error("the AI declined to continue (cyber)")), /I've stopped this errand: my AI declined to continue \(cyber\)\. Nothing was booked/);
  for (const yes of ["stop", "STOP", "can you stop it", "please stop", "stop that now", "cancel it", "never mind", "ok stop", "could you please cancel that?"]) assert.ok(STOP.test(yes), yes);
  for (const no of ["stop by the pharmacy and get my refill", "cancel my gym membership", "don't stop", "book a table"]) assert.ok(!STOP.test(no), no);
});
