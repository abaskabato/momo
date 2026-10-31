import { Hono, type Context } from "hono";
import {
  API,
  SIG_HEADERS,
  sealJson,
  verifyRequest,
  type CheckinRequest,
  type CheckinResponse,
  type EnqueueRequest,
  type EnqueueResponse,
  type InboundMessage,
  type RegisterDeviceRequest,
} from "@momo/protocol";
import type { Store } from "./store.ts";
import type { Notifier, WakeDispatcher } from "./wake.ts";

const MAX_WAIT_MS = 25_000;
const AWAKE_CHECKIN_MS = 60_000;
const ASLEEP_CHECKIN_MS = 15 * 60_000;

export interface TelegramRelayConfig {
  /** Must match the secret_token passed to setWebhook. */
  secretToken: string;
  /** Sends a content-free acknowledgement when the device is unreachable. */
  sendAck: (chatId: string, text: string) => Promise<void>;
}

export interface AppDeps {
  store: Store;
  notifier: Notifier;
  wake: WakeDispatcher;
  telegram?: TelegramRelayConfig;
}

type Env = { Variables: { deviceId: string; body: string } };

export function createApp({ store, notifier, wake, telegram }: AppDeps) {
  const app = new Hono<Env>();

  app.get(API.health, (c) => c.json({ ok: true }));

  app.post(API.register, async (c) => {
    const req = (await c.req.json()) as RegisterDeviceRequest;
    if (!req.deviceId || !req.boxPublicKey || !req.signPublicKey || !req.pairCode) {
      return c.json({ error: "missing fields" }, 400);
    }
    try {
      await store.registerDevice(req);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
    return c.json({ ok: true }, 201);
  });

  // The box key is public by design: senders need it to seal tasks.
  app.get("/v1/devices/:id", async (c) => {
    const dev = await store.getDevice(c.req.param("id"));
    if (!dev) return c.json({ error: "not found" }, 404);
    return c.json({ deviceId: dev.deviceId, boxPublicKey: dev.boxPublicKey, online: store.isOnline(dev), lastSeenAt: dev.lastSeenAt });
  });

  // Everything below is signed by the device's Ed25519 key.
  const signed = async (c: Context<Env>, next: () => Promise<void>) => {
    const deviceId = c.req.header(SIG_HEADERS.device);
    const ts = c.req.header(SIG_HEADERS.timestamp);
    const sig = c.req.header(SIG_HEADERS.signature);
    if (!deviceId || !ts || !sig) return c.json({ error: "unsigned" }, 401);
    const dev = await store.getDevice(deviceId);
    const body = await c.req.text();
    const url = new URL(c.req.url);
    if (!dev || !verifyRequest(dev.signPublicKey, c.req.method, url.pathname + url.search, body, ts, sig)) {
      return c.json({ error: "bad signature" }, 401);
    }
    c.set("deviceId", deviceId);
    c.set("body", body);
    await next();
  };

  app.post(API.checkin, signed, async (c) => {
    const deviceId = c.get("deviceId");
    const req = JSON.parse(c.get("body") || "{}") as CheckinRequest;
    await store.ack(deviceId, req.ack ?? []);
    await store.touch(deviceId, req.state);

    // The device owns its local deferred jobs; we only remember when to wake it.
    if (req.nextLocalDueAt) await store.scheduleWake(deviceId, req.nextLocalDueAt);

    let envelopes = await store.claim(deviceId);
    const waitMs = Math.min(req.waitMs ?? 0, MAX_WAIT_MS);
    if (envelopes.length === 0 && waitMs > 0 && req.state === "awake") {
      await notifier.wait(deviceId, waitMs, c.req.raw.signal);
      envelopes = await store.claim(deviceId);
    }

    const res: CheckinResponse = {
      envelopes,
      serverTime: Date.now(),
      nextCheckinMs: await nextCheckinMs(store, deviceId, req),
    };
    return c.json(res);
  });

  // A device (or its paired phone) enqueuing work for itself, e.g. a follow-up
  // that must fire while the laptop sleeps.
  app.post("/v1/devices/:id/envelopes", signed, async (c) => {
    const target = c.req.param("id");
    if (target !== c.get("deviceId")) return c.json({ error: "forbidden" }, 403);
    const req = JSON.parse(c.get("body")) as EnqueueRequest;
    return c.json(await enqueueAndWake(store, wake, target, req), 202);
  });

  if (telegram) {
    app.post(API.telegramWebhook, async (c) => {
      if (c.req.header("x-telegram-bot-api-secret-token") !== telegram.secretToken) return c.json({}, 401);
      const update = (await c.req.json()) as TelegramUpdate;
      const msg = update.message;
      if (!msg?.text) return c.json({ ok: true });
      const chatId = String(msg.chat.id);

      const pair = /^\/(?:pair|start)\s+(\d{6})$/.exec(msg.text.trim());
      if (pair) {
        const ok = await store.bindHandle(pair[1]!, "telegram", chatId);
        await telegram.sendAck(chatId, ok ? "Paired. Text me anything you need done." : "That code didn't work. Make a new one on your computer.");
        return c.json({ ok: true });
      }

      const deviceId = await store.deviceForHandle("telegram", chatId);
      if (!deviceId) {
        await telegram.sendAck(chatId, "I don't know this chat yet. Send /pair followed by the code from your computer.");
        return c.json({ ok: true });
      }
      const dev = await store.getDevice(deviceId);
      if (!dev) return c.json({ ok: true });

      // Seal immediately; the plaintext is dropped when this handler returns.
      const inbound: InboundMessage = { channel: "telegram", from: chatId, threadId: chatId, text: msg.text, receivedAt: msg.date * 1000 };
      const { delivery } = await enqueueAndWake(store, wake, deviceId, {
        kind: "message",
        urgency: "now",
        sealed: sealJson(dev.boxPublicKey, inbound),
      });
      if (delivery === "queued") {
        await telegram.sendAck(chatId, "Got it. Your computer is asleep, so I'll start on this as soon as it wakes up.");
      }
      return c.json({ ok: true });
    });
  }

  return app;
}

async function enqueueAndWake(store: Store, wake: WakeDispatcher, deviceId: string, req: EnqueueRequest): Promise<EnqueueResponse> {
  const env = await store.enqueue(deviceId, req);
  const deferred = req.notBefore !== undefined && req.notBefore > Date.now();
  if (deferred) return { id: env.id, delivery: "queued" };
  if (req.urgency === "batch") return { id: env.id, delivery: "queued" };
  return { id: env.id, delivery: await wake.wake(deviceId) };
}

/**
 * Poll cadence: frequent while awake, rare while asleep, and never later than
 * the next thing that is due. This keeps cloud load proportional to work, not
 * to the number of idle devices.
 */
async function nextCheckinMs(store: Store, deviceId: string, req: CheckinRequest): Promise<number> {
  const base = req.state === "awake" ? AWAKE_CHECKIN_MS : ASLEEP_CHECKIN_MS;
  const now = Date.now();
  const dues = [await store.nextDeliverableAt(deviceId), req.nextLocalDueAt ?? null].filter((d): d is number => d !== null);
  if (dues.length === 0) return base;
  return Math.max(1_000, Math.min(base, Math.min(...dues) - now));
}

interface TelegramUpdate {
  message?: { text?: string; date: number; chat: { id: number } };
}
