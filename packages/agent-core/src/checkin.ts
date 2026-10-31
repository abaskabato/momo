// The device side of the thin cloud: long-poll /checkin, open sealed
// envelopes locally, hand them to the Assistant, ack when done.
//
// Delivery is at-least-once (unacked leases come back), so processed
// envelope ids are remembered locally and duplicates are acked unopened.

import { openJson, type CloudClient, type DeviceKeys, type Envelope, type InboundMessage } from "@momo/protocol";
import type { Assistant } from "./assistant.ts";
import type { Doc } from "./store.ts";
import { scheduleMacWake } from "./timers.ts";

const LONG_POLL_MS = 20_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const SEEN_LIMIT = 2_000;

export interface CheckinWorkerDeps {
  client: CloudClient;
  keys: DeviceKeys;
  assistant: Assistant;
  seen: Doc<string[]>;
  log?: (msg: string) => void;
}

export class CheckinWorker {
  private readonly d: CheckinWorkerDeps;
  private pendingAcks: string[] = [];
  private running = false;
  private abort: AbortController | null = null;

  constructor(deps: CheckinWorkerDeps) {
    this.d = deps;
  }

  /** One check-in cycle. Returns how long the cloud suggests waiting. */
  async once(waitMs = 0): Promise<number> {
    const nextLocalDueAt = await this.d.assistant.tick();
    this.abort = new AbortController();
    const res = await this.d.client.checkin(
      { state: "awake", ack: this.pendingAcks, waitMs, nextLocalDueAt },
      this.abort.signal,
    );
    this.pendingAcks = [];
    for (const env of res.envelopes) await this.process(env);
    return res.nextCheckinMs;
  }

  async run(): Promise<void> {
    this.running = true;
    let backoff = 1_000;
    while (this.running) {
      try {
        await this.once(LONG_POLL_MS);
        backoff = 1_000;
      } catch (e) {
        if (!this.running) break;
        this.d.log?.(`check-in failed: ${(e as Error).message}; retrying in ${backoff / 1000}s`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
  }

  /**
   * Call when the OS is about to sleep: flush acks, tell the cloud when the
   * next local job is due so it can wake us, and ask macOS for a timed wake.
   */
  async goingToSleep(): Promise<void> {
    const next = await this.d.assistant.tick();
    await this.d.client.checkin({ state: "going-to-sleep", ack: this.pendingAcks, nextLocalDueAt: next });
    this.pendingAcks = [];
    if (next) await scheduleMacWake(next);
  }

  private async process(env: Envelope): Promise<void> {
    const seen = await this.d.seen.read();
    if (seen.includes(env.id)) {
      this.pendingAcks.push(env.id);
      return;
    }
    try {
      if (env.kind === "message" || env.kind === "task") {
        await this.d.assistant.handle(openJson<InboundMessage>(this.d.keys, env.sealed));
      } else if (env.kind === "timer") {
        await this.d.assistant.tick();
      }
    } catch (e) {
      // Leave it unacked; the lease expires and it is redelivered.
      this.d.log?.(`envelope ${env.id} failed: ${(e as Error).message}`);
      return;
    }
    await this.d.seen.write([...seen, env.id].slice(-SEEN_LIMIT));
    this.pendingAcks.push(env.id);
  }
}
