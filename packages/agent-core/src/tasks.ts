// Durable task state. A task outlives any single message: it can wait on the
// owner's choice, on an approval, or on a timer, and is resumed from here.

import { randomId, type Channel } from "@momo/protocol";
import type { Doc } from "./store.ts";

export type TaskStatus =
  | "running"
  | "awaiting_input"
  | "awaiting_approval"
  | "waiting"
  | "done"
  | "failed"
  | "cancelled"
  | "undone";

export const ACTIVE: ReadonlySet<TaskStatus> = new Set(["running", "awaiting_input", "awaiting_approval", "waiting"]);

export interface Compensation {
  /** Skill action that reverses the committed one, e.g. "restaurant.cancel". */
  action: string;
  args: Record<string, unknown>;
  summary: string;
}

export interface Task {
  id: string;
  skill: string;
  channel: Channel;
  threadId: string;
  from: string;
  request: string;
  status: TaskStatus;
  /** Skill-private state (parsed intent, candidate slots, confirmation ids). */
  data: Record<string, unknown>;
  /** Owner-approved ceiling for this task; nothing may be charged past it. */
  spendCapUsd: number;
  spentUsd: number;
  undo?: Compensation;
  log: Array<{ at: number; msg: string }>;
  createdAt: number;
  updatedAt: number;
}

export class TaskStore {
  private readonly file: Doc<Task[]>;
  private readonly now: () => number;

  constructor(file: Doc<Task[]>, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
  }

  async create(init: Pick<Task, "skill" | "channel" | "threadId" | "from" | "request"> & { data?: Record<string, unknown> }): Promise<Task> {
    const t: Task = {
      id: randomId("task"),
      ...init,
      status: "running",
      data: init.data ?? {},
      spendCapUsd: 0,
      spentUsd: 0,
      log: [],
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    await this.file.update((all) => void all.push(t));
    return t;
  }

  async get(id: string): Promise<Task | undefined> {
    return (await this.file.read()).find((t) => t.id === id);
  }

  async all(): Promise<Task[]> {
    return this.file.read();
  }

  async active(threadId?: string): Promise<Task[]> {
    return (await this.file.read()).filter((t) => ACTIVE.has(t.status) && (!threadId || t.threadId === threadId));
  }

  /** The task in this thread that is waiting on the owner to answer a question. */
  async awaitingInput(threadId: string): Promise<Task | undefined> {
    return (await this.active(threadId)).filter((t) => t.status === "awaiting_input").at(-1);
  }

  /** Most recent finished task with something to undo. */
  async lastUndoable(threadId: string): Promise<Task | undefined> {
    return (await this.file.read()).filter((t) => t.threadId === threadId && (t.status === "done" || t.status === "waiting") && t.undo).at(-1);
  }

  async save(t: Task, logMsg?: string): Promise<Task> {
    t.updatedAt = this.now();
    if (logMsg) t.log.push({ at: t.updatedAt, msg: logMsg });
    await this.file.update((all) => {
      const i = all.findIndex((x) => x.id === t.id);
      if (i >= 0) all[i] = t;
      else all.push(t);
    });
    return t;
  }
}

export class SpendError extends Error {}

export interface SpendPolicyConfig {
  /** Hard ceiling per task, even with approval. */
  maxPerTaskUsd: number;
  /** Rolling 24h ceiling across all tasks. */
  maxPerDayUsd: number;
}

export const DEFAULT_SPEND: SpendPolicyConfig = { maxPerTaskUsd: 500, maxPerDayUsd: 1000 };

export class SpendPolicy {
  private readonly cfg: SpendPolicyConfig;
  private readonly tasks: TaskStore;
  private readonly now: () => number;

  constructor(tasks: TaskStore, cfg: SpendPolicyConfig = DEFAULT_SPEND, now: () => number = Date.now) {
    this.tasks = tasks;
    this.cfg = cfg;
    this.now = now;
  }

  /** Raise a task's cap to an owner-approved amount, within the global limits. */
  async approveCap(task: Task, amountUsd: number): Promise<void> {
    if (amountUsd > this.cfg.maxPerTaskUsd) throw new SpendError(`$${amountUsd} is over your per-task limit of $${this.cfg.maxPerTaskUsd}`);
    const today = await this.spentLast24h();
    if (today + amountUsd > this.cfg.maxPerDayUsd) throw new SpendError(`that would pass your daily limit of $${this.cfg.maxPerDayUsd}`);
    task.spendCapUsd = Math.max(task.spendCapUsd, amountUsd);
  }

  /** Record a charge; refuses anything past the approved cap. */
  charge(task: Task, amountUsd: number): void {
    if (task.spentUsd + amountUsd > task.spendCapUsd + 1e-9) {
      throw new SpendError(`charge of $${amountUsd} exceeds the $${task.spendCapUsd} you approved`);
    }
    task.spentUsd += amountUsd;
  }

  private async spentLast24h(): Promise<number> {
    const since = this.now() - 24 * 3600_000;
    return (await this.tasks.all()).filter((t) => t.updatedAt >= since).reduce((s, t) => s + t.spentUsd, 0);
  }
}
