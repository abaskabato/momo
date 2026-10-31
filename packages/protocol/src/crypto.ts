// End-to-end crypto shared by the device and the cloud.
//
// The cloud never holds a key that can open a task. Anything that enters the
// queue is sealed to the device's X25519 public key, and every device request
// is signed with the device's Ed25519 key, so the cloud stores public keys only.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

const SEAL_VERSION = 1;
const SEAL_INFO = Buffer.from("momo-seal-v1");

export type B64 = string;

export interface DeviceKeys {
  boxPublicKey: B64;
  boxPrivateKey: B64;
  signPublicKey: B64;
  signPrivateKey: B64;
}

const b64 = (buf: Uint8Array): B64 => Buffer.from(buf).toString("base64url");
const unb64 = (s: B64): Buffer => Buffer.from(s, "base64url");

function rawPublic(key: KeyObject): Buffer {
  return unb64(key.export({ format: "jwk" }).x as string);
}

function rawPrivate(key: KeyObject): Buffer {
  return unb64(key.export({ format: "jwk" }).d as string);
}

function importPublic(crv: "X25519" | "Ed25519", raw: B64): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv, x: raw }, format: "jwk" });
}

function importPrivate(crv: "X25519" | "Ed25519", rawPriv: B64, rawPub: B64): KeyObject {
  return createPrivateKey({ key: { kty: "OKP", crv, x: rawPub, d: rawPriv }, format: "jwk" });
}

export function generateDeviceKeys(): DeviceKeys {
  const box = generateKeyPairSync("x25519");
  const sig = generateKeyPairSync("ed25519");
  return {
    boxPublicKey: b64(rawPublic(box.publicKey)),
    boxPrivateKey: b64(rawPrivate(box.privateKey)),
    signPublicKey: b64(rawPublic(sig.publicKey)),
    signPrivateKey: b64(rawPrivate(sig.privateKey)),
  };
}

/** Anonymous sealed box: only the holder of the recipient's private key can open it. */
export function seal(recipientBoxPublicKey: B64, plaintext: string | Uint8Array): B64 {
  const eph = generateKeyPairSync("x25519");
  const recipient = importPublic("X25519", recipientBoxPublicKey);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const ephPub = rawPublic(eph.publicKey);
  const salt = Buffer.concat([ephPub, unb64(recipientBoxPublicKey)]);
  const key = Buffer.from(hkdfSync("sha256", shared, salt, SEAL_INFO, 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return b64(Buffer.concat([Buffer.from([SEAL_VERSION]), ephPub, nonce, cipher.getAuthTag(), ct]));
}

export function open(keys: Pick<DeviceKeys, "boxPublicKey" | "boxPrivateKey">, sealed: B64): Buffer {
  const buf = unb64(sealed);
  if (buf[0] !== SEAL_VERSION) throw new Error(`unsupported seal version ${buf[0]}`);
  const ephPub = buf.subarray(1, 33);
  const nonce = buf.subarray(33, 45);
  const tag = buf.subarray(45, 61);
  const ct = buf.subarray(61);
  const priv = importPrivate("X25519", keys.boxPrivateKey, keys.boxPublicKey);
  const shared = diffieHellman({ privateKey: priv, publicKey: importPublic("X25519", b64(ephPub)) });
  const salt = Buffer.concat([ephPub, unb64(keys.boxPublicKey)]);
  const key = Buffer.from(hkdfSync("sha256", shared, salt, SEAL_INFO, 32));
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function sealJson(recipientBoxPublicKey: B64, value: unknown): B64 {
  return seal(recipientBoxPublicKey, JSON.stringify(value));
}

export function openJson<T>(keys: Pick<DeviceKeys, "boxPublicKey" | "boxPrivateKey">, sealed: B64): T {
  return JSON.parse(open(keys, sealed).toString("utf8")) as T;
}

// ---- Request signing -------------------------------------------------------

export const SIG_HEADERS = {
  device: "x-momo-device",
  timestamp: "x-momo-ts",
  signature: "x-momo-sig",
} as const;

/** Requests older than this are rejected, which bounds replay. */
export const MAX_CLOCK_SKEW_MS = 2 * 60_000;

function canonical(method: string, path: string, ts: string, body: string): Buffer {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return Buffer.from(`${method.toUpperCase()}\n${path}\n${ts}\n${bodyHash}`);
}

export function signRequest(
  keys: Pick<DeviceKeys, "signPublicKey" | "signPrivateKey">,
  method: string,
  path: string,
  body: string,
  now = Date.now(),
): { timestamp: string; signature: B64 } {
  const ts = String(now);
  const priv = importPrivate("Ed25519", keys.signPrivateKey, keys.signPublicKey);
  return { timestamp: ts, signature: b64(sign(null, canonical(method, path, ts, body), priv)) };
}

export function verifyRequest(
  signPublicKey: B64,
  method: string,
  path: string,
  body: string,
  timestamp: string,
  signature: B64,
  now = Date.now(),
): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_CLOCK_SKEW_MS) return false;
  try {
    return verify(null, canonical(method, path, timestamp, body), importPublic("Ed25519", signPublicKey), unb64(signature));
  } catch {
    return false;
  }
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}
