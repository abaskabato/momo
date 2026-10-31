// Completion-rate eval on real websites: the number that says whether Momo
// is better than Instinct. Each errand runs through the real assistant, web
// agent, model, and headless browser, as if a person texted it.
//
// Nothing is ever bought or booked: at the "Reply YES" step the eval records
// the terms and answers NO. Questions get a stock persona's answers. A login
// or card request ends the run as "needs account" (give it test accounts to
// go further).
//
//   MOMO_MODEL=anthropic/claude-opus-5-5 ANTHROPIC_API_KEY=... npm run eval
//   npm run eval -- --only opentable-dinner --model openai/<model>
//
// Writes docs/evals/results/<date>-<model>.md and .json.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { HeadlessBrowser, type BrowserSessionFactory } from "./browser.ts";
import type { ComputerFactory } from "./computer.ts";
import { RecordingOutbound } from "./channels.ts";
import { createAnswerer, createPlanner, type Answerer } from "./llm.ts";
import { createAgent } from "./runtime.ts";
import type { Doc } from "./store.ts";
import { StaticKeyProvider } from "./vault.ts";
import { WebTaskSkill, type Planner } from "./skills/web/agent.ts";
import { randomBytes } from "node:crypto";

export interface Errand {
  id: string;
  /** What the person texts. */
  text: string;
  /** "commit": success is reaching the approval step; "answer": success is a finished reply. */
  expect: "commit" | "answer";
  /** What a correct approval/answer must mention (case-insensitive regexes). */
  mustMention?: string[];
}

export type Outcome = "done" | "wrong" | "needs_account" | "human_check" | "gave_up" | "step_limit" | "error" | "timeout";

export interface EvalResult {
  id: string;
  outcome: Outcome;
  seconds: number;
  steps: number;
  tools: string[];
  /** The approval summary or final reply. */
  detail: string;
}

const PERSONA: Array<[RegExp, string]> = [
  [/how many|party size|people|guests/i, "2"],
  [/name/i, "Ana Lopez"],
  [/email/i, "Use any; I'll sign in later."],
  [/phone/i, "+1 415 555 0123"],
  [/zip|postal|where|address|city|location/i, "San Francisco, CA 94110"],
  [/time|when|date/i, "Whatever is closest to what I asked."],
];
const persona = (q: string) => PERSONA.find(([re]) => re.test(q))?.[1] ?? "Your call, pick the most sensible option.";

class MemDoc<T> implements Doc<T> {
  private v: T;
  constructor(fallback: () => T) {
    this.v = fallback();
  }
  async read() {
    return structuredClone(this.v);
  }
  async write(value: T) {
    this.v = structuredClone(value);
  }
  async update(fn: (value: T) => T | void) {
    const cur = await this.read();
    this.v = (fn(cur) as T | undefined) ?? cur;
    return this.read();
  }
}

export interface RunOptions {
  answerer?: Answerer;
  /** A computer for non-web errands (agent-desktop). */
  computers?: ComputerFactory;
  timeoutMs?: number;
}

export async function runErrand(errand: Errand, planner: Planner, browser: BrowserSessionFactory, o: RunOptions = {}): Promise<EvalResult> {
  const { answerer, computers, timeoutMs = 6 * 60_000 } = o;
  const t0 = Date.now();
  const tools: string[] = [];
  const counting: Planner = {
    async next(system, history, specs) {
      const blocks = await planner.next(system, history, specs);
      for (const b of blocks) if (b.type === "tool_use") tools.push(String((b as { name: string }).name));
      return blocks;
    },
  };
  const out = new RecordingOutbound();
  const agent = await createAgent({
    docs: (_n, fallback) => new MemDoc(fallback),
    keyProvider: new StaticKeyProvider(randomBytes(32)),
    skills: () => [new WebTaskSkill(counting, browser, computers)],
    outbound: out,
    ownerHandles: ["eval"],
    onboarding: "done",
    secureLinks: { create: async () => ({ id: "x", url: "https://momo.example/s/eval-link" }) },
    answer: answerer && ((t, c) => answerer.answer(t, c)),
  });
  await agent.memory.set("owner.name", "Ana");
  await agent.memory.set("owner.city", "San Francisco");
  const say = (text: string) => agent.assistant.handle({ channel: "telegram", from: "eval", threadId: "eval", text, receivedAt: Date.now() });
  const result = (outcome: Outcome, detail: string): EvalResult => ({ id: errand.id, outcome, seconds: Math.round((Date.now() - t0) / 1000), steps: tools.length, tools, detail: detail.slice(0, 400) });
  const mentions = (s: string) => (errand.mustMention ?? []).every((m) => new RegExp(m, "i").test(s));

  const run = async (): Promise<EvalResult> => {
    let seen = 0;
    await say(errand.text);
    for (let turn = 0; turn < 6; turn++) {
      const fresh = out.sent.slice(seen).map((m) => m.text);
      seen = out.sent.length;
      const last = fresh.at(-1) ?? "";
      if (/Reply YES/.test(last)) {
        await say("no"); // dry run: never commit
        if (errand.expect !== "commit") return result("wrong", `asked to commit: ${last}`);
        return result(mentions(last) ? "done" : "wrong", last);
      }
      if (fresh.some((t) => /momo\.example\/s\//.test(t))) return result("needs_account", last);
      const task = (await agent.tasks.active("eval")).at(-1);
      if (!task) {
        if (/taking more steps/.test(last)) return result("step_limit", last);
        if (/couldn't finish/i.test(last)) return result("error", last);
        if (errand.expect === "answer") return result(mentions(last) ? "done" : "wrong", last);
        return result(tools.includes("hand_to_owner") ? "human_check" : "gave_up", last);
      }
      if (task.status !== "awaiting_input") return result("gave_up", `stuck in ${task.status}: ${last}`);
      await say(/live view|hand/i.test(last) ? "I can't do that right now, please try another way." : persona(last));
    }
    return result("gave_up", "too many questions");
  };

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<EvalResult>((r) => (timer = setTimeout(() => r(result("timeout", out.sent.at(-1)?.text ?? "")), timeoutMs))),
    ]);
  } catch (e) {
    return result("error", (e as Error).message);
  } finally {
    clearTimeout(timer);
    await say("stop").catch(() => {});
  }
}

export function report(model: string, results: EvalResult[]): string {
  const done = results.filter((r) => r.outcome === "done").length;
  const by = (o: Outcome) => results.filter((r) => r.outcome === o).length;
  const pct = (n: number) => `${Math.round((100 * n) / Math.max(1, results.length))}%`;
  const median = [...results].map((r) => r.seconds).sort((a, b) => a - b)[Math.floor(results.length / 2)] ?? 0;
  return [
    `# Momo errand eval: ${model}`,
    "",
    `**Done: ${done}/${results.length} (${pct(done)})**, median ${median}s per errand.`,
    "",
    `Needs account: ${by("needs_account")} · human check: ${by("human_check")} · wrong: ${by("wrong")} · gave up: ${by("gave_up")} · step limit: ${by("step_limit")} · error: ${by("error")} · timeout: ${by("timeout")}`,
    "",
    "| Errand | Outcome | Time | Steps | What it got to |",
    "|---|---|---|---|---|",
    ...results.map((r) => `| ${r.id} | ${r.outcome} | ${r.seconds}s | ${r.steps} | ${r.detail.replace(/\s+/g, " ").replace(/\|/g, "/")} |`),
    "",
  ].join("\n");
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { model: { type: "string" }, only: { type: "string" }, file: { type: "string" } } });
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const model = values.model ?? process.env.MOMO_MODEL ?? "anthropic/claude-opus-5-5";
  const errands = (JSON.parse(await readFile(values.file ?? join(root, "docs/evals/errands.json"), "utf8")) as Errand[]).filter(
    (e) => !values.only || values.only.split(",").includes(e.id),
  );
  const planner = createPlanner(model);
  const answerer = createAnswerer(process.env.MOMO_ANSWER_MODEL ?? model);
  const browser = new HeadlessBrowser({ timezoneId: "America/Los_Angeles" });
  const results: EvalResult[] = [];
  for (const e of errands) {
    process.stdout.write(`${e.id} … `);
    const r = await runErrand(e, planner, browser, { answerer });
    console.log(`${r.outcome} (${r.seconds}s, ${r.steps} steps)`);
    results.push(r);
  }
  await browser.dispose();
  const md = report(model, results);
  const base = join(root, "docs/evals/results", `${new Date().toISOString().slice(0, 10)}-${model.replace(/[^\w.-]+/g, "_")}`);
  await mkdir(dirname(base), { recursive: true });
  await writeFile(`${base}.md`, md);
  await writeFile(`${base}.json`, JSON.stringify(results, null, 2));
  console.log(`\n${md}\nSaved ${base}.md`);
}
