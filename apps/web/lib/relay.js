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
 * Shared model key (MOMO_MODEL + key on the server):
 *   POST /api/model/v1/chat/completions   their Momo (Bearer): OpenAI-compatible, forwarded
 */
export function createRelay(store, { env = {}, fetch: f = globalThis.fetch, devicesPerHour = 20, formsPerHour = 120, modelCallsPerHour = 600, sendsPerHour = 600 } = {}) {
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

  return async function handle(req) {
    const url = new URL(req.url);
    const path = (url.searchParams.get("p") ?? url.pathname.replace(/^\/(api\/)?/, "")).replace(/^\/|\/$/g, "");
    const parts = path.split("/");
    const m = req.method;

    if (path === "ics" && m === "GET") return ics(url.searchParams);
    if (path === "health") return store ? json({ ok: true }) : json({ ok: false, error: "no storage" }, 503);
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
      return json({ model: op.model ? { name: op.model.name } : null, bot: b?.username ?? null });
    }

    if (path === "devices" && m === "POST") {
      const ip = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
      if (await limited(`rl:dev:${ip}`, devicesPerHour)) return json({ error: "too many, try again later" }, 429);
      const token = randomToken();
      const dev = await sha256(token);
      await store.set(`dev:${dev}`, "1");
      let pair = null;
      if (op.botToken) {
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
          await store.set(`devchat:${dev}`, chat);
          text = "hi";
        }
      }
      const dev = await store.get(`chat:${chat}`);
      if (!dev) {
        const origin = op.publicUrl || url.origin;
        await tg("sendMessage", { chat_id: chat, text: `This is Momo. To get your own, open ${origin} and follow the steps; it takes a few minutes.` });
        return json({ ok: true });
      }
      await store.rpush(`inbox:${dev}`, JSON.stringify({ id: `tg:${u.update_id}`, from: chat, text: text.slice(0, MAX_TEXT), at: (msg.date ?? Date.now() / 1000) * 1000 }), INBOX_TTL_S);
      return json({ ok: true });
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
      if (!op.botToken) return json({ error: "no shared bot" }, 404);
      if (await limited(`rl:send:${dev}`, sendsPerHour)) return json({ error: "too many" }, 429);
      const { text } = await body();
      const chat = await store.get(`devchat:${dev}`);
      if (!chat) return json({ error: "not paired" }, 409);
      if (typeof text !== "string" || !text || text.length > MAX_TEXT) return json({ error: "bad request" }, 400);
      const r = await tg("sendMessage", { chat_id: chat, text, disable_web_page_preview: true });
      return r.ok ? json({ ok: true }) : json({ error: r.description ?? "telegram error" }, 502);
    }

    // --- Shared model key ----------------------------------------------------
    if (parts[0] === "model" && m === "POST") {
      const dev = await device();
      if (!dev) return json({ error: "unauthorized" }, 401);
      if (!op.model) return json({ error: "no shared model" }, 404);
      if (parts.slice(1).join("/") !== "v1/chat/completions") return json({ error: "not found" }, 404);
      if (await limited(`rl:model:${dev}`, modelCallsPerHour)) return json({ error: "too many" }, 429);
      const b = await body();
      if (!Array.isArray(b.messages)) return json({ error: "bad request" }, 400);
      const up = await f(`${op.model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${op.model.key}` },
        body: JSON.stringify({ ...b, model: op.model.name }),
      });
      return new Response(up.body, { status: up.status, headers: { "content-type": up.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
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
