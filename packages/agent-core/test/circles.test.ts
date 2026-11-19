// From a real-site test: a model searched Google ~30 times for a restaurant, and answered "when does Costco close
// today?" from memory. Both are caught in code now.
import assert from "node:assert/strict";
import { test } from "node:test";
import { needsLookup } from "../src/assistant.ts";
import { stuck } from "../src/llm.ts";
import { rut, SEARCH_RUT, type Turn } from "../src/skills/web/agent.ts";

let n = 0;
/** One step: the call, and what came back. */
function step(name: string, input: Record<string, unknown>, result = "ok", error = false): Turn[] {
  const id = `t${n++}`;
  return [
    { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result, ...(error ? { is_error: true } : {}) }] },
  ];
}
const search = (q: string) => step("goto", { url: `https://www.google.com/search?q=${encodeURIComponent(q)}` });
const start: Turn[] = [{ role: "user", content: [{ type: "text", text: "book a table" }] }];

test("search after search without opening a result is going round in circles", () => {
  const h = [...start];
  for (let i = 1; i < SEARCH_RUT; i++) {
    h.push(...search(`italian sf ${i}`));
    assert.equal(rut(h), "", `${i} searches is fine`);
  }
  h.push(...search("italian sf opentable"));
  assert.match(rut(h), /^That's 5 searches in a row without opening a result\. Stop rewording/);
  assert.match(stuck(h), /going round in circles/, "in hybrid mode, the frontier model takes over");
  // Opening a result breaks the run.
  h.push(...step("goto", { url: "https://www.example-restaurant.com/" }));
  assert.equal(rut(h), "");
  // DuckDuckGo and Bing count too.
  const g = [...start];
  for (let i = 0; i < 5; i++) g.push(...step("goto", { url: i % 2 ? `https://html.duckduckgo.com/html/?q=x${i}` : `https://www.bing.com/search?q=x${i}` }));
  assert.match(rut(g), /5 searches/);
});

test("a site that keeps refusing the browser isn't opened again", () => {
  const h = [...start, ...step("goto", { url: "https://www.opentable.com/" }, "Error: page.goto: net::ERR_HTTP2_PROTOCOL_ERROR", true)];
  assert.equal(rut(h), "", "once can be a blip");
  h.push(...search("bix sf"), ...step("goto", { url: "https://opentable.com/r/bix" }, "Error: page.goto: net::ERR_HTTP2_PROTOCOL_ERROR", true));
  assert.match(rut(h), /^opentable\.com has refused this browser 2 times\. Don't open it again/);
});

test("a fact that changes is looked up, not remembered; questions about Momo's own work are answered", () => {
  for (const t of ["what time does the SF Costco close today?", "is Trader Joes open now", "track USPS package 9400111899223197428490", "whats the weather tomorrow in SF", "how much is a PS5 at Target right now", "is my flight UA 123 delayed today"]) {
    assert.ok(needsLookup(t), t);
  }
  for (const t of ["did you book it?", "what did you order today?", "what is the capital of France", "what time is it in Tokyo", "when did the Costco open in 1983", "thanks!"]) {
    assert.ok(!needsLookup(t), t);
  }
});
