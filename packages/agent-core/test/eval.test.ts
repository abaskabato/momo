// The real-site eval must score honestly: reaching "Reply YES" with the right
// terms is done (and is answered NO, so nothing commits); a login request is
// "needs account"; wrong terms are "wrong".

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { HeadlessBrowser, report, runErrand, startMockShop, type Block, type Planner } from "../src/index.ts";

let shop: Awaited<ReturnType<typeof startMockShop>>;
let browser: HeadlessBrowser;
before(async () => {
  shop = await startMockShop();
  browser = new HeadlessBrowser();
});
after(async () => {
  await browser.dispose();
  await shop.close();
});

function script(calls: Array<[string, Record<string, unknown>]>): Planner {
  let n = 0;
  return { next: async () => [{ type: "tool_use", id: `c${n}`, name: calls[n]![0], input: calls[n++]![1] } as Block] };
}

test("eval: approval reached = done (answered NO), login = needs account, wrong terms = wrong", { timeout: 60_000 }, async () => {
  const toApproval = (summary: string) =>
    script([["goto", { url: `${shop.origin}/zuni` }], ["read_page", {}], ["request_approval", { summary, amount_usd: 0 }], ["finish", { message: "x" }]]);
  const errand = { id: "zuni", text: "book Zuni for 2 at 8pm", expect: "commit" as const, mustMention: ["Zuni", "8pm"] };

  const ok = await runErrand(errand, toApproval("Call Zuni Cafe to book 2 at 8pm?"), browser);
  assert.equal(ok.outcome, "done");
  assert.deepEqual(ok.tools, ["goto", "read_page", "request_approval"]);

  assert.equal((await runErrand(errand, toApproval("Call Zuni Cafe to book 2 at 6pm?"), browser)).outcome, "wrong");

  const login = await runErrand(
    { id: "shop", text: "order oat milk", expect: "commit" },
    script([["goto", { url: `${shop.origin}/login` }], ["read_page", {}], ["sign_in", { user_ref: 1, pass_ref: 2, submit_ref: 3 }]]),
    browser,
  );
  assert.equal(login.outcome, "needs_account");
  assert.equal(shop.state.orders.length, 0);

  assert.match(report("test/model", [ok, login]), /\*\*Done: 1\/2 \(50%\)\*\*/);
});
