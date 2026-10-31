// The browser half of sealing, shipped inline in the secure-link page. It is
// byte-compatible with seal() in crypto.ts, so the device opens it with open().
// Kept as source text so the page and the tests run the exact same code.

export const WEB_SEAL_SOURCE = String.raw`
async function momoSeal(recipientB64u, plaintext) {
  const dec = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
  const enc = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const subtle = crypto.subtle;
  const recip = dec(recipientB64u);
  const eph = await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const ephPub = new Uint8Array(await subtle.exportKey("raw", eph.publicKey));
  const recipKey = await subtle.importKey("raw", recip, { name: "X25519" }, false, []);
  const shared = await subtle.deriveBits({ name: "X25519", public: recipKey }, eph.privateKey, 256);
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array([...ephPub, ...recip]), info: new TextEncoder().encode("momo-seal-v1") },
    hkdf, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const out = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(plaintext)));
  const ct = out.slice(0, out.length - 16);
  const tag = out.slice(out.length - 16);
  return enc(new Uint8Array([1, ...ephPub, ...nonce, ...tag, ...ct]));
}`;
