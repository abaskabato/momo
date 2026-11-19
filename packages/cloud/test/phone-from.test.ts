// Calls from the owner's own number: a number in their Twilio account, imported into Bland.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BlandVoice } from "../src/hosted/phone.ts";

test("Bland calls from the owner's own number when BLAND_FROM is set, and from Bland's numbers when not", async () => {
  const sent: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (_u: string | URL, init?: RequestInit) => {
    sent.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return Response.json({ call_id: "c1" });
  }) as unknown as typeof fetch;
  await new BlandVoice("bk", fetchImpl, undefined, { number: "+1 (415) 555-0100", twilioKey: "enc_123" }).start({ to: "+14155550199", goal: "book" });
  assert.equal(sent[0]!.body.from, "+14155550100");
  assert.equal(sent[0]!.headers.get("encrypted_key"), "enc_123");
  await new BlandVoice("bk", fetchImpl).start({ to: "+14155550199", goal: "book" });
  assert.equal(sent[1]!.body.from, undefined);
  assert.equal(sent[1]!.headers.get("encrypted_key"), null);
});
