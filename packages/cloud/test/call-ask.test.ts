// Mid-call questions, as Grok Bot does them: when the business asks something only the owner knows, the voice
// agent texts the owner through the site and waits; the owner's next text is the answer, not a new errand.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRelay, memoryStore } from "../../../apps/web/lib/relay.js";
import { BlandVoice } from "../src/hosted/phone.ts";

const BASE = "https://momo-web.example";

test("relay: the voice agent asks the owner mid-call, and their reply goes back into the call", async () => {
  const sent: string[] = [];
  const placed: Array<Record<string, unknown>> = [];
  let secret = "";
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
    if (u.endsWith("/getMe")) return ok({ id: 1, username: "momo_bot" });
    if (u.endsWith("/setWebhook")) return (secret = body.secret_token), ok(true);
    if (u.endsWith("/sendMessage")) return sent.push(body.text), ok({ message_id: sent.length });
    if (u === "https://api.bland.ai/v1/calls") return placed.push(body), Response.json({ call_id: "call-0002-abcd" });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const store = memoryStore();
  const relay = createRelay(store, { env: { BLAND_API_KEY: "bk", TELEGRAM_BOT_TOKEN: "777:BOT", MOMO_PUBLIC_URL: BASE }, fetch: f, askWaitMs: 3000, askPollMs: 20 });
  const req = (path: string, init: RequestInit = {}) => relay(new Request(`${BASE}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } }));
  await req("/api/config");
  const { token, pair } = (await (await req("/api/devices", { method: "POST" })).json()) as { token: string; pair: string };
  const text = (id: number, t: string) => req("/api/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify({ update_id: id, message: { text: t, date: id, chat: { id: 42, type: "private" } } }) });
  await text(1, `/start ${pair}`);

  const voice = new BlandVoice(`Bearer ${token}`, ((u: string | URL | Request, init?: RequestInit) => relay(new Request(String(u), init))) as typeof fetch, `${BASE}/api`);
  await voice.start({ to: "+14155550199", goal: "Book a table for 2 on Saturday at 8pm under Ana." });
  const tool = (placed[0]!.tools as Array<Record<string, unknown>>)[0]!;
  assert.equal(tool.name, "AskCustomer");
  assert.match(String(tool.url), /^https:\/\/momo-web\.example\/api\/calls\/ask\/[\w-]{20,}$/);
  assert.deepEqual(tool.response, { customer_answer: "$.answer" });
  assert.match(String(placed[0]!.task), /AskCustomer tool/);
  const ask = (question: string, url = String(tool.url)) => relay(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) }));

  // Bland asks; the owner is texted; their reply comes back as the answer and never reaches Momo as an errand.
  const pending = ask("They have 7:30 or 9, which one?");
  for (let i = 0; i < 50 && !sent.some((s) => s.includes("7:30 or 9")); i++) await new Promise((r) => setTimeout(r, 10));
  assert.match(sent.at(-1)!, /^On the phone now, they're asking: "They have 7:30 or 9, which one\?"\nText me the answer/);
  await text(2, "7:30 is great");
  assert.deepEqual(await (await pending).json(), { answer: "7:30 is great" });
  await text(3, "thanks!");
  const inbox = (await (await req("/api/inbox", { headers: { authorization: `Bearer ${token}` } })).json()) as { messages: Array<{ text: string }> };
  assert.deepEqual(inbox.messages.map((m) => m.text), ["hi", "thanks!"], "the answer went to the call, later texts go to Momo");

  // "skip", or no reply in time: the agent is told to confirm later.
  const skipped = ask("Any allergies?");
  for (let i = 0; i < 50 && !sent.some((s) => s.includes("allergies")); i++) await new Promise((r) => setTimeout(r, 10));
  await text(4, "skip");
  assert.match(((await (await skipped).json()) as { answer: string }).answer, /didn't answer that\. Say you'll confirm/);
  assert.match(((await (await ask("Phone number for the booking?")).json()) as { answer: string }).answer, /didn't answer/);
  await text(5, "book me a haircut");
  const later = (await (await req("/api/inbox", { headers: { authorization: `Bearer ${token}` } })).json()) as { messages: Array<{ text: string }> };
  assert.deepEqual(later.messages.map((m) => m.text), ["book me a haircut"], "once the wait is over, texts are errands again");

  // Only that call's link works.
  assert.equal((await ask("x", `${BASE}/api/calls/ask/${"a".repeat(24)}`)).status, 404);
});

test("the call outcome says how long it took and, on your own key, what it cost", () => {
  const v = new BlandVoice("bk");
  assert.match(v.outcome({ status: "completed", answered_by: "human", call_length: 2.4, price: 0.336, summary: "Booked." }), /^Phone call ended \(completed, answered by human, 2 min, cost \$0\.34\)\.\nSummary: Booked\./);
  assert.match(v.outcome({ status: "no-answer" }), /^Phone call ended \(no-answer\)\./);
});
