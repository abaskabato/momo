// Setting Momo up, the way a person would: `npm start` with a .env, no public
// address. The real server boots, finds its bot, long-polls Telegram (a fake
// Telegram here), and answers the first text. With MOMO_SINGLE_OWNER, a
// second person is turned away. Run twice: on a server (Redis) and on a
// person's own device (no Redis; state in ~/.momo, kept across restarts).
// Also: setup's .env handling.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redis } from "ioredis";
import { keepOrGenerate, mergeEnv, parseEnv } from "../src/setup.ts";
import { createRelay, memoryStore } from "../../../apps/web/lib/relay.js";
import { startDev } from "../../../apps/web/dev.js";

test("setup: .env merge keeps comments and other keys, and never regenerates the master key", () => {
  const before = "# my notes\nMOMO_MODEL=gemini/old\nGEMINI_API_KEY=abc\nCUSTOM=1\n";
  const after = mergeEnv(before, { MOMO_MODEL: "gemini/new", PUBLIC_URL: "https://x.example", MOMO_DESKTOP: undefined, GEMINI_API_KEY: "abc" });
  assert.equal(after, "# my notes\nMOMO_MODEL=gemini/new\nGEMINI_API_KEY=abc\nCUSTOM=1\nPUBLIC_URL=https://x.example\n");
  assert.equal(mergeEnv("A=1\nB=2\n", { A: "" }), "B=2\n", "empty answers remove the line");
  assert.deepEqual(parseEnv('X="quoted"\n# c\nY=2'), { X: "quoted", Y: "2" });
  const first = keepOrGenerate({});
  assert.equal(Buffer.from(first.MOMO_MASTER_KEY, "base64").length, 32);
  assert.deepEqual(keepOrGenerate(first), first);
});

async function fakeTelegram(firstUpdateId = 0) {
  const sent: Array<{ chat_id: string; text: string }> = [];
  const inbox: unknown[] = [];
  let updateId = firstUpdateId;
  const state = { webhookCleared: false, secret: "" };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const method = req.url!.split("/").pop();
    const reply = (result: unknown) => res.end(JSON.stringify({ ok: true, result }));
    if (!req.url!.startsWith("/botTEST:token/")) return res.writeHead(401).end(JSON.stringify({ ok: false, description: "Unauthorized" }));
    if (method === "getMe") return reply({ id: 1, username: "my_momo_bot", first_name: "Momo" });
    if (method === "deleteWebhook") return (state.webhookCleared = true), reply(true);
    if (method === "setWebhook") return (state.secret = JSON.parse(body).secret_token), reply(true);
    if (method === "sendMessage") return sent.push(JSON.parse(body)), reply({ message_id: sent.length });
    if (method === "getUpdates") {
      const { offset } = JSON.parse(body) as { offset: number };
      const pending = inbox.filter((u) => (u as { update_id: number }).update_id >= offset);
      if (pending.length) return reply(pending);
      await new Promise((r) => setTimeout(r, 200)); // a short long-poll
      return reply([]);
    }
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const text = (chat: number, t: string) => inbox.push({ update_id: ++updateId, message: { text: t, date: 1, chat: { id: chat, type: "private" } } });
  return { sent, text, state, base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

async function boot(env: Record<string, string>, tgBase: string) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/main.ts", import.meta.url))], {
    env: {
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      PORT: String(port),
      MOMO_MODEL: "gemini/test-model",
      GEMINI_API_KEY: "unused",
      TELEGRAM_BOT_TOKEN: "TEST:token",
      TELEGRAM_API_BASE: tgBase,
      MOMO_MODEL_BASE_URL: tgBase, // the startup AI check gets a quick 404 instead of calling a real provider
      MOMO_SINGLE_OWNER: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = { out: "" };
  child.stdout.on("data", (d) => (log.out += d));
  child.stderr.on("data", (d) => (log.out += d));
  const until = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 150 && !ok(); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(ok(), `${what}\n--- server output ---\n${log.out}`);
  };
  const exited = new Promise((r) => child.once("exit", r));
  const stop = async () => {
    child.kill("SIGTERM");
    await exited;
  };
  return { port, log, until, stop };
}

async function bootAndChat(env: Record<string, string>) {
  const tg = await fakeTelegram();
  const s = await boot(env, tg.base);
  try {
    await s.until(() => s.log.out.includes("Telegram: text https://t.me/my_momo_bot (polling)"), "prints the bot link");
    assert.match(s.log.out, /No PUBLIC_URL/);
    assert.match(s.log.out, /AI PROBLEM: /, "a model that can't be reached is called out at startup");
    await s.until(() => tg.state.webhookCleared, "polling clears any webhook");
    const health = await fetch(`http://127.0.0.1:${s.port}/healthz`).then((r) => r.json());
    assert.deepEqual(health, { ok: true });

    tg.text(777, "hey");
    await s.until(() => tg.sent.some((m) => m.chat_id === "777"), "answers the first text");
    assert.match(tg.sent.find((m) => m.chat_id === "777")!.text, /Hi, I'm Momo/);

    tg.text(888, "hello?");
    await s.until(() => tg.sent.some((m) => m.chat_id === "888"), "answers the second person");
    assert.equal(tg.sent.find((m) => m.chat_id === "888")!.text, "This Momo is private.");
  } finally {
    await s.stop();
    tg.close();
  }
}

test("npm start on a server (Redis): boots, long-polls Telegram, answers, and stays private", { timeout: 60_000 }, async () => {
  const redisUrl = process.env.TEST_REDIS_URL_BOOT ?? "redis://127.0.0.1:6379/11";
  const redis = new Redis(redisUrl);
  await redis.flushdb();
  redis.disconnect();
  await bootAndChat({ REDIS_URL: redisUrl, MOMO_MASTER_KEY: randomBytes(32).toString("base64") });
});

test("npm start on a person's own device: no Redis, state saved in MOMO_HOME and kept across restarts", { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-home-"));
  const env = { MOMO_HOME: home, MOMO_MASTER_KEY: randomBytes(32).toString("base64") };
  try {
    await bootAndChat(env);
    assert.ok(existsSync(join(home, "store.json")), "state is saved on shutdown");

    // Restart: the owner is remembered, so a stranger is still turned away.
    const tg = await fakeTelegram(100); // Telegram never reuses update ids
    const s = await boot(env, tg.base);
    try {
      await s.until(() => s.log.out.includes("(polling)"), "boots again");
      tg.text(888, "let me in");
      await s.until(() => tg.sent.some((m) => m.chat_id === "888"), "answers after restart");
      assert.equal(tg.sent[0]!.text, "This Momo is private.");
    } finally {
      await s.stop();
      tg.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("npm start as the website hands it out: shared bot and shared model through the relay, nothing of its own", { timeout: 90_000 }, async () => {
  // The operator's site: a shared bot (fake Telegram) and a shared model (fake upstream).
  const tg = await fakeTelegram();
  const modelCalls: string[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("generativelanguage.googleapis.com")) {
      modelCalls.push((init?.headers as Record<string, string>).authorization ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "A model answer." } }] }), { headers: { "content-type": "application/json" } });
    }
    return fetch(url, init);
  }) as typeof fetch;
  const relay = createRelay(memoryStore(), {
    env: { MOMO_MODEL: "gemini/gemini-test", GEMINI_API_KEY: "operator-key", TELEGRAM_BOT_TOKEN: "TEST:token", TELEGRAM_API_BASE: tg.base },
    fetch: f,
  });
  const site = await startDev(0, relay);
  const siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  const { token, pair } = (await (await fetch(`${siteUrl}/api/devices`, { method: "POST" })).json()) as { token: string; pair: string };
  const home = mkdtempSync(join(tmpdir(), "momo-home-"));
  const s = await boot(
    {
      MOMO_HOME: home,
      MOMO_MASTER_KEY: randomBytes(32).toString("base64"),
      MOMO_MODEL: "custom/gemini-test",
      MOMO_MODEL_BASE_URL: `${siteUrl}/api/model/v1`,
      MOMO_MODEL_API_KEY: token,
      MOMO_RELAY_URL: siteUrl,
      MOMO_RELAY_TOKEN: token,
      MOMO_PAIR_CODE: pair,
      TELEGRAM_BOT_TOKEN: "", // none of its own
      GEMINI_API_KEY: "",
    },
    tg.base,
  );
  try {
    await s.until(() => s.log.out.includes(`Telegram: tap https://t.me/my_momo_bot?start=${pair} (shared bot via ${siteUrl})`), "prints the tap-to-start link");
    // The webhook the relay registered with Telegram is what Telegram will call; call it as Telegram would.
    const hook = async (update: unknown) => {
      const r = await fetch(`${siteUrl}/api/telegram`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": tg.state.secret }, body: JSON.stringify(update) });
      assert.equal(r.status, 200);
    };
    await hook({ update_id: 1, message: { text: `/start ${pair}`, date: 1, chat: { id: 777, type: "private" } } });
    await s.until(() => tg.sent.some((m) => m.chat_id === "777"), "answers the first text through the relay");
    assert.match(tg.sent.find((m) => m.chat_id === "777")!.text, /Hi, I'm Momo/);
    await hook({ update_id: 2, message: { text: "Ana", date: 2, chat: { id: 777, type: "private" } } });
    await s.until(() => tg.sent.filter((m) => m.chat_id === "777").length >= 2, "keeps the conversation going");
    assert.match(tg.sent.filter((m) => m.chat_id === "777").at(-1)!.text, /Nice to meet you, Ana/);
    await hook({ update_id: 3, message: { text: "San Francisco", date: 3, chat: { id: 777, type: "private" } } });
    await s.until(() => tg.sent.filter((m) => m.chat_id === "777").length >= 3, "finishes onboarding");
    // A question goes to the model through the relay with the operator's key, which never left the server.
    await hook({ update_id: 4, message: { text: "what time is it in Tokyo?", date: 4, chat: { id: 777, type: "private" } } });
    await s.until(() => modelCalls.length > 0, "the model is called through the relay");
    assert.equal(modelCalls[0], "Bearer operator-key");
    assert.ok(!s.log.out.includes("operator-key"));
  } finally {
    await s.stop();
    tg.close();
    site.close();
    rmSync(home, { recursive: true, force: true });
  }
});
