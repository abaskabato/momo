// Setting Momo up, the way a person would: `npm start` with a .env, no public
// address. The real server boots, finds its bot, long-polls Telegram (a fake
// Telegram here), and answers the first text. With MOMO_SINGLE_OWNER, a
// second person is turned away. Also: setup's .env handling.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
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

test("npm start: boots, long-polls Telegram without a public address, answers, and stays private", { timeout: 60_000 }, async () => {
  const sent: Array<{ chat_id: string; text: string }> = [];
  const inbox: unknown[] = [];
  let updateId = 0;
  let webhookCleared = false;
  const fakeTelegram = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const method = req.url!.split("/").pop();
    const reply = (result: unknown) => res.end(JSON.stringify({ ok: true, result }));
    if (!req.url!.startsWith("/botTEST:token/")) return res.writeHead(401).end(JSON.stringify({ ok: false, description: "Unauthorized" }));
    if (method === "getMe") return reply({ id: 1, username: "my_momo_bot", first_name: "Momo" });
    if (method === "deleteWebhook") return (webhookCleared = true), reply(true);
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
  await new Promise<void>((r) => fakeTelegram.listen(0, "127.0.0.1", r));
  const tgPort = (fakeTelegram.address() as { port: number }).port;
  const text = (chat: number, t: string) => inbox.push({ update_id: ++updateId, message: { text: t, date: 1, chat: { id: chat, type: "private" } } });

  const redisUrl = process.env.TEST_REDIS_URL_BOOT ?? "redis://127.0.0.1:6379/11";
  const redis = new Redis(redisUrl);
  await redis.flushdb();
  redis.disconnect();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/main.ts", import.meta.url))], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PORT: String(port),
      REDIS_URL: redisUrl,
      MOMO_MASTER_KEY: randomBytes(32).toString("base64"),
      MOMO_MODEL: "gemini/test-model",
      GEMINI_API_KEY: "unused",
      TELEGRAM_BOT_TOKEN: "TEST:token",
      TELEGRAM_API_BASE: `http://127.0.0.1:${tgPort}`,
      MOMO_SINGLE_OWNER: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const until = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 150 && !ok(); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(ok(), `${what}\n--- server output ---\n${out}`);
  };

  try {
    await until(() => out.includes("Telegram: text https://t.me/my_momo_bot (polling)"), "prints the bot link");
    assert.match(out, /No PUBLIC_URL/);
    assert.ok(webhookCleared, "polling clears any webhook");
    const health = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json());
    assert.deepEqual(health, { ok: true });

    text(777, "hey");
    await until(() => sent.some((m) => m.chat_id === "777"), "answers the first text");
    assert.match(sent.find((m) => m.chat_id === "777")!.text, /Hi, I'm Momo/);

    text(888, "hello?");
    await until(() => sent.some((m) => m.chat_id === "888"), "answers the second person");
    assert.equal(sent.find((m) => m.chat_id === "888")!.text, "This Momo is private.");
  } finally {
    child.kill("SIGTERM");
    fakeTelegram.close();
  }
});
