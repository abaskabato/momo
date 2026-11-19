import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { Redis } from "ioredis";
import { createApp, type TelegramRelayConfig } from "./app.ts";
import { Store } from "./store.ts";
import { KeepAwake, awakeFromEnv } from "./awake.ts";
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
 * Without it, Telegram is long-polled and links point at this computer (127.0.0.1).
 */
async function hostedFromEnv(kv: import("./hosted/kv.ts").KV, port: number) {
  const env = process.env;
  const master = env.MOMO_MASTER_KEY;
  if (!master) return null;
  const { AgentDesktop, createAnswerer, createPlanner, isSmallModel, parseModelSpec, LocalPc, VisibleBrowser, everydayBrowsers, DesktopBrowser, DockerComputers, HeadlessBrowser, LocalComputer, RemindersSkill, WebTaskSkill } = await import("@momo/agent-core");
  const { HostedRuntime } = await import("./hosted/runtime.ts");
  const { RelayTelegramAdapter, TelegramAdapter, WhatsAppAdapter } = await import("./hosted/channels.ts");
  const { UserKeys } = await import("./hosted/keys.ts");
  const { BlandVoice } = await import("./hosted/phone.ts");
  const baseUrl = env.PUBLIC_URL || `http://127.0.0.1:${port}`;
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
  // On a person's own computer (no REDIS_URL, a screen): a real, visible browser window they can watch and
  // step into, with its own profile that keeps sign-ins. MOMO_BROWSER=hidden turns that off; =visible forces it.
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const hasScreen = process.platform === "win32" || process.platform === "darwin" || !!env.DISPLAY || !!env.WAYLAND_DISPLAY;
  const visible = env.MOMO_BROWSER === "visible" || (!env.MOMO_BROWSER && !env.REDIS_URL && hasScreen);
  const browser =
    env.MOMO_BROWSER === "desktop"
      ? new DesktopBrowser(new AgentDesktop(), env.MOMO_DESKTOP_APP || "Google Chrome")
      : visible
        ? new VisibleBrowser({
            profileDir: join(env.MOMO_HOME ?? join(homedir(), ".momo"), "browser-profile"),
            timezoneId: env.TZ || undefined,
            // Start out signed in wherever the owner is: copy their everyday browser's sign-ins once.
            // MOMO_SIGN_INS=none keeps Momo's browser separate; =edge or =chrome picks which to copy.
            signIns: everydayBrowsers().filter((b) => !env.MOMO_SIGN_INS || b.name.toLowerCase() === env.MOMO_SIGN_INS.toLowerCase()),
          })
        : new HeadlessBrowser({ timezoneId: env.TZ || undefined });
  // Any model: MOMO_MODEL=provider/model (see agent-core/src/llm.ts). Answers can use a cheaper one.
  // ollama/auto: a Gemma 4 size picked for this computer (agent-core/src/local.ts).
  const { resolveAutoModel, ollamaHas, pullOllamaModel } = await import("@momo/agent-core");
  const auto = await resolveAutoModel(env.MOMO_MODEL ?? "anthropic/claude-opus-5-5");
  const model = auto.spec;
  if (env.MOMO_ANSWER_MODEL) env.MOMO_ANSWER_MODEL = (await resolveAutoModel(env.MOMO_ANSWER_MODEL)).spec;
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
  // MOMO_ACCESS=full: files and commands on this computer too (the owner's own; one owner).
  // Looking is free; every change is shown to the owner and waits for their YES.
  const pc = env.MOMO_ACCESS === "full" ? new LocalPc() : undefined;
  // On the owner's own computer commands run without a question each (deleting, uninstalling and replacing
  // files still ask). MOMO_ASK=commands goes back to asking before every change.
  // A free reservation or appointment the owner asked for is made without a YES first, then reported with how
  // to cancel. MOMO_ASK=money asks before purchases, messages, calls and deletions; =bookings before free bookings too.
  const web = new WebTaskSkill(planner, browser, computers, pc, {
    freeCommands: env.MOMO_ASK !== "commands",
    freeBookings: !env.MOMO_ASK || env.MOMO_ASK === "money",
    // Text and done (the default): nothing waits for a YES, except a purchase above MOMO_SPEND_LIMIT (US dollars; "none" lifts it).
    noAsk: !env.MOMO_ASK,
    spendLimit: env.MOMO_SPEND_LIMIT === "none" ? Infinity : Number(env.MOMO_SPEND_LIMIT ?? 200) || 0,
    // Small and local models get the light loop (short instructions, core tools, small page views). MOMO_LITE=1/0 forces it.
    lite: env.MOMO_LITE ? env.MOMO_LITE === "1" : isSmallModel(model),
  });
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
    // MOMO_CALLS=relay: the website places them on its own key (the setup page writes this when it can).
    voice: env.BLAND_API_KEY
      ? new BlandVoice(env.BLAND_API_KEY)
      : env.MOMO_CALLS === "relay" && relay
        ? new BlandVoice(`Bearer ${relay.token}`, fetch, `${relay.url.replace(/\/$/, "")}/api`)
        : undefined,
    // Per-user inboxes: MOMO_EMAIL_DOMAIN's MX goes to an inbound-email service
    // that posts to /v1/hosted/email/<INBOUND_EMAIL_SECRET>.
    emailDomain: env.MOMO_EMAIL_DOMAIN,
    inboundEmailSecret: env.INBOUND_EMAIL_SECRET,
    singleOwner: desktopMode === "local" || !!pc || env.MOMO_SINGLE_OWNER === "1",
    relay,
    log: (m) => console.error(m),
  });

  const stop = new AbortController();
  // On a person's own computer: hold it awake so texts are always answered (MOMO_AWAKE=off to leave it be),
  // with a nightly rest where the computer can wake itself again (MOMO_MAINTENANCE=03:00-05:00).
  const awake = isPublic || env.REDIS_URL ? undefined : awakeFromEnv(env); // a server never sleeps
  const keepAwake = awake?.on ? new KeepAwake({ window: awake.window, busy: () => runtime.busy, log: (m) => console.error(m) }) : undefined;
  return {
    runtime,
    model,
    baseUrl,
    async start(): Promise<string[]> {
      const notes: string[] = [
        `model: ${model}`,
        `browser: ${env.MOMO_BROWSER === "desktop" ? "your Chrome via agent-desktop" : visible ? "a visible window on this computer (Chrome or Edge; you can watch and step in)" : "headless Chromium"}`,
        ...(browser instanceof VisibleBrowser ? ["sign-ins and saved passwords: checking in the background (the result is logged below)"] : []),
        `computer: ${computers ? computers.describe : "off (websites only; set MOMO_DESKTOP=local or cloud)"}`,
      ];
      // Copying a big browser profile can take minutes; Momo answers texts meanwhile.
      if (browser instanceof VisibleBrowser) void browser.prepare().then((r) => console.log(`  sign-ins and saved passwords: ${r}`), () => {});
      if (awake) notes.push(awake.note);
      keepAwake?.start();
      // This Mac as everybody's iMessage line: MOMO_GATEWAY_TOKEN (the same one set on the website).
      if (env.MOMO_GATEWAY_TOKEN && env.MOMO_RELAY_URL) {
        const { IMessageGateway, canBeGateway } = await import("./imessage-gateway.ts");
        const no = canBeGateway();
        if (no) notes.push(`IMESSAGE GATEWAY PROBLEM: ${no}`);
        else {
          void new IMessageGateway({ relayUrl: env.MOMO_RELAY_URL, token: env.MOMO_GATEWAY_TOKEN, log: (m) => console.error(m) }).run(stop.signal);
          notes.push(`iMessage gateway: on (texts to this Mac's Messages are passed to ${env.MOMO_RELAY_URL}, answers are sent from here)`);
        }
      }
      if (pc) notes.push(env.MOMO_ASK === "commands" ? "files and commands: full access to this computer (it looks freely; every change asks for your YES)" : !env.MOMO_ASK ? "files and commands: full access to this computer (it does what the errand needs and tells you what it changed; MOMO_ASK=money makes it ask before deleting)" : "files and commands: full access to this computer (it asks only before deleting, uninstalling or replacing a file; MOMO_ASK=commands makes it ask before every change)");
      if (desktopMode === "local" || pc) notes.push("Private: only the first person to text this Momo can use it.");
      if (telegram instanceof RelayTelegramAdapter) {
        const me = await telegram.me();
        void telegram.poll((m) => runtime.accept(m), stop.signal, (e) => console.error(`telegram: ${e.message}`));
        const link = env.MOMO_PAIR_CODE ? `https://t.me/${me.username}?start=${env.MOMO_PAIR_CODE}` : `https://t.me/${me.username}`;
        if (me.username) notes.push(`Telegram: tap ${link} (shared bot via ${relay!.url})`);
        if (me.imessage) notes.push(`iMessage: text ${env.MOMO_PAIR_CODE ? `the code ${env.MOMO_PAIR_CODE} to ` : ""}${me.imessage} from Messages (shared line via ${relay!.url})`);
      } else if (telegram) {
        const me = await telegram.me();
        const mode = env.TELEGRAM_MODE || (isPublic ? "webhook" : "polling");
        if (mode === "webhook") await telegram.setWebhook(`${baseUrl.replace(/\/$/, "")}/v1/hosted/telegram`);
        else void telegram.poll((m) => runtime.accept(m), stop.signal, (e) =>
            console.error(/conflict/i.test(e.message) ? "telegram: ANOTHER COPY of this bot is running somewhere (another Momo, or another computer). Stop it: only one can receive texts." : `telegram poll: ${e.message}`),
          );
        notes.push(`Telegram: text https://t.me/${me.username} (${mode})`);
      }
      if (env.MOMO_FRONTIER_MODEL && env.MOMO_FRONTIER_MODEL !== model) notes.push(`hybrid: ${model} does each step; ${env.MOMO_FRONTIER_MODEL} takes over when it's stuck and checks before anything final`);
      if (env.MOMO_LITE ? env.MOMO_LITE === "1" : isSmallModel(model)) notes.push("light mode for a small model: short instructions, core tools, small page views (MOMO_LITE=0 turns it off)");
      notes.push(!env.MOMO_ASK ? `asking: text and done (nothing waits for a YES${env.MOMO_SPEND_LIMIT === "none" ? "" : `, except a purchase over $${Number(env.MOMO_SPEND_LIMIT ?? 200) || 0}`}; MOMO_ASK=money brings the questions back)` : `asking: MOMO_ASK=${env.MOMO_ASK}`);
      notes.push(env.BLAND_API_KEY ? "phone calls: on (Momo can phone businesses)" : env.MOMO_CALLS === "relay" && relay ? `phone calls: on, through ${relay.url} (Momo can phone businesses)` : "phone calls: off (add BLAND_API_KEY to turn them on)");
      if (whatsapp) notes.push(isPublic ? `WhatsApp: webhook ${baseUrl.replace(/\/$/, "")}/v1/hosted/whatsapp` : "WhatsApp needs PUBLIC_URL (https) for its webhook");
      if (!isPublic && env.MOMO_RELAY_URL) notes.push(`Secure links: through ${env.MOMO_RELAY_URL} (sealed on the phone; only this computer can open them)`);
      else if (!isPublic) notes.push("No PUBLIC_URL: login/card links only open on this computer. For phones, set up at your Momo website or set PUBLIC_URL.");
      // Same for the computer: say now if Momo can't actually reach this computer's apps.
      if (desktopMode === "local") {
        try {
          await new AgentDesktop().listApps();
          notes.push("computer check: ok (Momo can see and use this computer's apps)");
        } catch (e) {
          notes.push(`COMPUTER PROBLEM: ${(e as Error).message.slice(0, 300)}`);
        }
      }
      if (auto.note) notes.push(auto.note);
      // A local model that isn't on this computer yet: download it now (in the background, it's gigabytes).
      let fetching = false;
      for (const spec of new Set([model, env.MOMO_ANSWER_MODEL ?? model, env.MOMO_FRONTIER_MODEL ?? model])) {
        const s = parseModelSpec(spec);
        if (s.provider !== "ollama") continue;
        const has = await ollamaHas(s.model, s.baseUrl).catch(() => undefined);
        if (has === false) {
          fetching = true;
          notes.push(`downloading ${s.model} through Ollama (a few GB, once); Momo answers texts as soon as it's done`);
          void pullOllamaModel(s.model, s.baseUrl).then(() => console.log(`AI check: ${s.model} is ready`), (e) => console.error(`AI PROBLEM: downloading ${s.model}: ${(e as Error).message}`));
        }
      }
      // Check the AI once at startup so a wrong key or model name is obvious in the log.
      if (!fetching) try {
        await answerer.answer("Reply with the single word: ok", "");
        notes.push("AI check: ok");
      } catch (e) {
        notes.push(`AI PROBLEM: ${(e as Error).message.slice(0, 300)}`);
        // If it's the model name, say which names this key does have.
        try {
          const spec = parseModelSpec(env.MOMO_ANSWER_MODEL ?? model);
          if (spec.baseUrl) {
            const r = await fetch(`${spec.baseUrl.replace(/\/$/, "")}/models`, { headers: spec.apiKey ? { authorization: `Bearer ${spec.apiKey}` } : {} });
            const ids = r.ok ? ((await r.json()) as { data?: Array<{ id: string }> }).data?.map((m) => m.id.replace(/^models\//, "")) : undefined;
            if (ids?.length) notes.push(`Model names this key can use: ${ids.slice(0, 30).join(", ")}. Set MOMO_MODEL=${spec.provider}/<one of these>.`);
          }
        } catch {}
        notes.push("Momo will answer texts with this error until the model name/key in its settings is fixed.");
      }
      void runtime.run(Number(env.MOMO_WORKERS ?? 8));
      return notes;
    },
    stop: () => {
      keepAwake?.stop();
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
  // On a person's own computer (no Redis, no public address) the server is only for this computer: nothing on the
  // same wifi can reach it. A server for many people listens everywhere. MOMO_LISTEN overrides.
  const hostname = process.env.MOMO_LISTEN ?? (redisUrl || process.env.PUBLIC_URL ? undefined : "127.0.0.1");
  serve({ fetch: app.fetch, port, ...(hostname ? { hostname } : {}) });
  const { readFile } = await import("node:fs/promises");
  const fetched = await readFile(new URL("../../../VERSION", import.meta.url), "utf8").then((v) => v.trim(), () => "");
  if (fetched) console.log(`version: downloaded ${fetched}`);
  console.log(`momo listening on :${port}${hosted ? " (hosted mode)" : ""}${redisUrl ? "" : ` (state in ${process.env.MOMO_HOME ?? "~/.momo"})`}`);
  if (hosted) for (const n of await hosted.start()) console.log(`  ${n}`);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      hosted?.stop();
      void close().finally(() => process.exit(0));
    });
  }
}
