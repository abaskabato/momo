// momo CLI: the owner's local controls.
//   momo pair <cloud-url> [--push <url>]   register this device, print a pair code
//   momo run                               start the check-in loop
//   momo vault add-login <origin>          save a login (typed here, never sent anywhere)
//   momo vault add-card <label>            save a card
//   momo vault add-address                 save a delivery address
//   momo vault list                        show what's saved (hints only)
//   momo vault rm <handle>
//   momo receipts                          what was sent to remote models
//   momo demo                              try the whole flow locally against a mock site

import { createInterface } from "node:readline/promises";
import { mkdtemp } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { randomInt } from "node:crypto";
import { CloudClient } from "@momo/protocol";
import { HeadlessBrowser } from "./browser.ts";
import { ImsgOutbound, MultiOutbound, RecordingOutbound, TelegramOutbound, type Outbound } from "./channels.ts";
import { CheckinWorker } from "./checkin.ts";
import type { PrivacyReceipt } from "./privacy.ts";
import { createLocalAgent, loadOrCreateDeviceKeys } from "./runtime.ts";
import { RestaurantSkill } from "./skills/restaurant/skill.ts";
import { TableNowProvider } from "./skills/restaurant/tablenow.ts";
import { startMockSite } from "./skills/restaurant/mock-site.ts";
import { JsonFile } from "./store.ts";

const STATE = process.env.MOMO_HOME ?? join(homedir(), ".momo");
const config = new JsonFile<{ cloudUrl?: string; deviceId?: string; owner?: string[]; tablenowOrigin?: string }>(join(STATE, "config.json"), () => ({}));

async function ask(q: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    // Mute echo for secrets.
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    out._writeToOutput = (s: string) => out.output.write(s.includes(q) ? s : "");
  }
  const a = await rl.question(q);
  rl.close();
  if (hidden) process.stdout.write("\n");
  return a.trim();
}

function outbound(): Outbound {
  const routes: ConstructorParameters<typeof MultiOutbound>[0] = { imessage: new ImsgOutbound() };
  if (process.env.TELEGRAM_BOT_TOKEN) routes.telegram = new TelegramOutbound(process.env.TELEGRAM_BOT_TOKEN);
  return new MultiOutbound(routes);
}

async function agentFor(out: Outbound, origin: string, owners: string[]) {
  const browser = new HeadlessBrowser();
  const agent = await createLocalAgent({
    stateDir: STATE,
    skills: () => [new RestaurantSkill(new TableNowProvider(origin, browser))],
    outbound: out,
    ownerHandles: owners,
  });
  return { ...agent, browser };
}

async function main(argv: string[]): Promise<void> {
  const [cmd, sub, arg] = argv;
  const cfg = await config.read();

  if (cmd === "pair") {
    const cloudUrl = sub ?? cfg.cloudUrl;
    if (!cloudUrl) throw new Error("usage: momo pair <cloud-url> [--push <url>]");
    const push = argv.indexOf("--push");
    const keys = await loadOrCreateDeviceKeys(STATE);
    const deviceId = cfg.deviceId ?? `${hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${randomInt(1e6)}`;
    const code = String(randomInt(100000, 1000000));
    await new CloudClient(cloudUrl, deviceId, keys).register(code, push > 0 ? { kind: "push", url: argv[push + 1]! } : { kind: "none" });
    await config.write({ ...cfg, cloudUrl, deviceId });
    console.log(`Paired as ${deviceId}. In Telegram, text your bot:  /pair ${code}   (valid 15 min)`);
    return;
  }

  if (cmd === "run") {
    if (!cfg.cloudUrl || !cfg.deviceId) throw new Error("run `momo pair <cloud-url>` first");
    const keys = await loadOrCreateDeviceKeys(STATE);
    const agent = await agentFor(outbound(), cfg.tablenowOrigin ?? "https://tablenow.example", cfg.owner ?? []);
    const worker = new CheckinWorker({
      client: new CloudClient(cfg.cloudUrl, cfg.deviceId, keys),
      keys,
      assistant: agent.assistant,
      seen: new JsonFile(join(STATE, "seen.json"), () => []),
      log: (m) => console.error(m),
    });
    process.on("SIGINT", () => worker.stop());
    console.log(`momo running. Cloud: ${cfg.cloudUrl}. State: ${STATE}`);
    await worker.run();
    await agent.browser.dispose();
    return;
  }

  if (cmd === "vault") {
    const { vault } = await createLocalAgent({ stateDir: STATE, skills: () => [], outbound: new RecordingOutbound(), ownerHandles: [] });
    if (sub === "add-login") {
      if (!arg) throw new Error("usage: momo vault add-login <https://site>");
      const origin = new URL(arg).origin;
      const identifier = await ask(`Email or username for ${new URL(origin).host}: `);
      const password = await ask("Password (hidden): ", true);
      const item = await vault.put("login", new URL(origin).host, { identifier, password }, origin);
      console.log(`Saved ${item.label} (${item.hint}). It is encrypted on this device and only ever typed into ${origin}.`);
    } else if (sub === "add-card") {
      const label = arg ?? "Card";
      const name = await ask("Name on card: ");
      const number = (await ask("Card number (hidden): ", true)).replace(/[\s-]/g, "");
      const [mm = "", yy = ""] = (await ask("Expiry MM/YY: ")).split("/").map((p) => p.trim());
      const expMonth = mm.padStart(2, "0");
      const expYear = yy.length === 2 ? `20${yy}` : yy;
      const cvc = await ask("CVC (hidden): ", true);
      const zip = await ask("Billing ZIP: ");
      const item = await vault.put("payment", label, { name, number, expMonth, expYear, cvc, zip });
      console.log(`Saved ${item.hint}. It never leaves this device; every purchase still needs your YES.`);
    } else if (sub === "add-address") {
      const name = await ask("Full name: ");
      const line1 = await ask("Street address: ");
      const line2 = (await ask("Apt/suite (optional): ")) || undefined;
      const city = await ask("City: ");
      const region = await ask("State: ");
      const postal = await ask("ZIP: ");
      const phone = (await ask("Phone for delivery (optional): ")) || undefined;
      const item = await vault.put("address", "home", { name, line1, line2, city, region, postal, country: "US", phone });
      console.log(`Saved ${item.hint}.`);
    } else if (sub === "list") {
      for (const i of await vault.list()) console.log(`${i.handle}  ${i.kind.padEnd(8)} ${i.label}  ${i.hint}${i.origin ? `  (${i.origin})` : ""}`);
    } else if (sub === "rm") {
      console.log((await vault.remove(arg ?? "")) ? "Removed." : "No such item.");
    } else {
      throw new Error("usage: momo vault add-login|add-card|add-address|list|rm");
    }
    return;
  }

  if (cmd === "owner") {
    // Which channel handles are "you" (phone number, Telegram chat id).
    await config.write({ ...cfg, owner: argv.slice(1) });
    console.log(`Owner handles: ${argv.slice(1).join(", ")}`);
    return;
  }

  if (cmd === "receipts") {
    const all = await new JsonFile<PrivacyReceipt[]>(join(STATE, "privacy-receipts.json"), () => []).read();
    if (all.length === 0) console.log("Nothing has been sent to a remote model.");
    for (const r of all.slice(-20)) {
      console.log(`${new Date(r.at).toLocaleString()}  ${r.destination} via ${r.transport}/${r.payment}  hid: ${r.redactedKinds.join(",") || "none"}\n  ${r.sent.slice(0, 200)}`);
    }
    return;
  }

  if (cmd === "demo") {
    const site = await startMockSite();
    const out = new RecordingOutbound(true);
    const dir = await mkdtemp(join(tmpdir(), "momo-demo-"));
    const browser = new HeadlessBrowser();
    const agent = await createLocalAgent({ stateDir: dir, skills: () => [new RestaurantSkill(new TableNowProvider(site.origin, browser))], outbound: out, ownerHandles: ["me"] });
    await agent.vault.put("login", "TableNow", { identifier: site.state.account.email, password: site.state.account.password }, site.origin);
    console.log(`Demo: a local booking site is at ${site.origin}. Text like you would on iMessage. Ctrl-D to quit.\n`);
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
    let closed = false;
    rl.on("close", () => (closed = true));
    rl.prompt();
    for await (const line of rl) {
      if (line.trim()) {
        const r = await agent.assistant.handle({ channel: "imessage", from: "me", threadId: "me", text: line, receivedAt: Date.now() });
        if (!r.handled) console.log("\n[momo] (would go to the general OpenClaw agent)\n");
      }
      // Piped input may have closed readline while we were replying.
      if (!closed) rl.prompt();
    }
    await browser.dispose();
    await site.close();
    return;
  }

  console.log("usage: momo pair|run|owner|vault|receipts|demo");
}

main(process.argv.slice(2)).catch((e) => {
  console.error(process.env.MOMO_DEBUG ? e : (e as Error).message);
  process.exit(1);
});
