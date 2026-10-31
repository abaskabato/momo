// Outbound messaging. Inside OpenClaw the plugin supplies an Outbound backed
// by the gateway's `send`; standalone, these talk to the channel directly.

import { execFile } from "node:child_process";
import type { Channel } from "@momo/protocol";

export interface Outbound {
  send(channel: Channel, threadId: string, text: string): Promise<void>;
}

/** iMessage via steipete/imsg on the signed-in Mac. */
export class ImsgOutbound implements Outbound {
  private readonly bin: string;
  constructor(bin = "imsg") {
    this.bin = bin;
  }
  send(_channel: Channel, threadId: string, text: string): Promise<void> {
    const target = threadId.startsWith("chat_id:") ? ["--chat-id", threadId.slice(8)] : ["--to", threadId];
    return new Promise((resolve, reject) =>
      execFile(this.bin, ["send", ...target, "--text", text], (err) => (err ? reject(err) : resolve())),
    );
  }
}

export class TelegramOutbound implements Outbound {
  private readonly token: string;
  constructor(token: string) {
    this.token = token;
  }
  async send(_channel: Channel, threadId: string, text: string): Promise<void> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: threadId, text }),
    });
    if (!res.ok) throw new Error(`telegram send failed: ${res.status}`);
  }
}

/** Routes by channel. */
export class MultiOutbound implements Outbound {
  private readonly routes: Partial<Record<Channel, Outbound>>;
  constructor(routes: Partial<Record<Channel, Outbound>>) {
    this.routes = routes;
  }
  send(channel: Channel, threadId: string, text: string): Promise<void> {
    const r = this.routes[channel];
    if (!r) throw new Error(`no outbound for ${channel}`);
    return r.send(channel, threadId, text);
  }
}

/** Collects messages; used by tests and the local demo. */
export class RecordingOutbound implements Outbound {
  readonly sent: Array<{ channel: Channel; threadId: string; text: string }> = [];
  private readonly echo: boolean;
  constructor(echo = false) {
    this.echo = echo;
  }
  async send(channel: Channel, threadId: string, text: string): Promise<void> {
    this.sent.push({ channel, threadId, text });
    if (this.echo) console.log(`\n[momo → ${channel}:${threadId}]\n${text}\n`);
  }
  last(): string {
    return this.sent.at(-1)?.text ?? "";
  }
}
