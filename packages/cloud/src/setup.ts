// `npm run setup`: a few questions, each answer checked, then a ready .env.
//
//   1. Which AI model (any provider) and its key: test-called with a tool.
//   2. The Telegram bot token from @BotFather: checked with getMe.
//   3. A public https address, if there is one (else Telegram is polled).
//   4. Where Momo works: a private browser, your own computer (agent-desktop),
//      or a cloud computer per person.
//   5. Redis: checked.
// Secrets it generates (master key, webhook secret) are kept on re-runs.

import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

export interface Provider {
  id: string;
  label: string;
  keyEnv?: string;
  defaultModel?: string;
  keyUrl?: string;
}

export const PROVIDERS: Provider[] = [
  { id: "gemini", label: "Google Gemini (free key available)", keyEnv: "GEMINI_API_KEY", defaultModel: "gemini-flash-latest", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "anthropic", label: "Anthropic Claude", keyEnv: "ANTHROPIC_API_KEY", defaultModel: "claude-opus-5-5", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", label: "OpenAI", keyEnv: "OPENAI_API_KEY", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "openrouter", label: "OpenRouter (hundreds of models)", keyEnv: "OPENROUTER_API_KEY", keyUrl: "https://openrouter.ai/keys" },
  { id: "groq", label: "Groq", keyEnv: "GROQ_API_KEY", keyUrl: "https://console.groq.com/keys" },
  { id: "ollama", label: "Ollama (a model on this computer, no key)" },
];

/** Parse KEY=value lines (comments and blanks ignored). */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/** Existing .env text with `updates` applied: changed lines in place, new ones appended, empty values removed. */
export function mergeEnv(existing: string, updates: Record<string, string | undefined>): string {
  const left = new Map(Object.entries(updates));
  const lines = existing.split(/\r?\n/).flatMap((line) => {
    const key = /^\s*([A-Z0-9_]+)\s*=/.exec(line)?.[1];
    if (!key || !left.has(key)) return [line];
    const v = left.get(key);
    left.delete(key);
    return v ? [`${key}=${v}`] : [];
  });
  while (lines.length && lines.at(-1) === "") lines.pop();
  for (const [k, v] of left) if (v) lines.push(`${k}=${v}`);
  return `${lines.join("\n")}\n`;
}

/** Generated once; re-running setup must not change them (the master key decrypts everyone's data). */
export function keepOrGenerate(env: Record<string, string>): Record<string, string> {
  return {
    MOMO_MASTER_KEY: env.MOMO_MASTER_KEY || randomBytes(32).toString("base64"),
    TELEGRAM_WEBHOOK_SECRET: env.TELEGRAM_WEBHOOK_SECRET || randomBytes(16).toString("hex"),
  };
}

async function checkModel(spec: string, env: Record<string, string>): Promise<string> {
  const { createPlanner, WEB_TOOLS } = await import("@momo/agent-core");
  const planner = createPlanner(spec, { ...process.env, ...env });
  const blocks = await planner.next(
    "You drive a browser for the owner.",
    [{ role: "user", content: [{ type: "text", text: "Errand: open https://example.com" }] }],
    WEB_TOOLS,
  );
  const call = blocks.find((b) => b.type === "tool_use") as { name: string } | undefined;
  if (!call) throw new Error("the model answered but didn't use tools; pick a model that supports tool calling");
  return call.name;
}

async function main() {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");
  const envPath = join(root, ".env");
  const existingText = await readFile(envPath, "utf8").catch(() => "");
  const env = parseEnv(existingText);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def = "") => (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def;
  const yes = async (q: string, def = true) => /^y/i.test(await ask(`${q} (y/n)`, def ? "y" : "n"));
  const updates: Record<string, string | undefined> = { ...keepOrGenerate(env) };

  console.log("\nMomo setup. Press Enter to keep the value in [brackets].\n");

  // 1. Model
  const current = env.MOMO_MODEL?.split("/")[0];
  PROVIDERS.forEach((p, i) => console.log(`  ${i + 1}. ${p.label}`));
  const pick = await ask("Which AI should drive Momo? (number)", String(Math.max(1, PROVIDERS.findIndex((p) => p.id === current) + 1)));
  const provider = PROVIDERS[Number(pick) - 1] ?? PROVIDERS[0]!;
  if (provider.keyEnv) {
    if (provider.keyUrl) console.log(`  Get a key at ${provider.keyUrl}`);
    const key = await ask(`${provider.label} API key`, env[provider.keyEnv] ? "keep current" : "");
    if (key && key !== "keep current") updates[provider.keyEnv] = key;
  }
  const currentModel = current === provider.id ? env.MOMO_MODEL!.slice(provider.id.length + 1) : provider.defaultModel ?? "";
  const model = await ask("Model name", currentModel);
  updates.MOMO_MODEL = `${provider.id}/${model}`;
  process.stdout.write("  Checking the model… ");
  try {
    console.log(`OK (it chose to ${await checkModel(updates.MOMO_MODEL, { ...env, ...(updates as Record<string, string>) })}).`);
  } catch (e) {
    console.log(`failed: ${(e as Error).message.slice(0, 300)}`);
    if (!(await yes("Save it anyway?", false))) process.exit(1);
  }

  // 2. Telegram
  console.log("\nTelegram: open https://t.me/BotFather, send /newbot, and paste the token it gives you.");
  const token = await ask("Bot token", env.TELEGRAM_BOT_TOKEN ? "keep current" : "");
  if (token && token !== "keep current") updates.TELEGRAM_BOT_TOKEN = token;
  const tg = updates.TELEGRAM_BOT_TOKEN ?? env.TELEGRAM_BOT_TOKEN;
  if (tg) {
    const me = (await fetch(`https://api.telegram.org/bot${tg}/getMe`).then((r) => r.json()).catch(() => ({}))) as { ok?: boolean; result?: { username: string } };
    console.log(me.ok ? `  OK: your bot is https://t.me/${me.result!.username}` : "  That token didn't work. Check it with @BotFather.");
  }

  // 3. Public address
  console.log("\nA public https address lets Momo send login/card links that open on any phone.");
  console.log("No domain? Leave blank: Telegram still works. (Quick option: `cloudflared tunnel --url http://localhost:8787`.)");
  updates.PUBLIC_URL = await ask("Public https URL", env.PUBLIC_URL ?? "");

  // 4. Where Momo works
  console.log("\nWhere should Momo work?");
  console.log("  1. A private web browser on this server (websites only; many people can share this Momo)");
  console.log("  2. This computer's screen via agent-desktop: any app, like a person at the keyboard (only you can use it)");
  console.log("  3. A cloud computer per person via agent-desktop (needs Docker; many people)");
  const where = await ask("Choose", env.MOMO_DESKTOP === "local" ? "2" : env.MOMO_DESKTOP === "cloud" ? "3" : "1");
  updates.MOMO_DESKTOP = where === "2" ? "local" : where === "3" ? "cloud" : undefined;
  if (where === "2") console.log("  Install it with: npm install -g agent-desktop   (macOS: then run `agent-desktop permissions --guide`)");
  if (where === "3") console.log("  Build the desktop image once: docker build -f Dockerfile.desktop -t momo-desktop .");

  // 5. Redis
  updates.REDIS_URL = await ask("Redis URL", env.REDIS_URL ?? "redis://127.0.0.1:6379");
  try {
    const { Redis } = await import("ioredis");
    const r = new Redis(updates.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
    await r.connect();
    await r.ping();
    r.disconnect();
    console.log("  OK: Redis is reachable.");
  } catch {
    console.log("  Can't reach Redis. Start one with: docker compose up -d redis");
  }

  rl.close();
  await writeFile(envPath, mergeEnv(existingText, updates), { mode: 0o600 });
  await chmod(envPath, 0o600);
  console.log(`\nSaved ${envPath}. Start Momo with:\n\n  npm start\n\nor with Docker:\n\n  docker compose up -d\n`);
}

if (import.meta.main) await main();
