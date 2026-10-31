// End-to-end vertical slice: "book a restaurant reservation from a text
// request" with confirm-before-commit.
//
// Real pieces: Redis-backed cloud (in-process Hono), sealed envelopes,
// signed check-ins, the Assistant + restaurant skill, the local vault, and a
// real headless Chromium driving a real (local) booking site.
// Faked: only the outbound channel (recorded instead of sent).

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudClient } from "@momo/protocol";
import { createCloud } from "@momo/cloud";
import {
  CheckinWorker,
  FileKeyProvider,
  HeadlessBrowser,
  JsonFile,
  RecordingOutbound,
  RestaurantSkill,
  TableNowProvider,
  createLocalAgent,
  loadOrCreateDeviceKeys,
  startMockSite,
} from "../src/index.ts";

const OWNER_CHAT = "424242";
const PASSWORD = "hunter2-correct-horse";
const MONDAY_NOON = new Date(2026, 10, 2, 12, 0);

let cloud: Awaited<ReturnType<typeof createCloud>>;
let site: Awaited<ReturnType<typeof startMockSite>>;
let browser: HeadlessBrowser;
let stateDir: string;
const acks: string[] = [];

before(async () => {
  cloud = await createCloud({
    redisUrl: process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379/14",
    push: async () => false,
    telegram: { secretToken: "tg", sendAck: async (_c, t) => void acks.push(t) },
  });
  await cloud.store.redis.flushdb();
  site = await startMockSite(undefined, { email: "owner@example.com", password: PASSWORD });
  browser = new HeadlessBrowser();
  stateDir = await mkdtemp(join(tmpdir(), "momo-e2e-"));
});

after(async () => {
  await browser.dispose();
  await site.close();
  await cloud.close();
});

async function setup() {
  const outbound = new RecordingOutbound();
  const agent = await createLocalAgent({
    stateDir,
    skills: () => [new RestaurantSkill(new TableNowProvider(site.origin, browser))],
    outbound,
    ownerHandles: [OWNER_CHAT],
    keyProvider: new FileKeyProvider(join(stateDir, "vault.key")),
    now: () => MONDAY_NOON,
  });
  const keys = await loadOrCreateDeviceKeys(stateDir);
  const fetchViaApp: typeof fetch = async (input, init) => cloud.app.request(String(input).replace("http://cloud", ""), init);
  const client = new CloudClient("http://cloud", "macbook-1", keys, fetchViaApp);
  const worker = new CheckinWorker({ client, keys, assistant: agent.assistant, seen: new JsonFile(join(stateDir, "seen.json"), () => []) });
  return { agent, outbound, client, worker };
}

async function text(body: string) {
  const res = await cloud.app.request("/v1/channels/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "tg" },
    body: JSON.stringify({ message: { text: body, date: MONDAY_NOON.getTime() / 1000, chat: { id: Number(OWNER_CHAT) } } }),
  });
  assert.equal(res.status, 200);
}

test("text -> book a restaurant with confirm-before-commit -> undo", { timeout: 120_000 }, async () => {
  const { agent, outbound, client, worker } = await setup();

  // Pair the device with the owner's Telegram chat.
  await client.register("654321", { kind: "none" });
  await text("/pair 654321");

  // 1. The request arrives while the computer is "asleep": queued, generic ack.
  await text("Book a table for 4 at Nopa this Friday at 7pm");
  assert.match(acks.at(-1)!, /asleep/);

  // 2. Computer wakes and checks in. No saved login yet -> it asks for one
  //    instead of asking for an approval it couldn't act on.
  await worker.once();
  assert.match(outbound.last(), /momo vault add-login/);

  // 3. Owner saves the login locally (the CLI does this) and says done.
  await agent.vault.put("login", "TableNow", { identifier: "owner@example.com", password: PASSWORD }, site.origin);
  await text("done");
  await worker.once();

  // 4. It searched with a real browser and now asks for confirmation.
  const prompt = outbound.last();
  assert.match(prompt, /Book Nopa, Fri, Nov 6, 7pm, 4 people\? No-show fee \$25\/person \(\$100 total\)/);
  const token = /YES ([A-Z2-9]{4})/.exec(prompt)![1]!;
  assert.equal(site.state.reservations.size, 0, "nothing is booked before approval");

  // 5. A vague reply is not an approval.
  await text("hmm maybe");
  await worker.once();
  assert.equal(site.state.reservations.size, 0);

  // 6. Owner confirms -> booked through the site, logged in via vault injection.
  await text(`yes ${token}`);
  await worker.once();
  const booked = outbound.last();
  const conf = /Confirmation (TN-[A-F0-9]+)/.exec(booked)![1]!;
  assert.match(booked, /^Booked\. Nopa, Fri, Nov 6, 7pm, 4 people/);
  assert.deepEqual(site.state.reservations.get(conf), { slug: "nopa", date: "2026-11-06", time: "19:00", party: 4, cancelled: false });
  assert.equal(site.state.logins, 1);

  // 7. Replaying the same approval can't book twice.
  await text(`yes ${token}`);
  await worker.once();
  assert.equal(site.state.reservations.size, 1);

  // 8. A reminder is scheduled locally, and memory learned the party size.
  assert.equal(await agent.timers.nextDueAt(), new Date(2026, 10, 6, 16, 0).getTime());
  assert.equal(await agent.memory.get("restaurant.party"), "4");

  // 9. UNDO cancels on the site.
  await text("undo");
  await worker.once();
  assert.match(outbound.last(), new RegExp(`Cancelled your Nopa reservation \\(${conf}\\)`));
  assert.equal(site.state.reservations.get(conf)!.cancelled, true);
  assert.equal(await agent.timers.nextDueAt(), null);

  // Privacy: the password exists only as vault ciphertext on the device; it
  // never appears in any message, task log, or anything the cloud stored.
  for (const m of outbound.sent) assert.ok(!m.text.includes(PASSWORD));
  for (const f of await readdir(stateDir)) {
    assert.ok(!(await readFile(join(stateDir, f), "utf8")).includes(PASSWORD), `${f} leaked the password`);
  }
  for (const k of await cloud.store.redis.keys("*")) {
    const type = await cloud.store.redis.type(k);
    const v = type === "string" ? await cloud.store.redis.get(k) : JSON.stringify(await cloud.store.redis.hgetall(k).catch(() => ({})));
    assert.ok(!String(v).includes("Nopa") && !String(v).includes(PASSWORD), `cloud key ${k} holds plaintext`);
  }
});

test("slot taken -> offers alternatives -> pick one -> approve; STOP cancels", { timeout: 120_000 }, async () => {
  const { outbound, worker } = await setup();
  // 8pm isn't offered; 7pm is free again after the undo above.
  await text("book nopa friday at 8pm for 2");
  await worker.once();
  assert.equal(outbound.last(), "8pm is taken at Nopa on Fri, Nov 6. Closest: 1) 7pm  2) 6:45pm  3) 9:15pm. Reply with a number.");
  await text("1");
  await worker.once();
  assert.match(outbound.last(), /Book Nopa, Fri, Nov 6, 7pm, 2 people\?/);

  await text("stop");
  await worker.once();
  assert.match(outbound.last(), /Stopped 1 task/);
  await text("yes");
  await worker.once();
  assert.equal([...site.state.reservations.values()].filter((r) => !r.cancelled).length, 0, "stop revoked the pending approval");
});
