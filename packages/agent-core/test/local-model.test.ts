// Small and local models: the light errand loop, and Ollama through its own API.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlanner, HybridPlanner, isSmallModel, OllamaPlanner, textToolCalls, toOllamaMessages } from "../src/llm.ts";
import type { Block, Planner, ToolSpec } from "../src/skills/web/agent.ts";
import { failureText } from "../src/assistant.ts";
import { detectMachine, ollamaHas, pickLocalModel, pullOllamaModel, resolveAutoModel } from "../src/local.ts";
import { forgetOldSteps, LITE_SYSTEM, WEB_SYSTEM, WEB_TOOLS, type Turn } from "../src/skills/web/agent.ts";

test("which models get the light loop", () => {
  for (const yes of ["ollama/qwen3.5:4b", "ollama/qwen2.5:3b", "groq/llama-3.1-8b-instant", "ollama/llama3.2", "lmstudio/some-model", "openrouter/qwen/qwen3-4b"]) assert.ok(isSmallModel(yes), yes);
  for (const no of ["anthropic/claude-opus-5-5", "gemini/gemini-flash-latest", "groq/openai/gpt-oss-120b", "ollama/qwen2.5:72b", "openai/gpt-4o"]) assert.ok(!isSmallModel(no), no);
  assert.ok(LITE_SYSTEM.length * 3 < WEB_SYSTEM.length, "the light instructions are a fraction of the full ones");
  assert.ok(WEB_TOOLS.length > 15);
});

test("Ollama: its own API, with a real context window, no thinking, the model kept loaded; tool calls round-trip", async () => {
  const bodies: Array<Record<string, any>> = [];
  let replies: Array<Record<string, unknown>> = [
    { message: { content: "", tool_calls: [{ function: { name: "click", arguments: { ref: 3 } } }] }, prompt_eval_count: 900, prompt_eval_cached_count: 2100, eval_count: 12 },
  ];
  const fetchImpl = (async (url: string, init: { body: string }) => {
    assert.equal(url, "http://127.0.0.1:11434/api/chat");
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(replies.shift()), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const planner = createPlanner("ollama/qwen3.5:4b", { MOMO_LOCAL_CONTEXT: "12000" }, fetchImpl);
  assert.ok(planner instanceof OllamaPlanner);
  const history: Turn[] = [
    { role: "user", content: [{ type: "text", text: "Errand: order paper towels" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "goto", input: { url: "https://shop.test" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "Opened https://shop.test" }] },
  ];
  const blocks = await planner.next("sys", history, [{ name: "click", description: "Click", input_schema: { type: "object" } }]);
  assert.deepEqual(blocks.map((b) => b.type === "tool_use" && [b.name, b.input]), [["click", { ref: 3 }]]);
  const b = bodies[0]!;
  assert.equal(b.model, "qwen3.5:4b");
  assert.equal(b.stream, false);
  assert.equal(b.think, false, "thinking off: much faster on a small model");
  assert.equal(b.keep_alive, "30m");
  assert.deepEqual(b.options, { num_ctx: 12000 });
  assert.deepEqual(b.messages[2], { role: "assistant", content: "", tool_calls: [{ function: { name: "goto", arguments: { url: "https://shop.test" } } }] }, "arguments as an object");
  assert.deepEqual(b.messages[3], { role: "tool", content: "Opened https://shop.test", tool_name: "goto" });
  assert.deepEqual(planner.spent, { input: 900, cached: 2100, output: 12 });

  // A model without a thinking setting: Momo stops sending it.
  let refusedThink = false;
  const picky = new OllamaPlanner({ provider: "ollama", model: "llama3.2", baseUrl: "http://127.0.0.1:11434/v1" }, undefined, (async (_u: string, init: { body: string }) => {
    if ("think" in JSON.parse(init.body)) { refusedThink = true; return new Response(JSON.stringify({ error: "\"llama3.2\" does not support thinking" }), { status: 400 }); }
    return new Response(JSON.stringify({ message: { content: "ok" } }));
  }) as unknown as typeof fetch);
  assert.deepEqual(await picky.next("sys", history, []), [{ type: "text", text: "ok" }]);
  assert.ok(refusedThink);

  // A model that isn't downloaded yet, and Ollama not running, say what to do.
  // A model Ollama doesn't have: Momo starts downloading it and says so, instead of "run ollama pull".
  const pulled: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const missingFetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith("/api/pull")) {
      pulled.push(JSON.parse(String(init?.body)).model);
      await held;
      return new Response('{"status":"success"}\n');
    }
    return new Response('{"error":"model \'qwen3.5:4b\' not found"}', { status: 404 });
  }) as unknown as typeof fetch;
  const missing = new OllamaPlanner({ provider: "ollama", model: "qwen3.5:4b", baseUrl: "http://127.0.0.1:11434/v1" }, undefined, missingFetch);
  await assert.rejects(missing.next("sys", history, []), /^Error: I'm still downloading my AI \(qwen3\.5:4b\)/);
  await assert.rejects(missing.next("sys", history, []), /still downloading/);
  assert.deepEqual(pulled, ["qwen3.5:4b"], "downloaded once, not once per text");
  assert.equal(failureText(new Error("I'm still downloading my AI (qwen3.5:4b). It's a few gigabytes, once; text me again in a few minutes.")), "I'm still downloading my AI (qwen3.5:4b). It's a few gigabytes, once; text me again in a few minutes.");
  release();
  const off = new OllamaPlanner({ provider: "ollama", model: "qwen3.5:4b", baseUrl: "http://127.0.0.1:11434/v1" }, undefined, (async () => { throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:11434") }); }) as unknown as typeof fetch);
  await assert.rejects(off.next("sys", history, []), /Ollama isn't running/);
});

test("a tool call written out as text still runs", () => {
  assert.deepEqual(textToolCalls('Let me click it.\n<tool_call>\n{"name": "click", "arguments": {"ref": 7}}\n</tool_call>'), [{ function: { name: "click", arguments: '{"ref":7}' } }]);
  assert.deepEqual(textToolCalls('{"name": "finish", "arguments": {"message": "Ordered."}}'), [{ function: { name: "finish", arguments: '{"message":"Ordered."}' } }]);
  assert.deepEqual(textToolCalls("The page shows {three} results."), []);
  const msgs = toOllamaMessages("s", [{ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: [{ type: "text", text: "Screenshot" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } }] }] }]);
  assert.deepEqual(msgs.at(-1), { role: "user", content: "Screenshot:", images: ["QUJD"] }, "images go as bare base64");
});

test("small models forget old steps in a batch, so the start of the prompt stays the same between steps", () => {
  const h: Turn[] = [{ role: "user", content: [{ type: "text", text: "Errand" }] }];
  for (let i = 0; i < 10; i++) h.push({ role: "assistant", content: [{ type: "text", text: `a${i}` }] }, { role: "user", content: [{ type: "text", text: `r${i}` }] });
  forgetOldSteps(h, 20, 8);
  assert.equal(h.length, 21, "nothing dropped until past the limit");
  h.push({ role: "assistant", content: [{ type: "text", text: "a10" }] }, { role: "user", content: [{ type: "text", text: "r10" }] });
  forgetOldSteps(h, 20, 8);
  assert.equal(h.length, 9);
  assert.equal((h[0]!.content[0] as { text: string }).text, "Errand", "the errand itself is kept");
  assert.equal(h[1]!.role, "assistant");
  assert.equal((h.at(-1)!.content[0] as { text: string }).text, "r10");
});

test("hybrid: the local model does the steps; the frontier model takes the ones beyond it", async () => {
  const tools: ToolSpec[] = ["goto", "click", "finish"].map((name) => ({ name, description: name, input_schema: { type: "object", required: name === "click" ? ["ref"] : [] } }));
  const call = (name: string, input: Record<string, unknown> = {}): Block[] => [{ type: "tool_use", id: `${name}${Math.random()}`, name, input }];
  let localNext: () => Block[] = () => call("goto", { url: "https://a.test" });
  let frontierCalls = 0;
  const local: Planner = { next: async () => localNext(), spent: { input: 100, cached: 0, output: 5 } };
  const frontier: Planner = { next: async () => { frontierCalls++; return call("click", { ref: 1 }); }, spent: { input: 10, cached: 90, output: 2 } };
  const h = new HybridPlanner(local, frontier);
  const history: Turn[] = [{ role: "user", content: [{ type: "text", text: "Errand" }] }];

  assert.equal(((await h.next("s", history, tools))[0] as { name: string }).name, "goto", "ordinary steps stay local");
  assert.equal(frontierCalls, 0);

  // A call the local model can't make properly goes to the frontier model, which keeps the next steps too.
  localNext = () => call("click", {});
  await h.next("s", history, tools);
  assert.equal(frontierCalls, 1, "a click with no element: the frontier model takes it");
  await h.next("s", history, tools);
  await h.next("s", history, tools);
  assert.equal(frontierCalls, 3, "and keeps the next two steps");
  localNext = () => call("goto", { url: "https://b.test" });
  await h.next("s", history, tools);
  assert.equal(frontierCalls, 3, "then the local model gets another go");

  // Finishing is checked by the frontier model.
  localNext = () => call("finish", { message: "Ordered." });
  await h.next("s", history, tools);
  assert.equal(frontierCalls, 4);

  // A local model that is down or repeats itself hands over too.
  const other: Turn[] = [{ role: "user", content: [{ type: "text", text: "Another errand" }] }];
  localNext = () => { throw new Error("Ollama isn't running"); };
  await h.next("s", other, tools);
  assert.equal(frontierCalls, 5);
  const looping: Turn[] = [{ role: "user", content: [{ type: "text", text: "Third" }] }];
  for (let i = 0; i < 3; i++) looping.push({ role: "assistant", content: call("goto", { url: "https://same.test" }).map((b) => ({ ...b, id: "x" })) as Block[] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "Opened" }] });
  localNext = () => call("goto", { url: "https://same.test" });
  await h.next("s", looping, tools);
  assert.equal(frontierCalls, 6, "repeating the same step");
  assert.deepEqual(h.spent, { input: 110, cached: 90, output: 7 });

  // Configured with MOMO_FRONTIER_MODEL.
  assert.ok(createPlanner("ollama/qwen3.5:4b", { MOMO_FRONTIER_MODEL: "anthropic/claude-opus-5-5" }) instanceof HybridPlanner);
  assert.ok(!(createPlanner("ollama/qwen3.5:4b", {}) instanceof HybridPlanner));
});

test("ollama/auto: a Gemma 4 size that fits the computer; a named model is left alone", async () => {
  const pick = (m: Parameters<typeof pickLocalModel>[0]) => pickLocalModel(m).model;
  assert.equal(pick({ platform: "darwin", arch: "arm64", memoryGB: 8 }), "gemma4:e2b");
  assert.equal(pick({ platform: "darwin", arch: "arm64", memoryGB: 16 }), "gemma4:12b");
  assert.equal(pick({ platform: "darwin", arch: "arm64", memoryGB: 36 }), "gemma4:26b");
  assert.equal(pick({ platform: "darwin", arch: "x64", memoryGB: 16 }), "gemma4:e4b", "an Intel Mac runs it on the processor");
  assert.equal(pick({ platform: "win32", arch: "x64", memoryGB: 16 }), "gemma4:e4b", "no graphics card: a smaller model, or it's too slow");
  assert.equal(pick({ platform: "win32", arch: "x64", memoryGB: 8 }), "gemma4:e2b");
  assert.equal(pick({ platform: "win32", arch: "x64", memoryGB: 32, nvidiaGB: 12 }), "gemma4:12b");
  assert.equal(pick({ platform: "linux", arch: "x64", memoryGB: 64, nvidiaGB: 24 }), "gemma4:26b");
  assert.equal(pick({ platform: "linux", arch: "x64", memoryGB: 32, nvidiaGB: 4 }), "gemma4:e4b", "a small card is no help");

  const box = async () => ({ platform: "win32" as const, arch: "x64", memoryGB: 32, nvidiaGB: 12 });
  const auto = await resolveAutoModel("ollama/auto", box);
  assert.equal(auto.spec, "ollama/gemma4:12b");
  assert.match(auto.note!, /NVIDIA card with 12 GB/);
  assert.equal((await resolveAutoModel("ollama", box)).spec, "ollama/gemma4:12b");
  assert.deepEqual(await resolveAutoModel("ollama/qwen3.5:4b", box), { spec: "ollama/qwen3.5:4b" });
  assert.deepEqual(await resolveAutoModel("anthropic/claude-opus-5-5", box), { spec: "anthropic/claude-opus-5-5" });

  // nvidia-smi says MiB per card; no nvidia-smi means no card.
  assert.equal((await detectMachine(async () => "8192\n24576\n")).nvidiaGB ?? (process.platform === "darwin" ? undefined : -1), process.platform === "darwin" ? undefined : 24);
  assert.equal((await detectMachine(async () => { throw new Error("not found"); })).nvidiaGB, undefined);
});

test("Momo downloads a missing local model itself, with progress", async () => {
  const lines: string[] = [];
  const total = 4 * 1024 ** 3;
  const events = [{ status: "pulling manifest" }, ...[0, 0.05, 0.12, 0.5, 0.97, 1].map((f) => ({ status: "pulling abc", total, completed: Math.round(total * f) })), { status: "success" }];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u === "http://127.0.0.1:11434/api/tags") return Response.json({ models: [{ name: "gemma4:e4b" }, { name: "qwen3.5:latest" }] });
    assert.equal(u, "http://127.0.0.1:11434/api/pull");
    assert.deepEqual(JSON.parse(String(init?.body)), { model: "gemma4:12b", stream: true });
    // Streamed in pieces that split lines, as a network does.
    const text = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const parts = [text.slice(0, 50), text.slice(50, 200), text.slice(200)];
    return new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); } }));
  }) as unknown as typeof fetch;
  assert.equal(await ollamaHas("gemma4:e4b", undefined, fetchImpl), true);
  assert.equal(await ollamaHas("qwen3.5", undefined, fetchImpl), true, "a bare name is its latest tag");
  assert.equal(await ollamaHas("gemma4:12b", "http://127.0.0.1:11434/v1", fetchImpl), false);
  await pullOllamaModel("gemma4:12b", "http://127.0.0.1:11434/v1", (l) => lines.push(l), fetchImpl);
  assert.deepEqual(lines, ["downloading gemma4:12b: 0% of 4.0 GB", "downloading gemma4:12b: 10% of 4.0 GB", "downloading gemma4:12b: 50% of 4.0 GB", "downloading gemma4:12b: 90% of 4.0 GB", "downloading gemma4:12b: 100% of 4.0 GB", "downloaded gemma4:12b"]);

  const failing = (async () => new Response('{"error":"pull model manifest: file does not exist"}\n')) as unknown as typeof fetch;
  await assert.rejects(pullOllamaModel("nope:1b", undefined, () => {}, failing), /file does not exist/);
});
