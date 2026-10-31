// Privacy layer for every remote (frontier) model call.
//
// Three layers, each pluggable, none allowed to slow the product down:
//   1. Content:  the device decides what leaves. Identifiers are swapped for
//                per-request placeholders (deterministic, microseconds), and
//                the local model may rewrite the query in neutral wording
//                (hides writing style) within a hard time budget. Answers are
//                rehydrated locally, so the reply the owner sees is specific.
//   2. Payment:  who pays is pluggable (API key by default; an anonymous
//                credit scheme such as zkAPI can implement CredentialSource).
//   3. Network:  how bytes travel is pluggable (direct by default; Tor or an
//                oblivious relay can implement Transport, ideally with a
//                fresh circuit per request since long-lived ids link requests).
// Placeholders are fresh per request, so two requests can't be joined on them.

import type { Doc } from "./store.ts";

export interface Entity {
  /** Literal text to hide, e.g. the owner's name or a contact's name. */
  value: string;
  kind: "PERSON" | "PLACE" | "ORG";
}

export interface Redaction {
  text: string;
  /** placeholder -> original; never leaves the device. */
  map: Map<string, string>;
}

const PATTERNS: Array<[kind: string, re: RegExp]> = [
  ["EMAIL", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ["CARD", /\b(?:\d[ -]?){13,19}\b/g],
  ["PHONE", /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g],
  ["SSN", /\b\d{3}-\d{2}-\d{4}\b/g],
  ["ADDRESS", /\b\d{1,6}\s+(?:[A-Z][a-z]+\s){1,4}(?:St|Street|Ave|Avenue|Blvd|Rd|Road|Dr|Drive|Ln|Lane|Way|Ct|Pl)\b\.?/g],
  ["CONFIRMATION", /\b[A-Z]{2,4}-[A-Z0-9]{4,10}\b/g],
  ["URL_SECRET", /https?:\/\/\S*[?&](?:token|key|sig|code|session)=\S+/gi],
];

export function redact(text: string, entities: Entity[] = []): Redaction {
  const map = new Map<string, string>();
  const counters = new Map<string, number>();
  const reverse = new Map<string, string>();
  const placeholder = (kind: string, original: string) => {
    const known = reverse.get(original);
    if (known) return known;
    const n = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, n);
    const p = `[${kind}_${n}]`;
    map.set(p, original);
    reverse.set(original, p);
    return p;
  };

  let out = text;
  // Longest first so "Ana Lopez" wins over "Ana".
  for (const e of [...entities].sort((a, b) => b.value.length - a.value.length)) {
    if (!e.value.trim()) continue;
    out = out.replace(new RegExp(`\\b${escapeRe(e.value)}\\b`, "gi"), (m) => placeholder(e.kind, m));
  }
  for (const [kind, re] of PATTERNS) out = out.replace(re, (m) => placeholder(kind, m));
  return { text: out, map };
}

export function rehydrate(text: string, map: Map<string, string>): string {
  return text.replace(/\[[A-Z_]+_\d+\]/g, (p) => map.get(p) ?? p);
}

/** Rehydrate every string inside parsed JSON (safer than editing JSON text). */
export function rehydrateDeep(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === "string") return rehydrate(value, map);
  if (Array.isArray(value)) return value.map((v) => rehydrateDeep(v, map));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rehydrateDeep(v, map)]));
  }
  return value;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- Layers 2 and 3 --------------------------------------------------------

/** Layer 2: who pays. Returns headers for one request. */
export interface CredentialSource {
  readonly name: string;
  headersFor(): Promise<Record<string, string>>;
}

/** Layer 3: how the request travels. Must be a drop-in `fetch`. */
export interface Transport {
  readonly name: string;
  fetch: typeof fetch;
}

export const directTransport: Transport = { name: "direct", fetch: (...a) => fetch(...a) };

// ---- Receipt ---------------------------------------------------------------

/** What actually left the device, for the owner to inspect ("what did you send?"). */
export interface PrivacyReceipt {
  at: number;
  destination: string;
  transport: string;
  payment: string;
  rewritten: boolean;
  redactedKinds: string[];
  sentChars: number;
  /** The exact outbound prompt (already redacted), kept locally only. */
  sent: string;
}

export interface MinimizeOptions {
  entities: Entity[];
  /** Local-model rewrite into neutral, minimal wording. Optional. */
  rewrite?: (redacted: string) => Promise<string>;
  /** Budget for the rewrite; past it we send the redaction-only text. */
  rewriteBudgetMs?: number;
}

/**
 * Produce the text that may leave the device. Never blocks on the local
 * model for longer than the budget, and never sends a rewrite that
 * reintroduced an original value.
 */
export async function minimize(text: string, o: MinimizeOptions): Promise<Redaction & { rewritten: boolean }> {
  const r = redact(text, o.entities);
  if (!o.rewrite) return { ...r, rewritten: false };
  const budget = o.rewriteBudgetMs ?? 1_500;
  const rewritten = await Promise.race([
    o.rewrite(r.text).catch(() => null),
    new Promise<null>((res) => setTimeout(() => res(null), budget).unref()),
  ]);
  if (!rewritten) return { ...r, rewritten: false };
  const leaked = [...r.map.values()].some((v) => rewritten.toLowerCase().includes(v.toLowerCase()));
  const dropped = [...r.map.keys()].filter((p) => r.text.includes(p) && !rewritten.includes(p));
  // A rewrite that drops placeholders the answer depends on would cost quality; keep the original then.
  if (leaked || dropped.length > 0) return { ...r, rewritten: false };
  return { text: rewritten, map: r.map, rewritten: true };
}

export async function recordReceipt(file: Doc<PrivacyReceipt[]>, receipt: PrivacyReceipt, keep = 500): Promise<void> {
  await file.update((all) => all.concat(receipt).slice(-keep));
}

export const MINIMAL_DISCLOSURE_SYSTEM = `Rewrite the user's request for an outside expert.
Keep every [PLACEHOLDER] token exactly as written. Remove anything not needed to answer:
names, exact ages, employers, neighborhoods, health details beyond what the question needs.
Use plain, neutral wording. Output only the rewritten request.`;
