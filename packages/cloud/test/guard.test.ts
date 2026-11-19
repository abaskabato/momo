// Momo's server on a person's own computer: only that computer, and not websites open in its browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { localOnly } from "../src/hosted/guard.ts";

test("the local server turns away other sites, other names for this computer, and anything but JSON", async () => {
  const app = new Hono();
  app.use("*", localOnly(8787));
  app.get("/s/:id", (c) => c.text("form page"));
  app.post("/v1/forms/:id", (c) => c.json({ ok: true }));
  const req = (path: string, init: RequestInit & { host?: string } = {}) =>
    app.request(`http://127.0.0.1:8787${path}`, { ...init, headers: { host: init.host ?? "127.0.0.1:8787", ...(init.headers as Record<string, string>) } });
  const json = { "content-type": "application/json" };

  assert.equal((await req("/s/abc")).status, 200);
  assert.equal((await req("/s/abc", { host: "localhost:8787" })).status, 200);
  assert.equal((await req("/v1/forms/abc", { method: "POST", headers: { ...json, origin: "http://127.0.0.1:8787" }, body: "{}" })).status, 200, "Momo's own page");
  assert.equal((await req("/v1/forms/abc", { method: "POST", headers: json, body: "{}" })).status, 200, "no Origin (not from a browser page)");

  assert.equal((await req("/s/abc", { host: "evil.example:8787" })).status, 403, "a name that resolves here (DNS rebinding)");
  assert.equal((await req("/v1/forms/abc", { method: "POST", headers: { ...json, origin: "https://evil.example" }, body: "{}" })).status, 403, "another site's script");
  assert.equal((await req("/v1/forms/abc", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415, "a form or script that skips the browser's check");
  assert.equal((await req("/v1/forms/abc", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=1" })).status, 415);
});
