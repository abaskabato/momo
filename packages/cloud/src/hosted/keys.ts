// Per-user keys for hosted mode, derived from one master key (in production
// held by a KMS; here from MOMO_MASTER_KEY). Every user's state and vault are
// encrypted with that user's own key, and each user has their own X25519 key
// that secure-link pages seal to. Nothing is stored in plaintext at rest.

import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, createHash, hkdfSync, randomBytes } from "node:crypto";
import type { DeviceKeys } from "@momo/protocol";

export function userIdFor(channel: string, handle: string): string {
  return createHash("sha256").update(`${channel}:${handle}`).digest("hex").slice(0, 32);
}

export class UserKeys {
  private readonly master: Buffer;

  constructor(master: Buffer) {
    if (master.length < 32) throw new Error("master key must be at least 32 bytes");
    this.master = master;
  }

  dataKey(userId: string): Buffer {
    return Buffer.from(hkdfSync("sha256", this.master, Buffer.from(userId), Buffer.from("momo-user-data-v1"), 32));
  }

  /** The user's sealing keypair (only the box half is used). */
  boxKeys(userId: string): Pick<DeviceKeys, "boxPublicKey" | "boxPrivateKey"> {
    const seed = Buffer.from(hkdfSync("sha256", this.master, Buffer.from(userId), Buffer.from("momo-user-box-v1"), 32));
    const der = Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), seed]);
    const priv = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    const jwk = createPublicKey(priv).export({ format: "jwk" });
    return { boxPublicKey: jwk.x as string, boxPrivateKey: seed.toString("base64url") };
  }

  encrypt(userId: string, aad: string, plaintext: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.dataKey(userId), iv);
    c.setAAD(Buffer.from(`${userId}\0${aad}`));
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
  }

  decrypt(userId: string, aad: string, blob: string): string {
    const [iv, tag, ct] = blob.split(".").map((p) => Buffer.from(p, "base64url"));
    const d = createDecipheriv("aes-256-gcm", this.dataKey(userId), iv!);
    d.setAAD(Buffer.from(`${userId}\0${aad}`));
    d.setAuthTag(tag!);
    return Buffer.concat([d.update(ct!), d.final()]).toString("utf8");
  }
}
