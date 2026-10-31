// The agent's JSON documents for one hosted user, encrypted with that user's
// key and stored in Redis. Writes for one user are serialized by the runtime.

import type { Redis } from "ioredis";
import type { Doc } from "@momo/agent-core";
import type { UserKeys } from "./keys.ts";

export class RedisDoc<T> implements Doc<T> {
  private readonly redis: Redis;
  private readonly keys: UserKeys;
  private readonly userId: string;
  private readonly name: string;
  private readonly fallback: () => T;

  constructor(redis: Redis, keys: UserKeys, userId: string, name: string, fallback: () => T) {
    this.redis = redis;
    this.keys = keys;
    this.userId = userId;
    this.name = name;
    this.fallback = fallback;
  }

  async read(): Promise<T> {
    const blob = await this.redis.get(`u:${this.userId}:${this.name}`);
    return blob ? (JSON.parse(this.keys.decrypt(this.userId, this.name, blob)) as T) : this.fallback();
  }

  async write(value: T): Promise<void> {
    await this.redis.set(`u:${this.userId}:${this.name}`, this.keys.encrypt(this.userId, this.name, JSON.stringify(value)));
  }

  async update(fn: (value: T) => T | void): Promise<T> {
    const v = await this.read();
    const out = (fn(v) ?? v) as T;
    await this.write(out);
    return out;
  }
}
