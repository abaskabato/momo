// The setup page. Everything happens in this browser. The site's operator
// may have pre-filled the AI and a shared Telegram bot on the server; the
// page only asks for what's missing. Any key typed here is checked with the
// company that issued it and written into the downloaded installer, never
// sent to this site.
const PROVIDERS = [
  { id: "gemini", label: "Google Gemini (free key available)", keyEnv: "GEMINI_API_KEY", model: "gemini-flash-latest", keyUrl: "https://aistudio.google.com/apikey",
    check: (k) => fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(k)}`) },
  { id: "anthropic", label: "Anthropic Claude", keyEnv: "ANTHROPIC_API_KEY", model: "claude-opus-5-5", keyUrl: "https://console.anthropic.com/settings/keys",
    check: (k) => fetch("https://api.anthropic.com/v1/models", { headers: { "x-api-key": k, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" } }) },
  { id: "openai", label: "OpenAI", keyEnv: "OPENAI_API_KEY", model: "gpt-4o", keyUrl: "https://platform.openai.com/api-keys",
    check: (k) => fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${k}` } }) },
  { id: "openrouter", label: "OpenRouter (hundreds of models)", keyEnv: "OPENROUTER_API_KEY", model: "openai/gpt-4o", keyUrl: "https://openrouter.ai/keys",
    check: (k) => fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${k}` } }) },
  { id: "groq", label: "Groq", keyEnv: "GROQ_API_KEY", model: "openai/gpt-oss-120b", keyUrl: "https://console.groq.com/keys",
    check: (k) => fetch("https://api.groq.com/openai/v1/models", { headers: { authorization: `Bearer ${k}` } }) },
  { id: "ollama", label: "Ollama (a model on this computer, no key)", model: "" },
];

const $ = (id) => document.getElementById(id);
const say = (el, text, cls = "") => { el.textContent = text; el.className = `note ${cls}`; };
const origin = location.origin;
const BOT_TOKEN = /^\d+:[\w-]{30,}$/;

// What the operator pre-filled. Without it, the page asks for everything.
let config = { model: null, bot: null };
const ready = fetch("/api/config", { cache: "no-store" }).then((r) => (r.ok ? r.json() : config)).then((c) => (config = c)).catch(() => config).finally(() => {
  $("s-model").hidden = !!config.model;
  $("s-bot").hidden = !!config.bot;
  $("intro-ready").hidden = !(config.model && config.bot);
  $("intro-manual").hidden = !!(config.model && config.bot);
  let n = 0;
  for (const h of document.querySelectorAll("section.step:not([hidden]) h2 .num")) h.textContent = String(++n);
});

// --- Step: the AI ---------------------------------------------------------
const provider = $("provider");
for (const p of PROVIDERS) provider.append(new Option(p.label, p.id));
const current = () => PROVIDERS.find((p) => p.id === provider.value);
function showProvider() {
  const p = current();
  $("key-row").hidden = !p.keyEnv;
  $("model").value = p.model;
  $("model").placeholder = p.model || "the model's name, from the provider's docs";
  $("key-help").textContent = "";
  if (p.keyUrl) {
    const a = Object.assign(document.createElement("a"), { href: p.keyUrl, target: "_blank", rel: "noopener", textContent: "Get a key here" });
    $("key-help").append(a, document.createTextNode(p.id === "gemini" ? ". The free tier allows about one errand a day; turn on billing for real use." : "."));
  }
  say($("model-status"), "");
}
provider.addEventListener("change", showProvider);
showProvider();

async function checked(el, run) {
  say(el, "Checking…");
  try {
    const r = await run();
    if (r.ok) return true;
    say(el, r.status === 401 || r.status === 403 || r.status === 400 ? "That was refused. Check you copied all of it." : `It answered ${r.status}. Try again in a minute.`, "bad");
  } catch {
    say(el, "Couldn't check it from this browser. That's fine: Momo checks again when it starts.", "");
  }
  return false;
}

/** The model field, without a provider typed in front ("groq/llama-…" → "llama-…"). */
function modelName() {
  const p = current();
  let m = $("model").value.trim();
  if (m.toLowerCase().startsWith(`${p.id}/`)) m = m.slice(p.id.length + 1);
  $("model").value = m;
  return m;
}

/** Model names this key can use, when the provider's list says (empty if unknown). */
async function modelIds(r) {
  try {
    const j = await r.clone().json();
    const list = j.data ?? j.models ?? [];
    return list.map((m) => String(m.id ?? m.name ?? "").replace(/^models\//, "")).filter(Boolean);
  } catch { return []; }
}

$("check-model").addEventListener("click", async () => {
  const p = current();
  if (!p.check) return say($("model-status"), "Nothing to check for this one.");
  const key = $("key").value.trim();
  if (!key) return say($("model-status"), "Paste the key first.", "bad");
  let ids = [];
  const ok = await checked($("model-status"), async () => {
    const r = await p.check(key);
    if (r.ok) ids = await modelIds(r);
    return r;
  });
  if (!ok) return;
  const list = $("models");
  list.textContent = "";
  for (const id of ids) list.append(new Option(id, id));
  const model = modelName();
  if (ids.length && !ids.includes(model)) return say($("model-status"), `The key works, but it has no model called "${model}". Try one of: ${ids.slice(0, 6).join(", ")}`, "bad");
  say($("model-status"), "The key works.", "ok");
});

// --- Step: the bot --------------------------------------------------------
let botName = "";
$("check-bot").addEventListener("click", async () => {
  const t = $("bot").value.trim();
  if (!BOT_TOKEN.test(t)) return say($("bot-status"), "That doesn't look like a bot token (numbers, a colon, then letters).", "bad");
  const el = $("bot-status");
  const ok = await checked(el, async () => {
    const r = await fetch(`https://api.telegram.org/bot${t}/getMe`);
    if (r.ok) botName = (await r.json()).result?.username ?? "";
    return r;
  });
  if (ok) say(el, `Found your bot: @${botName}`, "ok");
});

// --- Step: what Momo can use ----------------------------------------------
$("where").addEventListener("change", () => {
  $("where-note").textContent = {
    web: "Momo uses websites in a browser of its own, so it doesn't touch yours.",
    local: "Momo can also use apps on this computer, like a person at the screen. It asks before sending or deleting anything. Only you can text it.",
    full: "Momo can use apps, read your files and run commands on this computer. It looks freely, and shows you every change (the exact command) and waits for your YES. Nothing it reads leaves the computer except to the AI you chose. Only you can text it.",
  }[$("where").value];
});

// --- Step: download ---------------------------------------------------------
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const b64text = (s) => btoa(unescape(encodeURIComponent(s)));
const guessOs = () => (/Win/.test(navigator.platform) ? "windows" : /Mac|iP/.test(navigator.platform) ? "mac" : "linux");
let os = guessOs();

const OS = {
  mac: { label: "Mac", file: "Install Momo.zip", how: "Open the file you just downloaded: it unpacks to Install Momo.command. Open that. If your Mac says it can't be opened, right-click it and choose Open; it's a plain script you can read." },
  windows: { label: "Windows", file: "Install Momo.cmd", how: "Open the file you just downloaded. If Windows says it protected your PC, choose More info, then Run anyway." },
  linux: { label: "Linux", file: "install-momo.sh", how: "Run the file you just downloaded in a terminal:  sh ~/Downloads/install-momo.sh" },
};

/** One file that carries the settings and runs the installer. */
function installerFor(which, envText) {
  const env64 = b64text(envText);
  if (which === "windows") {
    return `@echo off\r\ntitle Momo\r\necho Installing Momo. This takes a minute or two.\r\npowershell -NoProfile -ExecutionPolicy Bypass -Command "$env:MOMO_ENV_B64='${env64}'; irm ${origin}/install.ps1 | iex"\r\npause\r\n`;
  }
  return `#!/bin/sh\n# Installs Momo on this computer and starts it. Settings are below, encoded; nothing else is in this file.\nMOMO_ENV_B64='${env64}'\nexport MOMO_ENV_B64\ncurl -fsSL ${origin}/install.sh | sh\n${which === "mac" ? 'echo; echo "You can close this window."\n' : ""}`;
}

async function settings() {
  const st = $("get-status");
  const lines = [`# Momo settings, made at ${origin} on ${new Date().toISOString().slice(0, 10)}. Keep private: it holds keys.`];
  let relay = null;
  try {
    const r = await fetch("/api/devices", { method: "POST" });
    if (r.ok) relay = await r.json();
  } catch {}
  if (config.model) {
    if (!relay) throw new Error("This site isn't answering right now. Try again in a minute.");
    lines.push(`MOMO_MODEL=custom/${config.model.name}`, `MOMO_MODEL_BASE_URL=${origin}/api/model/v1`, `MOMO_MODEL_API_KEY=${relay.token}`);
  } else {
    const p = current();
    const key = $("key").value.trim();
    const model = modelName();
    if (p.keyEnv && !key) throw new Error("Paste your AI key first.");
    if (!model) throw new Error("Enter the model's name.");
    if (p.check) {
      const r = await p.check(key).catch(() => null);
      if (r && (r.status === 401 || r.status === 403)) throw new Error("That AI key was refused. Check you copied all of it.");
      const ids = r && r.ok ? await modelIds(r) : [];
      if (ids.length && !ids.includes(model)) throw new Error(`That key has no model called "${model}". Try one of: ${ids.slice(0, 6).join(", ")}`);
    }
    lines.push(`MOMO_MODEL=${p.id}/${model}`);
    if (p.keyEnv) lines.push(`${p.keyEnv}=${key}`);
  }
  if (config.bot) {
    if (!relay?.pair) throw new Error("This site isn't answering right now. Try again in a minute.");
    lines.push(`MOMO_PAIR_CODE=${relay.pair}`);
  } else {
    const bot = $("bot").value.trim();
    if (!BOT_TOKEN.test(bot)) throw new Error("Paste your Telegram bot token first.");
    lines.push(`TELEGRAM_BOT_TOKEN=${bot}`);
  }
  lines.push(`MOMO_MASTER_KEY=${b64(crypto.getRandomValues(new Uint8Array(32)))}`, "MOMO_SINGLE_OWNER=1");
  if ($("where").value !== "web") lines.push("MOMO_DESKTOP=local");
  if ($("where").value === "full") lines.push("MOMO_ACCESS=full");
  if ($("bland").value.trim()) lines.push(`BLAND_API_KEY=${$("bland").value.trim()}`);
  if (relay) lines.push(`MOMO_RELAY_URL=${origin}`, `MOMO_RELAY_TOKEN=${relay.token}`);
  else say(st, "Note: this site's relay didn't answer, so secure links will only open on this computer.");
  return { text: lines.join("\n") + "\n", relay };
}

// A zip that marks its one file executable. Browsers drop the execute bit on a
// plain download, so a Mac can't run a bare .command; it unpacks a zip correctly.
const CRC = new Uint32Array(256).map((_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function zipExecutable(name, text) {
  const data = new TextEncoder().encode(text);
  const fname = new TextEncoder().encode(name);
  let crc = 0xffffffff;
  for (const b of data) crc = CRC[(crc ^ b) & 0xff] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  const le = (n, bytes) => Array.from({ length: bytes }, (_, i) => (n >>> (8 * i)) & 0xff);
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const common = [...le(20, 2), ...le(0, 2), ...le(0, 2), ...le(dosTime, 2), ...le(dosDate, 2), ...le(crc, 4), ...le(data.length, 4), ...le(data.length, 4), ...le(fname.length, 2), ...le(0, 2)];
  const local = [...le(0x04034b50, 4), ...common, ...fname];
  const unixMode = 0o100755; // a regular file, executable
  const central = [...le(0x02014b50, 4), ...le(0x031e, 2), ...common, ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le((unixMode << 16) >>> 0, 4), ...le(0, 4), ...fname];
  const cdOffset = local.length + data.length;
  const end = [...le(0x06054b50, 4), ...le(0, 2), ...le(0, 2), ...le(1, 2), ...le(1, 2), ...le(central.length, 4), ...le(cdOffset, 4), ...le(0, 2)];
  return new Uint8Array([...local, ...data, ...central, ...end]);
}

function download(name, content) {
  const url = URL.createObjectURL(new Blob([content], { type: name.endsWith(".zip") ? "application/zip" : "text/plain" }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

$("download").addEventListener("click", async () => {
  await ready;
  const st = $("get-status");
  $("download").disabled = true;
  say(st, "Making your installer…");
  try {
    const { text, relay } = await settings();
    download(OS[os].file, os === "mac" ? zipExecutable("Install Momo.command", installerFor(os, text)) : installerFor(os, text));
    say(st, `Saved ${OS[os].file} to your Downloads.`, "ok");
    $("after").hidden = false;
    $("os-how").textContent = OS[os].how;
    const link = $("bot-link");
    if (config.bot) {
      link.textContent = `t.me/${config.bot}`;
      link.href = `https://t.me/${config.bot}?start=${relay.pair}`;
    } else {
      link.textContent = botName ? `t.me/${botName}` : "your bot";
      link.href = botName ? `https://t.me/${botName}` : "#";
    }
  } catch (e) {
    say(st, e.message, "bad");
  } finally {
    $("download").disabled = false;
  }
});

function pickOs(which) {
  os = which;
  for (const b of document.querySelectorAll("[data-os]")) b.setAttribute("aria-pressed", String(b.dataset.os === which));
  $("download").textContent = `Download Momo for ${OS[which].label}`;
}
for (const b of document.querySelectorAll("[data-os]")) b.addEventListener("click", () => pickOs(b.dataset.os));
pickOs(os);
