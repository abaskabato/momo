import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { CloudClient, generateDeviceKeys, openJson, sealJson, type InboundMessage } from "@momo/protocol";
import { createCloud } from "../src/main.ts";

// Uses a dedicated Redis logical DB so tests never touch real data.
const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379/15";
const pushes: string[] = [];
const acks: Array<[string, string]> = [];
let cloud: Awaited<ReturnType<typeof createCloud>>;

// Route CloudClient fetches straight into the Hono app, no sockets needed.
const appFetch: typeof fetch = async (input, init) => cloud.app.request(String(input).replace("http://cloud", ""), init);

before(async () => {
  cloud = await createCloud({
    redisUrl: REDIS_URL,
    push: async (url) => (pushes.push(url), true),
    telegram: { secretToken: "s3cret", sendAck: async (chat, text) => void acks.push([chat, text]) },
  });
});
after(() => cloud.close());
beforeEach(async () => {
  await cloud.store.redis.flushdb();
  pushes.length = 0;
  acks.length = 0;
});

function device(id: string) {
  const keys = generateDeviceKeys();
  return { keys, client: new CloudClient("http://cloud", id, keys, appFetch) };
}

async function telegram(chatId: number, text: string) {
  return cloud.app.request("/v1/channels/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "s3cret" },
    body: JSON.stringify({ message: { text, date: 1_700_000_000, chat: { id: chatId } } }),
  });
}

test("unsigned and forged check-ins are rejected", async () => {
  const { client } = device("dev-a");
  await client.register("111111", { kind: "none" });
  const res = await cloud.app.request("/v1/checkin", { method: "POST", body: "{}" });
  assert.equal(res.status, 401);
  const imposter = new CloudClient("http://cloud", "dev-a", generateDeviceKeys(), appFetch);
  await assert.rejects(imposter.checkin({ state: "awake", ack: [] }), /401/);
});

test("a device id cannot be re-registered under a different key", async () => {
  await device("dev-a").client.register("111111", { kind: "none" });
  await assert.rejects(device("dev-a").client.register("222222", { kind: "none" }), /409/);
});

test("telegram pairing, sealed relay, lease and ack", async () => {
  const { keys, client } = device("dev-a");
  await client.register("123456", { kind: "none" });

  await telegram(42, "/pair 123456");
  assert.match(acks.at(-1)![1], /Paired/);

  await telegram(42, "book a table at Nopa for 4 friday 7pm");
  // Device offline with no wake path: the sender gets a content-free ack.
  assert.match(acks.at(-1)![1], /asleep/);

  // The cloud only ever stored ciphertext.
  const raw = await cloud.store.redis.keys("env:*");
  const stored = await cloud.store.redis.get(raw[0]!);
  assert.ok(!stored!.includes("Nopa"));

  const first = await client.checkin({ state: "awake", ack: [] });
  assert.equal(first.envelopes.length, 1);
  const msg = openJson<InboundMessage>(keys, first.envelopes[0]!.sealed);
  assert.equal(msg.text, "book a table at Nopa for 4 friday 7pm");
  assert.equal(msg.channel, "telegram");

  // Leased, so not redelivered while the device works on it...
  assert.equal((await client.checkin({ state: "awake", ack: [] })).envelopes.length, 0);
  // ...and gone for good once acked.
  await client.checkin({ state: "awake", ack: [first.envelopes[0]!.id] });
  assert.equal(await cloud.store.redis.exists(`env:${first.envelopes[0]!.id}`), 0);
});

test("expired leases are redelivered", async () => {
  const { keys, client } = device("dev-a");
  await client.register("123456", { kind: "none" });
  await client.enqueueSelf({ kind: "task", urgency: "batch", sealed: sealJson(keys.boxPublicKey, { x: 1 }) });
  const now = Date.now();
  assert.equal((await cloud.store.claim("dev-a", now)).length, 1);
  const again = await cloud.store.claim("dev-a", now + 6 * 60_000);
  assert.equal(again.length, 1);
  assert.equal(again[0]!.attempts, 2);
});

test("long-poll check-in returns as soon as work arrives", async () => {
  const { keys, client } = device("dev-a");
  await client.register("123456", { kind: "none" });
  const started = Date.now();
  const polling = client.checkin({ state: "awake", ack: [], waitMs: 10_000 });
  await new Promise((r) => setTimeout(r, 100));
  const { delivery } = await client.enqueueSelf({ kind: "task", urgency: "now", sealed: sealJson(keys.boxPublicKey, {}) });
  assert.equal(delivery, "long-poll");
  const res = await polling;
  assert.equal(res.envelopes.length, 1);
  assert.ok(Date.now() - started < 5_000);
});

test("push wake fires for an asleep device, once per burst", async () => {
  const { keys, client } = device("dev-a");
  await client.register("123456", { kind: "push", url: "https://ntfy.example/dev-a" });
  const a = await client.enqueueSelf({ kind: "task", urgency: "now", sealed: sealJson(keys.boxPublicKey, {}) });
  const b = await client.enqueueSelf({ kind: "task", urgency: "now", sealed: sealJson(keys.boxPublicKey, {}) });
  assert.equal(a.delivery, "woken");
  assert.equal(b.delivery, "woken");
  assert.deepEqual(pushes, ["https://ntfy.example/dev-a"]);
});

test("deferred envelopes wait for notBefore and the scheduler wakes the device", async () => {
  const { keys, client } = device("dev-a");
  await client.register("123456", { kind: "push", url: "https://ntfy.example/dev-a" });
  const due = Date.now() + 60_000;
  const r = await client.enqueueSelf({ kind: "timer", urgency: "now", sealed: sealJson(keys.boxPublicKey, {}), notBefore: due });
  assert.equal(r.delivery, "queued");
  assert.equal((await client.checkin({ state: "going-to-sleep", ack: [] })).envelopes.length, 0);
  assert.deepEqual(await cloud.scheduler.tick(due - 1), []);
  await cloud.store.redis.del("lock:wake-sweep");
  assert.deepEqual(await cloud.scheduler.tick(due + 1), ["dev-a"]);
  assert.equal(pushes.length, 1);
  assert.equal((await cloud.store.claim("dev-a", due + 1)).length, 1);
});

test("check-in cadence tightens toward the next due item", async () => {
  const { client } = device("dev-a");
  await client.register("123456", { kind: "none" });
  const asleep = await client.checkin({ state: "going-to-sleep", ack: [] });
  assert.equal(asleep.nextCheckinMs, 15 * 60_000);
  const soon = await client.checkin({ state: "going-to-sleep", ack: [], nextLocalDueAt: Date.now() + 120_000 });
  assert.ok(soon.nextCheckinMs <= 120_000 && soon.nextCheckinMs > 100_000);
});

test("inbound email: Postmark, SendGrid and Mailgun shapes all parse", async () => {
  const { parseInboundEmail } = await import("../src/hosted/email.ts");
  const pm = parseInboundEmail({ To: "Momo <m1@in.x.com>", From: "a@b.com", Subject: "S", TextBody: "T" });
  assert.deepEqual(pm, { to: ["m1@in.x.com"], from: "a@b.com", subject: "S", text: "T", html: undefined });
  assert.equal(parseInboundEmail({ to: "m2@in.x.com, other@z.com", from: "a", subject: "S", text: "T" })!.to[1], "other@z.com");
  assert.equal(parseInboundEmail({ recipient: "m3@in.x.com", sender: "a", subject: "S", "body-plain": "T" })!.text, "T");
  assert.equal(parseInboundEmail({ subject: "no recipient" }), null);
});
