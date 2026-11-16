// The free way to give Momo an iMessage address (and a phone number): a Mac.
//
// Apple offers no iMessage API. What can send and receive iMessages is the
// Messages app on a Mac signed in to an Apple Account, so that is the gateway:
// this loop reads the texts that arrive in Messages, hands them to the
// website's relay (which knows whose Momo each sender belongs to), and sends
// the answers the relay has waiting. One Mac serves everybody's Momo.
//
// The address people text is whatever that Mac's Messages uses: the Apple
// Account's email, or its phone number when an iPhone is signed in to the same
// account (with Text Message Forwarding on, plain SMS works too).
//
// It needs two permissions on the Mac, both granted once in System Settings >
// Privacy & Security: Full Disk Access for the program running Momo (to read
// ~/Library/Messages/chat.db), and Automation > Messages (to send).

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Arrived {
  row: number;
  id: string;
  from: string;
  text: string;
}

/**
 * Newer macOS keeps a message's words in `attributedBody` (an archived NSAttributedString)
 * and leaves `text` empty. The words are the first NSString in it: a length, then UTF-8.
 */
export function decodeAttributedBody(body: Uint8Array | null | undefined): string {
  if (!body) return "";
  const b = Buffer.from(body);
  const at = b.indexOf("NSString");
  if (at < 0) return "";
  let i = at + "NSString".length + 5;
  if (i >= b.length) return "";
  let len = b[i++]!;
  if (len === 0x81) {
    if (i + 2 > b.length) return "";
    len = b.readUInt16LE(i);
    i += 2;
  } else if (len === 0x82) {
    if (i + 4 > b.length) return "";
    len = b.readUInt32LE(i);
    i += 4;
  }
  return b.subarray(i, i + len).toString("utf8");
}

/** Texts other people sent to this Mac after row `after`: one-to-one chats only, no tapbacks. `after` < 0 only reports the newest row. */
export async function readArrived(dbPath: string, after: number): Promise<{ last: number; messages: Arrived[] }> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (after < 0) return { last: Number((db.prepare("SELECT COALESCE(MAX(ROWID), 0) AS n FROM message").get() as { n: number }).n), messages: [] };
    const rows = db
      .prepare(
        `SELECT m.ROWID AS row, m.guid AS id, m.text AS text, m.attributedBody AS body, h.id AS sender, m.is_from_me AS mine,
                m.cache_roomnames AS room, m.associated_message_type AS tapback
           FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id
          WHERE m.ROWID > ? ORDER BY m.ROWID LIMIT 200`,
      )
      .all(after) as Array<{ row: number; id: string; text: string | null; body: Uint8Array | null; sender: string | null; mine: number; room: string | null; tapback: number | null }>;
    const messages: Arrived[] = [];
    let last = after;
    for (const r of rows) {
      last = Number(r.row);
      if (r.mine || r.room || r.tapback || !r.sender) continue;
      const text = (r.text || decodeAttributedBody(r.body)).trim();
      if (text) messages.push({ row: last, id: r.id, from: r.sender, text });
    }
    return { last, messages };
  } finally {
    db.close();
  }
}

const SEND = `on run {who, msg}
  tell application "Messages"
    try
      send msg to participant who of (1st account whose service type = iMessage)
    on error
      send msg to participant who of (1st account whose service type = SMS)
    end try
  end tell
end run`;

/** Send from Messages on this Mac: by iMessage, or as a plain text when the person has no iMessage. */
export function sendFromMessages(to: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => execFile("osascript", ["-e", SEND, to, text], { timeout: 30_000 }, (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().slice(0, 300))) : resolve())));
}

export interface GatewayOptions {
  relayUrl: string;
  token: string;
  /** ~/Library/Messages/chat.db */
  dbPath?: string;
  /** Where the place it has read up to is kept between restarts. */
  statePath?: string;
  fetch?: typeof fetch;
  send?: (to: string, text: string) => Promise<void>;
  log?: (m: string) => void;
}

export class IMessageGateway {
  private readonly o: Required<Omit<GatewayOptions, "log">> & { log?: (m: string) => void };
  private last: number | undefined;
  private said = "";

  constructor(o: GatewayOptions) {
    this.o = {
      dbPath: join(homedir(), "Library", "Messages", "chat.db"),
      statePath: join(process.env.MOMO_HOME ?? join(homedir(), ".momo"), "imessage-gateway.json"),
      fetch: globalThis.fetch,
      send: sendFromMessages,
      ...o,
    };
  }

  private api(path: string, init: RequestInit = {}): Promise<Response> {
    return this.o.fetch(`${this.o.relayUrl.replace(/\/$/, "")}${path}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${this.o.token}` } });
  }

  /** One round: pass on what arrived, send what is waiting. Returns how many of each. */
  async tick(): Promise<{ in: number; out: number }> {
    if (this.last === undefined) {
      try {
        this.last = Number((JSON.parse(readFileSync(this.o.statePath, "utf8")) as { last: number }).last);
      } catch {
        // First run: start from now. Old conversations on this Mac are nobody's errands.
        this.last = (await readArrived(this.o.dbPath, -1)).last;
        this.save();
      }
    }
    const { last, messages } = await readArrived(this.o.dbPath, this.last);
    if (messages.length) {
      const r = await this.api("/api/gateway/inbound", { method: "POST", body: JSON.stringify({ messages: messages.map((m) => ({ from: m.from, text: m.text, id: m.id })) }) });
      if (!r.ok) throw new Error(`relay inbound: ${r.status}`); // not marked as read: tried again next round
    }
    if (last !== this.last) {
      this.last = last;
      this.save();
    }
    const r = await this.api("/api/gateway/outbox");
    if (!r.ok) throw new Error(`relay outbox: ${r.status}`);
    const waiting = ((await r.json()) as { messages: Array<{ to: string; text: string }> }).messages;
    for (const m of waiting) await this.o.send(m.to, m.text).catch((e: Error) => this.o.log?.(`imessage gateway: couldn't send to ${m.to.slice(0, 4)}...: ${e.message}`));
    return { in: messages.length, out: waiting.length };
  }

  private save(): void {
    mkdirSync(dirname(this.o.statePath), { recursive: true });
    writeFileSync(this.o.statePath, JSON.stringify({ last: this.last }));
  }

  /** Run until aborted. A problem is said once, not every two seconds. */
  async run(signal: AbortSignal, everyMs = 2000): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick();
        this.said = "";
      } catch (e) {
        const m = (e as Error).message;
        const why = /unable to open|authorization denied|not permitted|SQLITE_CANTOPEN|EPERM/i.test(m)
          ? "can't read Messages. Give Full Disk Access to the program running Momo (System Settings > Privacy & Security > Full Disk Access), then restart Momo"
          : m;
        if (why !== this.said) this.o.log?.(`imessage gateway: ${why}`);
        this.said = why;
      }
      await new Promise((r) => setTimeout(r, everyMs));
    }
  }
}

/** Whether this computer can be the gateway at all. */
export function canBeGateway(platform: NodeJS.Platform = process.platform, dbPath = join(homedir(), "Library", "Messages", "chat.db")): string | undefined {
  if (platform !== "darwin") return "the iMessage gateway only runs on a Mac";
  if (!existsSync(dbPath)) return "Messages has never been opened on this Mac: open it and sign in to your Apple Account first";
  return undefined;
}
