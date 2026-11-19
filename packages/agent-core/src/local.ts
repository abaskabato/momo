// A local model that fits the computer, downloaded by Momo itself.
//
// MOMO_MODEL=ollama/auto (or just "ollama") picks a Gemma 4 size from the computer's memory and graphics card,
// the way Tiles (github.com/tilesprivacy/tiles) does for its local assistant. A model named outright, like
// ollama/qwen3.5:4b, is used as it is. Either way, if Ollama doesn't have the model yet, Momo downloads it at
// startup instead of failing with "run ollama pull".
import { execFile } from "node:child_process";
import { totalmem } from "node:os";

export interface Machine {
  platform: NodeJS.Platform;
  arch: string;
  /** Total memory, in GB. On Apple silicon the graphics share it. */
  memoryGB: number;
  /** An NVIDIA card's own memory, in GB, when there is one. */
  nvidiaGB?: number;
}

const GB = 1024 ** 3;

/** What this computer has: memory, and an NVIDIA card's memory if nvidia-smi can tell. */
export async function detectMachine(run: (cmd: string, args: string[]) => Promise<string> = runQuiet): Promise<Machine> {
  const m: Machine = { platform: process.platform, arch: process.arch, memoryGB: Math.round(totalmem() / GB) };
  if (m.platform === "darwin") return m;
  // memory.total in MiB, one line per card; the biggest card is the one Ollama will use.
  const out = await run("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"]).catch(() => "");
  const cards = out.split("\n").map((l) => Number(l.trim())).filter((n) => n > 0);
  if (cards.length) m.nvidiaGB = Math.round(Math.max(...cards) / 1024);
  return m;
}

function runQuiet(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 5000, windowsHide: true }, (e, out) => (e ? reject(e) : resolve(out))));
}

/**
 * The Gemma 4 size for this computer. Room is left for the browser, the system and a long errand's context, and a
 * computer without a fast graphics chip gets a smaller model: on the processor alone, a big one is too slow to text with.
 *   gemma4:26b  (MoE, 4B active: fast for its size, ~17 GB)   gemma4:12b (~8 GB)   gemma4:e4b (~7 GB)   gemma4:e2b (~5 GB)
 */
export function pickLocalModel(m: Machine): { model: string; why: string } {
  const appleSilicon = m.platform === "darwin" && m.arch === "arm64";
  if (appleSilicon) {
    const why = `Apple silicon with ${m.memoryGB} GB`;
    if (m.memoryGB >= 32) return { model: "gemma4:26b", why };
    if (m.memoryGB >= 16) return { model: "gemma4:12b", why };
    if (m.memoryGB >= 12) return { model: "gemma4:e4b", why };
    return { model: "gemma4:e2b", why };
  }
  if (m.nvidiaGB) {
    const why = `an NVIDIA card with ${m.nvidiaGB} GB`;
    if (m.nvidiaGB >= 20) return { model: "gemma4:26b", why };
    if (m.nvidiaGB >= 10) return { model: "gemma4:12b", why };
    if (m.nvidiaGB >= 7) return { model: "gemma4:e4b", why };
  }
  const why = `${m.memoryGB} GB and ${m.nvidiaGB ? `an NVIDIA card with only ${m.nvidiaGB} GB` : "no graphics card Ollama can use"}`;
  return m.memoryGB >= 16 ? { model: "gemma4:e4b", why } : { model: "gemma4:e2b", why };
}

/** "ollama/auto" or "ollama" -> "ollama/<the size for this computer>"; anything else as it is. */
export async function resolveAutoModel(spec: string, detect: () => Promise<Machine> = detectMachine): Promise<{ spec: string; note?: string }> {
  if (!/^ollama(\/auto)?$/i.test(spec.trim())) return { spec };
  const { model, why } = pickLocalModel(await detect());
  return { spec: `ollama/${model}`, note: `local model: ${model}, picked for this computer (${why}); set MOMO_MODEL=ollama/<model> to choose another` };
}

// ---- Downloading the model ------------------------------------------------------------------------------------

/** Downloads in progress, by model: how far along, for "still downloading" answers. */
const downloading = new Map<string, number>();

/** How far along a download of this model is (0-100), or undefined when none is running. */
export function downloadProgress(model: string): number | undefined {
  return downloading.get(model);
}

const ollamaBase = (baseUrl = "http://127.0.0.1:11434/v1") => baseUrl.replace(/\/$/, "").replace(/\/v1$/, "");

/** Whether Ollama already has the model (a bare name means its "latest" tag). */
export async function ollamaHas(model: string, baseUrl?: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const r = await fetchImpl(`${ollamaBase(baseUrl)}/api/tags`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`ollama ${r.status}`);
  const names = ((await r.json()) as { models?: Array<{ name: string }> }).models?.map((m) => m.name) ?? [];
  const full = model.includes(":") ? model : `${model}:latest`;
  return names.includes(full) || names.includes(model);
}

/**
 * Downloads the model through Ollama (POST /api/pull, streamed), reporting every 10%. Resolves when it's ready.
 * A second call for the same model while one runs waits for that one.
 */
const pulls = new Map<string, Promise<void>>();
export function pullOllamaModel(model: string, baseUrl?: string, log: (line: string) => void = console.log, fetchImpl: typeof fetch = fetch): Promise<void> {
  const running = pulls.get(model);
  if (running) return running;
  const p = (async () => {
    downloading.set(model, 0);
    try {
      const r = await fetchImpl(`${ollamaBase(baseUrl)}/api/pull`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, stream: true }),
      });
      if (!r.ok || !r.body) throw new Error(`ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
      let said = -10;
      let buf = "";
      const decoder = new TextDecoder();
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
          if (ev.error) throw new Error(ev.error);
          // The big layer is the one worth counting; small ones flash by.
          if (ev.total && ev.total > 100_000_000 && ev.completed !== undefined) {
            const pct = Math.floor((ev.completed / ev.total) * 100);
            downloading.set(model, pct);
            if (pct >= said + 10) {
              said = pct - (pct % 10);
              log(`downloading ${model}: ${said}% of ${(ev.total / GB).toFixed(1)} GB`);
            }
          }
          if (ev.status === "success") log(`downloaded ${model}`);
        }
      }
    } finally {
      downloading.delete(model);
      pulls.delete(model);
    }
  })();
  pulls.set(model, p);
  return p;
}
