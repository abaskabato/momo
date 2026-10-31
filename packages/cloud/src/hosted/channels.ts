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

/**
 * Telegram bot. Receives by webhook (needs a public HTTPS address) or by
 * long polling (works anywhere, e.g. a laptop with no domain).
 */
export class TelegramAdapter implements ChannelAdapter {
  readonly channel = "telegram" as const;
  private readonly token: string;
  readonly secretToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(token: string, secretToken: string, fetchImpl: typeof fetch = fetch, apiBase = "https://api.telegram.org") {
    this.token = token;
    this.secretToken = secretToken;
    this.fetchImpl = fetchImpl;
    this.apiBase = apiBase.replace(/\/$/, "");
  }

  private async call<T>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(`${this.apiBase}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!res.ok || !json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
    return json.result as T;
  }

  /** The bot's own account; also checks the token. */
  me(): Promise<{ id: number; username: string; first_name: string }> {
    return this.call("getMe");
  }

  setWebhook(url: string): Promise<unknown> {
    return this.call("setWebhook", { url, secret_token: this.secretToken, allowed_updates: ["message"] });
  }

  /**
   * Long-poll for messages until `signal` aborts. Clears any webhook first
   * (Telegram allows one or the other). Errors back off and retry.
   */
  async poll(onMessage: (m: Inbound) => Promise<unknown>, signal: AbortSignal, onError?: (e: Error) => void): Promise<void> {
    await this.call("deleteWebhook", { drop_pending_updates: false }, signal);
    let offset = 0;
    while (!signal.aborted) {
      try {
        const updates = await this.call<Array<{ update_id: number }>>("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] }, signal);
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1);
          const m = this.parseUpdate(u);
          if (m) await onMessage(m);
        }
      } catch (e) {
        if (signal.aborted) return;
        onError?.(e as Error);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  /** Parse a webhook; null if it isn't authentic or isn't a text message. */
  parse(headers: Headers, body: unknown): Inbound | null {
    if (headers.get("x-telegram-bot-api-secret-token") !== this.secretToken) return null;
    return this.parseUpdate(body);
  }

  private parseUpdate(body: unknown): Inbound | null {
    const u = body as { update_id: number; message?: { text?: string; date: number; chat: { id: number; type?: string } } };
    const m = u.message;
    if (!m?.text || (m.chat.type && m.chat.type !== "private")) return null;
    return { channel: "telegram", from: String(m.chat.id), text: m.text, at: m.date * 1000, id: `tg:${u.update_id}` };
  }

  async send(to: string, text: string): Promise<void> {
    await this.call("sendMessage", { chat_id: to, text });
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
