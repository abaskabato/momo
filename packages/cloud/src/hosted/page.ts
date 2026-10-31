// The secure-link page. Plain HTML, no third-party scripts. The secret is
// sealed in the browser (WebCrypto) to the user's own key before it is sent.

import { WEB_SEAL_SOURCE, type SecureFormSpec } from "@momo/protocol";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'",
};

interface Field {
  id: string;
  label: string;
  auto: string;
  type?: string;
  mode?: string;
  optional?: boolean;
}

function formCopy(spec: SecureFormSpec): { title: string; note: string; fields: Field[] } {
  if (spec.kind === "card") {
    return {
      title: "Add your card",
      note: "Encrypted on your phone before it's sent. Momo never sees the number in chat, and asks you before every purchase.",
      fields: [
        { id: "name", label: "Name on card", auto: "cc-name" },
        { id: "number", label: "Card number", auto: "cc-number", mode: "numeric" },
        { id: "exp", label: "Expiry (MM/YY)", auto: "cc-exp" },
        { id: "cvc", label: "Security code", auto: "cc-csc", mode: "numeric" },
        { id: "zip", label: "Billing ZIP", auto: "postal-code", optional: true },
      ],
    };
  }
  if (spec.kind === "address") {
    return {
      title: "Add your address",
      note: "Saved encrypted so you won't be asked again.",
      fields: [
        { id: "name", label: "Full name", auto: "name" },
        { id: "line1", label: "Street address", auto: "address-line1" },
        { id: "line2", label: "Apt, suite (optional)", auto: "address-line2", optional: true },
        { id: "city", label: "City", auto: "address-level2" },
        { id: "region", label: "State", auto: "address-level1" },
        { id: "postal", label: "ZIP", auto: "postal-code" },
        { id: "phone", label: "Phone (for delivery)", auto: "tel", type: "tel", optional: true },
      ],
    };
  }
  return {
    title: `Add your ${spec.label} login`,
    note: `This is encrypted on your phone before it's sent. Momo uses it only on ${spec.label}, and it never appears in chat.`,
    fields: [
      { id: "identifier", label: "Email or username", auto: "username" },
      { id: "password", label: "Password", auto: "current-password", type: "password" },
    ],
  };
}

export function secureFormPage(id: string, spec: SecureFormSpec, boxPublicKey: string): string {
  const c = formCopy(spec);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(c.title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#111;--mut:#666;--acc:#2b6cb0;--line:#ddd}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--mut:#aaa;--acc:#63a4ff;--line:#333}}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.45 system-ui,sans-serif}
main{max-width:420px;margin:0 auto;padding:28px 16px}
h1{font-size:22px;margin:0 0 6px}p{color:var(--mut);margin:0 0 20px}
label{display:block;font-size:14px;margin:14px 0 6px}
input{box-sizing:border-box;width:100%;padding:12px;font-size:17px;border:1px solid var(--line);border-radius:10px;background:transparent;color:inherit}
button{width:100%;margin-top:22px;padding:14px;font-size:17px;border:0;border-radius:10px;background:var(--acc);color:#fff}
.ok{font-size:18px;color:var(--fg)}
</style></head><body><main>
<h1>${esc(c.title)}</h1>
<p>${esc(c.note)}</p>
<form id="f">
${c.fields.map((f) => `<label for="${f.id}">${esc(f.label)}</label><input id="${f.id}" name="${f.id}" autocomplete="${f.auto}"${f.type ? ` type="${f.type}"` : ""}${f.mode ? ` inputmode="${f.mode}"` : ""}${f.optional ? "" : " required"}>`).join("\n")}
<button type="submit">Save securely</button>
</form>
<p id="done" class="ok" hidden>Saved. You can close this page and go back to the chat.</p>
<script>
${WEB_SEAL_SOURCE}
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = e.target.querySelector("button"); b.disabled = true; b.textContent = "Saving…";
  const fields = Object.fromEntries([...e.target.querySelectorAll("input")].map((i) => [i.name, i.value]));
  const sealed = await momoSeal(${JSON.stringify(boxPublicKey)}, JSON.stringify({ formId: ${JSON.stringify(id)}, fields }));
  const r = await fetch(location.pathname.replace("/s/", "/v1/forms/"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sealed }) });
  if (r.ok) { e.target.hidden = true; document.getElementById("done").hidden = false; }
  else { b.disabled = false; b.textContent = r.status === 410 ? "This link expired. Ask Momo for a new one." : "Try again"; }
});
</script></main></body></html>`;
}

export const LIVE_HEADERS = {
  ...PAGE_HEADERS,
  "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; form-action 'none'",
};

/** The owner sees the errand's browser and taps/types through one step (a CAPTCHA, an odd page). */
export function liveViewPage(reason: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Momo live view</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#111;--mut:#666;--acc:#2b6cb0;--line:#ddd}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--mut:#aaa;--acc:#63a4ff;--line:#333}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.4 system-ui,sans-serif}
main{max-width:900px;margin:0 auto;padding:12px 16px 24px}
p{color:var(--mut);margin:4px 0 10px}
img{width:100%;border:1px solid var(--line);border-radius:8px;touch-action:manipulation;display:block}
.row{display:flex;gap:8px;margin-top:10px}
input{flex:1;min-width:0;padding:12px;font-size:16px;border:1px solid var(--line);border-radius:10px;background:transparent;color:inherit}
button{padding:12px 14px;font-size:16px;border:1px solid var(--line);border-radius:10px;background:transparent;color:inherit}
#done{width:100%;margin-top:12px;border:0;background:var(--acc);color:#fff}
</style></head><body><main>
<p>${esc(reason)} Tap the picture to click. Type below to fill a box.</p>
<img id="shot" alt="The page Momo is working on">
<div class="row"><input id="t" placeholder="Type here" autocomplete="off"><button id="send">Send</button><button id="enter">Enter</button></div>
<div class="row"><button id="up">Scroll up</button><button id="down">Scroll down</button></div>
<button id="done">I'm done</button>
<script>
const base = location.pathname;
const post = (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) });
const img = document.getElementById("shot");
let busy = false, over = false;
async function refresh() {
  if (busy || over) return; busy = true;
  try {
    const r = await fetch(base + "/shot", { cache: "no-store" });
    if (r.status === 410) { over = true; document.querySelector("p").textContent = "This live view has ended. Go back to the chat."; return; }
    if (r.ok) { const u = URL.createObjectURL(await r.blob()); const old = img.src; img.src = u; if (old) URL.revokeObjectURL(old); }
  } finally { busy = false; }
}
img.addEventListener("click", async (e) => {
  const b = img.getBoundingClientRect();
  await post("/tap", { x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height });
  setTimeout(refresh, 400);
});
document.getElementById("send").onclick = async () => { const t = document.getElementById("t"); await post("/type", { text: t.value }); t.value = ""; refresh(); };
document.getElementById("enter").onclick = async () => { await post("/type", { key: "Enter" }); setTimeout(refresh, 400); };
document.getElementById("up").onclick = async () => { await post("/scroll", { dy: -600 }); refresh(); };
document.getElementById("down").onclick = async () => { await post("/scroll", { dy: 600 }); refresh(); };
document.getElementById("done").onclick = async () => { await post("/done"); over = true; document.querySelector("main").innerHTML = "<p style='font-size:18px'>Thanks! Momo is continuing. You can close this page.</p>"; };
refresh(); setInterval(refresh, 1500);
</script></main></body></html>`;
}
