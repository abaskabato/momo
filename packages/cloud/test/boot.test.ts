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
  const state = { webhookCleared: false };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const method = req.url!.split("/").pop();
    const reply = (result: unknown) => res.end(JSON.stringify({ ok: true, result }));
    if (!req.url!.startsWith("/botTEST:token/")) return res.writeHead(401).end(JSON.stringify({ ok: false, description: "Unauthorized" }));
    if (method === "getMe") return reply({ id: 1, username: "my_momo_bot", first_name: "Momo" });
    if (method === "deleteWebhook") return (state.webhookCleared = true), reply(true);
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
