// Redis-backed coordination state. Per device:
//   dev:{id}        hash   public keys, wake strategy, liveness
//   q:{id}          zset   envelope ids scored by deliverable-at
//   lease:{id}      zset   handed-out envelope ids scored by lease expiry
//   env:{envId}     string the envelope JSON (sealed payload + metadata)
// Global:
//   wake:due        zset   deviceId scored by the next time it must be woken
//   pair:{code}     string deviceId, short-lived, for binding channel handles
//   handle:{hash}   string deviceId for a hashed channel handle

import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import type { Envelope, EnqueueRequest, RegisterDeviceRequest, WakeStrategy } from "@momo/protocol";
import { randomId } from "@momo/protocol";

export const ENVELOPE_TTL_S = 7 * 24 * 3600;
export const LEASE_MS = 5 * 60_000;
export const ONLINE_WINDOW_MS = 90_000;
const PAIR_TTL_S = 15 * 60;

export interface DeviceRecord {
  deviceId: string;
  boxPublicKey: string;
  signPublicKey: string;
  wake: WakeStrategy;
  lastSeenAt: number | null;
  state: string | null;
}

// Moves expired leases back to the queue, then claims every due envelope.
// KEYS: q, lease   ARGV: now, leaseUntil, maxBatch
const CLAIM_LUA = `
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
for _, id in ipairs(expired) do
  redis.call('ZREM', KEYS[2], id)
  redis.call('ZADD', KEYS[1], ARGV[1], id)
end
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[3]))
for _, id in ipairs(due) do
  redis.call('ZREM', KEYS[1], id)
  redis.call('ZADD', KEYS[2], ARGV[2], id)
end
return due
`;

export function hashHandle(channel: string, handle: string): string {
  return createHash("sha256").update(`${channel}:${handle}`).digest("hex");
}

export class Store {
  readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async registerDevice(req: RegisterDeviceRequest): Promise<void> {
    const key = `dev:${req.deviceId}`;
    const existing = await this.redis.hget(key, "signPublicKey");
    // A device id is bound to its first signing key; re-registering with a
    // different key would let anyone hijack someone else's queue.
    if (existing && existing !== req.signPublicKey) throw new Error("device id already registered to another key");
    await this.redis.hset(key, {
      deviceId: req.deviceId,
      boxPublicKey: req.boxPublicKey,
      signPublicKey: req.signPublicKey,
      wake: JSON.stringify(req.wake),
    });
    await this.redis.set(`pair:${req.pairCode}`, req.deviceId, "EX", PAIR_TTL_S);
  }

  async getDevice(deviceId: string): Promise<DeviceRecord | null> {
    const h = await this.redis.hgetall(`dev:${deviceId}`);
    if (!h.deviceId) return null;
    return {
      deviceId: h.deviceId,
      boxPublicKey: h.boxPublicKey!,
      signPublicKey: h.signPublicKey!,
      wake: JSON.parse(h.wake ?? '{"kind":"none"}') as WakeStrategy,
      lastSeenAt: h.lastSeenAt ? Number(h.lastSeenAt) : null,
      state: h.state ?? null,
    };
  }

  isOnline(dev: DeviceRecord, now = Date.now()): boolean {
    return dev.state === "awake" && dev.lastSeenAt !== null && now - dev.lastSeenAt < ONLINE_WINDOW_MS;
  }

  async touch(deviceId: string, state: string, now = Date.now()): Promise<void> {
    await this.redis.hset(`dev:${deviceId}`, { lastSeenAt: String(now), state });
  }

  async enqueue(deviceId: string, req: EnqueueRequest, now = Date.now()): Promise<Envelope> {
    const env: Envelope = {
      id: randomId("env"),
      deviceId,
      kind: req.kind,
      urgency: req.urgency,
      sealed: req.sealed,
      createdAt: now,
      notBefore: req.notBefore,
      attempts: 0,
    };
    const deliverableAt = Math.max(now, req.notBefore ?? now);
    await this.redis
      .multi()
      .set(`env:${env.id}`, JSON.stringify(env), "EX", ENVELOPE_TTL_S)
      .zadd(`q:${deviceId}`, deliverableAt, env.id)
      .exec();
    if (req.notBefore && req.notBefore > now) await this.scheduleWake(deviceId, req.notBefore);
    return env;
  }

  /** Lease every due envelope to the device. Unacked leases come back after LEASE_MS. */
  async claim(deviceId: string, now = Date.now(), maxBatch = 50): Promise<Envelope[]> {
    const ids = (await this.redis.eval(CLAIM_LUA, 2, `q:${deviceId}`, `lease:${deviceId}`, now, now + LEASE_MS, maxBatch)) as string[];
    if (ids.length === 0) return [];
    const raw = await this.redis.mget(ids.map((id) => `env:${id}`));
    const out: Envelope[] = [];
    const pipe = this.redis.pipeline();
    for (const r of raw) {
      if (!r) continue;
      const env = JSON.parse(r) as Envelope;
      env.attempts += 1;
      pipe.set(`env:${env.id}`, JSON.stringify(env), "KEEPTTL");
      out.push(env);
    }
    await pipe.exec();
    return out;
  }

  async ack(deviceId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const pipe = this.redis.pipeline();
    for (const id of ids) {
      pipe.zrem(`lease:${deviceId}`, id);
      pipe.del(`env:${id}`);
    }
    await pipe.exec();
  }

  async pendingCount(deviceId: string, now = Date.now()): Promise<number> {
    return this.redis.zcount(`q:${deviceId}`, "-inf", now);
  }

  async nextDeliverableAt(deviceId: string): Promise<number | null> {
    const [, score] = await this.redis.zrange(`q:${deviceId}`, 0, 0, "WITHSCORES");
    return score ? Number(score) : null;
  }

  /** Keep the earliest wake time per device (LT still adds missing members). */
  async scheduleWake(deviceId: string, at: number): Promise<void> {
    await this.redis.zadd("wake:due", "LT", at, deviceId);
  }

  async clearWake(deviceId: string): Promise<void> {
    await this.redis.zrem("wake:due", deviceId);
  }

  async popDueWakes(now = Date.now(), limit = 100): Promise<string[]> {
    const ids = await this.redis.zrangebyscore("wake:due", "-inf", now, "LIMIT", 0, limit);
    if (ids.length) await this.redis.zrem("wake:due", ...ids);
    return ids;
  }

  async bindHandle(pairCode: string, channel: string, handle: string): Promise<string | null> {
    const deviceId = await this.redis.getdel(`pair:${pairCode}`);
    if (!deviceId) return null;
    await this.redis.set(`handle:${hashHandle(channel, handle)}`, deviceId);
    return deviceId;
  }

  async deviceForHandle(channel: string, handle: string): Promise<string | null> {
    return this.redis.get(`handle:${hashHandle(channel, handle)}`);
  }
}
