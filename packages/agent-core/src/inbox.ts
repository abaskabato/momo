// The owner's Momo email inbox. Sites send sign-in codes, "confirm your email"
// links, and booking confirmations here (directly for sign-ups, or forwarded
// from the owner's own email), so errands don't stall waiting on the owner.
// Email content is untrusted: it is shown to the planner as data, never
// followed as instructions.

import { randomBytes } from "node:crypto";
import type { Doc } from "./store.ts";

export interface Email {
  id: string;
  at: number;
  from: string;
  subject: string;
  text: string;
  links: string[];
}

const KEEP = 50;
const KEEP_MS = 7 * 24 * 3600_000;
const MAX_TEXT = 8000;

export class Inbox {
  readonly address: string;
  private readonly doc: Doc<Email[]>;
  private readonly now: () => number;

  constructor(address: string, doc: Doc<Email[]>, now: () => number = Date.now) {
    this.address = address;
    this.doc = doc;
    this.now = now;
  }

  async add(e: { from: string; subject: string; text: string; html?: string }): Promise<Email> {
    const text = (e.text || htmlToText(e.html ?? "")).slice(0, MAX_TEXT);
    const email: Email = {
      id: randomBytes(6).toString("hex"),
      at: this.now(),
      from: e.from.slice(0, 200),
      subject: e.subject.slice(0, 300),
      text,
      links: extractLinks(`${text}\n${e.html ?? ""}`),
    };
    await this.doc.update((all) => all.concat(email).filter((m) => m.at > this.now() - KEEP_MS).slice(-KEEP));
    return email;
  }

  /** Emails received at or after `since` (ms), newest last. */
  async since(since: number): Promise<Email[]> {
    return (await this.doc.read()).filter((m) => m.at >= since);
  }
}

export function matchesEmail(e: Email, contains?: string): boolean {
  if (!contains) return true;
  const hay = `${e.from}\n${e.subject}\n${e.text}`.toLowerCase();
  return contains.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/** The likely one-time code in an email, if any. */
export function guessCode(e: Pick<Email, "subject" | "text">): string | undefined {
  const s = `${e.subject}\n${e.text}`;
  const near = /(?:code|passcode|pin|otp|verification|verify|one[- ]time)[^\n]{0,60}?\b([A-Z0-9]{4,10})\b/i.exec(s);
  if (near && /\d/.test(near[1]!)) return near[1];
  return /\b(\d{6})\b/.exec(s)?.[1] ?? /\b(\d{4,10})\b/.exec(s)?.[1];
}

export function extractLinks(s: string): string[] {
  const seen = new Set<string>();
  for (const m of s.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
    const u = m[0].replace(/[.,;]+$/, "").replace(/&amp;/g, "&");
    if (!/\.(png|jpe?g|gif|svg|css)(\?|$)/i.test(u)) seen.add(u);
  }
  return [...seen].slice(0, 20);
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}
