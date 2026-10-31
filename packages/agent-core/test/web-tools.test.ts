// The browsing tools real sites need: search with Enter, dropdowns,
// screenshots, scroll/back, and the rule that Enter can't submit an order
// form the owner hasn't approved. Also: old page views are trimmed so long
// errands stay fast.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { HeadlessBrowser, runErrand, type Block, type Planner, type Turn } from "../src/index.ts";

let server: Server;
let origin = "";
let orders = 0;
let browser: HeadlessBrowser;

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    res.writeHead(200, { "content-type": "text/html" });
    if (url.pathname === "/order") orders++;
    const body =
      url.pathname === "/results"
        ? `<title>Results</title><h1>Results for ${url.searchParams.get("q")}</h1>
           <form action="/order"><label>Size <select name="size"><option>Small</option><option>Large</option></select></label>
           <label>Note <input name="note"></label><label><input type="checkbox" name="gift" checked> Gift</label>
           <button>Place order</button></form><div style="height:3000px"></div><p>Bottom of page</p>`
        : `<title>Search</title><form action="/results"><label>Search <input name="q"></label><button>Search</button></form>`;
    // Real pages are long; pad so page views are realistic in size.
    res.end(`<!doctype html><html><body>${body}<p>${"Fresh oat milk, delivered. ".repeat(40)}</p></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = new HeadlessBrowser();
});
after(async () => {
  await browser.dispose();
  server.close();
});

test("web tools: Enter to search, dropdowns, screenshot, scroll, back; Enter can't place an unapproved order", { timeout: 60_000 }, async () => {
  const results: string[] = [];
  let images = 0;
  let lastHistory: Turn[] = [];
  let snap = "";
  const ref = (re: RegExp) => Number(/^\[(\d+)\]/.exec(snap.split("\n").find((l) => /^\[\d+\]/.test(l) && re.test(l))!)![1]);
  const plan: Array<() => [string, Record<string, unknown>]> = [
    () => ["goto", { url: `${origin}/` }],
    () => ["read_page", {}],
    () => ["type", { ref: ref(/Search/), text: "oat milk" }],
    () => ["press_key", { key: "Enter" }],
    () => ["read_page", {}],
    () => ["select_option", { ref: ref(/select/), option: "Large" }],
    () => ["type", { ref: ref(/Note/), text: "leave at door" }],
    () => ["press_key", { key: "Enter" }],
    () => ["screenshot", {}],
    () => ["scroll", { direction: "down" }],
    () => ["go_back", {}],
    () => ["read_page", {}],
    () => ["request_approval", { summary: "Order oat milk, Large, $5?", amount_usd: 5 }],
  ];
  let n = 0;
  const planner: Planner = {
    async next(_s, history) {
      lastHistory = history;
      const last = history.at(-1)!.content.find((b) => b.type === "tool_result") as { content: unknown } | undefined;
      if (last) {
        if (Array.isArray(last.content)) images++;
        const text = Array.isArray(last.content) ? (last.content[0] as { text: string }).text : String(last.content);
        results.push(text);
        if (text.startsWith("URL: ")) snap = text;
      }
      const [name, input] = plan[n]!();
      return [{ type: "tool_use", id: `w${n++}`, name, input } as Block];
    },
  };

  const r = await runErrand({ id: "tools", text: "order oat milk", expect: "commit", mustMention: ["Large"] }, planner, browser);
  assert.equal(r.outcome, "done", r.detail);

  const snapshotAt = results.find((t) => t.includes("Title: Results"))!;
  assert.match(snapshotAt, /select\(select-one\) Size \{Small\|Large\}/);
  assert.match(snapshotAt, /input\(checkbox\) Gift \(checked\)/);
  assert.match(results[3]!, /Pressed Enter\. Now at .*\/results\?q=oat\+milk/);
  assert.equal(results[5], 'Selected "Large".');
  assert.match(results[7]!, /^Refused: Enter would submit "Place order"\. Call request_approval first\./);
  assert.equal(orders, 0, "nothing ordered");
  assert.equal(images, 1);
  assert.match(results[10]!, /Back at http:\/\/127\.0\.0\.1:\d+\/$/);

  // Only the newest page views are kept in full.
  const pages = lastHistory.flatMap((t) => t.content).filter((b) => b.type === "tool_result").map((b) => (b as { content: unknown }).content);
  const full = pages.filter((c) => Array.isArray(c) || (typeof c === "string" && c.startsWith("URL: ") && c.length > 600));
  assert.equal(full.length, 2);
  assert.ok(pages.some((c) => typeof c === "string" && c.includes("older page view omitted")));
});
