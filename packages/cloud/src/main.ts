import { randomBytes } from "node:crypto";
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
 * Hosted mode (the default product). `npm run setup` writes the .env this
 * reads; see docs/SETUP.md. Needs MOMO_MASTER_KEY, a model (MOMO_MODEL plus
 * that provider's key) and Telegram and/or WhatsApp credentials.
 *
 * PUBLIC_URL (an https address that reaches this server) enables the
 * Telegram webhook, WhatsApp, and the secure links for logins and cards.
 * Without it, Telegram is long-polled and links point at localhost.
 */
async function hostedFromEnv(kv: import("./hosted/kv.ts").KV, port: number) {
  const env = process.env;
  const master = env.MOMO_MASTER_KEY;
  if (!master) return null;
  const { AgentDesktop, createAnswerer, createPlanner, DesktopBrowser, DockerComputers, HeadlessBrowser, LocalComputer, RemindersSkill, WebTaskSkill } = await import("@momo/agent-core");
  const { HostedRuntime } = await import("./hosted/runtime.ts");
  const { RelayTelegramAdapter, TelegramAdapter, WhatsAppAdapter } = await import("./hosted/channels.ts");
  const { UserKeys } = await import("./hosted/keys.ts");
  const { BlandVoice } = await import("./hosted/phone.ts");
  const baseUrl = env.PUBLIC_URL || `http://localhost:${port}`;
  const isPublic = /^https:\/\//.test(baseUrl);
  // Set by the setup website: secure links and live views open on any phone through it,
  // and (when the site has a shared bot and model) Telegram and the model go through it too.
  const relay = env.MOMO_RELAY_URL && env.MOMO_RELAY_TOKEN ? { url: env.MOMO_RELAY_URL, token: env.MOMO_RELAY_TOKEN } : undefined;
  const telegram = env.TELEGRAM_BOT_TOKEN
    ? new TelegramAdapter(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET || randomBytes(16).toString("hex"), fetch, env.TELEGRAM_API_BASE)
    : relay
      ? new RelayTelegramAdapter(relay.url, relay.token)
      : undefined;
  const whatsapp =
    env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_APP_SECRET && env.WHATSAPP_VERIFY_TOKEN
      ? new WhatsAppAdapter({ phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, accessToken: env.WHATSAPP_ACCESS_TOKEN, appSecret: env.WHATSAPP_APP_SECRET, verifyToken: env.WHATSAPP_VERIFY_TOKEN })
      : undefined;
  if (!telegram && !whatsapp) throw new Error("set TELEGRAM_BOT_TOKEN (or WhatsApp credentials), or set up at your Momo website; run `npm run setup`");
  // MOMO_BROWSER=desktop drives your own Chrome through vercel-labs/agent-desktop
  // (a computer with a screen, one owner). Default: private headless Chromium per errand.
  const browser =
    env.MOMO_BROWSER === "desktop" ? new DesktopBrowser(new AgentDesktop(), env.MOMO_DESKTOP_APP || "Google Chrome") : new HeadlessBrowser({ timezoneId: env.TZ || undefined });
  // Any model: MOMO_MODEL=provider/model (see agent-core/src/llm.ts). Answers can use a cheaper one.
  const model = env.MOMO_MODEL ?? "anthropic/claude-opus-5-5";
  const planner = createPlanner(model);
  const answerer = createAnswerer(env.MOMO_ANSWER_MODEL ?? model);
  // MOMO_DESKTOP: "local" = this computer's screen (one owner), "cloud" = a desktop container per errand.
  const desktopMode = env.MOMO_DESKTOP;
  const computers =
    desktopMode === "local"
      ? new LocalComputer(new AgentDesktop())
      : desktopMode === "cloud"
        ? new DockerComputers({ image: env.MOMO_DESKTOP_IMAGE || "momo-desktop" })
        : undefined;
  const web = new WebTaskSkill(planner, browser, computers);
  const runtime = new HostedRuntime({
    redis: kv,
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
    singleOwner: desktopMode === "local" || env.MOMO_SINGLE_OWNER === "1",
    relay,
    log: (m) => console.error(m),
  });

  const stop = new AbortController();
  return {
    runtime,
    model,
    baseUrl,
    async start(): Promise<string[]> {
      const notes: string[] = [
        `model: ${model}`,
        `browser: ${env.MOMO_BROWSER === "desktop" ? "your Chrome via agent-desktop" : "headless Chromium"}`,
        `computer: ${computers ? computers.describe : "off (websites only; set MOMO_DESKTOP=local or cloud)"}`,
      ];
      if (desktopMode === "local") notes.push("Private: only the first person to text this Momo can use it.");
      if (telegram instanceof RelayTelegramAdapter) {
        const me = await telegram.me();
        void telegram.poll((m) => runtime.accept(m), stop.signal, (e) => console.error(`telegram: ${e.message}`));
        const link = env.MOMO_PAIR_CODE ? `https://t.me/${me.username}?start=${env.MOMO_PAIR_CODE}` : `https://t.me/${me.username}`;
        notes.push(`Telegram: tap ${link} (shared bot via ${relay!.url})`);
      } else if (telegram) {
        const me = await telegram.me();
        const mode = env.TELEGRAM_MODE || (isPublic ? "webhook" : "polling");
        if (mode === "webhook") await telegram.setWebhook(`${baseUrl.replace(/\/$/, "")}/v1/hosted/telegram`);
        else void telegram.poll((m) => runtime.accept(m), stop.signal, (e) => console.error(`telegram poll: ${e.message}`));
        notes.push(`Telegram: text https://t.me/${me.username} (${mode})`);
      }
      if (whatsapp) notes.push(isPublic ? `WhatsApp: webhook ${baseUrl.replace(/\/$/, "")}/v1/hosted/whatsapp` : "WhatsApp needs PUBLIC_URL (https) for its webhook");
      if (!isPublic && env.MOMO_RELAY_URL) notes.push(`Secure links: through ${env.MOMO_RELAY_URL} (sealed on the phone; only this computer can open them)`);
      else if (!isPublic) notes.push("No PUBLIC_URL: login/card links only open on this computer. For phones, set up at your Momo website or set PUBLIC_URL.");
      // Check the AI once at startup so a wrong key or model name is obvious in the log.
      try {
        await answerer.answer("Reply with the single word: ok", "");
        notes.push("AI check: ok");
      } catch (e) {
        notes.push(`AI PROBLEM: ${(e as Error).message.slice(0, 300)}`);
        notes.push("Momo will answer texts with this error until the model name/key in its settings is fixed.");
      }
      void runtime.run(Number(env.MOMO_WORKERS ?? 8));
      return notes;
    },
    stop: () => {
      stop.abort();
      runtime.stop();
    },
  };
}

if (import.meta.main) {
  // A server sets REDIS_URL. On a person's own device there's no Redis to
  // install: Momo keeps its state in one file (~/.momo/store.json).
  const redisUrl = process.env.REDIS_URL;
  const port = Number(process.env.PORT ?? 8787);
  const { FileKV, fromRedis } = await import("./hosted/kv.ts");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const kv = redisUrl
    ? fromRedis(new Redis(redisUrl))
    : new FileKV(join(process.env.MOMO_HOME ?? join(homedir(), ".momo"), "store.json"));
  const hosted = await hostedFromEnv(kv, port);
  let app: { fetch: (r: Request) => Response | Promise<Response> };
  let close = async () => kv.disconnect();
  if (hosted && !redisUrl) {
    const { Hono } = await import("hono");
    const device = new Hono();
    device.get("/healthz", (c) => c.json({ ok: true }));
    device.route("/", hosted.runtime.routes());
    app = device;
  } else {
    // The device relay owns the Telegram webhook only when hosted mode is off.
    const cloud = await createCloud({ redisUrl, telegram: hosted ? undefined : telegramFromEnv() });
    cloud.scheduler.start();
    if (hosted) cloud.app.route("/", hosted.runtime.routes());
    app = cloud.app;
    close = async () => {
      await cloud.close();
      kv.disconnect();
    };
  }
  serve({ fetch: app.fetch, port });
  console.log(`momo listening on :${port}${hosted ? " (hosted mode)" : ""}${redisUrl ? "" : ` (state in ${process.env.MOMO_HOME ?? "~/.momo"})`}`);
  if (hosted) for (const n of await hosted.start()) console.log(`  ${n}`);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      hosted?.stop();
      void close().finally(() => process.exit(0));
    });
  }
}
