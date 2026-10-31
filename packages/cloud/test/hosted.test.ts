// Hosted mode, as an average person uses it: text a Telegram bot or WhatsApp
// number, nothing installed, things get done.
//
// Real: Redis, per-user encryption, webhooks, the job queue, the web agent
// driving headless Chromium on a real (local) booking site, the secure-link
// page's browser crypto, approvals. Scripted: only the planner model's
// decisions (no API key in CI) and the outbound channel HTTP calls.

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { fromRedis } from "../src/hosted/kv.ts";
import { WEB_SEAL_SOURCE } from "@momo/protocol";
import {
  HeadlessBrowser,
  OpenAICompatiblePlanner,
  RemindersSkill,
  WEB_TOOLS,
  WebTaskSkill,
  parseModelSpec,
  startMockSite,
  type Block,
  type Planner,
  type Turn,
} from "@momo/agent-core";
import { HostedRuntime, TelegramAdapter, UserKeys, WhatsAppAdapter, type HostedOptions } from "../src/index.ts";
import { createRelay, memoryStore } from "../../../apps/web/lib/relay.js";

const redis = new Redis(process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379/13");
const PASSWORD = "hunter2-correct-horse";
const FRIDAY_NOON = new Date(2026, 10, 6, 12, 0);
let now = new Date(2026, 11, 1, 9, 0); // Tue Dec 1 2026, mutable clock for reminders
const sent: Array<{ to: string; text: string }> = [];
const fakeFetch: typeof fetch = async (_url, init) => {
  const b = JSON.parse(String(init!.body));
  sent.push({ to: String(b.chat_id ?? b.to), text: b.text?.body ?? b.text });
  return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
};

let site: Awaited<ReturnType<typeof startMockSite>>;
let browser: HeadlessBrowser;

before(async () => {
  site = await startMockSite(undefined, { email: "ana@example.com", password: PASSWORD });
  browser = new HeadlessBrowser();
});
after(async () => {
  await browser.dispose();
  await site.close();
  redis.disconnect();
});
beforeEach(async () => {
  await redis.flushdb();
  sent.length = 0;
});

/** Plays the model's part, reading real page snapshots to pick element numbers. */
function scriptedBooking(origin: string): Planner {
  const ref = (snap: string, re: RegExp) => {
    const line = snap.split("\n").find((l) => /^\[\d+\]/.test(l) && re.test(l));
    if (!line) throw new Error(`planner: no element matching ${re}\n${snap}`);
    return Number(/^\[(\d+)\]/.exec(line)![1]);
  };
  let n = 0;
  const slotFor = (history: Turn[]) => {
    const ask = (history[0]!.content[0] as { text: string }).text;
    const m = /at (\d{1,2})(?::(\d{2}))?\s*pm/i.exec(ask.split("Errand:")[1]!)!;
    return `${Number(m[1]) + 12}:${m[2] ?? "00"}`;
  };
  const call = (name: string, input: Record<string, unknown> = {}): Block[] => [{ type: "tool_use", id: `t${++n}`, name, input }];
  return {
    async next(_system: string, history: Turn[]): Promise<Block[]> {
      const last = history.at(-1)!.content.find((b) => b.type === "tool_result") as { content: string } | undefined;
      const r = last?.content ?? "";
      const prev = history.at(-2)?.content.find((b) => b.type === "tool_use") as { name: string; input: Record<string, unknown> } | undefined;
      if (!prev) return call("goto", { url: `${origin}/search?q=nopa` });
      if (prev.name === "goto" || prev.name === "sign_in" || (prev.name === "click" && !r.includes("Refused:"))) return call("read_page");
      if (prev.name === "read_page") {
        if (r.includes("<h1>") || /Title: Search/.test(r)) return call("click", { ref: ref(r, /\ba Nopa\b/) });
        if (/Title: Nopa/.test(r)) return call("click", { ref: ref(r, new RegExp(`\\b${slotFor(history)}\\b`)) });
        if (/Title: Sign in/.test(r)) return call("sign_in", { user_ref: ref(r, /input\(email\)/), pass_ref: ref(r, /input\(password\)/), submit_ref: ref(r, /Sign in/) });
        if (/Title: Confirm Nopa/.test(r)) return call("click", { ref: ref(r, /Complete reservation/) });
        if (/Title: You're booked/.test(r)) {
          const conf = /TN-[A-F0-9]+/.exec(r)![0];
          return call("finish", { message: `Booked: Nopa, ${slotFor(history)}. Confirmation ${conf}.` });
        }
      }
      if (prev.name === "click" && r.includes("Refused:")) {
        return call("request_approval", { summary: "Book Nopa, Fri Nov 6, 7pm, 2 people? $25/person no-show fee.", amount_usd: 50 });
      }
      if (prev.name === "request_approval") return call("read_page"); // resumed after YES
      throw new Error(`planner: unexpected state after ${prev.name}: ${r.slice(0, 200)}`);
    },
  };
}

function runtime(planner: Planner, clock: () => Date, extra: Partial<HostedOptions> = {}) {
  const telegram = new TelegramAdapter("BOT", "tg-secret", fakeFetch);
  const whatsapp = new WhatsAppAdapter({ phoneNumberId: "1", accessToken: "x", appSecret: "app-secret", verifyToken: "v" }, fakeFetch);
  const rt = new HostedRuntime({
    redis: fromRedis(redis),
    keys: new UserKeys(randomBytes(32)),
    baseUrl: "https://momo.example",
    telegram,
    whatsapp,
    skills: () => [new RemindersSkill(), new WebTaskSkill(planner, browser)],
    now: clock,
    ...extra,
  });
  return { rt, app: rt.routes() };
}

let updateId = 0;
async function tg(app: ReturnType<HostedRuntime["routes"]>, rt: HostedRuntime, text: string) {
  const res = await app.request("/v1/hosted/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "tg-secret" },
    body: JSON.stringify({ update_id: ++updateId, message: { text, date: 1, chat: { id: 777, type: "private" } } }),
  });
  assert.equal(res.status, 200);
  await rt.drain();
  return sent.at(-1)!.text;
}

test("new user on Telegram: onboarding, then a web errand done end to end", { timeout: 120_000 }, async () => {
  const { rt, app } = runtime(scriptedBooking(site.origin), () => FRIDAY_NOON);

  assert.match(await tg(app, rt, "hey"), /Hi, I'm Momo.*What should I call you\?/s);
  assert.match(await tg(app, rt, "I'm Ana"), /Nice to meet you, Ana\. What city/);
  assert.match(await tg(app, rt, "San Francisco"), /All set/);

  // The errand: it browses, hits the login page, and sends a secure link.
  const linkMsg = await tg(app, rt, "book a table for 2 at Nopa tonight at 7pm");
  assert.equal(sent.at(-2)!.text, "On it.");
  const url = /https:\/\/momo\.example(\/s\/[\w-]+)/.exec(linkMsg)?.[1];
  if (!url) throw new Error(`expected a secure link, got:\n${sent.map((m) => m.text).join("\n---\n")}`);
  assert.match(linkMsg, /encrypted on your phone/);

  // The person opens the link; the page seals the login in the browser.
  const page = await app.request(url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Add your 127\.0\.0\.1:\d+ login/);
  const boxKey = /momoSeal\("([\w-]+)"/.exec(html)![1]!;
  const formId = url.split("/").pop()!;
  const momoSeal = new Function(`${WEB_SEAL_SOURCE}; return momoSeal;`)() as (k: string, p: string) => Promise<string>;
  const sealed = await momoSeal(boxKey, JSON.stringify({ formId, fields: { identifier: "ana@example.com", password: PASSWORD } }));
  const submit = await app.request(url.replace("/s/", "/v1/forms/"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sealed }) });
  assert.equal(submit.status, 200);
  assert.equal((await app.request(url)).status, 410, "links are single-use");
  await rt.drain();

  // It signed in, tried to click "Complete reservation", was refused by code,
  // and asked for approval instead. Nothing is booked yet.
  const ask = sent.at(-1)!.text;
  assert.match(ask, /Book Nopa, Fri Nov 6, 7pm, 2 people\? .*Reply YES [A-Z2-9]{4}/s);
  assert.ok(sent.some((m) => m.text === `Saved your ${new URL(site.origin).host} login. Continuing.`));
  assert.equal(site.state.reservations.size, 0);
  assert.equal(site.state.logins, 1);

  const done = await tg(app, rt, "yes");
  assert.match(done, /^Booked: Nopa, 19:00\. Confirmation TN-[A-F0-9]+\.$/);
  assert.equal(site.state.reservations.size, 1);

  // Second errand on the same site: still signed in, so no login link, no re-login.
  const before = sent.length;
  await tg(app, rt, "book a table for 2 at Nopa tonight at 5:30pm");
  assert.ok(!sent.slice(before).some((m) => /\/s\//.test(m.text)), "no login link the second time");
  assert.match(sent.at(-1)!.text, /Reply YES/);
  assert.match(await tg(app, rt, "yes"), /^Booked: Nopa, 17:30\./);
  assert.equal(site.state.logins, 1);

  // A different person on the same server shares nothing: they must sign in themselves.
  const other = await app.request("/v1/hosted/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "tg-secret" },
    body: JSON.stringify({ update_id: ++updateId, message: { text: "book a table for 2 at Nopa tonight at 9:15pm", date: 1, chat: { id: 888, type: "private" } } }),
  });
  assert.equal(other.status, 200);
  await rt.drain();
  assert.match(sent.filter((m) => m.to === "888").at(-1)!.text, /Add it here/);

  // Privacy at rest: nothing in Redis is readable.
  for (const k of await redis.keys("*")) {
    if ((await redis.type(k)) !== "string") continue;
    const v = (await redis.get(k))!;
    // Short words ("Ana", "777") can occur by chance inside base64 ciphertext,
    // so per-user records are checked for being opaque ciphertext instead.
    if (k.startsWith("u:")) assert.match(v, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/, `${k} is not ciphertext`);
    for (const secret of [PASSWORD, "ana@example.com", "\"Ana\"", "Nopa tonight"]) assert.ok(!v.includes(secret), `${k} leaks ${secret}`);
  }
  for (const m of sent) assert.ok(!m.text.includes(PASSWORD));
});

test("on a person's own computer: the secure link opens on their phone through the Vercel relay, which sees only ciphertext", { timeout: 120_000 }, async () => {
  const store = memoryStore();
  const relay = createRelay(store);
  const RELAY = "https://momo-web.example";
  const relayFetch = (async (url: string | URL | Request, init?: RequestInit) => relay(new Request(url, init))) as typeof fetch;
  const token = ((await (await relayFetch(`${RELAY}/api/devices`, { method: "POST" })).json()) as { token: string }).token;
  // No public address: the server is only reachable on this computer.
  const { rt, app } = runtime(scriptedBooking(site.origin), () => FRIDAY_NOON, {
    baseUrl: "http://localhost:8787",
    relay: { url: RELAY, token, fetch: relayFetch },
  });

  await tg(app, rt, "hey");
  await tg(app, rt, "I'm Ana");
  await tg(app, rt, "San Francisco");
  // (The shared test restaurant's 7pm slot is booked by the first test.)
  const linkMsg = await tg(app, rt, "book a table for 2 at Nopa tonight at 9:15pm");
  const url = /https:\/\/momo-web\.example\/s\/([\w-]+)/.exec(linkMsg);
  if (!url) throw new Error(`expected a relay link, got:\n${sent.map((m) => m.text).join("\n---\n")}`);
  const formId = url[1]!;

  // The phone: the static page asks the relay what to show and which key to seal to.
  const info = (await (await relayFetch(`${RELAY}/api/forms/${formId}`)).json()) as { spec: { kind: string; label: string }; pk: string };
  assert.equal(info.spec.kind, "login");
  assert.match(info.spec.label, /127\.0\.0\.1:\d+/);
  const momoSeal = new Function(`${WEB_SEAL_SOURCE}; return momoSeal;`)() as (k: string, p: string) => Promise<string>;
  const sealed = await momoSeal(info.pk, JSON.stringify({ formId, fields: { identifier: "ana@example.com", password: PASSWORD } }));
  assert.equal((await relayFetch(`${RELAY}/api/forms/${formId}`, { method: "POST", body: JSON.stringify({ sealed }) })).status, 200);
  assert.equal((await relayFetch(`${RELAY}/api/forms/${formId}`, { method: "POST", body: JSON.stringify({ sealed }) })).status, 410, "single use");
  for (const v of store.dump()) for (const secret of [PASSWORD, "ana@example.com"]) assert.ok(!v.includes(secret), "the relay holds only ciphertext");

  // This computer collects it and the errand carries on.
  assert.equal(await rt.pollRelay(), 1);
  await rt.drain();
  assert.ok(sent.some((m) => m.text === `Saved your ${new URL(site.origin).host} login. Continuing.`));
  assert.match(sent.at(-1)!.text, /Book Nopa, .*Reply YES/s);
  assert.equal(await rt.pollRelay(), 0, "collected once");
});

test("reminders fire on time via the hosted timer sweep; UNDO cancels", { timeout: 30_000 }, async () => {
  const { rt, app } = runtime(scriptedBooking(site.origin), () => now);
  await tg(app, rt, "hi");
  await tg(app, rt, "Sam");
  await tg(app, rt, "Austin");

  assert.equal(await tg(app, rt, "remind me to call mom tomorrow at 6pm"), "Got it. I'll remind you Wed, Dec 2, 6pm: call mom.");
  assert.equal(await tg(app, rt, "remind me in 20 minutes to move the car"), "Got it. I'll remind you today at 9:20am: move the car.");

  now = new Date(2026, 11, 1, 9, 21);
  await rt.sweepTimers(now.getTime());
  await rt.drain();
  assert.equal(sent.at(-1)!.text, "Reminder: move the car");

  assert.equal(await tg(app, rt, "undo"), "Cancelled the reminder: call mom.");
  now = new Date(2026, 11, 2, 18, 1);
  assert.deepEqual(await rt.sweepTimers(now.getTime()), []);
});

test("WhatsApp: verified webhook only; duplicates ignored", async () => {
  const { rt, app } = runtime(scriptedBooking(site.origin), () => now);
  assert.equal(await (await app.request("/v1/hosted/whatsapp?hub.mode=subscribe&hub.verify_token=v&hub.challenge=42")).text(), "42");
  const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: "wamid.1", from: "15551234567", timestamp: "1", type: "text", text: { body: "hello" } }] } }] }] });
  const sig = "sha256=" + createHmac("sha256", "app-secret").update(body).digest("hex");
  const post = (s: string) => app.request("/v1/hosted/whatsapp", { method: "POST", headers: { "x-hub-signature-256": s }, body });
  assert.equal((await post("sha256=" + "0".repeat(64))).status, 401);
  assert.equal((await post(sig)).status, 200);
  assert.equal((await post(sig)).status, 200); // Meta retry
  await rt.drain();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, "15551234567");
  assert.match(sent[0]!.text, /Hi, I'm Momo/);
});

/** A fake OpenAI-compatible server whose "model" is the scripted planner. */
function fakeOpenAI(inner: Planner, seen: Array<{ auth: string | null; tools: number }>): typeof fetch {
  return async (_url, init) => {
    const req = JSON.parse(String(init!.body)) as { messages: Array<Record<string, any>>; tools: unknown[] };
    seen.push({ auth: new Headers(init!.headers).get("authorization"), tools: req.tools.length });
    // chat messages -> turns, exactly what a real model would have to understand
    const history: Turn[] = [];
    for (const m of req.messages.slice(1)) {
      if (m.role === "user") history.push({ role: "user", content: [{ type: "text", text: m.content }] });
      else if (m.role === "assistant")
        history.push({ role: "assistant", content: (m.tool_calls ?? []).map((c: any) => ({ type: "tool_use", id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments) })) });
      else if (m.role === "tool") {
        const last = history.at(-1)!;
        const block = { type: "tool_result", tool_use_id: m.tool_call_id, content: m.content };
        if (last.role === "user" && last.content[0]?.type === "tool_result") last.content.push(block);
        else history.push({ role: "user", content: [block] });
      }
    }
    const blocks = await inner.next("", history, []);
    const tool_calls = blocks
      .filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use")
      .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }));
    return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls } }] });
  };
}

test("any model: the same errand completes through an OpenAI-compatible provider", { timeout: 120_000 }, async () => {
  const seen: Array<{ auth: string | null; tools: number }> = [];
  const spec = parseModelSpec("openrouter/some-vendor/some-model", { OPENROUTER_API_KEY: "or-key" });
  assert.equal(spec.baseUrl, "https://openrouter.ai/api/v1");
  const planner = new OpenAICompatiblePlanner(spec, fakeOpenAI(scriptedBooking(site.origin), seen));
  const { rt, app } = runtime(planner, () => FRIDAY_NOON);

  // 7pm and 5:30pm were booked by the first test on the shared site.
  const first = await tg(app, rt, "book a table for 2 at Nopa tonight at 9:15pm");
  const link = /https:\/\/momo\.example(\/s\/[\w-]+)/.exec(first)?.[1];
  if (!link) throw new Error(sent.map((m) => m.text).join("\n---\n"));
  const html = await (await app.request(link)).text();
  const momoSeal = new Function(`${WEB_SEAL_SOURCE}; return momoSeal;`)() as (k: string, p: string) => Promise<string>;
  const sealed = await momoSeal(/momoSeal\("([\w-]+)"/.exec(html)![1]!, JSON.stringify({ formId: link.split("/").pop(), fields: { identifier: "ana@example.com", password: PASSWORD } }));
  await app.request(link.replace("/s/", "/v1/forms/"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sealed }) });
  await rt.drain();
  assert.match(sent.at(-1)!.text, /Reply YES/, sent.map((m) => JSON.stringify(m.text)).join("\n"));
  assert.match(await tg(app, rt, "yes"), /^Booked: Nopa, 21:15\. Confirmation TN-/);
  assert.ok(seen.length > 5 && seen.every((r) => r.auth === "Bearer or-key" && r.tools === WEB_TOOLS.length));
});
