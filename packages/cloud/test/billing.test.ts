// Paying for the website's shared AI: a free week, then a monthly subscription through Stripe Checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore plain JS
import { createRelay, memoryStore } from "../../../apps/web/lib/relay.js";
import { createHash } from "node:crypto";
import { failureText } from "../../agent-core/src/assistant.ts";

const devId = (token: string) => createHash("sha256").update(token).digest("base64url");

test("the shared AI is free for a week, then Momo texts a link to pay; paying turns it back on", async () => {
  const store = memoryStore();
  const stripe: Array<{ path: string; body: string }> = [];
  let subStatus = "active";
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = input instanceof Request ? input.url : String(input);
    if (u.startsWith("https://model.test/")) return Response.json({ choices: [{ message: { role: "assistant", content: "hi" } }] });
    if (u.startsWith("https://api.stripe.com/v1/")) {
      const path = u.slice("https://api.stripe.com/v1/".length);
      stripe.push({ path, body: String(init?.body ?? "") });
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer sk_test_x");
      if (path === "checkout/sessions") return Response.json({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
      if (path === "checkout/sessions/cs_test_1") {
        const code = new URLSearchParams(stripe.find((s) => s.path === "checkout/sessions")!.body).get("client_reference_id");
        return Response.json({ id: "cs_test_1", client_reference_id: code, status: "complete", subscription: "sub_1" });
      }
      if (path === "subscriptions/sub_1") return Response.json({ id: "sub_1", status: subStatus });
    }
    return Response.json({ error: "unexpected " + u }, { status: 500 });
  };
  const env = { MOMO_MODEL: "openai/m", MOMO_MODEL_BASE_URL: "https://model.test/v1", OPENAI_API_KEY: "k", STRIPE_SECRET_KEY: "sk_test_x", MOMO_PUBLIC_URL: "https://textmomo.app" };
  const handle = createRelay(store, { env, fetch: fetchImpl });
  const call = (path: string, init: RequestInit = {}) => handle(new Request(`https://textmomo.app/api/${path}`, init));

  const cfg = await (await call("config")).json();
  assert.deepEqual(cfg.price, { cents: 1500, trialDays: 7 }, "the setup page is told the price");

  const { token } = await (await call("devices", { method: "POST" })).json();
  const ask = () => call("model/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
  assert.equal((await ask()).status, 200, "in the free week");

  // Eight days later.
  const dev = devId(token);
  assert.ok(await store.get(`devat:${dev}`), "the free week starts when Momo is set up");
  await store.set(`devat:${dev}`, String(Date.now() - 8 * 24 * 3600_000));
  const over = await ask();
  assert.equal(over.status, 402);
  const said = (await over.json()).message as string;
  assert.match(said, /^Your free week of Momo is over\. To keep it going, it's \$15 a month, cancel anytime: https:\/\/textmomo\.app\/api\/pay\/[\w-]+$/);
  assert.equal(failureText(new Error(said)), said, "Momo texts it to its owner as it is");

  // The link opens Stripe Checkout for a $15 monthly subscription.
  const link = new URL(said.split(": ").at(-1)!);
  const go = await handle(new Request(link));
  assert.equal(go.status, 303);
  assert.equal(go.headers.get("location"), "https://checkout.stripe.com/c/pay/cs_test_1");
  const form = new URLSearchParams(stripe[0]!.body);
  assert.equal(form.get("mode"), "subscription");
  assert.equal(form.get("line_items[0][price_data][unit_amount]"), "1500");
  assert.equal(form.get("line_items[0][price_data][recurring][interval]"), "month");
  assert.equal(form.get("success_url"), `${link.href}/done?s={CHECKOUT_SESSION_ID}`);

  // Back from Checkout: paid, and the AI works again.
  const done = await handle(new Request(`${link.href}/done?s=cs_test_1`));
  assert.equal(done.status, 200);
  assert.match(await done.text(), /all set/);
  assert.equal((await ask()).status, 200, "paid up");

  // A cancelled subscription stops it again once the twice-daily check runs.
  subStatus = "canceled";
  await store.del(`subok:${dev}`);
  assert.equal((await ask()).status, 402, "cancelled");

  // A wrong link pays for nothing.
  assert.equal((await call("pay/not-a-real-code-x")).status, 404);
});

test("without Stripe on the site, nothing is charged", async () => {
  const handle = createRelay(memoryStore(), { env: { MOMO_MODEL: "openai/m", MOMO_MODEL_BASE_URL: "https://model.test/v1", OPENAI_API_KEY: "k" }, fetch: async () => Response.json({ choices: [{ message: { role: "assistant", content: "hi" } }] }) });
  const cfg = await (await handle(new Request("https://x.test/api/config"))).json();
  assert.equal(cfg.price, undefined);
  assert.equal((await handle(new Request("https://x.test/api/pay/abcdefghijklmnop"))).status, 404);
});
