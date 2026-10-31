import { test } from "node:test";
import assert from "node:assert/strict";
import { generateDeviceKeys, open, openJson, seal, sealJson, signRequest, verifyRequest } from "../src/index.ts";

test("sealed box round-trips and only opens with the right key", () => {
  const device = generateDeviceKeys();
  const other = generateDeviceKeys();
  const sealed = seal(device.boxPublicKey, "book Nopa for 4 at 7");
  assert.equal(open(device, sealed).toString(), "book Nopa for 4 at 7");
  assert.throws(() => open(other, sealed));
  assert.deepEqual(openJson(device, sealJson(device.boxPublicKey, { a: 1 })), { a: 1 });
});

test("sealing the same plaintext twice gives different ciphertext", () => {
  const device = generateDeviceKeys();
  assert.notEqual(seal(device.boxPublicKey, "x"), seal(device.boxPublicKey, "x"));
});

test("request signatures bind method, path, body and time", () => {
  const k = generateDeviceKeys();
  const now = Date.now();
  const { timestamp, signature } = signRequest(k, "POST", "/v1/checkin", '{"ack":[]}', now);
  assert.ok(verifyRequest(k.signPublicKey, "POST", "/v1/checkin", '{"ack":[]}', timestamp, signature, now));
  assert.ok(!verifyRequest(k.signPublicKey, "POST", "/v1/checkin", '{"ack":["x"]}', timestamp, signature, now));
  assert.ok(!verifyRequest(k.signPublicKey, "GET", "/v1/checkin", '{"ack":[]}', timestamp, signature, now));
  assert.ok(!verifyRequest(k.signPublicKey, "POST", "/v1/checkin", '{"ack":[]}', timestamp, signature, now + 10 * 60_000));
});

test("the browser seal (WebCrypto) opens with the device's open()", async () => {
  const { WEB_SEAL_SOURCE } = await import("../src/index.ts");
  const momoSeal = new Function(`${WEB_SEAL_SOURCE}; return momoSeal;`)() as (k: string, p: string) => Promise<string>;
  const device = generateDeviceKeys();
  for (const msg of ["p@ss wörd ✓", "x".repeat(5000)]) {
    assert.equal(open(device, await momoSeal(device.boxPublicKey, msg)).toString(), msg);
  }
});
