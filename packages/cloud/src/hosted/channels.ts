// Messaging adapters for hosted mode. Users just text a Telegram bot or a
// WhatsApp number; nothing to install.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface Inbound {
  channel: "telegram" | "whatsapp";
  from: string;
  text: string;
  at: number;
  /** Provider message id, for de-duplicating webhook retries. */
  id: string;
}

export interface ChannelAdapter {
  readonly channel: Inbound["channel"];
  send(to: string, text: string): Promise<void>;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly channel = "telegram" as const;
  private readonly token: string;
  readonly secretToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(token: string, secretToken: string, fetchImpl: typeof fetch = fetch) {
    this.token = token;
    this.secretToken = secretToken;
    this.fetchImpl = fetchImpl;
  }

  /** Parse a webhook; null if it isn't authentic or isn't a text message. */
  parse(headers: Headers, body: unknown): Inbound | null {
    if (headers.get("x-telegram-bot-api-secret-token") !== this.secretToken) return null;
    const u = body as { update_id: number; message?: { text?: string; date: number; chat: { id: number; type?: string } } };
    const m = u.message;
    if (!m?.text || (m.chat.type && m.chat.type !== "private")) return null;
    return { channel: "telegram", from: String(m.chat.id), text: m.text, at: m.date * 1000, id: `tg:${u.update_id}` };
  }

  async send(to: string, text: string): Promise<void> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: to, text }),
    });
    if (!res.ok) throw new Error(`telegram send ${res.status}`);
  }
}

/** WhatsApp Business Cloud API. */
export class WhatsAppAdapter implements ChannelAdapter {
  readonly channel = "whatsapp" as const;
  private readonly cfg: { phoneNumberId: string; accessToken: string; appSecret: string; verifyToken: string };
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: WhatsAppAdapter["cfg"], fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  /** Meta's subscription handshake. */
  verify(params: URLSearchParams): string | null {
    return params.get("hub.mode") === "subscribe" && params.get("hub.verify_token") === this.cfg.verifyToken ? params.get("hub.challenge") : null;
  }

  parse(signature: string | undefined, rawBody: string): Inbound[] | null {
    const expected = "sha256=" + createHmac("sha256", this.cfg.appSecret).update(rawBody).digest("hex");
    if (!signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const body = JSON.parse(rawBody) as {
      entry?: Array<{ changes?: Array<{ value?: { messages?: Array<{ id: string; from: string; timestamp: string; type: string; text?: { body: string } }> } }> }>;
    };
    const out: Inbound[] = [];
    for (const e of body.entry ?? [])
      for (const c of e.changes ?? [])
        for (const m of c.value?.messages ?? [])
          if (m.type === "text" && m.text) out.push({ channel: "whatsapp", from: m.from, text: m.text.body, at: Number(m.timestamp) * 1000, id: `wa:${m.id}` });
    return out;
  }

  async send(to: string, text: string): Promise<void> {
    const res = await this.fetchImpl(`https://graph.facebook.com/v21.0/${this.cfg.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.accessToken}` },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text, preview_url: true } }),
    });
    if (!res.ok) throw new Error(`whatsapp send ${res.status}`);
  }
}
