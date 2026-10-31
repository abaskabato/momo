// Wake-on-demand. The order of preference when work arrives for a device:
//   1. it is already long-polling /checkin -> notify the held request
//   2. it registered a push URL            -> POST an empty wake ping
//   3. neither                             -> leave it queued; it is batched
//                                             into the device's next check-in
// A push ping carries no content. It only tells the device to check in.

import type { Redis } from "ioredis";
import type { EnqueueResponse } from "@momo/protocol";
import type { Store } from "./store.ts";

const WAKE_COOLDOWN_MS = 30_000;

/** Fans Redis pub/sub notifications out to in-process long-poll waiters. */
export class Notifier {
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly pub: Redis;
  private readonly sub: Redis;

  constructor(pub: Redis, sub: Redis) {
    this.pub = pub;
    this.sub = sub;
    this.sub.on("message", (_channel: string, deviceId: string) => this.fire(deviceId));
  }

  async start(): Promise<void> {
    await this.sub.subscribe("notify");
  }

  /** Online in this process, or announced by another cloud instance. */
  async isListening(deviceId: string): Promise<boolean> {
    if (this.waiters.get(deviceId)?.size) return true;
    return (await this.pub.exists(`listening:${deviceId}`)) === 1;
  }

  async notify(deviceId: string): Promise<void> {
    await this.pub.publish("notify", deviceId);
  }

  /** Resolve when notified or after timeoutMs, whichever first. */
  async wait(deviceId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await this.pub.set(`listening:${deviceId}`, "1", "PX", timeoutMs + 2_000);
    await new Promise<void>((resolve) => {
      const set = this.waiters.get(deviceId) ?? new Set();
      this.waiters.set(deviceId, set);
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        if (set.size === 0) this.waiters.delete(deviceId);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      set.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
    if (!this.waiters.get(deviceId)?.size) await this.pub.del(`listening:${deviceId}`);
  }

  private fire(deviceId: string): void {
    for (const done of [...(this.waiters.get(deviceId) ?? [])]) done();
  }
}

export type PushFn = (url: string) => Promise<boolean>;

export const httpPush: PushFn = async (url) => {
  try {
    const res = await fetch(url, { method: "POST", body: "", signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
};

export class WakeDispatcher {
  private readonly store: Store;
  private readonly notifier: Notifier;
  private readonly push: PushFn;

  constructor(store: Store, notifier: Notifier, push: PushFn = httpPush) {
    this.store = store;
    this.notifier = notifier;
    this.push = push;
  }

  async wake(deviceId: string): Promise<EnqueueResponse["delivery"]> {
    if (await this.notifier.isListening(deviceId)) {
      await this.notifier.notify(deviceId);
      return "long-poll";
    }
    const dev = await this.store.getDevice(deviceId);
    if (dev?.wake.kind === "push") {
      // Collapse bursts of work into one ping.
      const fresh = await this.store.redis.set(`wakecd:${deviceId}`, "1", "PX", WAKE_COOLDOWN_MS, "NX");
      if (!fresh) return "woken";
      if (await this.push(dev.wake.url)) return "woken";
      await this.store.redis.del(`wakecd:${deviceId}`);
    }
    return "queued";
  }
}

/**
 * Fires timed wakes (deferred follow-ups, envelopes with notBefore). Runs on
 * every cloud instance; a short Redis lock keeps one sweeper active at a time.
 */
export class WakeScheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly store: Store;
  private readonly dispatcher: WakeDispatcher;
  private readonly intervalMs: number;

  constructor(store: Store, dispatcher: WakeDispatcher, intervalMs = 5_000) {
    this.store = store;
    this.dispatcher = dispatcher;
    this.intervalMs = intervalMs;
  }

  start(): void {
    this.timer = setInterval(() => void this.tick().catch(() => {}), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = Date.now()): Promise<string[]> {
    const lock = await this.store.redis.set("lock:wake-sweep", "1", "PX", this.intervalMs, "NX");
    if (!lock) return [];
    const due = await this.store.popDueWakes(now);
    await Promise.all(due.map((id) => this.dispatcher.wake(id)));
    return due;
  }
}
