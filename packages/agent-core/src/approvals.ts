// Confirm-before-commit.
//
// Any irreversible or spending action needs an approval that is:
//   - bound to the exact arguments (SHA-256 of canonical JSON),
//   - bound to a spend amount (re-asked if the real total drifts > 5%),
//   - single-use and short-lived,
//   - settled ONLY by the owner's own text on a direct channel, parsed by code.
// The model can request an approval but can never grant one: replies are
// intercepted before they reach the model (see the OpenClaw before_dispatch hook).

import { createHash, randomInt } from "node:crypto";
import type { Doc } from "./store.ts";

export type Risk = "read" | "reversible" | "irreversible" | "purchase";

export interface ApprovalRequest {
  taskId: string;
  action: string;
  args: Record<string, unknown>;
  risk: Risk;
  /** The exact sentence the owner is agreeing to. */
  summary: string;
  amountUsd?: number;
  ttlMs?: number;
}

export interface Approval {
  id: string;
  token: string;
  taskId: string;
  action: string;
  argsHash: string;
  risk: Risk;
  summary: string;
  amountUsd?: number;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "denied" | "expired" | "consumed";
}

export type ReplyVerdict =
  | { kind: "approved"; approval: Approval }
  | { kind: "denied"; approval: Approval }
  | { kind: "ambiguous"; message: string }
  | { kind: "none" };

export const DEFAULT_APPROVAL_TTL_MS = 15 * 60_000;
const AMOUNT_TOLERANCE = 0.05;
// No 0/O/1/I so tokens survive being read aloud or retyped.
const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const YES = new Set(["yes", "y", "approve", "approved", "confirm", "go", "go ahead", "do it", "book it", "yes please"]);
const NO = new Set(["no", "n", "deny", "cancel", "don't", "dont", "stop", "nope"]);

export function hashArgs(action: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(action + "\0" + canonicalJson(args)).digest("hex");
}

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export class ApprovalError extends Error {}

export class ApprovalGate {
  private readonly file: Doc<Approval[]>;
  private readonly now: () => number;

  constructor(file: Doc<Approval[]>, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
  }

  async request(req: ApprovalRequest): Promise<Approval> {
    const all = await this.file.read();
    const approval: Approval = {
      id: `apr_${this.now().toString(36)}${randomInt(1e6)}`,
      token: Array.from({ length: 4 }, () => TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)]).join(""),
      taskId: req.taskId,
      action: req.action,
      argsHash: hashArgs(req.action, req.args),
      risk: req.risk,
      summary: req.summary,
      amountUsd: req.amountUsd,
      createdAt: this.now(),
      expiresAt: this.now() + (req.ttlMs ?? DEFAULT_APPROVAL_TTL_MS),
      status: "pending",
    };
    // A new ask for the same task supersedes the old one.
    for (const a of all) if (a.taskId === req.taskId && a.status === "pending") a.status = "expired";
    all.push(approval);
    await this.file.write(all);
    return approval;
  }

  /** The prompt texted to the owner. Point first, then the exact reply. */
  static prompt(a: Approval): string {
    const mins = Math.round((a.expiresAt - a.createdAt) / 60_000);
    return `${a.summary}\nReply YES ${a.token} to confirm or NO to skip. (expires in ${mins} min)`;
  }

  async pending(): Promise<Approval[]> {
    const all = await this.expire();
    return all.filter((a) => a.status === "pending");
  }

  /**
   * Parse an owner reply. A bare "yes" only counts when exactly one approval is
   * pending; otherwise the token is required. Anything that isn't a clear yes/no
   * is not an approval.
   */
  async resolveReply(text: string, ctx: { fromOwner: boolean; directChannel: boolean }): Promise<ReplyVerdict> {
    const pending = await this.pending();
    if (pending.length === 0) return { kind: "none" };
    const cleaned = text.trim().toLowerCase().replace(/[.!]+$/g, "");
    const m = /^(.*?)(?:\s+([a-z2-9]{4}))?$/.exec(cleaned);
    const word = m?.[1]?.trim() ?? "";
    const token = m?.[2]?.toUpperCase();
    const isYes = YES.has(word);
    const isNo = NO.has(word);
    if (!isYes && !isNo) return { kind: "none" };

    if (!ctx.fromOwner || !ctx.directChannel) {
      return { kind: "ambiguous", message: "Approvals only count when they come from you in a direct chat." };
    }

    let target: Approval | undefined;
    if (token) {
      target = pending.find((a) => a.token === token);
      if (!target) return { kind: "ambiguous", message: `I don't have a pending request with code ${token}.` };
    } else if (pending.length === 1) {
      target = pending[0];
    } else {
      const list = pending.map((a) => `${a.token}: ${a.summary.split("\n")[0]}`).join("\n");
      return { kind: "ambiguous", message: `I have ${pending.length} things waiting. Which one?\n${list}` };
    }

    target!.status = isYes ? "approved" : "denied";
    await this.save(target!);
    return isYes ? { kind: "approved", approval: target! } : { kind: "denied", approval: target! };
  }

  /**
   * Called by the action itself right before committing. Throws unless an
   * approved, unexpired, unused approval matches these exact arguments and
   * the amount is within tolerance. Marks it consumed.
   */
  async consume(taskId: string, action: string, args: Record<string, unknown>, amountUsd?: number): Promise<Approval> {
    const all = await this.expire();
    const hash = hashArgs(action, args);
    const a = all.find((x) => x.taskId === taskId && x.argsHash === hash && x.status === "approved");
    if (!a) throw new ApprovalError(`no owner approval for ${action} with these exact arguments`);
    if (a.amountUsd !== undefined && amountUsd !== undefined) {
      const drift = Math.abs(amountUsd - a.amountUsd) / Math.max(a.amountUsd, 0.01);
      if (drift > AMOUNT_TOLERANCE) throw new ApprovalError(`total changed from $${a.amountUsd} to $${amountUsd}; ask again`);
    }
    a.status = "consumed";
    await this.save(a);
    return a;
  }

  async cancelForTask(taskId: string): Promise<void> {
    const all = await this.file.read();
    for (const a of all) if (a.taskId === taskId && (a.status === "pending" || a.status === "approved")) a.status = "denied";
    await this.file.write(all);
  }

  private async save(a: Approval): Promise<void> {
    const all = await this.file.read();
    const i = all.findIndex((x) => x.id === a.id);
    if (i >= 0) all[i] = a;
    await this.file.write(all);
  }

  private async expire(): Promise<Approval[]> {
    const all = await this.file.read();
    let changed = false;
    for (const a of all) {
      if ((a.status === "pending" || a.status === "approved") && a.expiresAt < this.now()) {
        a.status = "expired";
        changed = true;
      }
    }
    if (changed) await this.file.write(all);
    return all;
  }
}
