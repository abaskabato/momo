// Momo's website on Vercel (apps/web): the relay for secure links, and the
// files it shares with the device.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateDeviceKeys, openJson, WEB_SEAL_SOURCE } from "@momo/protocol";
import { createRelay, memoryStore } from "../../../apps/web/lib/relay.js";
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
});

test("in a real browser: the setup page makes momo.env, and a secure link seals on the 'phone'", { timeout: 60_000 }, async () => {
  const { chromium } = await import("playwright-core");
  const { startDev } = await import("../../../apps/web/dev.js");
  const store = memoryStore();
  const relay = createRelay(store);
  const server = await startDev(0, relay);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const cspErrors: string[] = [];
    page.on("console", (m) => /Content Security Policy/i.test(m.text()) && cspErrors.push(m.text()));
    // Keys are checked with the provider straight from the browser; stand in for Gemini and Telegram.
    await page.route("https://generativelanguage.googleapis.com/**", (r) => r.fulfill({ status: 200, body: "{}" }));
    await page.route("https://api.telegram.org/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, result: { username: "ana_momo_bot" } }) }));
    await page.goto(base);
    await page.fill("#key", "AIza-test-key");
    await page.click("#check-model");
    await page.getByText("The key works.").waitFor();
    await page.fill("#bot", "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    await page.click("#check-bot");
    await page.getByText("Found your bot: @ana_momo_bot").waitFor();
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
    assert.equal(download.suggestedFilename(), "momo.env");
    const env = parseEnvText(readFileSync((await download.path())!, "utf8"));
    assert.equal(env.MOMO_MODEL, "gemini/gemini-flash-latest");
    assert.equal(env.GEMINI_API_KEY, "AIza-test-key");
    assert.equal(env.MOMO_SINGLE_OWNER, "1");
    assert.equal(Buffer.from(env.MOMO_MASTER_KEY!, "base64").length, 32);
    assert.equal(env.MOMO_RELAY_URL, base);
    assert.ok(env.MOMO_RELAY_TOKEN);
    for (const v of store.dump()) assert.ok(!v.includes("AIza-test-key"), "keys never reach the site");
    assert.match(await page.textContent("#cmd") ?? "", /install\.(sh|ps1)/);
    assert.match(await page.textContent("#bot-link") ?? "", /t\.me\/ana_momo_bot/);

    // A secure link from that Momo opens on the phone and seals the card there.
    const keys = generateDeviceKeys();
    const id = "card-link-0123456789";
    await call(relay, "/api/forms", { method: "POST", token: env.MOMO_RELAY_TOKEN, body: JSON.stringify({ id, spec: { kind: "card", label: "" }, pk: keys.boxPublicKey }) });
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
    const got = (await (await call(relay, `/api/forms/${id}/result`, { token: env.MOMO_RELAY_TOKEN })).json()) as { sealed: string };
    const sub = openJson<{ formId: string; fields: Record<string, string> }>(keys, got.sealed);
    assert.equal(sub.formId, id);
    assert.equal(sub.fields.number, "4242 4242 4242 4242");

    assert.deepEqual(cspErrors, [], "the pages work under the site's strict CSP");
    const csp = (await fetch(`${base}/s/${id}`)).headers.get("content-security-policy") ?? "";
    assert.match(csp, /script-src 'self'/, "served with the vercel.json headers");
    await phone.reload();
    await phone.getByRole("heading", { name: "This link has expired" }).waitFor();
  } finally {
    await browser.close();
    server.close();
  }
});

function parseEnvText(t: string): Record<string, string> {
  return Object.fromEntries(t.split("\n").flatMap((l) => (/^([A-Z0-9_]+)=(.*)$/.exec(l) ? [[RegExp.$1, RegExp.$2]] : [])));
}
