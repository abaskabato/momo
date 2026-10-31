// Tiny durable JSON files under the local state dir. Writes are atomic
// (temp file + rename) and serialized per file, which is enough for a single
// local agent process.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** A small durable JSON document. Files on a device; encrypted Redis records when hosted. */
export interface Doc<T> {
  read(): Promise<T>;
  write(value: T): Promise<void>;
  update(fn: (value: T) => T | void): Promise<T>;
}

export class JsonFile<T> implements Doc<T> {
  readonly path: string;
  private readonly fallback: () => T;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(path: string, fallback: () => T) {
    this.path = path;
    this.fallback = fallback;
  }

  async read(): Promise<T> {
    await this.chain;
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as T;
    } catch {
      return this.fallback();
    }
  }

  write(value: T): Promise<void> {
    const next = this.chain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
      await rename(tmp, this.path);
    });
    this.chain = next.catch(() => {});
    return next;
  }

  async update(fn: (value: T) => T | void): Promise<T> {
    const v = await this.read();
    const out = (fn(v) ?? v) as T;
    await this.write(out);
    return out;
  }
}
