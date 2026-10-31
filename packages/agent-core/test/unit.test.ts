import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalError,
  ApprovalGate,
  FileKeyProvider,
  JsonFile,
  LocalVault,
  VaultOriginError,
  minimize,
  parseReservation,
  redact,
  rehydrateDeep,
  type Approval,
} from "../src/index.ts";

const MONDAY = new Date(2026, 10, 2); // Mon Nov 2 2026
const tmp = () => mkdtemp(join(tmpdir(), "momo-"));

test("parses common reservation phrasings", () => {
  const a = parseReservation("Book a table for 4 at Nopa this Friday at 7pm", MONDAY);
  assert.deepEqual(a, { restaurant: "Nopa", date: "2026-11-06", time: "19:00", party: 4, flexible: false });

  const b = parseReservation("can you get us a reservation at State Bird Provisions tomorrow around 7:30 for two", MONDAY);
  assert.equal(b.restaurant, "State Bird Provisions");
  assert.equal(b.date, "2026-11-03");
  assert.equal(b.time, "19:30");
  assert.equal(b.party, 2);
  assert.equal(b.flexible, true);

  const c = parseReservation("dinner at Zuni tonight, party of 6", MONDAY);
  assert.equal(c.restaurant, "Zuni");
  assert.equal(c.date, "2026-11-02");
  assert.equal(c.party, 6);

  const d = parseReservation("book Lazy Bear nov 20 8pm 3 people", MONDAY);
  assert.deepEqual([d.restaurant, d.date, d.time, d.party], ["Lazy Bear", "2026-11-20", "20:00", 3]);

  assert.equal(parseReservation("table at Nopa", MONDAY).time, undefined);
});

async function gate() {
  let now = 1_000_000;
  const g = new ApprovalGate(new JsonFile<Approval[]>(join(await tmp(), "a.json"), () => []), () => now);
  return { g, advance: (ms: number) => (now += ms) };
}
const owner = { fromOwner: true, directChannel: true };
const req = (taskId: string, args: Record<string, unknown> = { slot: "19:00" }) =>
  ({ taskId, action: "restaurant.book", args, risk: "purchase" as const, summary: "Book Nopa?", amountUsd: 100 });

test("approvals: bare yes works only with one pending; tokens disambiguate", async () => {
  const { g } = await gate();
  const a1 = await g.request(req("t1"));
  const a2 = await g.request(req("t2"));
  assert.equal((await g.resolveReply("yes", owner)).kind, "ambiguous");
  assert.equal((await g.resolveReply("sounds fun", owner)).kind, "none");
  const v = await g.resolveReply(`yes ${a2.token}`, owner);
  assert.equal(v.kind, "approved");
  assert.equal((await g.resolveReply("Yes!", owner)).kind, "approved"); // now only a1 pending
  assert.ok(a1.token !== a2.token);
});

test("approvals: non-owner and group replies never approve", async () => {
  const { g } = await gate();
  await g.request(req("t1"));
  assert.equal((await g.resolveReply("yes", { fromOwner: false, directChannel: true })).kind, "ambiguous");
  assert.equal((await g.resolveReply("yes", { fromOwner: true, directChannel: false })).kind, "ambiguous");
  assert.equal((await g.pending()).length, 1);
});

test("approvals: bound to exact args, amount, single use, and expiry", async () => {
  const { g, advance } = await gate();
  await g.request(req("t1"));
  await g.resolveReply("yes", owner);
  await assert.rejects(g.consume("t1", "restaurant.book", { slot: "20:00" }, 100), ApprovalError);
  await assert.rejects(g.consume("t1", "restaurant.book", { slot: "19:00" }, 150), /total changed/);
  await g.consume("t1", "restaurant.book", { slot: "19:00" }, 102);
  await assert.rejects(g.consume("t1", "restaurant.book", { slot: "19:00" }, 100), ApprovalError);

  await g.request(req("t2"));
  advance(16 * 60_000);
  assert.equal((await g.resolveReply("yes", owner)).kind, "none");
});

test("vault: encrypted at rest, hints only, origin-bound", async () => {
  const dir = await tmp();
  const vault = new LocalVault(new JsonFile(join(dir, "vault.json"), () => ({ version: 1 as const, items: [] })), new FileKeyProvider(join(dir, "vault.key")));
  const item = await vault.put("login", "TableNow", { identifier: "ana@example.com", password: "s3cret-pass" }, "https://tablenow.test/login");
  const raw = await readFile(join(dir, "vault.json"), "utf8");
  assert.ok(!raw.includes("s3cret-pass") && !raw.includes("ana@example.com"));
  assert.deepEqual(await vault.list(), [{ handle: item.handle, kind: "login", label: "TableNow", hint: "a•••@example.com", origin: "https://tablenow.test" }]);
  const pw = await vault.use(item.handle, "https://tablenow.test/r/x", async (s) => (s as { password: string }).password);
  assert.equal(pw, "s3cret-pass");
  await assert.rejects(vault.use(item.handle, "https://evil.test/login", async () => 1), VaultOriginError);

  // A fresh instance with the same key reads it back.
  const again = new LocalVault(new JsonFile(join(dir, "vault.json"), () => ({ version: 1 as const, items: [] })), new FileKeyProvider(join(dir, "vault.key")));
  assert.equal((await again.list()).length, 1);
});

test("privacy: redaction hides identifiers and rehydrates answers", () => {
  const r = redact("I'm Ana Lopez (ana@x.com, 415-555-0134), live at 12 Valencia St. Card 4242 4242 4242 4242. Ana likes Nopa.", [
    { value: "Ana Lopez", kind: "PERSON" },
    { value: "Ana", kind: "PERSON" },
  ]);
  for (const s of ["Ana", "ana@x.com", "415-555-0134", "12 Valencia St", "4242"]) assert.ok(!r.text.includes(s), s);
  assert.ok(r.text.includes("Nopa"), "non-identifying context is kept so answers stay useful");
  const back = rehydrateDeep({ tip: "Text [PERSON_1] at [PHONE_1]" }, r.map) as { tip: string };
  assert.equal(back.tip, "Text Ana Lopez at 415-555-0134");
});

test("privacy: a slow or leaky local rewrite never blocks or leaks", async () => {
  const entities = [{ value: "Ana", kind: "PERSON" as const }];
  const slow = await minimize("Ana wants dinner", { entities, rewriteBudgetMs: 20, rewrite: () => new Promise((r) => setTimeout(() => r("x"), 500)) });
  assert.equal(slow.rewritten, false);
  assert.equal(slow.text, "[PERSON_1] wants dinner");
  const leaky = await minimize("Ana wants dinner", { entities, rewrite: async () => "Ana would like dinner" });
  assert.equal(leaky.rewritten, false);
  const good = await minimize("Ana wants dinner", { entities, rewrite: async () => "[PERSON_1] would like a dinner suggestion" });
  assert.equal(good.rewritten, true);
});

test("model specs: any provider/model", async () => {
  const { parseModelSpec } = await import("../src/index.ts");
  assert.equal(parseModelSpec("ollama/qwen3:8b", {}).baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(parseModelSpec("gemini/gemini-3-pro", { GEMINI_API_KEY: "g" }).apiKey, "g");
  assert.equal(parseModelSpec("openrouter/meta/llama-5", {}).model, "meta/llama-5");
  assert.deepEqual(parseModelSpec("anthropic/claude-opus-5-5", {}), { provider: "anthropic", model: "claude-opus-5-5" });
  assert.equal(parseModelSpec("custom/my-model", { MOMO_MODEL_BASE_URL: "http://gpu:8000/v1" }).baseUrl, "http://gpu:8000/v1");
  assert.throws(() => parseModelSpec("nope", {}));
  assert.throws(() => parseModelSpec("acme/x", {}), /unknown provider/);
});

test("email codes and links are found in real-looking emails", async () => {
  const { guessCode, extractLinks } = await import("../src/inbox.ts");
  assert.equal(guessCode({ subject: "Your code", text: "Order #48213 total $18. Your verification code is 731942." }), "731942");
  assert.equal(guessCode({ subject: "Sign in to Acme", text: "Use 4821 to sign in." }), "4821");
  assert.equal(guessCode({ subject: "(#123456789) Gmail Forwarding Confirmation", text: "Confirmation code: 123456789" }), "123456789");
  assert.equal(guessCode({ subject: "Welcome", text: "Thanks for joining." }), undefined);
  assert.deepEqual(extractLinks('<a href="https://x.com/v?a=1&amp;b=2">go</a> https://x.com/logo.png and https://y.com/ok.'), ["https://x.com/v?a=1&b=2", "https://y.com/ok"]);
});
