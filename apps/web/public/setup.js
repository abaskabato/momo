// The setup page. Everything happens in this browser: keys are checked
// directly with the company that issued them and written into a file you
// download. The only request to this site is for a relay token, which lets
// your Momo's secure links (for logins and cards) open on your phone.
const PROVIDERS = [
  { id: "gemini", label: "Google Gemini (free key available)", keyEnv: "GEMINI_API_KEY", model: "gemini-flash-latest", keyUrl: "https://aistudio.google.com/apikey",
    check: (k) => fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(k)}`) },
  { id: "anthropic", label: "Anthropic Claude", keyEnv: "ANTHROPIC_API_KEY", model: "claude-opus-5-5", keyUrl: "https://console.anthropic.com/settings/keys",
    check: (k) => fetch("https://api.anthropic.com/v1/models", { headers: { "x-api-key": k, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" } }) },
  { id: "openai", label: "OpenAI", keyEnv: "OPENAI_API_KEY", model: "", keyUrl: "https://platform.openai.com/api-keys",
    check: (k) => fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${k}` } }) },
  { id: "openrouter", label: "OpenRouter (hundreds of models)", keyEnv: "OPENROUTER_API_KEY", model: "", keyUrl: "https://openrouter.ai/keys",
    check: (k) => fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${k}` } }) },
  { id: "groq", label: "Groq", keyEnv: "GROQ_API_KEY", model: "", keyUrl: "https://console.groq.com/keys",
    check: (k) => fetch("https://api.groq.com/openai/v1/models", { headers: { authorization: `Bearer ${k}` } }) },
  { id: "ollama", label: "Ollama (a model on this computer, no key)", model: "" },
];

const $ = (id) => document.getElementById(id);
const say = (el, text, cls = "") => { el.textContent = text; el.className = `note ${cls}`; };
const origin = location.origin;

const provider = $("provider");
for (const p of PROVIDERS) provider.append(new Option(p.label, p.id));
const current = () => PROVIDERS.find((p) => p.id === provider.value);
function showProvider() {
  const p = current();
  $("key-row").hidden = !p.keyEnv;
  $("model").value = p.model;
  $("model").placeholder = p.model || "the model's name, e.g. from the provider's docs";
  $("key-help").textContent = "";
  if (p.keyUrl) {
    const a = Object.assign(document.createElement("a"), { href: p.keyUrl, target: "_blank", rel: "noopener", textContent: "Get a key here" });
    $("key-help").append(a, document.createTextNode(p.id === "gemini" ? ". The free tier allows about 20 errands' worth a day; turn on billing for real use." : "."));
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

$("check-model").addEventListener("click", async () => {
  const p = current();
  if (!p.check) return say($("model-status"), "Nothing to check for this one.");
  const key = $("key").value.trim();
  if (!key) return say($("model-status"), "Paste the key first.", "bad");
  if (await checked($("model-status"), () => p.check(key))) say($("model-status"), "The key works.", "ok");
});

$("check-bot").addEventListener("click", async () => {
  const t = $("bot").value.trim();
  if (!/^\d+:[\w-]{30,}$/.test(t)) return say($("bot-status"), "That doesn't look like a bot token (numbers, a colon, then letters).", "bad");
  const el = $("bot-status");
  let name = "";
  const ok = await checked(el, async () => {
    const r = await fetch(`https://api.telegram.org/bot${t}/getMe`);
    if (r.ok) name = (await r.json()).result?.username ?? "";
    return r;
  });
  if (ok) say(el, `Found your bot: @${name}`, "ok");
  if (name) $("bot-link").textContent = `t.me/${name}`;
});

$("where").addEventListener("change", () => {
  $("where-note").textContent = $("where").value === "local"
    ? "Momo can also use apps on this computer, like a person at the screen. It asks before sending or deleting anything. Only you can text it."
    : "Momo uses websites in a browser of its own, so it doesn't touch yours.";
});

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));

$("download").addEventListener("click", async () => {
  const p = current();
  const key = $("key").value.trim();
  const model = $("model").value.trim();
  const bot = $("bot").value.trim();
  const st = $("get-status");
  if (p.keyEnv && !key) return say(st, "Step 1: paste your AI key.", "bad");
  if (!model) return say(st, "Step 1: enter the model's name.", "bad");
  if (!/^\d+:[\w-]{30,}$/.test(bot)) return say(st, "Step 2: paste your bot token.", "bad");
  $("download").disabled = true;
  say(st, "Making your settings…");
  let relay = "";
  try {
    const r = await fetch("/api/devices", { method: "POST" });
    if (r.ok) relay = (await r.json()).token;
  } catch {}
  const lines = [
    `# Momo settings, made at ${origin} on ${new Date().toISOString().slice(0, 10)}.`,
    "# Keep this file private: it holds your keys.",
    `MOMO_MODEL=${p.id}/${model}`,
    ...(p.keyEnv ? [`${p.keyEnv}=${key}`] : []),
    `TELEGRAM_BOT_TOKEN=${bot}`,
    `MOMO_MASTER_KEY=${b64(crypto.getRandomValues(new Uint8Array(32)))}`,
    "# Only the first person to text the bot (you) can use this Momo.",
    "MOMO_SINGLE_OWNER=1",
    ...($("where").value === "local" ? ["MOMO_DESKTOP=local"] : []),
    ...(relay ? [`MOMO_RELAY_URL=${origin}`, `MOMO_RELAY_TOKEN=${relay}`] : []),
    "",
  ];
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/plain" }));
  Object.assign(document.createElement("a"), { href: url, download: "momo.env" }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  $("download").disabled = false;
  say(st, relay ? "Saved momo.env to your Downloads." : "Saved momo.env. (Secure links will only open on this computer: this site's relay didn't answer.)", relay ? "ok" : "");
  $("install").hidden = false;
  pickOs(guessOs());
});

const OS = {
  mac: { how: "Open Terminal (press ⌘ Space, type Terminal) and paste:", cmd: `curl -fsSL ${origin}/install.sh | sh` },
  linux: { how: "Open a terminal and paste:", cmd: `curl -fsSL ${origin}/install.sh | sh` },
  windows: { how: "Open PowerShell (Start menu, type PowerShell) and paste:", cmd: `irm ${origin}/install.ps1 | iex` },
};
const guessOs = () => (/Win/.test(navigator.platform) ? "windows" : /Mac|iP/.test(navigator.platform) ? "mac" : "linux");
function pickOs(os) {
  for (const b of document.querySelectorAll("[data-os]")) b.setAttribute("aria-pressed", String(b.dataset.os === os));
  $("os-how").textContent = OS[os].how;
  $("cmd").textContent = OS[os].cmd;
}
for (const b of document.querySelectorAll("[data-os]")) b.addEventListener("click", () => pickOs(b.dataset.os));
$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("cmd").textContent).catch(() => {});
  $("copy").textContent = "Copied";
  setTimeout(() => ($("copy").textContent = "Copy"), 1500);
});
