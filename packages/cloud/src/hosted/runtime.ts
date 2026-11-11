// Hosted mode: text Momo on Telegram or WhatsApp and it gets done, with
// nothing to install.
//
// Webhooks only enqueue (fast 200s, retries de-duplicated). Stateless workers
// pull jobs, take a per-user lock, load that user's assistant from their
// encrypted documents, run it, and save. No machine sits idle per user;
// compute is spent only while a task runs.

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { KV } from "./kv.ts";
import { Hono } from "hono";
import { openJson, type SecureFormSpec, type SecureFormSubmission } from "@momo/protocol";
import { createAgent, failureText, StaticKeyProvider, type Skill } from "@momo/agent-core";
import type { ChannelAdapter, Inbound, TelegramAdapter, WhatsAppAdapter } from "./channels.ts";
import { userIdFor, type UserKeys } from "./keys.ts";
import { LIVE_HEADERS, liveViewPage, PAGE_HEADERS, secureFormPage } from "./page.ts";
import type { VoiceProvider } from "./phone.ts";
import { parseInboundEmail, type InboundEmail } from "./email.ts";
import { RedisDoc } from "./userdocs.ts";

const FORM_TTL_S = 30 * 60;
const LOCK_MS = 10 * 60_000;
const DEDUPE_TTL_S = 24 * 3600;
const LIVE_TTL_MS = 30 * 60_000;
const CALL_TTL_S = 2 * 3600;

/** The slice of a Playwright page the live view drives. */
interface LivePage {
  screenshot(o: { type: "jpeg"; quality: number }): Promise<Buffer>;
  viewportSize(): { width: number; height: number } | null;
  mouse: { click(x: number, y: number): Promise<void>; wheel(dx: number, dy: number): Promise<void> };
  waitForLoadState(state: "domcontentloaded"): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  keyboard: { type(t: string): Promise<void>; press(k: string): Promise<void> };
}

type Job =
  | { kind: "message"; channel: Inbound["channel"]; from: string; text: string; at: number }
  | { kind: "secret"; sealed: string }
  | { kind: "resume"; taskId: string; text: string }
  | { kind: "email"; email: Omit<InboundEmail, "to"> }
  | { kind: "tick" };

export interface HostedOptions {
  redis: KV;
  keys: UserKeys;
  /** Public base URL, used in secure links. */
  baseUrl: string;
  /** The bot (direct, or the website's shared bot through the relay). */
  telegram?: ChannelAdapter & Partial<Pick<TelegramAdapter, "parse">>;
  whatsapp?: WhatsAppAdapter;
  skills: () => Skill[];
  /** Answers messages that aren't errands. */
  answer?: (text: string, context: string) => Promise<string>;
  /** Each user gets <token>@emailDomain; sites' codes and confirmations land there. */
  emailDomain?: string;
  /** Path secret for the inbound-email webhook. */
  inboundEmailSecret?: string;
  /**
   * Only the first person to text this Momo can use it (required when it runs
   * on someone's own computer). Everyone else is told it's private.
   */
  singleOwner?: boolean;
  /** Phone calls for errands a website can't do. */
  voice?: VoiceProvider;
  /**
   * Momo's website on Vercel (apps/web). When this server has no public
   * address (a person's own computer), secure links go through it: the page
   * seals in the browser, the relay holds only ciphertext, and this server
   * collects it.
   */
  relay?: { url: string; token: string; fetch?: typeof fetch; pollMs?: number };
  now?: () => Date;
  log?: (m: string) => void;
}

export class HostedRuntime {
  private readonly o: HostedOptions;
  private running = false;
  /**
   * Live views of in-progress errands, by unguessable id. In memory: the web
   * and worker roles share a process, and the browser page lives here too.
   */
  private readonly live = new Map<string, { uid: string; taskId: string; page: LivePage; expires: number; reason: string }>();

  constructor(o: HostedOptions) {
    this.o = o;
  }

  private adapter(channel: string): ChannelAdapter {
    const a = channel === "telegram" ? this.o.telegram : channel === "whatsapp" ? this.o.whatsapp : undefined;
    if (!a) throw new Error(`channel ${channel} not configured`);
    return a;
  }

  /** Accept an inbound message; returns false for a duplicate webhook delivery. */
  async accept(m: Inbound): Promise<boolean> {
    const fresh = await this.o.redis.set(`seen:${m.id}`, "1", "EX", DEDUPE_TTL_S, "NX");
    if (!fresh) return false;
    if (this.o.singleOwner) {
      const who = `${m.channel}:${m.from}`;
      await this.o.redis.set("owner:single", who, "NX");
      if ((await this.o.redis.get("owner:single")) !== who) {
        await this.adapter(m.channel).send(m.from, "This Momo is private.").catch(() => {});
        return false;
      }
    }
    const uid = userIdFor(m.channel, m.from);
    // Who to reply to, kept encrypted so the routing table holds no phone numbers.
    await this.o.redis.set(`user:${uid}`, this.o.keys.encrypt(uid, "route", JSON.stringify({ channel: m.channel, handle: m.from })));
    await this.enqueue(uid, { kind: "message", channel: m.channel, from: m.from, text: m.text, at: m.at });
    return true;
  }

  private async enqueue(uid: string, job: Job): Promise<void> {
    await this.o.redis.lpush("hosted:jobs", JSON.stringify({ uid, blob: this.o.keys.encrypt(uid, "job", JSON.stringify(job)) }));
  }

  /** Process queued jobs until the queue is empty (tests, cron-style workers). */
  async drain(): Promise<number> {
    let n = 0;
    while (await this.step(0)) n++;
    return n;
  }

  /** Long-running worker loops; `concurrency` errands run at once. */
  async run(concurrency = 1): Promise<void> {
    this.running = true;
    const loop = async (first: boolean) => {
      // A blocking pop holds its connection, so each loop waits on its own.
      const waiter = this.o.redis.duplicate();
      while (this.running) {
        try {
          await this.step(5, waiter);
          if (first) await this.sweepTimers();
        } catch (e) {
          this.o.log?.(`hosted worker: ${(e as Error).message}`);
        }
      }
      waiter.disconnect();
    };
    const relay = async () => {
      while (this.running && this.o.relay) {
        try {
          await this.pollRelay();
        } catch (e) {
          this.o.log?.(`relay: ${(e as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, this.o.relay?.pollMs ?? 2000));
      }
    };
    await Promise.all([relay(), ...Array.from({ length: Math.max(1, concurrency) }, (_, i) => loop(i === 0))]);
  }

  /** Collect sealed answers to open secure links from the relay. */
  async pollRelay(): Promise<number> {
    if (!this.o.relay) return 0;
    let got = 0;
    for (const id of await this.o.redis.zrangebyscore("hosted:relayforms", "-inf", "+inf")) {
      const uid = await this.o.redis.get(`relayform:${id}`);
      if (!uid) {
        await this.o.redis.zrem("hosted:relayforms", id);
        continue;
      }
      const res = await this.relayFetch(`/api/forms/${id}/result`);
      if (res.status === 410 || res.status === 404) {
        await this.o.redis.zrem("hosted:relayforms", id);
        continue;
      }
      if (!res.ok) continue;
      const { sealed } = (await res.json()) as { sealed?: string };
      if (typeof sealed !== "string" || sealed.length > 16_000) continue;
      await this.o.redis.zrem("hosted:relayforms", id);
      await this.o.redis.del(`relayform:${id}`);
      await this.enqueue(uid, { kind: "secret", sealed });
      got++;
    }
    return got;
  }

  stop(): void {
    this.running = false;
  }

  /** Enqueue a tick for every user whose next timer is due. */
  async sweepTimers(now = (this.o.now?.() ?? new Date()).getTime()): Promise<string[]> {
    const due = await this.o.redis.zrangebyscore("hosted:timers", "-inf", now);
    for (const uid of due) {
      await this.o.redis.zrem("hosted:timers", uid);
      await this.enqueue(uid, { kind: "tick" });
    }
    return due;
  }

  private async step(blockS: number, waiter: KV = this.o.redis): Promise<boolean> {
    const raw = blockS
      ? await waiter.blmove("hosted:jobs", "hosted:processing", "RIGHT", "LEFT", blockS)
      : await this.o.redis.lmove("hosted:jobs", "hosted:processing", "RIGHT", "LEFT");
    if (!raw) return false;
    const { uid, blob } = JSON.parse(raw) as { uid: string; blob: string };
    // One job at a time per user, across all workers.
    const locked = await this.o.redis.set(`lock:${uid}`, "1", "PX", LOCK_MS, "NX");
    if (!locked) {
      await this.o.redis.lrem("hosted:processing", 1, raw);
      await this.o.redis.lpush("hosted:jobs", raw);
      return true;
    }
    try {
      await this.process(uid, JSON.parse(this.o.keys.decrypt(uid, "job", blob)) as Job);
    } catch (e) {
      this.o.log?.(`job for ${uid.slice(0, 8)} failed: ${(e as Error).message}`);
    } finally {
      await this.o.redis.del(`lock:${uid}`);
      await this.o.redis.lrem("hosted:processing", 1, raw);
    }
    return true;
  }

  private async process(uid: string, job: Job): Promise<void> {
    const routeBlob = await this.o.redis.get(`user:${uid}`);
    if (!routeBlob) return;
    const route = JSON.parse(this.o.keys.decrypt(uid, "route", routeBlob)) as { channel: Inbound["channel"]; handle: string };
    const inboxAddress = await this.mailbox(uid);
    const agent = await createAgent({
      docs: (name, fallback) => new RedisDoc(this.o.redis, this.o.keys, uid, name, fallback),
      keyProvider: new StaticKeyProvider(this.o.keys.dataKey(uid)),
      skills: this.o.skills,
      outbound: { send: (channel, to, text) => this.adapter(channel).send(to, text) },
      ownerHandles: [route.handle],
      onboarding: "welcome",
      secureLinks: { create: (spec) => this.createLink(uid, spec) },
      // A live view streams this process's browser: straight from here with a
      // public address, otherwise through the relay. Neither: not offered.
      liveViews: this.isPublic() || this.o.relay ? { create: async (task, page, reason) => this.createLive(uid, task.id, page as LivePage, reason) } : undefined,
      phone: this.o.voice && {
        call: async (task, req) => {
          const token = randomBytes(16).toString("base64url");
          await this.o.redis.set(`call:${token}`, JSON.stringify({ uid, taskId: task.id }), "EX", CALL_TTL_S);
          await this.o.voice!.start({ ...req, webhookUrl: `${this.base()}/v1/hosted/calls/${token}` });
        },
      },
      publicUrl: this.linkBase(),
      inboxAddress,
      home: { channel: route.channel, threadId: route.handle },
      answer: this.o.answer,
      now: this.o.now,
    });

    if (job.kind === "message") {
      try {
        await agent.assistant.handle({ channel: job.channel, from: job.from, threadId: job.from, text: job.text, receivedAt: job.at });
      } catch (e) {
        // Never leave a text unanswered: say what went wrong, in plain words.
        await this.adapter(route.channel).send(route.handle, failureText(e as Error)).catch(() => {});
        throw e;
      }
    } else if (job.kind === "secret") {
      await agent.assistant.onSecretSubmitted(openJson<SecureFormSubmission>(this.o.keys.boxKeys(uid), job.sealed));
    } else if (job.kind === "email") {
      if (agent.inbox) await agent.assistant.onEmail(await agent.inbox.add(job.email));
    } else if (job.kind === "resume") {
      await agent.assistant.resumeTask(job.taskId, job.text);
    }
    const next = await agent.assistant.tick();
    if (next) await this.o.redis.zadd("hosted:timers", next, uid);
    else await this.o.redis.zrem("hosted:timers", uid);
  }

  /** The user's Momo email address, created on first use. The token is random, not derived from their handle. */
  private async mailbox(uid: string): Promise<string | undefined> {
    if (!this.o.emailDomain) return undefined;
    let token = await this.o.redis.get(`mailbox:${uid}`);
    if (!token) {
      const fresh = `m${randomBytes(6).toString("hex")}`;
      if (await this.o.redis.set(`mailbox:${uid}`, fresh, "NX")) await this.o.redis.set(`mail:${fresh}`, uid);
      token = (await this.o.redis.get(`mailbox:${uid}`))!;
    }
    return `${token}@${this.o.emailDomain}`;
  }

  private base(): string {
    return this.o.baseUrl.replace(/\/$/, "");
  }

  private isPublic(): boolean {
    return /^https:\/\//.test(this.o.baseUrl);
  }

  /** Where links people open on their phone point. */
  private linkBase(): string {
    return this.o.relay && !this.isPublic() ? this.o.relay.url.replace(/\/$/, "") : this.base();
  }

  private relayFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const r = this.o.relay!;
    return (r.fetch ?? fetch)(`${r.url.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${r.token}`, ...(init.headers as Record<string, string>) },
    });
  }

  private async createLink(uid: string, spec: SecureFormSpec): Promise<{ id: string; url: string }> {
    const id = randomBytes(16).toString("base64url");
    if (this.o.relay && !this.isPublic()) {
      const pk = this.o.keys.boxKeys(uid).boxPublicKey;
      const res = await this.relayFetch("/api/forms", { method: "POST", body: JSON.stringify({ id, spec: { kind: spec.kind, label: spec.label }, pk }) });
      if (!res.ok) throw new Error(`relay: ${res.status} ${await res.text().catch(() => "")}`.trim());
      await this.o.redis.set(`relayform:${id}`, uid, "EX", FORM_TTL_S);
      await this.o.redis.zadd("hosted:relayforms", Date.now() + FORM_TTL_S * 1000, id);
      return { id, url: `${this.linkBase()}/s/${id}` };
    }
    await this.o.redis.set(`form:${id}`, JSON.stringify({ uid, spec }), "EX", FORM_TTL_S);
    return { id, url: `${this.base()}/s/${id}` };
  }

  private async createLive(uid: string, taskId: string, page: LivePage, reason: string): Promise<string> {
    const now = Date.now();
    for (const [k, v] of this.live) if (v.expires < now || v.taskId === taskId) this.live.delete(k);
    const id = randomBytes(18).toString("base64url");
    this.live.set(id, { uid, taskId, page, expires: now + LIVE_TTL_MS, reason });
    if (this.isPublic()) return `${this.base()}/l/${id}`;
    const res = await this.relayFetch("/api/live", { method: "POST", body: JSON.stringify({ id, reason }) });
    if (!res.ok) throw new Error(`relay: ${res.status}`);
    void this.pumpLive(id).catch((e) => this.o.log?.(`live view: ${(e as Error).message}`));
    return `${this.linkBase()}/l/${id}`;
  }

  /** Through the relay: send screenshots, apply the phone's taps, until "done" or the view expires. */
  private async pumpLive(id: string): Promise<void> {
    const every = this.o.relay?.pollMs ?? 1500;
    let lastShot = "";
    try {
      await this.pumpLiveLoop(id, every, (shot) => (lastShot === shot ? false : ((lastShot = shot), true)));
    } finally {
      this.live.delete(id);
      await this.relayFetch(`/api/live/${id}/end`, { method: "POST" }).catch(() => {});
    }
  }

  private async pumpLiveLoop(id: string, every: number, fresh: (shot: string) => boolean): Promise<void> {
    while (this.liveFor(id)) {
      const v = this.live.get(id)!;
      const acts = await this.relayFetch(`/api/live/${id}/acts`);
      if (acts.status === 410 || acts.status === 401) break;
      if (acts.ok) {
        for (const a of ((await acts.json()) as { acts: Array<Record<string, unknown>> }).acts) {
          const r = await this.applyLive(id, v, String(a.type), a);
          if (r === "done" || !this.live.has(id)) return;
        }
      }
      const jpeg = (await v.page.screenshot({ type: "jpeg", quality: 50 }).catch(() => undefined))?.toString("base64");
      if (jpeg && fresh(jpeg)) await this.relayFetch(`/api/live/${id}/shot`, { method: "POST", body: JSON.stringify({ jpeg }) });
      await new Promise((r) => setTimeout(r, every));
    }
  }

  /** One thing the person did in the live view. Returns "done" when they're finished. */
  private async applyLive(id: string, v: { uid: string; taskId: string; page: LivePage }, action: string, b: { x?: unknown; y?: unknown; text?: unknown; key?: unknown; dy?: unknown }): Promise<"ok" | "done" | "bad" | "unknown"> {
    const size = v.page.viewportSize() ?? { width: 1280, height: 860 };
    switch (action) {
      case "tap":
        if (!(Number(b.x) >= 0 && Number(b.x) <= 1 && Number(b.y) >= 0 && Number(b.y) <= 1)) return "bad";
        await v.page.mouse.click(Number(b.x) * size.width, Number(b.y) * size.height);
        // Let a navigation the tap started land before the next screenshot or "done".
        await v.page.waitForTimeout(300);
        await v.page.waitForLoadState("domcontentloaded").catch(() => {});
        return "ok";
      case "type":
        if (typeof b.key === "string" && ["Enter", "Tab", "Backspace", "Escape"].includes(b.key)) await v.page.keyboard.press(b.key);
        else if (typeof b.text === "string" && b.text.length <= 500) await v.page.keyboard.type(b.text);
        return "ok";
      case "scroll":
        await v.page.mouse.wheel(0, Math.max(-3000, Math.min(3000, Number(b.dy) || 0)));
        return "ok";
      case "done":
        this.live.delete(id);
        await this.enqueue(v.uid, { kind: "resume", taskId: v.taskId, text: "done" });
        return "done";
      default:
        return "unknown";
    }
  }

  private liveFor(id: string) {
    const v = this.live.get(id);
    if (!v || v.expires < Date.now()) return undefined;
    return v;
  }

  routes(): Hono {
    const app = new Hono();
    const ok = { ok: true };

    if (this.o.telegram?.parse) {
      const tg = this.o.telegram;
      app.post("/v1/hosted/telegram", async (c) => {
        const m = tg.parse!(c.req.raw.headers, await c.req.json());
        if (m) await this.accept(m);
        return c.json(ok);
      });
    }

    if (this.o.whatsapp) {
      const wa = this.o.whatsapp;
      app.get("/v1/hosted/whatsapp", (c) => {
        const challenge = wa.verify(new URL(c.req.url).searchParams);
        return challenge ? c.text(challenge) : c.text("forbidden", 403);
      });
      app.post("/v1/hosted/whatsapp", async (c) => {
        const msgs = wa.parse(c.req.header("x-hub-signature-256"), await c.req.text());
        if (!msgs) return c.text("bad signature", 401);
        for (const m of msgs) await this.accept(m);
        return c.json(ok);
      });
    }

    // Live view: the owner does one step (a CAPTCHA) in the errand's own browser.
    app.get("/l/:id", (c) => {
      const v = this.liveFor(c.req.param("id"));
      if (!v) return c.html("<!doctype html><meta name=viewport content='width=device-width'><p style='font:18px system-ui;padding:24px'>This live view has ended.</p>", 410);
      return c.body(liveViewPage(v.reason), 200, LIVE_HEADERS);
    });
    app.get("/l/:id/shot", async (c) => {
      const v = this.liveFor(c.req.param("id"));
      if (!v) return c.body(null, 410);
      const jpg = await v.page.screenshot({ type: "jpeg", quality: 60 });
      return c.body(new Uint8Array(jpg), 200, { "content-type": "image/jpeg", "cache-control": "no-store" });
    });
    app.post("/l/:id/:action", async (c) => {
      const id = c.req.param("id");
      const v = this.liveFor(id);
      if (!v) return c.json({ error: "expired" }, 410);
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const r = await this.applyLive(id, v, c.req.param("action"), b);
      if (r === "bad") return c.json({ error: "bad tap" }, 400);
      if (r === "unknown") return c.json({ error: "unknown" }, 404);
      return c.json(ok);
    });

    if (this.o.emailDomain && this.o.inboundEmailSecret) {
      const secret = Buffer.from(this.o.inboundEmailSecret);
      const domain = `@${this.o.emailDomain.toLowerCase()}`;
      app.post("/v1/hosted/email/:secret", async (c) => {
        const given = Buffer.from(c.req.param("secret"));
        if (given.length !== secret.length || !timingSafeEqual(given, secret)) return c.text("forbidden", 403);
        if (Number(c.req.header("content-length") ?? 0) > 5_000_000) return c.text("too large", 413);
        const body = /json/.test(c.req.header("content-type") ?? "") ? await c.req.json() : await c.req.parseBody();
        const mail = parseInboundEmail(body as Record<string, unknown>);
        if (!mail) return c.json({ error: "no recipient" }, 400);
        for (const to of mail.to.filter((t) => t.endsWith(domain))) {
          const uid = await this.o.redis.get(`mail:${to.slice(0, -domain.length)}`);
          if (uid) await this.enqueue(uid, { kind: "email", email: { from: mail.from, subject: mail.subject, text: mail.text, html: mail.html } });
        }
        return c.json(ok); // unknown addresses are dropped silently
      });
    }

    // A phone call ended; the token in the URL is the only proof needed (single use).
    app.post("/v1/hosted/calls/:token", async (c) => {
      const raw = await this.o.redis.getdel(`call:${c.req.param("token")}`);
      if (!raw || !this.o.voice) return c.json({ error: "unknown call" }, 404);
      const { uid, taskId } = JSON.parse(raw) as { uid: string; taskId: string };
      await this.enqueue(uid, { kind: "resume", taskId, text: this.o.voice.outcome(await c.req.json().catch(() => ({}))) });
      return c.json(ok);
    });

    // Add-to-calendar file; everything it shows is in its own URL.
    app.get("/ics", (c) => {
      const q = new URL(c.req.url).searchParams;
      const t = (k: string) => (q.get(k) ?? "").slice(0, 200);
      const when = (v: string) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? `${v.replace(/[-:]/g, "")}00` : null);
      const start = when(t("s"));
      const end = when(t("e"));
      if (!start || !end) return c.text("bad event", 400);
      const text = (v: string) => v.replace(/[\\;,]/g, (m) => `\\${m}`).replace(/[\r\n]+/g, " ");
      const ics = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Momo//EN", "BEGIN:VEVENT",
        `UID:${randomBytes(8).toString("hex")}@momo`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
        `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${text(t("t"))}`, ...(t("l") ? [`LOCATION:${text(t("l"))}`] : []),
        "END:VEVENT", "END:VCALENDAR", "",
      ].join("\r\n");
      return c.body(ics, 200, { "content-type": "text/calendar; charset=utf-8", "content-disposition": "attachment; filename=event.ics" });
    });

    app.get("/s/:id", async (c) => {
      const raw = await this.o.redis.get(`form:${c.req.param("id")}`);
      if (!raw) return c.html("<!doctype html><meta name=viewport content='width=device-width'><p style='font:18px system-ui;padding:24px'>This link has expired. Ask Momo for a new one.</p>", 410);
      const { uid, spec } = JSON.parse(raw) as { uid: string; spec: SecureFormSpec };
      return c.body(secureFormPage(c.req.param("id"), spec, this.o.keys.boxKeys(uid).boxPublicKey), 200, PAGE_HEADERS);
    });

    app.post("/v1/forms/:id", async (c) => {
      // Single use: the form disappears on the first submission.
      const raw = await this.o.redis.getdel(`form:${c.req.param("id")}`);
      if (!raw) return c.json({ error: "expired" }, 410);
      const { uid } = JSON.parse(raw) as { uid: string };
      const { sealed } = (await c.req.json()) as { sealed: string };
      if (typeof sealed !== "string" || sealed.length > 16_000) return c.json({ error: "bad request" }, 400);
      await this.enqueue(uid, { kind: "secret", sealed });
      return c.json(ok);
    });

    return app;
  }
}
