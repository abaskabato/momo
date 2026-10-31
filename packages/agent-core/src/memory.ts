// Owner preferences that make the next task need fewer questions ("usual
// party size", "home neighborhood"). Stored locally. When running inside
// OpenClaw, notes are also appended to the workspace memory folder so
// OpenClaw's own memory search sees them.

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Doc } from "./store.ts";

export interface Memory {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  /** Everything remembered about the owner ("pref.*" keys), for prompts. */
  prefs(): Promise<Record<string, string>>;
  /** A dated, human-readable note ("Booked Nopa for 4 on Fri"). */
  note(text: string): Promise<void>;
}

export class LocalMemory implements Memory {
  private readonly prefs_: Doc<Record<string, string>>;
  /** OpenClaw workspace `memory/` dir, if present. */
  private readonly notesDir?: string;
  private readonly now: () => Date;

  constructor(prefs: Doc<Record<string, string>>, notesDir?: string, now: () => Date = () => new Date()) {
    this.prefs_ = prefs;
    this.notesDir = notesDir;
    this.now = now;
  }

  async get(key: string) {
    return (await this.prefs_.read())[key];
  }

  async set(key: string, value: string) {
    await this.prefs_.update((p) => void (p[key] = value));
  }

  async prefs() {
    const all = await this.prefs_.read();
    return Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith("pref.")).map(([k, v]) => [k.slice(5), v]));
  }

  async note(text: string) {
    if (!this.notesDir) return;
    const d = this.now();
    const day = d.toISOString().slice(0, 10);
    await mkdir(this.notesDir, { recursive: true });
    await appendFile(join(this.notesDir, `${day}-momo.md`), `- ${d.toISOString().slice(11, 16)} ${text}\n`);
  }
}
