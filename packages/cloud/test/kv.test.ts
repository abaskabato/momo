// FileKV: the built-in store a person's own device uses instead of Redis.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileKV } from "../src/hosted/kv.ts";

test("FileKV: strings, NX, expiry, getdel", async () => {
  const kv = new FileKV();
  assert.equal(await kv.set("a", "1"), "OK");
  assert.equal(await kv.set("a", "2", "NX"), null);
  assert.equal(await kv.get("a"), "1");
  await kv.set("t", "x", "PX", 30, "NX");
  assert.equal(await kv.set("t", "y", "PX", 30, "NX"), null, "a lock holds");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await kv.get("t"), null, "expired");
  assert.equal(await kv.set("t", "y", "PX", 30, "NX"), "OK", "an expired lock can be taken");
  assert.equal(await kv.getdel("a"), "1");
  assert.equal(await kv.get("a"), null);
  assert.equal(await kv.del("t", "missing"), 1);
});

test("FileKV: a queue behaves like Redis lists (lpush, lmove right→left, lrem)", async () => {
  const kv = new FileKV();
  await kv.lpush("q", "j1");
  await kv.lpush("q", "j2");
  assert.equal(await kv.lmove("q", "p", "RIGHT", "LEFT"), "j1", "first in, first out");
  assert.equal(await kv.lrem("p", 1, "j1"), 1);
  assert.equal(await kv.lmove("q", "p", "RIGHT", "LEFT"), "j2");
  assert.equal(await kv.lmove("q", "p", "RIGHT", "LEFT"), null);
});

test("FileKV: blmove wakes on push and times out when idle", async () => {
  const kv = new FileKV();
  const waiting = kv.duplicate().blmove("q", "p", "RIGHT", "LEFT", 5);
  setTimeout(() => void kv.lpush("q", "job"), 20);
  const t0 = Date.now();
  assert.equal(await waiting, "job");
  assert.ok(Date.now() - t0 < 1000, "woken by the push, not the timeout");
  const t1 = Date.now();
  assert.equal(await kv.blmove("q", "p", "RIGHT", "LEFT", 0.1), null);
  assert.ok(Date.now() - t1 >= 90);
});

test("FileKV: sorted sets for scheduled reminders", async () => {
  const kv = new FileKV();
  await kv.zadd("z", 30, "c");
  await kv.zadd("z", 10, "a");
  await kv.zadd("z", 20, "b");
  assert.deepEqual(await kv.zrangebyscore("z", "-inf", 20), ["a", "b"]);
  assert.equal(await kv.zrem("z", "a"), 1);
  assert.deepEqual(await kv.zrangebyscore("z", 0, "+inf"), ["b", "c"]);
});

test("FileKV: survives a restart (saved to its file)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "momo-kv-"));
  try {
    const path = join(dir, "sub", "store.json");
    const a = new FileKV(path);
    await a.set("k", "v");
    await a.set("gone", "v", "EX", 0);
    await a.lpush("q", "job");
    await a.zadd("z", 1, "m");
    a.disconnect();
    const b = new FileKV(path);
    assert.equal(await b.get("k"), "v");
    assert.equal(await b.get("gone"), null);
    assert.equal(await b.lmove("q", "p", "RIGHT", "LEFT"), "job");
    assert.deepEqual(await b.zrangebyscore("z", 0, 2), ["m"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
