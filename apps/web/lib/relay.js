// Momo's relay on Vercel. A person's Momo runs on their own computer; this
// relay does the few things that need a public address, and lets the site's
// operator pre-fill the hard parts of setup:
//
//   - secure links: the page seals what the person types to their own Momo's
//     key in the browser; the relay holds only ciphertext for 30 minutes
//   - live views: screenshots one way, taps the other, while a person finishes
//     a CAPTCHA in the errand's browser
//   - one shared Telegram bot (TELEGRAM_BOT_TOKEN on the server): people tap a
//     link instead of making their own bot; messages are queued per device
//   - one shared iMessage line (SENDBLUE_API_KEY_ID, SENDBLUE_API_SECRET_KEY and
//     SENDBLUE_NUMBER on the server): people text the line from Messages; no Mac
//     anywhere. Works beside the Telegram bot or instead of it
//   - one shared model key (MOMO_MODEL + that provider's key on the server):
//     devices call the model through here and never hold the key
//
// Plain JavaScript with no dependencies and no build step. Web standards only.

const FORM_TTL_S = 30 * 60;
const LIVE_TTL_S = 30 * 60;
const SHOT_TTL_S = 20;
const PAIR_TTL_S = 7 * 24 * 3600;
const INBOX_TTL_S = 24 * 3600;
const MAX_SEALED = 16_000;
const MAX_SHOT = 900_000; // base64 JPEG
const MAX_TEXT = 4000;
const ID = /^[\w-]{16,64}$/;
const KINDS = new Set(["login", "card", "address"]);

/** OpenAI-compatible endpoints, the same table as agent-core's llm.ts (a test keeps them equal). */
export const MODEL_PROVIDERS = {
  openai: { baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", keyEnv: "ANTHROPIC_API_KEY" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: "GEMINI_API_KEY" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY" },
  together: { baseUrl: "https://api.together.xyz/v1", keyEnv: "TOGETHER_API_KEY" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY" },
  mistral: { baseUrl: "https://api.mistral.ai/v1", keyEnv: "MISTRAL_API_KEY" },
  xai: { baseUrl: "https://api.x.ai/v1", keyEnv: "XAI_API_KEY" },
  fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1", keyEnv: "FIREWORKS_API_KEY" },
};

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** A plain page for the person (the end of paying). */
const page = (text, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Momo</title>` +
      `<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f1ea;color:#1d1b17;font:20px/1.4 system-ui,sans-serif;padding:24px;box-sizing:border-box">` +
      `<p style="max-width:28em">${text.replace(/[<>&]/g, "")}</p>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
const randomToken = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));
async function sha256(s) {
  return b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

/** Upstash Redis over REST (Vercel Storage → Upstash sets these env vars). */
export function upstashStore(url, token, f = fetch) {
  const call = async (cmd) => {
    const r = await f(url.replace(/\/$/, ""), { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(cmd) });
    const j = await r.json();
    if (j.error) throw new Error(`upstash: ${j.error}`);
    return j.result;
  };
  return {
    get: (k) => call(["GET", k]),
    set: async (k, v, ex, nx) => (await call(["SET", k, v, ...(ex ? ["EX", ex] : []), ...(nx ? ["NX"] : [])])) === "OK",
    getdel: (k) => call(["GETDEL", k]),
    del: (k) => call(["DEL", k]),
    async rpush(k, v, ex) {
      await call(["RPUSH", k, v]);
      await call(["EXPIRE", k, ex]);
    },
    popall: async (k, n = 100) => (await call(["LPOP", k, n])) ?? [],
    async incr(k, ex) {
      const n = await call(["INCR", k]);
      if (n === 1) await call(["EXPIRE", k, ex]);
      return n;
    },
  };
}

/** In memory: local development and tests. */
export function memoryStore() {
  const m = new Map();
  const live = (k) => {
    const e = m.get(k);
    if (e && e.exp && e.exp <= Date.now()) m.delete(k);
    return m.get(k);
  };
  return {
    dump: () => [...m.values()].map((e) => JSON.stringify(e.v)),
    get: async (k) => live(k)?.v ?? null,
    async set(k, v, ex, nx) {
      if (nx && live(k)) return false;
      m.set(k, { v, exp: ex ? Date.now() + ex * 1000 : 0 });
      return true;
    },
    async getdel(k) {
      const v = live(k)?.v ?? null;
      m.delete(k);
      return v;
    },
    del: async (k) => void m.delete(k),
    async rpush(k, v, ex) {
      const e = live(k) ?? { v: [], exp: Date.now() + ex * 1000 };
      e.v = [...e.v, v];
      m.set(k, e);
    },
    async popall(k, n = 100) {
      const e = live(k);
      if (!e) return [];
      const out = e.v.slice(0, n);
      e.v = e.v.slice(n);
      if (!e.v.length) m.delete(k);
      return out;
    },
    async incr(k, ex) {
      const n = Number(live(k)?.v ?? 0) + 1;
      m.set(k, { v: String(n), exp: live(k)?.exp || Date.now() + ex * 1000 });
      return n;
    },
  };
}

export function storeFromEnv(env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return upstashStore(url, token);
  return env.VERCEL ? null : memoryStore();
}

/** Calendar file for a booking; everything it shows is in its own URL. */
function ics(q) {
  const t = (k) => (q.get(k) ?? "").slice(0, 200);
  const when = (v) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? `${v.replace(/[-:]/g, "")}00` : null);
  const start = when(t("s"));
  const end = when(t("e"));
  if (!start || !end) return new Response("bad event", { status: 400 });
  const text = (v) => v.replace(/[\\;,]/g, (m) => `\\${m}`).replace(/[\r\n]+/g, " ");
  const body = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Momo//EN", "BEGIN:VEVENT",
    `UID:${randomToken(8)}@momo`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
    `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${text(t("t"))}`, ...(t("l") ? [`LOCATION:${text(t("l"))}`] : []),
    "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
  return new Response(body, { headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": "attachment; filename=event.ics" } });
}

/** What the operator pre-filled on the server, if anything. */
export function operatorConfig(env) {
  const spec = env.MOMO_MODEL ?? "";
  const slash = spec.indexOf("/");
  const provider = slash > 0 ? MODEL_PROVIDERS[spec.slice(0, slash)] : undefined;
  const key = provider && env[provider.keyEnv];
  return {
    model: provider && key ? { name: spec.slice(slash + 1), baseUrl: env.MOMO_MODEL_BASE_URL || provider.baseUrl, key } : null,
    botToken: env.TELEGRAM_BOT_TOKEN || null,
    // An iMessage line from Sendblue: its two API keys and the line's number (what people text).
    // Or, free: a Mac of the operator's own passes texts through (MOMO_GATEWAY_TOKEN, shared with that Mac,
    // and MOMO_IMESSAGE_ADDRESS, the phone number or Apple Account email people text).
    imessage: env.SENDBLUE_API_KEY_ID && env.SENDBLUE_API_SECRET_KEY && env.SENDBLUE_NUMBER
      ? { keyId: env.SENDBLUE_API_KEY_ID, secret: env.SENDBLUE_API_SECRET_KEY, number: env.SENDBLUE_NUMBER.trim() }
      : env.MOMO_GATEWAY_TOKEN && env.MOMO_IMESSAGE_ADDRESS
        ? { gateway: env.MOMO_GATEWAY_TOKEN, number: env.MOMO_IMESSAGE_ADDRESS.trim() }
        : null,
    // Phone calls for everyone's Momo on the operator's Bland AI key.
    callsKey: env.BLAND_API_KEY || null,
    publicUrl: env.MOMO_PUBLIC_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : null),
  };
}

/**
 * Routes (Vercel rewrites /api/* and /ics here; see vercel.json):
 *   GET  /api/config                 setup page and devices: what the operator pre-filled
 *   POST /api/devices                setup page: a token for one person's Momo, plus a pairing code
 *   POST /api/forms                  their Momo (Bearer token): open a secure link
 *   GET  /api/forms/:id              the link page: what to ask, which key to seal to
 *   POST /api/forms/:id              the link page: the sealed answer (single use)
 *   GET  /api/forms/:id/result       their Momo (Bearer): collect the sealed answer
 *   GET  /ics                        add-to-calendar file
 *
 * Live view (the person taps through a CAPTCHA in the errand's browser):
 *   POST /api/live                   their Momo (Bearer): open one {id, reason}
 *   POST /api/live/:id/shot          their Momo (Bearer): the latest screenshot {jpeg: base64}
 *   GET  /api/live/:id/acts          their Momo (Bearer): taps and typing since last time
 *   POST /api/live/:id/end           their Momo (Bearer): over
 *   GET  /api/live/:id               the page: {reason}
 *   GET  /api/live/:id/shot          the page: image/jpeg (204 until the first one)
 *   POST /api/live/:id/act           the page: {type: tap|type|scroll|done, ...}
 *
 * Shared Telegram bot (TELEGRAM_BOT_TOKEN on the server):
 *   POST /api/telegram               Telegram's webhook; "/start <pair>" links a chat to a device
 *   GET  /api/inbox                  their Momo (Bearer): messages for it since last time
 *   POST /api/send                   their Momo (Bearer): {text} to its own chat
 *
 * Shared iMessage line (SENDBLUE_* on the server):
 *   POST /api/imessage/<secret>      the line's webhook; texting the pairing code links a sender to a device
 *   (their Momo reads /api/inbox and answers with /api/send, exactly as with the bot; the answer
 *    goes wherever the person last texted from)
 *
 *   POST /api/gateway/inbound        the operator's Mac (Bearer MOMO_GATEWAY_TOKEN): texts that arrived in Messages
 *   GET  /api/gateway/outbox         the operator's Mac: answers to send from Messages
 *
 * Shared phone calls (BLAND_API_KEY on the server):
 *   POST /api/calls                  their Momo (Bearer): place a call to a business; the key stays here
 *   GET  /api/calls/<id>             their Momo: how that call went (only the Momo that placed it)
 *
 * Shared model key (MOMO_MODEL + key on the server):
 *   POST /api/model/v1/chat/completions   their Momo (Bearer): OpenAI-compatible, forwarded
 *
 * Paying for the shared AI and calls (STRIPE_SECRET_KEY on the server): free for MOMO_TRIAL_DAYS (7), then
 * MOMO_PRICE_CENTS (1500) a month. Running Momo on your own AI key never touches this.
 *   GET  /api/pay/<code>             Stripe Checkout for that Momo (the link Momo's owner is texted)
 *   GET  /api/pay/<code>/done        back from Checkout: the subscription is checked with Stripe and kept
 */
export function createRelay(store, { env = {}, fetch: f = globalThis.fetch, devicesPerHour = 20, formsPerHour = 120, modelCallsPerHour = 600, sendsPerHour = 600, phoneCallsPerDay = 20 } = {}) {
  const op = operatorConfig(env);
  const tg = (method, body) =>
    f(`${env.TELEGRAM_API_BASE || "https://api.telegram.org"}/bot${op.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }).then((r) => r.json());
  let webhookSecret;
  const secret = async () => (webhookSecret ??= await sha256(`momo-telegram-webhook:${op.botToken}`));

  /** The bot's username, and its webhook pointed here; both remembered for a day. */
  async function bot(origin) {
    if (!op.botToken) return null;
    const cached = await store.get("tg:me");
    const hook = `${op.publicUrl || origin}/api/telegram`;
    if (cached && (await store.get(`tg:hook:${await sha256(hook)}`))) return JSON.parse(cached);
    const me = await tg("getMe");
    if (!me.ok) throw new Error(`telegram getMe: ${me.description}`);
    const info = { username: me.result.username };
    await store.set("tg:me", JSON.stringify(info), 24 * 3600);
    const set = await tg("setWebhook", { url: hook, secret_token: await secret(), allowed_updates: ["message"], drop_pending_updates: false });
    if (!set.ok) throw new Error(`telegram setWebhook: ${set.description}`);
    await store.set(`tg:hook:${await sha256(hook)}`, "1", 24 * 3600);
    return info;
  }

  // --- Shared iMessage line (Sendblue) ---------------------------------------
  const sb = (path, body, method = "POST") =>
    f(`${env.SENDBLUE_API_BASE || "https://api.sendblue.com"}/api/${path}`, {
      method,
      headers: { "content-type": "application/json", "sb-api-key-id": op.imessage.keyId, "sb-api-secret-key": op.imessage.secret },
      body: body ? JSON.stringify(body) : undefined,
    });
  // The webhook's address carries its own secret: only Sendblue is ever told it.
  let imSecretMemo;
  const imSecret = async () => (imSecretMemo ??= (await sha256(`momo-imessage-webhook:${op.imessage.secret}`)).slice(0, 40));
  const imSend = async (number, content) => {
    if (!op.imessage.gateway) return sb("send-message", { number, content, from_number: op.imessage.number });
    // The operator's Mac collects these and sends them from Messages.
    await store.rpush("gw:outbox", JSON.stringify({ to: number, text: content }), 3600);
    return { ok: true, status: 200 };
  };

  /** One text from one person to the line, however it got here. */
  async function imArrived({ from, text, id, at }, origin) {
    // A retried delivery is taken once.
    if (id && (await store.incr(`im:seen:${id}`, 24 * 3600)) > 1) return;
    const chat = `im:${from}`;
    // Pairing: the person texts the code from the setup page (the page's link fills it in for them).
    const code = /^(?:\/?start\s+)?([\w-]{10,16})$/i.exec(text)?.[1];
    const paired = code && (await store.get(`pair:${code}`));
    if (paired) {
      await store.set(`chat:${chat}`, paired);
      text = "hi";
    }
    const dev = await store.get(`chat:${chat}`);
    if (!dev) {
      if ((await store.incr(`rl:im:${from}`, 3600)) <= 3) await imSend(from, `This is Momo. To get your own, open ${op.publicUrl || origin} and follow the steps; it takes a few minutes.`);
      return;
    }
    await arrive(dev, chat, { id: `im:${id || randomToken(9)}`, text: text.slice(0, MAX_TEXT), at: at || Date.now() });
  }

  /** The line's number, with its webhook pointed here (registered once per address). */
  async function line(origin) {
    if (!op.imessage) return null;
    if (op.imessage.gateway) return op.imessage.number; // the Mac calls in; there is no webhook to register
    const hook = `${op.publicUrl || origin}/api/imessage/${await imSecret()}`;
    const key = `im:hook:${await sha256(hook)}`;
    if (!(await store.get(key))) {
      const r = await sb("account/webhooks", { webhooks: [hook], type: "receive" });
      if (!r.ok) throw new Error(`imessage webhook: ${r.status}`);
      await store.set(key, "1");
    }
    return op.imessage.number;
  }

  /**
   * One person, however they text: their Momo sees the same sender whether a message came by Telegram
   * or iMessage (the first chat it ever heard from), so it is one owner with one memory.
   */
  async function arrive(dev, chat, message) {
    let who = await store.get(`devowner:${dev}`);
    if (!who) {
      who = (await store.get(`devchat:${dev}`)) ?? chat;
      await store.set(`devowner:${dev}`, who);
    }
    await store.set(`devchat:${dev}`, chat); // answers go wherever they last texted from
    await store.rpush(`inbox:${dev}`, JSON.stringify({ ...message, from: who }), INBOX_TTL_S);
  }

  // --- Paying for the shared AI and calls -----------------------------------
  const billing = env.STRIPE_SECRET_KEY
    ? { key: env.STRIPE_SECRET_KEY, trialMs: Number(env.MOMO_TRIAL_DAYS ?? 7) * 24 * 3600_000, cents: Number(env.MOMO_PRICE_CENTS ?? 1500) }
    : null;
  const stripe = async (path, form) => {
    const r = await f(`${env.STRIPE_API_BASE || "https://api.stripe.com"}/v1/${path}`, {
      method: form ? "POST" : "GET",
      headers: { authorization: `Bearer ${billing.key}`, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`stripe ${path.split("/")[0]}: ${out.error?.message ?? r.status}`);
    return out;
  };
  /** Text the owner of a Momo through the shared bot or line, if they've paired. */
  async function tell(dev, text) {
    const chat = await store.get(`devchat:${dev}`);
    if (!chat) return;
    if (chat.startsWith("im:")) { if (op.imessage) await imSend(chat.slice(3), text); return; }
    if (op.botToken) await tg("sendMessage", { chat_id: chat, text, disable_web_page_preview: true });
  }
  /** The link that pays for one Momo (a code of its own, so the device's token never leaves it). */
  async function payLink(dev, origin) {
    let code = await store.get(`paycode:${dev}`);
    if (!code) {
      code = randomToken(12);
      await store.set(`paycode:${dev}`, code);
      await store.set(`pay:${code}`, dev);
    }
    return `${op.publicUrl || origin}/api/pay/${code}`;
  }
  /** Whether this Momo may use the shared AI and calls: in its free week, or paid up (checked with Stripe twice a day). */
  async function paidUp(dev) {
    if (!billing) return true;
    let since = Number(await store.get(`devat:${dev}`));
    if (!since) {
      since = Date.now();
      await store.set(`devat:${dev}`, String(since));
    }
    if (Date.now() - since < billing.trialMs) return true;
    const sub = await store.get(`sub:${dev}`);
    if (!sub) return false;
    if (await store.get(`subok:${dev}`)) return true;
    try {
      const s = await stripe(`subscriptions/${encodeURIComponent(sub)}`);
      if (!["active", "trialing", "past_due"].includes(s.status)) return false;
    } catch {
      return true; // Stripe unreachable: don't cut someone off who has paid
    }
    await store.set(`subok:${dev}`, "1", 12 * 3600);
    return true;
  }
  const price = () => `$${(billing.cents / 100).toFixed(billing.cents % 100 ? 2 : 0)} a month`;
  /** The answer when the free week is over: Momo texts its owner this, with the link. */
  async function payFirst(dev, origin) {
    const link = await payLink(dev, origin);
    const text = `Your free week of Momo is over. To keep it going, it's ${price()}, cancel anytime: ${link}`;
    return json({ error: { message: text, type: "payment_required" }, message: text, pay: link }, 402);
  }

  return async function handle(req) {
    const url = new URL(req.url);
    const path = (url.searchParams.get("p") ?? url.pathname.replace(/^\/(api\/)?/, "")).replace(/^\/|\/$/g, "");
    const parts = path.split("/");
    const m = req.method;

    if (path === "ics" && m === "GET") return ics(url.searchParams);
    if (path === "health") {
      // Whether payments are real ("live"), practice ("test") or off; never the key itself.
      const payments = billing ? (/^[sr]k_live_/.test(billing.key) ? "live" : /^[sr]k_test_/.test(billing.key) ? "test" : "unrecognised key") : "off";
      return store ? json({ ok: true, payments }) : json({ ok: false, error: "no storage", payments }, 503);
    }
    if (!store) return json({ error: "Add Upstash Redis to this Vercel project (Storage tab), then redeploy." }, 503);

    const device = async () => {
      const t = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
      if (!t) return null;
      const h = await sha256(t);
      return (await store.get(`dev:${h}`)) ? h : null;
    };
    const body = async () => req.json().catch(() => ({}));
    const limited = async (key, max) => (await store.incr(key, 3600)) > max;

    if (path === "config" && m === "GET") {
      let b = null;
      try {
        b = await bot(url.origin);
      } catch (e) {
        return json({ model: op.model ? { name: op.model.name } : null, bot: null, botError: e.message });
      }
      let im = null;
      let imError;
      try {
        im = await line(url.origin);
      } catch (e) {
        imError = e.message;
      }
      return json({ model: op.model ? { name: op.model.name } : null, bot: b?.username ?? null, ...(op.callsKey ? { calls: true } : {}), ...(billing && (op.model || op.callsKey) ? { price: { cents: billing.cents, trialDays: Math.round(billing.trialMs / 86400_000) } } : {}), ...(op.imessage ? { imessage: im, ...(imError ? { imessageError: imError } : {}) } : {}) });
    }

    if (path === "devices" && m === "POST") {
      const ip = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
      if (await limited(`rl:dev:${ip}`, devicesPerHour)) return json({ error: "too many, try again later" }, 429);
      const token = randomToken();
      const dev = await sha256(token);
      await store.set(`dev:${dev}`, "1");
      await store.set(`devat:${dev}`, String(Date.now()));
      let pair = null;
      if (op.botToken || op.imessage) {
        pair = randomToken(9);
        await store.set(`pair:${pair}`, dev, PAIR_TTL_S);
      }
      return json({ token, pair });
    }

    // --- Shared Telegram bot -------------------------------------------------
    if (path === "telegram" && m === "POST") {
      if (!op.botToken) return json({ error: "not found" }, 404);
      if (req.headers.get("x-telegram-bot-api-secret-token") !== (await secret())) return json({ error: "unauthorized" }, 401);
      const u = await body();
      const msg = u.message;
      if (!msg?.text || (msg.chat?.type && msg.chat.type !== "private")) return json({ ok: true });
      const chat = String(msg.chat.id);
      let text = msg.text;
      const start = /^\/start(?:\s+([\w-]+))?\s*$/.exec(text);
      if (start?.[1]) {
        const dev = await store.get(`pair:${start[1]}`);
        if (dev) {
          await store.set(`chat:${chat}`, dev);
          text = "hi";
        }
      }
      const dev = await store.get(`chat:${chat}`);

      if (!dev) {
        const origin = op.publicUrl || url.origin;
        await tg("sendMessage", { chat_id: chat, text: `This is Momo. To get your own, open ${origin} and follow the steps; it takes a few minutes.` });
        return json({ ok: true });
      }
      await arrive(dev, chat, { id: `tg:${u.update_id}`, text: text.slice(0, MAX_TEXT), at: (msg.date ?? Date.now() / 1000) * 1000 });
      return json({ ok: true });
    }

    if (parts[0] === "imessage" && m === "POST") {
      if (!op.imessage || op.imessage.gateway || parts[1] !== (await imSecret())) return json({ error: "not found" }, 404);
      const u = await body();
      // Only texts from one person to the line: not our own messages echoed back, not group chats.
      const from = typeof u.from_number === "string" ? u.from_number.trim() : "";
      if (u.is_outbound || u.group_id || !from || typeof u.content !== "string" || !u.content.trim()) return json({ ok: true });
      await imArrived({ from, text: u.content.trim(), id: u.message_handle, at: Date.parse(u.date_sent) }, url.origin);
      return json({ ok: true });
    }

    // The operator's Mac: hands over the texts that arrived in Messages, and collects the answers to send.
    if (parts[0] === "gateway") {
      if (!op.imessage?.gateway) return json({ error: "not found" }, 404);
      if (req.headers.get("authorization") !== `Bearer ${op.imessage.gateway}`) return json({ error: "unauthorized" }, 401);
      if (parts[1] === "inbound" && m === "POST") {
        const { messages } = await body();
        for (const x of Array.isArray(messages) ? messages.slice(0, 100) : []) {
          if (typeof x?.from !== "string" || typeof x?.text !== "string" || !x.from.trim() || !x.text.trim()) continue;
          await imArrived({ from: x.from.trim(), text: x.text.trim(), id: typeof x.id === "string" ? x.id : undefined, at: Number(x.at) || undefined }, url.origin);
        }
        return json({ ok: true });
      }
      if (parts[1] === "outbox" && m === "GET") return json({ messages: (await store.popall("gw:outbox", 50)).map((x) => JSON.parse(x)) });
      return json({ error: "not found" }, 404);
    }

    if (path === "inbox" && m === "GET") {
      const dev = await device();
      if (!dev) return json({ error: "unauthorized" }, 401);
      const messages = (await store.popall(`inbox:${dev}`, 50)).map((s) => JSON.parse(s));
      return json({ messages });
    }

    if (path === "send" && m === "POST") {
      const dev = await device();
      if (!dev) return json({ error: "unauthorized" }, 401);
      if (!op.botToken && !op.imessage) return json({ error: "no shared bot" }, 404);
      if (await limited(`rl:send:${dev}`, sendsPerHour)) return json({ error: "too many" }, 429);
      const { text } = await body();
      const chat = await store.get(`devchat:${dev}`);
      if (!chat) return json({ error: "not paired" }, 409);
      if (typeof text !== "string" || !text || text.length > MAX_TEXT) return json({ error: "bad request" }, 400);
      if (chat.startsWith("im:")) {
        if (!op.imessage) return json({ error: "no shared line" }, 404);
        const sent = await imSend(chat.slice(3), text);
        return sent.ok ? json({ ok: true }) : json({ error: `imessage error ${sent.status}` }, 502);
      }
      const r = await tg("sendMessage", { chat_id: chat, text, disable_web_page_preview: true });
      return r.ok ? json({ ok: true }) : json({ error: r.description ?? "telegram error" }, 502);
    }

    // --- Shared phone calls --------------------------------------------------
    if (parts[0] === "calls") {
      const dev = await device();
      if (!dev) return json({ error: "unauthorized" }, 401);
      if (!op.callsKey) return json({ error: "no shared calling" }, 404);
      const bland = env.BLAND_API_BASE || "https://api.bland.ai/v1";
      if (parts.length === 1 && m === "POST") {
        if (!(await paidUp(dev))) return payFirst(dev, url.origin);
        // Calls cost the operator by the minute: a daily cap per Momo, and a fixed length.
        if ((await store.incr(`rl:calls:${dev}`, 24 * 3600)) > phoneCallsPerDay) return json({ message: "too many calls today" }, 429);
        const b = await body();
        const to = typeof b.phone_number === "string" ? b.phone_number.replace(/[\s()-]/g, "") : "";
        if (!/^\+\d{8,15}$/.test(to) || typeof b.task !== "string" || !b.task || b.task.length > 6000) return json({ message: "bad request" }, 400);
        const up = await f(`${bland}/calls`, {
          method: "POST",
          headers: { authorization: op.callsKey, "content-type": "application/json" },
          body: JSON.stringify({ phone_number: to, task: b.task, wait_for_greeting: true, max_duration: 10 }),
        });
        const out = await up.json().catch(() => ({}));
        if (up.ok && typeof out.call_id === "string") await store.set(`callof:${out.call_id}`, dev, 7 * 24 * 3600);
        return json(up.ok ? { call_id: out.call_id } : { message: out.message ?? "call failed" }, up.status);
      }
      if (parts.length === 2 && m === "GET") {
        if (!ID.test(parts[1]) && !/^[\w-]{8,64}$/.test(parts[1])) return json({ error: "not found" }, 404);
        if ((await store.get(`callof:${parts[1]}`)) !== dev) return json({ error: "not found" }, 404);
        const up = await f(`${bland}/calls/${encodeURIComponent(parts[1])}`, { headers: { authorization: op.callsKey } });
        const out = await up.json().catch(() => ({}));
        // Only what Momo reads: the status and what was said.
        return json({ completed: out.completed, status: out.status, answered_by: out.answered_by, summary: out.summary, concatenated_transcript: out.concatenated_transcript }, up.status);
      }
      return json({ error: "not found" }, 404);
    }

    // --- Shared model key ----------------------------------------------------
    if (parts[0] === "model" && m === "POST") {
      const dev = await device();
      if (!dev) return json({ error: "unauthorized" }, 401);
      if (!op.model) return json({ error: "no shared model" }, 404);
      if (parts.slice(1).join("/") !== "v1/chat/completions") return json({ error: "not found" }, 404);
      if (await limited(`rl:model:${dev}`, modelCallsPerHour)) return json({ error: "too many" }, 429);
      if (!(await paidUp(dev))) return payFirst(dev, url.origin);
      const b = await body();
      if (!Array.isArray(b.messages)) return json({ error: "bad request" }, 400);
      const up = await f(`${op.model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${op.model.key}` },
        body: JSON.stringify({ ...b, model: op.model.name }),
      });
      return new Response(up.body, { status: up.status, headers: { "content-type": up.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
    }

    // --- Paying -------------------------------------------------------------
    if (parts[0] === "pay" && m === "GET" && billing) {
      const code = parts[1] ?? "";
      const dev = /^[\w-]{12,24}$/.test(code) ? await store.get(`pay:${code}`) : null;
      if (!dev) return page("That link isn't right. Text Momo and it will send you a new one.", 404);
      const base = op.publicUrl || url.origin;
      try {
        if (parts.length === 2) {
          const s = await stripe("checkout/sessions", {
            mode: "subscription",
            "line_items[0][quantity]": "1",
            "line_items[0][price_data][currency]": "usd",
            "line_items[0][price_data][unit_amount]": String(billing.cents),
            "line_items[0][price_data][recurring][interval]": "month",
            "line_items[0][price_data][product_data][name]": "Momo",
            client_reference_id: code,
            "metadata[pay]": code,
            "subscription_data[metadata][pay]": code,
            success_url: `${base}/api/pay/${code}/done?s={CHECKOUT_SESSION_ID}`,
            cancel_url: `${base}/`,
          });
          return new Response(null, { status: 303, headers: { location: s.url, "cache-control": "no-store" } });
        }
        if (parts.length === 3 && parts[2] === "done") {
          const id = url.searchParams.get("s") ?? "";
          if (!/^cs_[\w]+$/.test(id)) return page("That link isn't right.", 400);
          const s = await stripe(`checkout/sessions/${id}`);
          if (s.client_reference_id !== code || s.status !== "complete" || !s.subscription) return page("That payment didn't go through. You can try again from the link Momo sent you.", 402);
          const first = (await store.get(`sub:${dev}`)) !== s.subscription;
          await store.set(`sub:${dev}`, s.subscription);
          await store.set(`subok:${dev}`, "1", 12 * 3600);
          if (first) await tell(dev, "Thanks, you're all set. Momo is back on: text it anything.").catch(() => {});
          return page("You're all set. Go back to your messages and text Momo.");
        }
      } catch (e) {
        console.error(e);
        return page("Payments aren't working right now. Please try again in a few minutes.", 502);
      }
      return page("That link isn't right.", 404);
    }

    if (parts[0] === "live") return live(parts.slice(1));
    if (parts[0] !== "forms") return json({ error: "not found" }, 404);
    const id = parts[1];

    if (!id && m === "POST") {
      const dev = await device();
      if (!dev) return json({ error: "unauthorized" }, 401);
      if (await limited(`rl:forms:${dev}`, formsPerHour)) return json({ error: "too many" }, 429);
      const b = await body();
      const ok =
        typeof b.id === "string" && ID.test(b.id) &&
        KINDS.has(b.spec?.kind) && typeof b.spec?.label === "string" && b.spec.label.length <= 200 &&
        typeof b.pk === "string" && /^[\w-]{40,64}$/.test(b.pk);
      if (!ok) return json({ error: "bad request" }, 400);
      const record = JSON.stringify({ dev, spec: { kind: b.spec.kind, label: b.spec.label }, pk: b.pk });
      if (!(await store.set(`form:${b.id}`, record, FORM_TTL_S, true))) return json({ error: "exists" }, 409);
      return json({ ok: true });
    }

    if (!id || !ID.test(id)) return json({ error: "not found" }, 404);

    if (parts.length === 2 && m === "GET") {
      const raw = await store.get(`form:${id}`);
      if (!raw) return json({ error: "expired" }, 410);
      const { spec, pk } = JSON.parse(raw);
      return json({ spec, pk });
    }

    if (parts.length === 2 && m === "POST") {
      const { sealed } = await body();
      if (typeof sealed !== "string" || !sealed || sealed.length > MAX_SEALED) return json({ error: "bad request" }, 400);
      const raw = await store.getdel(`form:${id}`); // single use
      if (!raw) return json({ error: "expired" }, 410);
      const { dev } = JSON.parse(raw);
      await store.set(`res:${id}`, JSON.stringify({ dev, sealed }), FORM_TTL_S);
      return json({ ok: true });
    }

    if (parts[2] === "result" && m === "GET") {
      const dev = await device();
      if (!dev) return json({ error: "unauthorized" }, 401);
      const raw = await store.get(`res:${id}`);
      if (raw) {
        const r = JSON.parse(raw);
        if (r.dev !== dev) return json({ error: "not found" }, 404);
        await store.del(`res:${id}`);
        return json({ sealed: r.sealed });
      }
      const open = await store.get(`form:${id}`);
      if (!open) return json({ error: "expired" }, 410);
      if (JSON.parse(open).dev !== dev) return json({ error: "not found" }, 404);
      return json({ pending: true });
    }

    return json({ error: "not found" }, 404);

    async function live([id, sub]) {
      if (!id && m === "POST") {
        const dev = await device();
        if (!dev) return json({ error: "unauthorized" }, 401);
        if (await limited(`rl:forms:${dev}`, formsPerHour)) return json({ error: "too many" }, 429);
        const b = await body();
        if (!ID.test(b.id ?? "") || typeof b.reason !== "string" || b.reason.length > 300) return json({ error: "bad request" }, 400);
        if (!(await store.set(`live:${b.id}`, JSON.stringify({ dev, reason: b.reason }), LIVE_TTL_S, true))) return json({ error: "exists" }, 409);
        return json({ ok: true });
      }
      if (!ID.test(id ?? "")) return json({ error: "not found" }, 404);
      const raw = await store.get(`live:${id}`);
      if (!raw) return json({ error: "expired" }, 410);
      const rec = JSON.parse(raw);
      const mine = async () => (await device()) === rec.dev;
      // After "done" the phone's side is over, but their Momo still collects the last taps.
      if (rec.done && !["acts", "end"].includes(sub)) return json({ error: "expired" }, 410);

      if (!sub && m === "GET") return json({ reason: rec.reason });
      if (sub === "shot" && m === "GET") {
        const shot = await store.get(`live:${id}:shot`);
        if (!shot) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
        return new Response(Uint8Array.from(atob(shot), (c) => c.charCodeAt(0)), { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
      }
      if (sub === "act" && m === "POST") {
        const b = await body();
        const ok =
          (b.type === "tap" && b.x >= 0 && b.x <= 1 && b.y >= 0 && b.y <= 1) ||
          (b.type === "type" && ((typeof b.text === "string" && b.text.length <= 500) || ["Enter", "Tab", "Backspace", "Escape"].includes(b.key))) ||
          (b.type === "scroll" && Math.abs(Number(b.dy)) <= 3000) ||
          b.type === "done";
        if (!ok) return json({ error: "bad request" }, 400);
        await store.rpush(`live:${id}:acts`, JSON.stringify(b), LIVE_TTL_S);
        if (b.type === "done") await store.set(`live:${id}`, JSON.stringify({ ...rec, done: true }), 120);
        return json({ ok: true });
      }
      if (!(await mine())) return json({ error: "unauthorized" }, 401);
      if (sub === "shot" && m === "POST") {
        const { jpeg } = await body();
        if (typeof jpeg !== "string" || !jpeg || jpeg.length > MAX_SHOT) return json({ error: "bad request" }, 400);
        await store.set(`live:${id}:shot`, jpeg, SHOT_TTL_S);
        return json({ ok: true });
      }
      if (sub === "acts" && m === "GET") {
        const acts = (await store.popall(`live:${id}:acts`)).map((a) => JSON.parse(a));
        if (rec.done && !acts.length) return json({ error: "expired" }, 410);
        return json({ acts });
      }
      if (sub === "end" && m === "POST") {
        await store.del(`live:${id}`);
        await store.del(`live:${id}:shot`);
        await store.del(`live:${id}:acts`);
        return json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    }
  };
}
