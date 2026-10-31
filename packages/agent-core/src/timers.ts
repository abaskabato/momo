// Local deferred jobs ("remind me 3h before", "check for the confirmation
// email in an hour"). They live on the device. The cloud only learns the
// earliest due time (no content) so it can wake the device for it, and on
// macOS we additionally ask the power manager for a scheduled wake.

import { execFile } from "node:child_process";
import { randomId } from "@momo/protocol";
import type { Doc } from "./store.ts";

export interface Timer {
  id: string;
  taskId: string;
  event: string;
  at: number;
}

export class Timers {
  private readonly file: Doc<Timer[]>;

  constructor(file: Doc<Timer[]>) {
    this.file = file;
  }

  async add(taskId: string, event: string, at: number): Promise<Timer> {
    const t: Timer = { id: randomId("tmr"), taskId, event, at };
    await this.file.update((all) => void all.push(t));
    return t;
  }

  async cancelForTask(taskId: string): Promise<void> {
    await this.file.update((all) => all.filter((t) => t.taskId !== taskId));
  }

  /** Remove and return everything due at `now`. */
  async takeDue(now: number): Promise<Timer[]> {
    const all = await this.file.read();
    const due = all.filter((t) => t.at <= now);
    if (due.length) await this.file.write(all.filter((t) => t.at > now));
    return due;
  }

  async nextDueAt(): Promise<number | null> {
    const all = await this.file.read();
    return all.length ? Math.min(...all.map((t) => t.at)) : null;
  }
}

/**
 * Best-effort hardware wake on macOS. `pmset schedule` needs root, so this
 * only works if the owner allowed it in sudoers during setup; otherwise the
 * cloud push wake / next check-in is the fallback.
 */
export function scheduleMacWake(at: number): Promise<boolean> {
  if (process.platform !== "darwin") return Promise.resolve(false);
  const d = new Date(at - 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${p(d.getMonth() + 1)}/${p(d.getDate())}/${String(d.getFullYear()).slice(2)} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
  return new Promise((resolve) => execFile("sudo", ["-n", "pmset", "schedule", "wake", stamp], (err) => resolve(!err)));
}
