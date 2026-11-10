// The things that stall real errands, done end to end over Telegram:
// a login that texts a code, a "verify you're human" check (finished by the
// person in a live view), a delivery address and a card added once via secure
// links, and a restaurant with no online booking (Momo phones them).
//
// Real: Redis, per-user encryption, the job queue, headless Chromium on a
// real (local) store, the live view's taps, approvals. Scripted: the
// planner's decisions and the voice provider.

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { fromRedis } from "../src/hosted/kv.ts";
import { WEB_SEAL_SOURCE } from "@momo/protocol";
import { HeadlessBrowser, RemindersSkill, WebTaskSkill, startMockShop, type Block, type Planner, type Turn } from "@momo/agent-core";
import { HostedRuntime, TelegramAdapter, UserKeys, type HostedOptions, type VoiceProvider } from "../src/index.ts";
import { createRelay, memoryStore } from "../../../apps/web/lib/relay.js";

const redis = new Redis(process.env.TEST_REDIS_URL_ERRANDS ?? "redis://127.0.0.1:6379/12");
const PASSWORD = "hunter2-correct-horse";
const CARD = "4242424242424242";
const sent: Array<{ to: string; text: string }> = [];
const fakeFetch: typeof fetch = async (_url, init) => {
  const b = JSON.parse(String(init!.body));
  sent.push({ to: String(b.chat_id), text: b.text });
  return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
};

let shop: Awaited<ReturnType<typeof startMockShop>>;
let browser: HeadlessBrowser;

before(async () => {
  shop = await startMockShop({ email: "ana@example.com", password: PASSWORD });
  browser = new HeadlessBrowser();
});
after(async () => {
  await browser.dispose();
  await shop.close();
  redis.disconnect();
});
beforeEach(async () => {
  await redis.flushdb();
  sent.length = 0;
});

const ref = (snap: string, re: RegExp) => {
  const line = snap.split("\n").find((l) => /^\[\d+\]/.test(l) && re.test(l));
  if (!line) throw new Error(`planner: no element matching ${re}\n${snap}`);
  return Number(/^\[(\d+)\]/.exec(line)![1]);
};

/** Plays the model: reads real snapshots, uses the new tools the way the prompt says to. */
function scripted(start: string, steps: (prev: { name: string; input: Record<string, unknown> }, r: string, snap: string) => [string, Record<string, unknown>?]) {
  let n = 0;
  let snap = "";
  const histories: Turn[][] = [];
  const planner: Planner = {
    async next(_system, history) {
      histories.push(history);
      const r = (history.at(-1)!.content.find((b) => b.type === "tool_result") as { content: string } | undefined)?.content ?? "";
      const prev = history.at(-2)?.content.find((b) => b.type === "tool_use") as { name: string; input: Record<string, unknown> } | undefined;
      if (prev?.name === "read_page") snap = r;
      const [name, input = {}] = prev ? steps(prev, r, snap) : ["goto", { url: start }];
      return [{ type: "tool_use", id: `t${++n}`, name, input } as Block];
    },
  };
  return { planner, histories };
}

function runtime(planner: Planner, voice?: VoiceProvider, extra: Partial<HostedOptions> = {}) {
  // One web skill for the process, as in production: the live page survives between messages.
  const web = new WebTaskSkill(planner, browser);
  const rt = new HostedRuntime({
    redis: fromRedis(redis),
    keys: new UserKeys(randomBytes(32)),
    baseUrl: "https://momo.example",
    telegram: new TelegramAdapter("BOT", "tg-secret", fakeFetch),
    skills: () => [new RemindersSkill(), web],
    voice,
    ...extra,
  });
  return { rt, app: rt.routes() };
}

let updateId = 0;
async function tg(app: ReturnType<HostedRuntime["routes"]>, rt: HostedRuntime, text: string) {
  const res = await app.request("/v1/hosted/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "tg-secret" },
    body: JSON.stringify({ update_id: ++updateId, message: { text, date: 1, chat: { id: 555, type: "private" } } }),
  });
  assert.equal(res.status, 200);
  await rt.drain();
  return sent.at(-1)!.text;
}

const momoSeal = new Function(`${WEB_SEAL_SOURCE}; return momoSeal;`)() as (k: string, p: string) => Promise<string>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the person does on their phone: fill in a secure link; tap through a live view. */
interface Phone {
  fillLink(msg: string, fields: Record<string, string>, title: RegExp): Promise<void>;
  live(msg: string): Promise<void>;
  /** Everything the relay ever stored (empty for a direct connection). */
  stored(): string[];
}

/** The server has a public address: links and live views come straight from it. */
function directPhone(app: ReturnType<HostedRuntime["routes"]>, rt: HostedRuntime): Phone {
  return {
    async fillLink(msg, fields, title) {
      const url = /https:\/\/momo\.example(\/s\/[\w-]+)/.exec(msg)?.[1];
      if (!url) throw new Error(`expected a secure link in: ${msg}`);
      const html = await (await app.request(url)).text();
      assert.match(html, title);
      for (const name of Object.keys(fields)) assert.match(html, new RegExp(`name="${name}"`), `form has ${name}`);
      const boxKey = /momoSeal\("([\w-]+)"/.exec(html)![1]!;
      const sealed = await momoSeal(boxKey, JSON.stringify({ formId: url.split("/").pop(), fields }));
      const res = await app.request(url.replace("/s/", "/v1/forms/"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sealed }) });
      assert.equal(res.status, 200);
      await rt.drain();
    },
    async live(msg) {
      const live = /https:\/\/momo\.example(\/l\/[\w-]+)/.exec(msg)![1]!;
      assert.match(await (await app.request(live)).text(), /Tap the picture to click/);
      const shot = await app.request(`${live}/shot`);
      assert.equal(shot.headers.get("content-type"), "image/jpeg");
      assert.ok((await shot.arrayBuffer()).byteLength > 1000);
      const post = (p: string, b: unknown = {}) => app.request(`${live}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
      assert.equal((await post("/tap", { x: 0.5, y: 0.25 })).status, 200);
      assert.equal((await post("/done")).status, 200);
      assert.equal((await app.request(`${live}/shot`)).status, 410, "live view ends when they're done");
      await rt.drain();
    },
    stored: () => [],
  };
}

/** Momo on the person's own computer (no public address): everything goes through the website's relay. */
function relayPhone() {
  const store = memoryStore();
  const relay = createRelay(store);
  const RELAY = "https://momo-web.example";
  const relayFetch = (async (url: string | URL | Request, init?: RequestInit) => relay(new Request(url, init))) as typeof fetch;
  const api = (path: string, init?: RequestInit) => relayFetch(`${RELAY}${path}`, { ...init, headers: { "content-type": "application/json" } });
  let rt: HostedRuntime;
  const phone: Phone = {
    async fillLink(msg, fields, title) {
      const id = /https:\/\/momo-web\.example\/s\/([\w-]+)/.exec(msg)?.[1];
      if (!id) throw new Error(`expected a relay link in: ${msg}`);
      const info = (await (await api(`/api/forms/${id}`)).json()) as { spec: { kind: string; label: string }; pk: string };
      assert.match(`Add your ${info.spec.kind === "login" ? `${info.spec.label} login` : info.spec.kind}`, title);
      const sealed = await momoSeal(info.pk, JSON.stringify({ formId: id, fields }));
      assert.equal((await api(`/api/forms/${id}`, { method: "POST", body: JSON.stringify({ sealed }) })).status, 200);
      assert.equal(await rt.pollRelay(), 1);
      await rt.drain();
    },
    async live(msg) {
      const id = /https:\/\/momo-web\.example\/l\/([\w-]+)/.exec(msg)![1]!;
      assert.match(((await (await api(`/api/live/${id}`)).json()) as { reason: string }).reason, /check you're a person/);
      let shot: Response | undefined;
      for (let i = 0; i < 100 && shot?.status !== 200; i++) {
        await sleep(50);
        shot = await api(`/api/live/${id}/shot`);
      }
      assert.equal(shot!.headers.get("content-type"), "image/jpeg", "the computer streams screenshots through the relay");
      assert.ok((await shot!.arrayBuffer()).byteLength > 1000);
      const act = (b: unknown) => api(`/api/live/${id}/act`, { method: "POST", body: JSON.stringify(b) });
      assert.equal((await act({ type: "tap", x: 0.5, y: 0.25 })).status, 200);
      assert.equal((await act({ type: "done" })).status, 200);
      assert.equal((await api(`/api/live/${id}/shot`)).status, 410, "the phone's view ends on done");
      // The computer picks "done" up on its next pass and carries on.
      const before = sent.length;
      for (let i = 0; i < 100 && sent.length === before; i++) {
        await sleep(50);
        await rt.drain();
      }
    },
    stored: () => store.dump(),
  };
  return {
    phone,
    async token() {
      return ((await (await api("/api/devices", { method: "POST" })).json()) as { token: string }).token;
    },
    extra: (token: string): Partial<HostedOptions> => ({ baseUrl: "http://localhost:8787", relay: { url: RELAY, token, fetch: relayFetch, pollMs: 50 } }),
    attach: (r: HostedRuntime) => (rt = r),
  };
}

for (const via of ["a public address", "the website's relay (Momo on the person's own computer)"] as const) {
test(`shopping errand via ${via}: texted code, human check via live view, address and card added once, then done`, { timeout: 120_000 }, async () => {
  const { planner, histories } = scripted(`${shop.origin}/`, (prev, r, snap) => {
    switch (prev.name) {
      case "goto":
      case "hand_to_owner":
        return ["read_page"];
      case "click":
        return r.includes("Refused:") ? (() => { throw new Error(r); })() : ["read_page"];
      case "read_page":
        if (/Title: ShopNow/.test(r)) return ["click", { ref: ref(r, /Oat milk/) }];
        if (/Title: Oat milk/.test(r)) return ["click", { ref: ref(r, /Add to cart/) }];
        if (/Title: Cart/.test(r)) return ["click", { ref: ref(r, /Continue/) }];
        if (/Title: Sign in/.test(r)) return ["sign_in", { user_ref: ref(r, /input\(email\)/), pass_ref: ref(r, /input\(password\)/), submit_ref: ref(r, /Sign in/) }];
        if (/Title: Enter code/.test(r)) return ["enter_code", { ref: ref(r, /input\(text\) Code/), question: "ShopNow texted you a code. What is it?" }];
        if (/Title: Quick check/.test(r)) {
          assert.match(r, /human check\. Use hand_to_owner/);
          return ["hand_to_owner", { reason: "ShopNow wants to check you're a person." }];
        }
        if (/Title: Checkout/.test(r)) {
          return ["fill_address", {
            fields: [
              { ref: ref(r, /Full name/), field: "name" }, { ref: ref(r, /Street/), field: "line1" }, { ref: ref(r, /City/), field: "city" },
              { ref: ref(r, /State/), field: "region" }, { ref: ref(r, /ZIP/), field: "postal" },
            ],
          }];
        }
        if (/Title: Order placed/.test(r)) return ["remember", { key: "milk", value: "oat milk 6-pack" }];
        break;
      case "sign_in":
        return r.includes("saved their login") ? ["sign_in", prev.input] : ["read_page"];
      case "enter_code":
        assert.match(r, /Typed the code/);
        return ["click", { ref: ref(snap, /Next/) }];
      case "fill_address":
        if (r.includes("saved it")) return ["fill_address", prev.input];
        return ["request_approval", { summary: "Order Oat milk 6-pack from ShopNow, $18.00, delivered Thursday?", amount_usd: 18 }];
      case "request_approval":
        return ["fill_card", {
          fields: [
            { ref: ref(snap, /Card number/), field: "number" }, { ref: ref(snap, /select\(select-one\) Month/), field: "exp_month" },
            { ref: ref(snap, /select\(select-one\) Year/), field: "exp_year" }, { ref: ref(snap, /CVC/), field: "cvc" },
          ],
        }];
      case "fill_card":
        if (r.includes("saved it")) return ["fill_card", prev.input];
        assert.match(r, /Filled the card \(.*4242\)/);
        return ["click", { ref: ref(snap, /Place order/) }];
      case "remember":
        return ["finish", { message: `Ordered: Oat milk 6-pack, $18.00, arrives Thursday. Order ${/SN-[A-F0-9]+/.exec(JSON.stringify(histories.at(-1)))![0]}.` }];
    }
    throw new Error(`planner: unexpected state after ${prev.name}: ${r.slice(0, 300)}`);
  });
  const relay = via.startsWith("a public") ? undefined : relayPhone();
  const { rt, app } = runtime(planner, undefined, relay ? relay.extra(await relay.token()) : {});
  relay?.attach(rt);
  const phone = relay ? relay.phone : directPhone(app, rt);
  const orders0 = shop.state.orders.length;

  // 1. The errand starts; the store needs a login Momo doesn't have yet.
  await tg(app, rt, "order me oat milk from ShopNow");
  await phone.fillLink(sent.at(-1)!.text, { identifier: "ana@example.com", password: PASSWORD }, /Add your 127\.0\.0\.1:\d+ login/);

  // 2. The store texts the person a code; Momo asks for it and types it in.
  assert.equal(sent.at(-1)!.text, "ShopNow texted you a code. What is it?");
  const liveMsg = await tg(app, rt, `it's ${shop.state.lastCode}`);

  // 3. A "verify you're human" page: the person does that one step in a live view.
  assert.match(liveMsg, /ShopNow wants to check you're a person\. .*I'm done/s);
  await phone.live(liveMsg);

  // 4. Delivery address: asked for once, by secure link.
  await phone.fillLink(sent.at(-1)!.text, { name: "Ana Lopez", line1: "1 Main St", line2: "", city: "San Francisco", region: "CA", postal: "94110", phone: "" }, /Add your address/);

  // 5. Approval before paying, then the card (also once, by secure link).
  assert.match(sent.at(-1)!.text, /Order Oat milk 6-pack from ShopNow, \$18\.00.*Reply YES/s);
  assert.equal(shop.state.orders.length, orders0);
  const cardMsg = await tg(app, rt, "yes");
  assert.match(cardMsg, /add the card/);
  await phone.fillLink(cardMsg, { name: "Ana Lopez", number: "4242 4242 4242 4242", exp: "07/29", cvc: "123", zip: "94110" }, /Add your card/);

  // Done: the order went through with the right details.
  assert.match(sent.at(-1)!.text, /^Ordered: Oat milk 6-pack, \$18\.00, arrives Thursday\. Order SN-[A-F0-9]+\.$/);
  assert.equal(shop.state.orders.length, orders0 + 1);
  assert.deepEqual(shop.state.orders.at(-1)!.address, { name: "Ana Lopez", street: "1 Main St", city: "San Francisco", state: "CA", zip: "94110" });
  assert.deepEqual(shop.state.orders.at(-1)!.card, { number: CARD, mm: "07", yy: "2029", cvc: "123" });

  // The model and the chat never saw the card number or password.
  for (const h of histories) assert.ok(!JSON.stringify(h).includes(CARD) && !JSON.stringify(h).includes(PASSWORD));
  for (const m of sent) assert.ok(!m.text.replace(/\s/g, "").includes(CARD) && !m.text.includes(PASSWORD));
  // Nor did the website: it relayed only sealed answers and pictures.
  for (const v of phone.stored()) for (const secret of [PASSWORD, CARD, "4242 4242", shop.state.lastCode!]) assert.ok(!v.includes(secret), `relay stored ${secret}`);

  // Next time: everything is saved, so a repeat order needs no links.
  const before = sent.length;
  await tg(app, rt, "order me oat milk from ShopNow again");
  assert.ok(!sent.slice(before).some((m) => /\/s\//.test(m.text)), "no secure links the second time");
  rt.stop();
});
}

test("no online booking: Momo phones the restaurant, then adds it to the calendar", { timeout: 60_000 }, async () => {
  const calls: Array<{ to: string; goal: string; webhookUrl: string }> = [];
  const voice: VoiceProvider = {
    async start(req) {
      calls.push(req);
    },
    outcome: (b) => `Phone call ended. Summary: ${(b as { summary: string }).summary}`,
  };
  const { planner } = scripted(`${shop.origin}/zuni`, (prev, r) => {
    switch (prev.name) {
      case "goto":
        return ["read_page"];
      case "read_page":
        assert.match(r, /Call us at \+1 415 555 0199/);
        return ["request_approval", { summary: "Zuni Cafe doesn't book online. Call them at +1 415 555 0199 to book 2 people Sat Nov 7 at 8pm?", amount_usd: 0 }];
      case "request_approval":
        return ["call_phone", { number: "+1 415 555 0199", goal: "Book a table for 2 on Saturday Nov 7 at 8pm under Ana." }];
      case "call_phone":
        assert.match(r, /Booked for 2 at 8pm/);
        return ["add_to_calendar", { title: "Zuni Cafe, 2 people", start: "2026-11-07T20:00", location: "1658 Market St" }];
      case "add_to_calendar":
        return ["finish", { message: "Booked: Zuni Cafe, Sat Nov 7, 8pm, 2 people (by phone, under Ana)." }];
    }
    throw new Error(`planner: unexpected state after ${prev.name}`);
  });
  const { rt, app } = runtime(planner, voice);

  assert.match(await tg(app, rt, "book a table for 2 at Zuni Cafe Saturday at 8pm"), /Call them at .*\sReply YES/s);
  assert.equal(calls.length, 0, "no call before approval");
  assert.match(await tg(app, rt, "yes"), /^Calling \+1 415 555 0199 now\./);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.goal, /Book a table for 2/);

  // While the call is underway, a message doesn't get mistaken for its result.
  assert.ok(!(await tg(app, rt, "thanks!")).startsWith("Booked"));

  // The voice provider reports back on the single-use webhook.
  const hook = new URL(calls[0]!.webhookUrl).pathname;
  const res = await app.request(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ summary: "Booked for 2 at 8pm under Ana." }) });
  assert.equal(res.status, 200);
  assert.equal((await app.request(hook, { method: "POST", body: "{}" })).status, 404, "webhook is single-use");
  await rt.drain();

  const done = sent.at(-1)!.text;
  assert.match(done, /^Booked: Zuni Cafe, Sat Nov 7, 8pm, 2 people \(by phone, under Ana\)\.\nAdd to calendar: https:\/\/momo\.example\/ics\?/);
  const ics = await app.request(new URL(/Add to calendar: (\S+)/.exec(done)![1]!).pathname + new URL(/Add to calendar: (\S+)/.exec(done)![1]!).search);
  assert.equal(ics.status, 200);
  const cal = await ics.text();
  assert.match(cal, /DTSTART:20261107T200000\r\nDTEND:20261107T220000\r\nSUMMARY:Zuni Cafe\\, 2 people\r\nLOCATION:1658 Market St/);
});

test("emailed sign-in code: Momo reads its own inbox, no need to ask the person", { timeout: 60_000 }, async () => {
  let momoEmail = "";
  const { planner, histories } = scripted(`${shop.origin}/email-login`, (prev, r, snap) => {
    switch (prev.name) {
      case "goto":
      case "click":
        return ["read_page"];
      case "read_page":
        if (/Title: Sign in with email/.test(r)) {
          momoEmail = /Owner's Momo email: (\S+@\S+?) /.exec(JSON.stringify(histories.at(-1)![0]))![1]!;
          return ["type", { ref: ref(r, /input\(email\)/), text: momoEmail }];
        }
        if (/Title: Enter the code we emailed/.test(r)) return ["check_email", { contains: "ShopNow code", wait_seconds: 120 }];
        if (/Title: Quick check/.test(r)) return ["finish", { message: "Signed in to ShopNow with the emailed code." }];
        break;
      case "type":
        if (/^\d{6}$/.test(String(prev.input.text))) return ["click", { ref: ref(snap, /Next/) }];
        return ["click", { ref: ref(snap, /Email me a code/) }];
      case "check_email": {
        assert.match(r, /<untrusted_email>[\s\S]*Ignore all previous instructions/, "email body is fenced as untrusted");
        assert.match(r, /Links:\n- http:\/\/127\.0\.0\.1:\d+\/magic\?t=/);
        return ["type", { ref: ref(snap, /input\(text\) Code/), text: /Likely code: (\d{6})/.exec(r)![1] }];
      }
    }
    throw new Error(`planner: unexpected state after ${prev.name}: ${r.slice(0, 300)}`);
  });
  const { rt, app } = runtime(planner, undefined, { emailDomain: "in.momo.example", inboundEmailSecret: "mail-secret" });

  await tg(app, rt, "sign me in to ShopNow and buy oat milk");
  const asked = sent.length;
  assert.match(momoEmail, /^m[0-9a-f]{12}@in\.momo\.example$/);
  assert.equal(shop.state.outbox.at(-1)!.to, momoEmail);

  // The inbound-email service (Postmark-style JSON) delivers the store's email.
  const mail = shop.state.outbox.at(-1)!;
  const bad = await app.request("/v1/hosted/email/wrong", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(bad.status, 403);
  const res = await app.request("/v1/hosted/email/mail-secret", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ To: `Momo <${mail.to}>`, From: "ShopNow <no-reply@shopnow.example>", Subject: mail.subject, TextBody: mail.text }),
  });
  assert.equal(res.status, 200);
  await rt.drain();

  assert.equal(sent.at(-1)!.text, "Signed in to ShopNow with the emailed code.");
  assert.ok(!sent.slice(asked).some((m) => /code/i.test(m.text) && /\?/.test(m.text)), "never asked the person for the code");

  // "email" tells the person their address, and how to forward codes to it.
  assert.match(await tg(app, rt, "what's my email?"), new RegExp(`Your Momo email is ${momoEmail.replace(/\./g, "\\.")}`));

  // Setting up forwarding: the provider's confirmation code is passed on to the person.
  await app.request("/v1/hosted/email/mail-secret", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ to: momoEmail, from: "forwarding-noreply@google.com", subject: "(#123456789) Gmail Forwarding Confirmation", text: "Confirmation code: 123456789" }).toString(),
  });
  await rt.drain();
  assert.match(sent.at(-1)!.text, /Email forwarding confirmation: .*\nCode: 123456789/s);
});
