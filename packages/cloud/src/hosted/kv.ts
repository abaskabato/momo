// The few Redis commands hosted mode uses. A server uses Redis; a person's own
// device uses FileKV (no Redis to install): the same commands, kept in memory
// and saved to one JSON file.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface KV {
  get(key: string): Promise<string | null>;
  /** Supports the flags hosted mode uses: EX <s>, PX <ms>, NX. */
  set(key: string, value: string, ...flags: Array<string | number>): Promise<"OK" | null>;
  getdel(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  lpush(key: string, ...values: string[]): Promise<number>;
  lmove(src: string, dst: string, from: "RIGHT", to: "LEFT"): Promise<string | null>;
  blmove(src: string, dst: string, from: "RIGHT", to: "LEFT", timeoutS: number): Promise<string | null>;
  lrem(key: string, count: number, value: string): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<number | string>;
  zrem(key: string, member: string): Promise<number>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  /** A connection for blocking calls (Redis); the same store for FileKV. */
  duplicate(): KV;
  disconnect(): void;
}

interface Data {
  str: Record<string, { v: string; exp?: number }>;
  list: Record<string, string[]>;
  zset: Record<string, Record<string, number>>;
}

export class FileKV implements KV {
  private readonly path?: string;
  private readonly d: Data;
  private readonly waiters = new Set<() => void>();
  private saveTimer?: NodeJS.Timeout;

  /** Without a path it's memory only (tests). */
  constructor(path?: string) {
    this.path = path;
    let d: Data = { str: {}, list: {}, zset: {} };
    if (path) {
      try {
        d = JSON.parse(readFileSync(path, "utf8")) as Data;
      } catch {
        // first run
      }
    }
    this.d = d;
  }

  private live(key: string) {
    const e = this.d.str[key];
    if (e?.exp !== undefined && e.exp <= Date.now()) {
      delete this.d.str[key];
      return undefined;
    }
    return e;
  }

  private changed() {
    for (const w of this.waiters) w();
    if (!this.path || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 200);
  }

  /** Write to disk now (atomic rename; private to this user). */
  flush(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.d), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  async get(key: string) {
    return this.live(key)?.v ?? null;
  }

  async set(key: string, value: string, ...flags: Array<string | number>) {
    let exp: number | undefined;
    let nx = false;
    for (let i = 0; i < flags.length; i++) {
      const f = String(flags[i]).toUpperCase();
      if (f === "NX") nx = true;
      else if (f === "EX") exp = Date.now() + Number(flags[++i]) * 1000;
      else if (f === "PX") exp = Date.now() + Number(flags[++i]);
    }
    if (nx && this.live(key)) return null;
    this.d.str[key] = { v: value, exp };
    this.changed();
    return "OK" as const;
  }

  async getdel(key: string) {
    const v = this.live(key)?.v ?? null;
    if (v !== null) {
      delete this.d.str[key];
      this.changed();
    }
    return v;
  }

  async del(...keys: string[]) {
    let n = 0;
    for (const k of keys) {
      if (this.live(k) || this.d.list[k] || this.d.zset[k]) n++;
      delete this.d.str[k];
      delete this.d.list[k];
      delete this.d.zset[k];
    }
    if (n) this.changed();
    return n;
  }

  async lpush(key: string, ...values: string[]) {
    const l = (this.d.list[key] ??= []);
    l.unshift(...values.reverse());
    this.changed();
    return l.length;
  }

  async lmove(src: string, dst: string, _from?: "RIGHT", _to?: "LEFT") {
    const v = this.d.list[src]?.pop();
    if (v === undefined) return null;
    (this.d.list[dst] ??= []).unshift(v);
    this.changed();
    return v;
  }

  async blmove(src: string, dst: string, from: "RIGHT", to: "LEFT", timeoutS: number) {
    const deadline = Date.now() + timeoutS * 1000;
    for (;;) {
      const v = await this.lmove(src, dst, from, to);
      if (v !== null || Date.now() >= deadline) return v;
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(t);
          this.waiters.delete(wake);
          resolve();
        };
        const t = setTimeout(wake, Math.max(1, deadline - Date.now()));
        this.waiters.add(wake);
      });
    }
  }

  async lrem(key: string, count: number, value: string) {
    const l = this.d.list[key];
    if (!l) return 0;
    let removed = 0;
    for (let i = 0; i < l.length && (count === 0 || removed < Math.abs(count)); ) {
      if (l[i] === value) {
        l.splice(i, 1);
        removed++;
      } else i++;
    }
    if (removed) this.changed();
    return removed;
  }

  async zadd(key: string, score: number, member: string) {
    const z = (this.d.zset[key] ??= {});
    const isNew = !(member in z);
    z[member] = Number(score);
    this.changed();
    return isNew ? 1 : 0;
  }

  async zrem(key: string, member: string) {
    const z = this.d.zset[key];
    if (!z || !(member in z)) return 0;
    delete z[member];
    this.changed();
    return 1;
  }

  async zrangebyscore(key: string, min: number | string, max: number | string) {
    const lo = min === "-inf" ? -Infinity : Number(min);
    const hi = max === "+inf" ? Infinity : Number(max);
    return Object.entries(this.d.zset[key] ?? {})
      .filter(([, s]) => s >= lo && s <= hi)
      .sort((a, b) => a[1] - b[1])
      .map(([m]) => m);
  }

  duplicate(): KV {
    return this;
  }

  disconnect(): void {
    this.flush();
  }
}

/** ioredis's overloaded types don't match KV's plain signatures; the calls do. */
export function fromRedis(redis: { duplicate(): unknown; disconnect(): void }): KV {
  return redis as unknown as KV;
}
