// Momo's website on Vercel (apps/web): the relay for secure links, and the
// files it shares with the device.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDeviceKeys, openJson, WEB_SEAL_SOURCE } from "@momo/protocol";
import { createRelay, memoryStore, MODEL_PROVIDERS } from "../../../apps/web/lib/relay.js";
import { PROVIDERS } from "@momo/agent-core";
import { WEB_FORM_JS_PATH, webFormJs } from "../src/webassets.ts";

const BASE = "https://momo-web.example";
const call = (relay: (r: Request) => Promise<Response>, path: string, init: RequestInit & { token?: string } = {}) =>
  relay(new Request(`${BASE}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) } }));

test("web: the committed form-copy.js matches the device's sealing code and wording", () => {
  assert.equal(readFileSync(WEB_FORM_JS_PATH, "utf8"), webFormJs(), "run: node packages/cloud/src/webassets.ts");
});

test("relay: device token, open a link, seal on the phone, collect once", async () => {
  const relay = createRelay(memoryStore());
  const { token } = (await (await call(relay, "/api/devices", { method: "POST" })).json()) as { token: string };
  const keys = generateDeviceKeys();
  const id = "f".repeat(22);
  const open = (t?: string) => call(relay, "/api/forms", { method: "POST", token: t, body: JSON.stringify({ id, spec: { kind: "card", label: "" }, pk: keys.boxPublicKey }) });
  assert.equal((await open()).status, 401, "needs a device token");
  assert.equal((await open("nope")).status, 401);
  assert.equal((await open(token)).status, 200);
  assert.equal((await open(token)).status, 409, "ids can't be taken over");

  const page = (await (await call(relay, `/api/forms/${id}`)).json()) as { spec: { kind: string }; pk: string };
  assert.deepEqual(page, { spec: { kind: "card", label: "" }, pk: keys.boxPublicKey });
  assert.deepEqual(await (await call(relay, `/api/forms/${id}/result`, { token })).json(), { pending: true });

  // Another device can't read this one's results.
  const other = ((await (await call(relay, "/api/devices", { method: "POST" })).json()) as { token: string }).token;
  assert.equal((await call(relay, `/api/forms/${id}/result`, { token: other })).status, 404);

  const momoSeal = new Function(`${WEB_SEAL_SOURCE}; return momoSeal;`)() as (k: string, p: string) => Promise<string>;
  const sealed = await momoSeal(page.pk, JSON.stringify({ formId: id, fields: { number: "4242424242424242" } }));
  assert.equal((await call(relay, `/api/forms/${id}`, { method: "POST", body: JSON.stringify({ sealed }) })).status, 200);
  assert.equal((await call(relay, `/api/forms/${id}`)).status, 410, "single use");
  assert.equal((await call(relay, `/api/forms/${id}/result`, { token: other })).status, 404);
  const got = (await (await call(relay, `/api/forms/${id}/result`, { token })).json()) as { sealed: string };
  assert.deepEqual(openJson(keys, got.sealed), { formId: id, fields: { number: "4242424242424242" } });
  assert.equal((await call(relay, `/api/forms/${id}/result`, { token })).status, 410, "collected once");
});

test("relay: a live view passes screenshots one way and taps the other, and ends on done", async () => {
  const relay = createRelay(memoryStore());
  const { token } = (await (await call(relay, "/api/devices", { method: "POST" })).json()) as { token: string };
  const id = "live-0123456789abcdef";
  assert.equal((await call(relay, "/api/live", { method: "POST", body: JSON.stringify({ id, reason: "Prove you're human." }) })).status, 401);
  assert.equal((await call(relay, "/api/live", { method: "POST", token, body: JSON.stringify({ id, reason: "Prove you're human." }) })).status, 200);
  assert.deepEqual(await (await call(relay, `/api/live/${id}`)).json(), { reason: "Prove you're human." });
  assert.equal((await call(relay, `/api/live/${id}/shot`)).status, 204, "no picture yet");
  const jpeg = Buffer.from("not really a jpeg but bytes").toString("base64");
  assert.equal((await call(relay, `/api/live/${id}/shot`, { method: "POST", body: JSON.stringify({ jpeg }) })).status, 401, "only the computer sends pictures");
  assert.equal((await call(relay, `/api/live/${id}/shot`, { method: "POST", token, body: JSON.stringify({ jpeg }) })).status, 200);
  const shot = await call(relay, `/api/live/${id}/shot`);
  assert.equal(shot.headers.get("content-type"), "image/jpeg");
  assert.equal(Buffer.from(await shot.arrayBuffer()).toString(), "not really a jpeg but bytes");
  assert.equal((await call(relay, `/api/live/${id}/act`, { method: "POST", body: JSON.stringify({ type: "tap", x: 2, y: 0 }) })).status, 400);
  assert.equal((await call(relay, `/api/live/${id}/act`, { method: "POST", body: JSON.stringify({ type: "tap", x: 0.5, y: 0.5 }) })).status, 200);
  assert.equal((await call(relay, `/api/live/${id}/act`, { method: "POST", body: JSON.stringify({ type: "type", text: "hello" }) })).status, 200);
  assert.equal((await call(relay, `/api/live/${id}/acts`)).status, 401);
  assert.deepEqual(await (await call(relay, `/api/live/${id}/acts`, { token })).json(), { acts: [{ type: "tap", x: 0.5, y: 0.5 }, { type: "type", text: "hello" }] });
  assert.deepEqual(await (await call(relay, `/api/live/${id}/acts`, { token })).json(), { acts: [] }, "each action is delivered once");
  assert.equal((await call(relay, `/api/live/${id}/act`, { method: "POST", body: JSON.stringify({ type: "done" }) })).status, 200);
  assert.equal((await call(relay, `/api/live/${id}`)).status, 410, "over for the phone");
  assert.deepEqual(await (await call(relay, `/api/live/${id}/acts`, { token })).json(), { acts: [{ type: "done" }] }, "the computer still gets the last actions");
  assert.equal((await call(relay, `/api/live/${id}/acts`, { token })).status, 410, "and then learns it's over");
  assert.equal((await call(relay, `/api/live/${id}/end`, { method: "POST", token })).status, 200);
});

test("relay: rejects bad input, rate-limits sign-ups, serves calendar files", async () => {
  const relay = createRelay(memoryStore(), { devicesPerHour: 2 });
  assert.equal((await call(relay, "/api/devices", { method: "POST" })).status, 200);
  const { token } = (await (await call(relay, "/api/devices", { method: "POST" })).json()) as { token: string };
  assert.equal((await call(relay, "/api/devices", { method: "POST" })).status, 429);
  const bad = (body: unknown) => call(relay, "/api/forms", { method: "POST", token, body: JSON.stringify(body) });
  assert.equal((await bad({ id: "short", spec: { kind: "card", label: "" }, pk: "x".repeat(43) })).status, 400);
  assert.equal((await bad({ id: "a".repeat(22), spec: { kind: "ssn", label: "" }, pk: "x".repeat(43) })).status, 400);
  assert.equal((await call(relay, `/api/forms/${"a".repeat(22)}`, { method: "POST", body: JSON.stringify({ sealed: "x".repeat(20_000) }) })).status, 400);
  assert.equal((await call(relay, "/api/forms/../devices")).status, 404);

  const ics = await relay(new Request(`${BASE}/api/relay?p=ics&t=Dinner%2C%20Nopa&s=2026-11-06T19:00&e=2026-11-06T21:00`));
  assert.equal(ics.status, 200);
  const text = await ics.text();
  assert.match(text, /DTSTART:20261106T190000/);
  assert.match(text, /SUMMARY:Dinner\\, Nopa/);
  assert.equal((await relay(new Request(`${BASE}/ics?s=bad`))).status, 400);
});

test("relay: on Vercel without storage it says what to add", async () => {
  const res = await createRelay(null)(new Request(`${BASE}/api/devices`, { method: "POST" }));
  assert.equal(res.status, 503);
  assert.match(((await res.json()) as { error: string }).error, /Upstash/);
  assert.equal((await createRelay(null)(new Request(`${BASE}/ics?t=x&s=2026-11-06T19:00&e=2026-11-06T21:00`))).status, 200, "calendar files need no storage");
});

test("web: the root of the repo deploys the same site as apps/web", () => {
  const root = JSON.parse(readFileSync(new URL("../../../vercel.json", import.meta.url), "utf8"));
  const web = JSON.parse(readFileSync(new URL("../../../apps/web/vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(root.rewrites, web.rewrites);
  assert.deepEqual(root.headers, web.headers);
  assert.equal(root.outputDirectory, "apps/web/public");
});

/** A stand-in for Telegram's Bot API: remembers what the bot sent, and the webhook it was given. */
function fakeTelegram() {
  const sent: Array<{ chat_id: string; text: string }> = [];
  const state = { webhook: "" as string, secret: "" as string };
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = u.split("/").pop();
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const reply = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
    if (method === "getMe") return reply({ id: 1, username: "momo_shared_bot" });
    if (method === "setWebhook") return (state.webhook = body.url), (state.secret = body.secret_token), reply(true);
    if (method === "sendMessage") return sent.push({ chat_id: String(body.chat_id), text: body.text }), reply({ message_id: sent.length });
    return new Response(JSON.stringify({ ok: false, description: `unexpected ${u}` }), { status: 404 });
  }) as typeof fetch;
  return { sent, state, fetch: f };
}

const OPERATOR_ENV = { MOMO_MODEL: "gemini/gemini-test", GEMINI_API_KEY: "operator-gemini-key", TELEGRAM_BOT_TOKEN: "777:SHAREDBOTTOKEN", MOMO_PUBLIC_URL: "https://momo-web.example" };

test("relay: the operator's shared bot and model: pairing, inbox, send, and model calls that never expose the key", async () => {
  const tg = fakeTelegram();
  const upstream: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("generativelanguage.googleapis.com")) {
      upstream.push({ url: u, auth: (init?.headers as Record<string, string>).authorization ?? null, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hello from the model" } }] }), { headers: { "content-type": "application/json" } });
    }
    return tg.fetch(url, init);
  }) as typeof fetch;
  const store = memoryStore();
  const relay = createRelay(store, { env: OPERATOR_ENV, fetch: f });

  // The setup page learns what's pre-filled; the relay points the bot's webhook at itself.
  assert.deepEqual(await (await call(relay, "/api/config")).json(), { model: { name: "gemini-test" }, bot: "momo_shared_bot" });
  assert.equal(tg.state.webhook, "https://momo-web.example/api/telegram");
  const { token, pair } = (await (await call(relay, "/api/devices", { method: "POST" })).json()) as { token: string; pair: string };
  assert.match(pair, /^[\w-]{10,}$/);

  // A stranger texts the shared bot: pointed at the site, nothing queued.
  const hook = (update: unknown, secret = tg.state.secret) =>
    relay(new Request(`${BASE}/api/telegram`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(update) }));
  assert.equal((await hook({ update_id: 1, message: { text: "hi", date: 1, chat: { id: 42, type: "private" } } }, "wrong")).status, 401);
  assert.equal((await hook({ update_id: 1, message: { text: "hi", date: 1, chat: { id: 42, type: "private" } } })).status, 200);
  assert.match(tg.sent.at(-1)!.text, /open https:\/\/momo-web\.example/);
  assert.deepEqual(await (await call(relay, "/api/inbox", { token })).json(), { messages: [] });
  assert.equal((await call(relay, "/api/send", { method: "POST", token, body: JSON.stringify({ text: "x" }) })).status, 409, "not paired yet");

  // The person taps t.me/<bot>?start=<pair>: the chat is theirs from then on.
  await hook({ update_id: 2, message: { text: `/start ${pair}`, date: 2, chat: { id: 42, type: "private" } } });
  await hook({ update_id: 3, message: { text: "book a table for two", date: 3, chat: { id: 42, type: "private" } } });
  const { messages } = (await (await call(relay, "/api/inbox", { token })).json()) as { messages: Array<{ from: string; text: string; id: string }> };
  assert.deepEqual(messages.map((m) => [m.from, m.text]), [["42", "hi"], ["42", "book a table for two"]]);
  assert.deepEqual(await (await call(relay, "/api/inbox", { token })).json(), { messages: [] }, "delivered once");
  assert.equal((await call(relay, "/api/inbox")).status, 401);

  // Replies go to that chat only.
  assert.equal((await call(relay, "/api/send", { method: "POST", token, body: JSON.stringify({ text: "On it." }) })).status, 200);
  assert.deepEqual(tg.sent.at(-1), { chat_id: "42", text: "On it." });

  // Model calls are forwarded with the operator's key and model; the device never sees either.
  const r = await call(relay, "/api/model/v1/chat/completions", { method: "POST", token, body: JSON.stringify({ model: "whatever-the-device-says", messages: [{ role: "user", content: "hi" }] }) });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content, "hello from the model");
  assert.equal(upstream[0]!.url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.equal(upstream[0]!.auth, "Bearer operator-gemini-key");
  assert.equal(upstream[0]!.body.model, "gemini-test");
  assert.equal((await call(relay, "/api/model/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [] }) })).status, 401);
  for (const v of store.dump()) assert.ok(!v.includes("operator-gemini-key") && !v.includes("SHAREDBOTTOKEN"), "secrets never land in storage");
});

test("relay: without an operator config, config says so and the shared routes are off", async () => {
  const relay = createRelay(memoryStore());
  assert.deepEqual(await (await call(relay, "/api/config")).json(), { model: null, bot: null });
  const { token, pair } = (await (await call(relay, "/api/devices", { method: "POST" })).json()) as { token: string; pair: string | null };
  assert.equal(pair, null);
  assert.equal((await call(relay, "/api/model/v1/chat/completions", { method: "POST", token, body: JSON.stringify({ messages: [] }) })).status, 404);
  assert.equal((await call(relay, "/api/send", { method: "POST", token, body: JSON.stringify({ text: "x" }) })).status, 404);
  assert.equal((await call(relay, "/api/telegram", { method: "POST", body: "{}" })).status, 404);
});

test("web: the relay's model table matches agent-core's", () => {
  for (const [id, p] of Object.entries(MODEL_PROVIDERS)) {
    if (id === "anthropic") continue; // native in agent-core; OpenAI-compatible through the relay
    assert.deepEqual(p, { baseUrl: PROVIDERS[id]!.baseUrl, keyEnv: PROVIDERS[id]!.keyEnv }, id);
  }
});

/** Pull the settings back out of a downloaded installer. */
function envFromInstaller(text: string): Record<string, string> {
  const b64 = /MOMO_ENV_B64='([^']+)'/.exec(text)?.[1];
  if (!b64) throw new Error(`no settings in installer:\n${text}`);
  return parseEnvText(Buffer.from(b64, "base64").toString("utf8"));
}

async function withSite(relay: (r: Request) => Promise<Response>, run: (base: string, browser: import("playwright-core").Browser) => Promise<void>) {
  const { chromium } = await import("playwright-core");
  const { startDev } = await import("../../../apps/web/dev.js");
  const server = await startDev(0, relay);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch();
  try {
    await run(base, browser);
  } finally {
    await browser.close();
    server.close();
  }
}

test("in a real browser, bare site: the page asks for a key and a bot, and makes one installer that carries them", { timeout: 60_000 }, async () => {
  const store = memoryStore();
  await withSite(createRelay(store), async (base, browser) => {
    const page = await browser.newPage();
    const cspErrors: string[] = [];
    page.on("console", (m) => /Content Security Policy/i.test(m.text()) && cspErrors.push(m.text()));
    // Keys are checked with the provider straight from the browser; stand in for Gemini and Telegram.
    await page.route("https://generativelanguage.googleapis.com/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: [{ name: "models/gemini-flash-latest" }, { name: "models/gemini-pro-latest" }] }) }));
    await page.route("https://api.telegram.org/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, result: { username: "ana_momo_bot" } }) }));
    await page.goto(base);
    await page.getByRole("heading", { name: /Momo is a personal assistant/ }).waitFor();
    // With nothing pre-filled, the two things to paste are right on the page, as numbered steps.
    await page.waitForSelector("#key", { state: "visible" });
    assert.ok(await page.isVisible("#bot"), "the bot step is on the page too");
    assert.ok(await page.isHidden("#where"), "the choices stay folded under Settings");
    // Downloading with nothing filled in says what is missing and puts the cursor there.
    await page.click("#download");
    await page.getByText("Paste your AI key first.").waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.id), "key");
    await page.fill("#key", "AIza-test-key");
    // A model name the key doesn't have is caught here, not after installing.
    assert.ok(await page.isHidden("#model"), "the model box is tucked away until someone wants it");
    await page.click("text=Use a different AI");
    await page.fill("#model", "gpt");
    await page.click("#check-model");
    await page.getByText('it has no model called "gpt". Try one of: gemini-flash-latest').waitFor();
    await page.click("#download");
    await page.getByText('That key has no model called "gpt"').waitFor();
    await page.fill("#model", "gemini-flash-latest");
    await page.click("#check-model");
    await page.getByText("The key works.").waitFor();
    // Pasting the token is enough: it is checked when the box is left.
    await page.fill("#bot", "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    await page.press("#bot", "Tab");
    await page.getByText("Found your bot: @ana_momo_bot").waitFor();
    await page.click("[data-os=mac]");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
    assert.equal(download.suggestedFilename(), "Install Momo.zip");
    // A Mac unpacks the zip and keeps the execute bit; a bare download would lose it.
    const dir = mkdtempSync(join(tmpdir(), "momo-zip-"));
    execFileSync("unzip", ["-q", (await download.path())!, "-d", dir]);
    const unpacked = join(dir, "Install Momo.command");
    assert.ok(statSync(unpacked).mode & 0o100, "unpacked installer is executable");
    const installer = readFileSync(unpacked, "utf8");
    assert.match(installer, /^#!\/bin\/sh\n/);
    assert.match(installer, new RegExp(`curl -fsSL ${base}/install.sh \\| sh`));
    const env = envFromInstaller(installer);
    assert.equal(env.MOMO_MODEL, "gemini/gemini-flash-latest");
    assert.equal(env.GEMINI_API_KEY, "AIza-test-key");
    assert.equal(env.TELEGRAM_BOT_TOKEN, "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    assert.equal(env.MOMO_SINGLE_OWNER, "1");
    assert.equal(Buffer.from(env.MOMO_MASTER_KEY!, "base64").length, 32);
    assert.equal(env.MOMO_RELAY_URL, base);
    assert.ok(env.MOMO_RELAY_TOKEN);
    for (const v of store.dump()) assert.ok(!v.includes("AIza-test-key") && !v.includes("123456:AAAA"), "keys never reach the site");
    assert.equal(await page.getAttribute("#bot-link", "href"), "https://t.me/ana_momo_bot");

    // A secure link from that Momo opens on the phone and seals the card there.
    const keys = generateDeviceKeys();
    const id = "card-link-0123456789";
    await call(createRelay(store), "/api/forms", { method: "POST", token: env.MOMO_RELAY_TOKEN, body: JSON.stringify({ id, spec: { kind: "card", label: "" }, pk: keys.boxPublicKey }) });
    const phone = await browser.newPage();
    phone.on("console", (m) => /Content Security Policy/i.test(m.text()) && cspErrors.push(m.text()));
    await phone.goto(`${base}/s/${id}`);
    await phone.getByRole("heading", { name: "Add your card" }).waitFor();
    await phone.fill("#name", "Ana Diaz");
    await phone.fill("#number", "4242 4242 4242 4242");
    await phone.fill("#exp", "12/29");
    await phone.fill("#cvc", "123");
    await phone.click("button[type=submit]");
    await phone.getByText("Saved. You can close this page").waitFor();
    for (const v of store.dump()) assert.ok(!v.includes("4242 4242"), "the relay holds only ciphertext");
    const got = (await (await call(createRelay(store), `/api/forms/${id}/result`, { token: env.MOMO_RELAY_TOKEN })).json()) as { sealed: string };
    const sub = openJson<{ formId: string; fields: Record<string, string> }>(keys, got.sealed);
    assert.equal(sub.fields.number, "4242 4242 4242 4242");
    assert.deepEqual(cspErrors, [], "the pages work under the site's strict CSP");
    const csp = (await fetch(`${base}/s/${id}`)).headers.get("content-security-policy") ?? "";
    assert.match(csp, /script-src 'self'/, "served with the vercel.json headers");
    await phone.reload();
    await phone.getByRole("heading", { name: "This link has expired" }).waitFor();
  });
});

test("in a real browser, operator-configured site: no key, no bot; download, open, tap a link", { timeout: 60_000 }, async () => {
  const tg = fakeTelegram();
  const store = memoryStore();
  await withSite(createRelay(store, { env: OPERATOR_ENV, fetch: tg.fetch }), async (base, browser) => {
    const page = await browser.newPage();
    await page.goto(base);
    await page.getByText("Two minutes: open the file").waitFor();
    assert.ok(await page.isHidden("#s-model"), "no AI step");
    assert.ok(await page.isHidden("#s-bot"), "no bot step");
    assert.ok(await page.isHidden("#where"), "choices are folded away under Settings");
    await page.click("#settings > summary");
    await page.click("[data-os=windows]");
    assert.equal(await page.textContent("#download"), "Download Momo for Windows");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
    assert.equal(download.suggestedFilename(), "Install Momo.cmd");
    const installer = readFileSync((await download.path())!, "utf8");
    assert.match(installer, /irm .*\/install\.ps1 \| iex/);
    const env = envFromInstaller(installer);
    assert.equal(env.MOMO_MODEL, "custom/gemini-test");
    assert.equal(env.MOMO_AWAKE, undefined, "the computer is kept awake unless the person says otherwise");
    assert.equal(env.MOMO_MAINTENANCE, undefined, "with the usual nightly rest");
    assert.match(await page.textContent("#awake-note") ?? "", /wakes itself at 5/);
    // Someone who wants it awake around the clock (their own visit: each download pairs afresh).
    const other = await browser.newPage();
    await other.goto(base);
    await other.getByText("Two minutes: open the file").waitFor();
    await other.click("#settings > summary");
    await other.selectOption("#awake", "always");
    const [again] = await Promise.all([other.waitForEvent("download"), other.click("#download")]);
    assert.equal(envFromInstaller(readFileSync((await again.path())!, "utf8")).MOMO_MAINTENANCE, "off");
    await other.close();
    assert.equal(env.MOMO_MODEL_BASE_URL, `${base}/api/model/v1`);
    assert.equal(env.MOMO_MODEL_API_KEY, env.MOMO_RELAY_TOKEN);
    assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(env.GEMINI_API_KEY, undefined, "the operator's key is not in the download");
    assert.match(env.MOMO_PAIR_CODE!, /^[\w-]{10,}$/);
    assert.equal(await page.getAttribute("#bot-link", "href"), `https://t.me/momo_shared_bot?start=${env.MOMO_PAIR_CODE}`);
  });
});

function parseEnvText(t: string): Record<string, string> {
  return Object.fromEntries(t.split("\n").flatMap((l) => (/^([A-Z0-9_]+)=(.*)$/.exec(l) ? [[RegExp.$1, RegExp.$2]] : [])));
}

test("relay: a shared iMessage line: text the code to pair, texts reach that person's Momo, answers go back by iMessage; one owner across Telegram and iMessage", async () => {
  const tg = fakeTelegram();
  const line: Array<{ url: string; keyId: string | undefined; body: Record<string, unknown> }> = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://api.sendblue.com/")) {
      line.push({ url: u, keyId: (init?.headers as Record<string, string>)["sb-api-key-id"], body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ status: "QUEUED" }), { headers: { "content-type": "application/json" } });
    }
    return tg.fetch(url, init);
  }) as typeof fetch;
  const store = memoryStore();
  const env = { ...OPERATOR_ENV, SENDBLUE_API_KEY_ID: "sb-id", SENDBLUE_API_SECRET_KEY: "sb-SECRETKEY", SENDBLUE_NUMBER: "+15122164639" };
  const relay = createRelay(store, { env, fetch: f });

  // The setup page learns the line's number; the relay points the line's webhook at itself, once.
  assert.deepEqual(await (await call(relay, "/api/config")).json(), { model: { name: "gemini-test" }, bot: "momo_shared_bot", imessage: "+15122164639" });
  await call(relay, "/api/config");
  const hooks = line.filter((c) => c.url.endsWith("/api/account/webhooks"));
  assert.equal(hooks.length, 1);
  const hookUrl = (hooks[0]!.body.webhooks as string[])[0]!;
  assert.match(hookUrl, /^https:\/\/momo-web\.example\/api\/imessage\/[\w-]{40}$/);
  assert.equal(hooks[0]!.keyId, "sb-id");
  const { token, pair } = (await (await call(relay, "/api/devices", { method: "POST" })).json()) as { token: string; pair: string };

  const text = (content: string, from = "+13605550142", extra: Record<string, unknown> = {}, path = new URL(hookUrl).pathname) =>
    relay(new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, from_number: from, to_number: "+15122164639", is_outbound: false, status: "RECEIVED", group_id: "", message_handle: `h-${Math.random()}`, date_sent: "2026-11-15T20:00:00Z", service: "iMessage", ...extra }) }));
  const inbox = async () => ((await (await call(relay, "/api/inbox", { token })).json()) as { messages: Array<{ from: string; text: string }> }).messages.map((m) => [m.from, m.text]);

  // Only the line's own webhook address works.
  assert.equal((await text("hi", "+13605550142", {}, "/api/imessage/wrong")).status, 404);
  // A stranger is pointed at the site; nothing is queued.
  await text("hi", "+19998887777");
  assert.deepEqual(line.at(-1)!.body, { number: "+19998887777", content: "This is Momo. To get your own, open https://momo-web.example and follow the steps; it takes a few minutes.", from_number: "+15122164639" });
  assert.deepEqual(await inbox(), []);

  // The person texts the code from the setup page: that sender is theirs from then on. An Apple ID email works as a sender too.
  await text(pair);
  await text("book a table for two", "+13605550142", { message_handle: "dup" });
  await text("book a table for two", "+13605550142", { message_handle: "dup" }); // the line retried
  await text("our own echo", "+13605550142", { is_outbound: true });
  await text("from a group", "+13605550142", { group_id: "g1" });
  assert.deepEqual(await inbox(), [["im:+13605550142", "hi"], ["im:+13605550142", "book a table for two"]]);

  // The answer goes back over iMessage, from the line.
  const before = line.length;
  assert.equal((await call(relay, "/api/send", { method: "POST", token, body: JSON.stringify({ text: "On it." }) })).status, 200);
  assert.equal(line.length, before + 1);
  assert.equal(line.at(-1)!.url, "https://api.sendblue.com/api/send-message");
  assert.deepEqual(line.at(-1)!.body, { number: "+13605550142", content: "On it.", from_number: "+15122164639" });

  // The same person also taps the Telegram link: their Momo sees one owner, and answers wherever they last texted.
  const hook = (update: unknown) => relay(new Request(`${BASE}/api/telegram`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": tg.state.secret }, body: JSON.stringify(update) }));
  await hook({ update_id: 2, message: { text: `/start ${pair}`, date: 2, chat: { id: 42, type: "private" } } });
  assert.deepEqual(await inbox(), [["im:+13605550142", "hi"]]);
  await call(relay, "/api/send", { method: "POST", token, body: JSON.stringify({ text: "Hello on Telegram." }) });
  assert.deepEqual(tg.sent.at(-1), { chat_id: "42", text: "Hello on Telegram." });
  await text("and back on iMessage");
  await call(relay, "/api/send", { method: "POST", token, body: JSON.stringify({ text: "Back here." }) });
  assert.equal(line.at(-1)!.body.content, "Back here.");
  for (const v of store.dump()) assert.ok(!v.includes("sb-SECRETKEY"), "the line's key never lands in storage");
});

test("iMessage for free: a Mac passes texts from Messages to the relay and sends the answers; old conversations are left alone", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { IMessageGateway, decodeAttributedBody, canBeGateway } = await import("../src/imessage-gateway.ts");
  const dir = mkdtempSync(join(tmpdir(), "momo-imsg-"));
  const dbPath = join(dir, "chat.db");
  // Messages' own database, as far as the gateway reads it.
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
           CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER, is_from_me INTEGER DEFAULT 0, cache_roomnames TEXT, associated_message_type INTEGER DEFAULT 0);
           INSERT INTO handle VALUES (1, '+13605550142'), (2, 'ana@icloud.com');
           INSERT INTO message (guid, text, handle_id) VALUES ('old-1', 'an old chat from last year', 1);`);
  const put = db.prepare("INSERT INTO message (guid, text, attributedBody, handle_id, is_from_me, cache_roomnames, associated_message_type) VALUES (?, ?, ?, ?, ?, ?, ?)");
  // How newer macOS stores the words: inside an archived attributed string, with `text` empty.
  const archived = (words: string) => {
    const w = Buffer.from(words, "utf8");
    const len = w.length < 0x80 ? Buffer.from([w.length]) : Buffer.from([0x81, w.length & 0xff, w.length >> 8]);
    return Buffer.concat([Buffer.from("\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+", "latin1"), len, w, Buffer.from("\x86\x84\x02iI\x01", "latin1")]);
  };
  assert.equal(decodeAttributedBody(archived("book a table for two")), "book a table for two");
  const long = "é".repeat(100) + " and more";
  assert.equal(decodeAttributedBody(archived(long)), long);
  assert.equal(decodeAttributedBody(Buffer.from("nothing here")), "");
  assert.match(canBeGateway("win32")!, /only runs on a Mac/);
  assert.equal(canBeGateway("darwin", dbPath), undefined);

  const store = memoryStore();
  const env = { MOMO_PUBLIC_URL: "https://momo-web.example", MOMO_GATEWAY_TOKEN: "gw-SECRET-token", MOMO_IMESSAGE_ADDRESS: "momo@icloud.com" };
  const relay = createRelay(store, { env });
  assert.deepEqual(await (await call(relay, "/api/config")).json(), { model: null, bot: null, imessage: "momo@icloud.com" });
  const { token, pair } = (await (await call(relay, "/api/devices", { method: "POST" })).json()) as { token: string; pair: string };
  assert.equal((await relay(new Request(`${BASE}/api/gateway/outbox`, { headers: { authorization: "Bearer wrong" } }))).status, 401);

  const sentFromMac: Array<[string, string]> = [];
  const gw = new IMessageGateway({
    relayUrl: BASE, token: "gw-SECRET-token", dbPath, statePath: join(dir, "state.json"),
    fetch: ((u: string | URL | Request, init?: RequestInit) => relay(new Request(String(u), init))) as typeof fetch,
    send: async (to, text) => void sentFromMac.push([to, text]),
  });
  const inbox = async () => ((await (await call(relay, "/api/inbox", { token })).json()) as { messages: Array<{ from: string; text: string }> }).messages.map((m) => [m.from, m.text]);

  // First round: nothing from before the gateway started is anybody's errand.
  assert.deepEqual(await gw.tick(), { in: 0, out: 0 });

  // A stranger texts the Mac: told where to get their own. The owner texts the code, then an errand.
  put.run("m-1", "hello?", null, 2, 0, null, 0);
  assert.deepEqual(await gw.tick(), { in: 1, out: 1 });
  assert.deepEqual(sentFromMac.at(-1), ["ana@icloud.com", "This is Momo. To get your own, open https://momo-web.example and follow the steps; it takes a few minutes."]);
  put.run("m-2", pair, null, 1, 0, null, 0);
  put.run("m-3", null, archived("book a table for two"), 1, 0, null, 0);
  put.run("m-4", "what Momo itself sent", null, 1, 1, null, 0);
  put.run("m-5", "a group chat", null, 1, 0, "chat123", 0);
  put.run("m-6", "Loved “book a table for two”", null, 1, 0, null, 2000);
  assert.deepEqual(await gw.tick(), { in: 2, out: 0 });
  assert.deepEqual(await inbox(), [["im:+13605550142", "hi"], ["im:+13605550142", "book a table for two"]]);

  // Their Momo answers; the Mac sends it from Messages. After a restart nothing is passed on twice.
  assert.equal((await call(relay, "/api/send", { method: "POST", token, body: JSON.stringify({ text: "On it." }) })).status, 200);
  const again = new IMessageGateway({ relayUrl: BASE, token: "gw-SECRET-token", dbPath, statePath: join(dir, "state.json"), fetch: ((u: string | URL | Request, init?: RequestInit) => relay(new Request(String(u), init))) as typeof fetch, send: async (to, text) => void sentFromMac.push([to, text]) });
  assert.deepEqual(await again.tick(), { in: 0, out: 1 });
  assert.deepEqual(sentFromMac.at(-1), ["+13605550142", "On it."]);
  assert.deepEqual(await inbox(), []);
  for (const v of store.dump()) assert.ok(!v.includes("gw-SECRET-token"));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("relay: phone calls on the operator's key: a person's Momo places a call and hears how it went, without ever holding the key", async () => {
  const { BlandVoice } = await import("../src/hosted/phone.ts");
  const placed: Array<{ auth: string | null; body: Record<string, unknown> }> = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
    if (u === "https://api.bland.ai/v1/calls") {
      placed.push({ auth, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ status: "success", call_id: "call-0001-abcd" }), { headers: { "content-type": "application/json" } });
    }
    if (u === "https://api.bland.ai/v1/calls/call-0001-abcd") {
      assert.equal(auth, "bland-OPERATOR-key");
      return new Response(JSON.stringify({ completed: true, status: "completed", answered_by: "human", summary: "Booked for 2 at 8pm under Ana.", concatenated_transcript: "...", price: 0.42, from: "+15550001111" }), { headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const store = memoryStore();
  const relay = createRelay(store, { env: { BLAND_API_KEY: "bland-OPERATOR-key", MOMO_PUBLIC_URL: BASE }, fetch: f, phoneCallsPerDay: 2 });
  assert.deepEqual(await (await call(relay, "/api/config")).json(), { model: null, bot: null, calls: true });
  const { token } = (await (await call(relay, "/api/devices", { method: "POST" })).json()) as { token: string };
  const other = (await (await call(relay, "/api/devices", { method: "POST" })).json()) as { token: string };

  // Their Momo calls through the site exactly as it would call the provider.
  const viaSite = (t: string) => new BlandVoice(`Bearer ${t}`, ((u: string | URL | Request, init?: RequestInit) => relay(new Request(String(u), init))) as typeof fetch, `${BASE}/api`);
  const voice = viaSite(token);
  const id = await voice.start({ to: "+1 (415) 555-0199", goal: "Book a table for 2 on Saturday at 8pm under Ana." });
  assert.equal(id, "call-0001-abcd");
  assert.equal(placed[0]!.auth, "bland-OPERATOR-key");
  assert.equal(placed[0]!.body.phone_number, "+14155550199");
  assert.equal(placed[0]!.body.max_duration, 10, "the length is set by the site, not the caller");
  assert.match(String(placed[0]!.body.task), /Goal: Book a table for 2/);
  const outcome = (await voice.check!(id as string)) as Record<string, unknown>;
  assert.match(voice.outcome(outcome), /Phone call ended \(completed, answered by human\)\.\nSummary: Booked for 2 at 8pm under Ana\./);
  assert.equal(outcome.price, undefined, "only what Momo reads is passed on");

  // Nobody else can ask about that call; no token, no call; and there is a daily cap.
  await assert.rejects(viaSite(other.token).check!(id as string), /couldn't check the call \(404\)/);
  assert.equal((await call(relay, "/api/calls", { method: "POST", body: JSON.stringify({ phone_number: "+14155550199", task: "x" }) })).status, 401);
  await voice.start({ to: "+14155550199", goal: "again" });
  await assert.rejects(voice.start({ to: "+14155550199", goal: "a third today" }), /429: too many calls today/);
  for (const v of store.dump()) assert.ok(!v.includes("bland-OPERATOR-key"));
  assert.equal((await call(createRelay(memoryStore()), "/api/calls", { method: "POST", token: "x", body: "{}" })).status, 401);
});
