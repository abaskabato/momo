// Local credential vault. "Your logins never leave your device."
//
// - Secrets are encrypted at rest with AES-256-GCM; the AAD binds each
//   ciphertext to its item id, so blobs can't be swapped between items.
// - The data key lives in the OS keychain (macOS Keychain / libsecret) and
//   never in the vault file or the cloud.
// - The model only ever sees handles and hints (`list()`). Secret values are
//   reachable only through `use()`, which injectors call to type values
//   straight into a page, and which refuses origins a login isn't bound to.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomId } from "@momo/protocol";
import type { Doc } from "./store.ts";

const exec = promisify(execFile);

export type VaultKind = "login" | "payment" | "address";

export interface LoginSecret {
  identifier: string;
  password: string;
}
export interface PaymentSecret {
  name: string;
  number: string;
  expMonth: string;
  expYear: string;
  cvc: string;
  zip?: string;
}
export interface AddressSecret {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postal: string;
  country: string;
  phone?: string;
}
export type VaultSecret = LoginSecret | PaymentSecret | AddressSecret;

/** Safe to show the model and the user. */
export interface VaultItemInfo {
  handle: string;
  kind: VaultKind;
  label: string;
  /** e.g. "a•••@gmail.com" or "Visa •••• 4242". */
  hint: string;
  /** Logins are bound to one origin and refused anywhere else. */
  origin?: string;
}

interface StoredItem extends VaultItemInfo {
  ct: string;
}

export interface KeyProvider {
  getOrCreateKey(): Promise<Buffer>;
}

/** macOS Keychain via the `security` CLI; nothing is written to disk by us. */
export class MacKeychainKeyProvider implements KeyProvider {
  private readonly service: string;
  constructor(service = "momo-vault") {
    this.service = service;
  }
  async getOrCreateKey(): Promise<Buffer> {
    try {
      const { stdout } = await exec("security", ["find-generic-password", "-s", this.service, "-a", "data-key", "-w"]);
      return Buffer.from(stdout.trim(), "base64");
    } catch {
      const key = randomBytes(32);
      await exec("security", ["add-generic-password", "-s", this.service, "-a", "data-key", "-w", key.toString("base64"), "-U"]);
      return key;
    }
  }
}

/** Linux desktops: libsecret's `secret-tool`. */
export class SecretToolKeyProvider implements KeyProvider {
  async getOrCreateKey(): Promise<Buffer> {
    try {
      const { stdout } = await exec("secret-tool", ["lookup", "service", "momo-vault", "account", "data-key"]);
      if (stdout.trim()) return Buffer.from(stdout.trim(), "base64");
    } catch {}
    const key = randomBytes(32);
    const child = execFile("secret-tool", ["store", "--label=momo vault key", "service", "momo-vault", "account", "data-key"]);
    child.stdin!.end(key.toString("base64"));
    await new Promise((res, rej) => child.on("exit", (c) => (c === 0 ? res(null) : rej(new Error("secret-tool failed")))));
    return key;
  }
}

/** Hosted mode: a per-user key handed in by the runtime (derived from the KMS master key). */
export class StaticKeyProvider implements KeyProvider {
  private readonly key: Buffer;
  constructor(key: Buffer) {
    this.key = key;
  }
  async getOrCreateKey(): Promise<Buffer> {
    return this.key;
  }
}

/** Fallback for headless servers and tests: a 0600 key file. Weaker than a keychain. */
export class FileKeyProvider implements KeyProvider {
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  async getOrCreateKey(): Promise<Buffer> {
    try {
      return Buffer.from((await readFile(this.path, "utf8")).trim(), "base64");
    } catch {
      const key = randomBytes(32);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(this.path, key.toString("base64"), { mode: 0o600 });
      return key;
    }
  }
}

export function defaultKeyProvider(fallbackPath: string): KeyProvider {
  if (process.platform === "darwin") return new MacKeychainKeyProvider();
  if (process.platform === "linux" && process.env.DBUS_SESSION_BUS_ADDRESS) return new SecretToolKeyProvider();
  return new FileKeyProvider(fallbackPath);
}

export class VaultOriginError extends Error {}

export interface VaultFile {
  version: 1;
  items: StoredItem[];
}

export class LocalVault {
  private readonly doc: Doc<VaultFile>;
  private readonly keys: KeyProvider;
  private key: Buffer | null = null;
  private items: StoredItem[] | null = null;

  constructor(doc: Doc<VaultFile>, keys: KeyProvider) {
    this.doc = doc;
    this.keys = keys;
  }

  async list(kind?: VaultKind): Promise<VaultItemInfo[]> {
    const items = await this.load();
    return items.filter((i) => !kind || i.kind === kind).map(({ ct: _ct, ...info }) => info);
  }

  async findLogin(origin: string): Promise<VaultItemInfo | undefined> {
    const want = new URL(origin).origin;
    return (await this.list("login")).find((i) => i.origin === want);
  }

  async put(kind: VaultKind, label: string, secret: VaultSecret, origin?: string): Promise<VaultItemInfo> {
    if (kind === "login" && !origin) throw new Error("logins must be bound to an origin");
    const items = await this.load();
    const handle = randomId("vlt");
    const item: StoredItem = {
      handle,
      kind,
      label,
      hint: hintFor(kind, secret),
      origin: origin ? new URL(origin).origin : undefined,
      ct: this.encrypt(handle, JSON.stringify(secret)),
    };
    items.push(item);
    await this.save();
    const { ct: _ct, ...info } = item;
    return info;
  }

  async remove(handle: string): Promise<boolean> {
    const items = await this.load();
    const i = items.findIndex((x) => x.handle === handle);
    if (i < 0) return false;
    items.splice(i, 1);
    await this.save();
    return true;
  }

  /**
   * Run `fn` with the decrypted secret. Only injectors call this; its result
   * must never be returned to the model. `origin` is where the secret will be
   * typed, and a login is refused anywhere but its bound origin.
   */
  async use<T>(handle: string, origin: string, fn: (secret: VaultSecret) => Promise<T>): Promise<T> {
    const item = (await this.load()).find((i) => i.handle === handle);
    if (!item) throw new Error(`no vault item ${handle}`);
    if (item.origin && item.origin !== new URL(origin).origin) {
      throw new VaultOriginError(`${item.label} is bound to ${item.origin}, refusing to use it on ${new URL(origin).origin}`);
    }
    return fn(JSON.parse(this.decrypt(handle, item.ct)) as VaultSecret);
  }

  private encrypt(handle: string, plaintext: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key!, iv);
    c.setAAD(Buffer.from(`momo-vault\0${handle}`));
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
  }

  private decrypt(handle: string, blob: string): string {
    const [v, iv, tag, ct] = blob.split(".");
    if (v !== "v1") throw new Error("unknown vault blob version");
    const d = createDecipheriv("aes-256-gcm", this.key!, Buffer.from(iv!, "base64url"));
    d.setAAD(Buffer.from(`momo-vault\0${handle}`));
    d.setAuthTag(Buffer.from(tag!, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct!, "base64url")), d.final()]).toString("utf8");
  }

  private async load(): Promise<StoredItem[]> {
    this.key ??= await this.keys.getOrCreateKey();
    if (this.items) return this.items;
    this.items = (await this.doc.read()).items;
    return this.items;
  }

  private async save(): Promise<void> {
    await this.doc.write({ version: 1, items: this.items! });
  }
}

function mask(s: string, keep = 1): string {
  return s.slice(0, keep) + "•••";
}

function hintFor(kind: VaultKind, secret: VaultSecret): string {
  if (kind === "login") {
    const id = (secret as LoginSecret).identifier;
    const at = id.indexOf("@");
    return at > 0 ? mask(id.slice(0, at)) + id.slice(at) : mask(id, 2);
  }
  if (kind === "payment") {
    const n = (secret as PaymentSecret).number.replace(/\D/g, "");
    const brand = n.startsWith("4") ? "Visa" : /^5[1-5]/.test(n) ? "Mastercard" : /^3[47]/.test(n) ? "Amex" : "Card";
    return `${brand} •••• ${n.slice(-4)}`;
  }
  const a = secret as AddressSecret;
  return `${a.city}, ${a.region}`;
}
