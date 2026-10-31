import { serve } from "@hono/node-server";
import { Redis } from "ioredis";
import { createApp, type TelegramRelayConfig } from "./app.ts";
import { Store } from "./store.ts";
import { Notifier, WakeDispatcher, WakeScheduler, httpPush, type PushFn } from "./wake.ts";

export interface CloudOptions {
  redisUrl?: string;
  push?: PushFn;
  telegram?: TelegramRelayConfig;
  sweepIntervalMs?: number;
}

export async function createCloud(opts: CloudOptions = {}) {
  const url = opts.redisUrl ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  const redis = new Redis(url);
  const sub = new Redis(url);
  const store = new Store(redis);
  const notifier = new Notifier(redis, sub);
  await notifier.start();
  const wake = new WakeDispatcher(store, notifier, opts.push ?? httpPush);
  const scheduler = new WakeScheduler(store, wake, opts.sweepIntervalMs);
  const app = createApp({ store, notifier, wake, telegram: opts.telegram });
  return {
    app,
    store,
    scheduler,
    async close() {
      scheduler.stop();
      sub.disconnect();
      redis.disconnect();
    },
  };
}

function telegramFromEnv(): TelegramRelayConfig | undefined {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token || !secretToken) return undefined;
  return {
    secretToken,
    async sendAck(chatId, text) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    },
  };
}

/**
 * Hosted mode (the default product): set MOMO_MASTER_KEY, PUBLIC_URL,
 * MOMO_MODEL (any provider/model) plus that provider's key, and Telegram
 * and/or WhatsApp credentials.
 */
async function hostedFromEnv(redisUrl: string) {
  const master = process.env.MOMO_MASTER_KEY;
  const baseUrl = process.env.PUBLIC_URL;
  if (!master || !baseUrl) return null;
  const { createAnswerer, createPlanner, HeadlessBrowser, RemindersSkill, WebTaskSkill } = await import("@momo/agent-core");
  const { HostedRuntime } = await import("./hosted/runtime.ts");
  const { TelegramAdapter, WhatsAppAdapter } = await import("./hosted/channels.ts");
  const { UserKeys } = await import("./hosted/keys.ts");
  const { BlandVoice } = await import("./hosted/phone.ts");
  const env = process.env;
  const telegram = env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET ? new TelegramAdapter(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET) : undefined;
  const whatsapp =
    env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_APP_SECRET && env.WHATSAPP_VERIFY_TOKEN
      ? new WhatsAppAdapter({ phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, accessToken: env.WHATSAPP_ACCESS_TOKEN, appSecret: env.WHATSAPP_APP_SECRET, verifyToken: env.WHATSAPP_VERIFY_TOKEN })
      : undefined;
  const browser = new HeadlessBrowser();
  // Any model: MOMO_MODEL=provider/model (see agent-core/src/llm.ts). Answers can use a cheaper one.
  const model = env.MOMO_MODEL ?? "anthropic/claude-opus-5-5";
  const planner = createPlanner(model);
  const answerer = createAnswerer(env.MOMO_ANSWER_MODEL ?? model);
  const web = new WebTaskSkill(planner, browser);
  const runtime = new HostedRuntime({
    redis: new Redis(redisUrl),
    keys: new UserKeys(Buffer.from(master, "base64")),
    baseUrl,
    telegram,
    whatsapp,
    // One web skill per process, so an errand's live page survives between messages.
    skills: () => [new RemindersSkill(), web],
    answer: (t, c) => answerer.answer(t, c),
    // Phone calls when a website can't do it (BLAND_API_KEY); off when unset.
    voice: env.BLAND_API_KEY ? new BlandVoice(env.BLAND_API_KEY) : undefined,
    // Per-user inboxes: MOMO_EMAIL_DOMAIN's MX goes to an inbound-email service
    // that posts to /v1/hosted/email/<INBOUND_EMAIL_SECRET>.
    emailDomain: env.MOMO_EMAIL_DOMAIN,
    inboundEmailSecret: env.INBOUND_EMAIL_SECRET,
    log: (m) => console.error(m),
  });
  if (telegram) {
    // Point the bot at us; Telegram retries until we return 200.
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${baseUrl.replace(/\/$/, "")}/v1/hosted/telegram`, secret_token: env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ["message"] }),
    });
  }
  return runtime;
}

if (import.meta.main) {
  const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  const hosted = await hostedFromEnv(redisUrl);
  // The device relay owns the Telegram webhook only when hosted mode is off.
  const cloud = await createCloud({ redisUrl, telegram: hosted ? undefined : telegramFromEnv() });
  cloud.scheduler.start();
  if (hosted) {
    cloud.app.route("/", hosted.routes());
    // Several errands at once; each user's jobs still run one at a time.
    void hosted.run(Number(process.env.MOMO_WORKERS ?? 8));
  }
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: cloud.app.fetch, port });
  console.log(`momo cloud listening on :${port}${hosted ? " (hosted mode)" : ""}`);
}
