// The task-orchestration skill layer. A skill owns one kind of real-world
// task end to end: understanding the ask, doing the reversible work, asking
// for approval, committing, and undoing. The Assistant routes messages,
// approvals, and timers to skills; skills never parse approvals themselves.

import type { SecureFormSpec } from "@momo/protocol";
import type { Approval, ApprovalGate, ApprovalRequest } from "./approvals.ts";
import type { Email, Inbox } from "./inbox.ts";
import type { Memory } from "./memory.ts";
import type { ModelRouter } from "./models.ts";
import type { SpendPolicy, Task, TaskStore } from "./tasks.ts";
import type { Timers } from "./timers.ts";
import type { LocalVault } from "./vault.ts";

/** Hosted one-time links where the owner types a secret on their phone (sealed in the browser). */
export interface SecureLinks {
  create(spec: SecureFormSpec): Promise<{ id: string; url: string }>;
}

/** A link where the owner sees the errand's live browser and can tap/type (CAPTCHAs, odd pages). */
export interface LiveViews {
  create(task: Task, page: unknown, reason: string): Promise<string>;
}

export interface PhoneCallRequest {
  /** E.164 number, e.g. +14155550123. */
  to: string;
  /** What the call must achieve and every fact the voice agent may share. */
  goal: string;
}

/** Places a phone call with a voice agent. The outcome arrives later via Assistant.resumeTask. */
export interface PhoneCaller {
  call(task: Task, req: PhoneCallRequest): Promise<void>;
}

export interface CalendarEvent {
  title: string;
  /** Local wall-clock time, "YYYY-MM-DDTHH:MM". */
  start: string;
  end?: string;
  location?: string;
}

export interface SkillContext {
  tasks: TaskStore;
  approvals: ApprovalGate;
  spend: SpendPolicy;
  vault: LocalVault;
  memory: Memory;
  timers: Timers;
  models?: ModelRouter;
  now(): Date;
  /** Text the owner in the task's thread. */
  reply(task: Task, text: string): Promise<void>;
  /**
   * Ask the owner for a login without it ever passing through chat. Returns
   * the text to send (a secure link when hosted). When it's saved, the task
   * resumes via onInput(task, "done").
   */
  requestLogin(task: Task, origin: string, label: string): Promise<string>;
  /** Same, for a payment card or a delivery address (not bound to one site). */
  requestSecret(task: Task, kind: "card" | "address"): Promise<string>;
  liveViews?: LiveViews;
  phone?: PhoneCaller;
  /** The owner's Momo inbox (hosted), where sites send codes and confirmation links. */
  inbox?: Inbox;
  /** A link that adds the event to the owner's calendar. */
  calendarLink(ev: CalendarEvent): string;
  /** Persist an approval request and text the owner the prompt. */
  askApproval(task: Task, req: Omit<ApprovalRequest, "taskId">): Promise<Approval>;
}

export interface Skill {
  readonly name: string;
  /** One line for the help text. */
  readonly description: string;
  matches(text: string): boolean;
  start(task: Task, ctx: SkillContext): Promise<void>;
  /** The owner answered a question this skill asked (task.status was awaiting_input). */
  onInput?(task: Task, text: string, ctx: SkillContext): Promise<void>;
  onApproved(task: Task, approval: Approval, ctx: SkillContext): Promise<void>;
  onDenied?(task: Task, approval: Approval, ctx: SkillContext): Promise<void>;
  onTimer?(task: Task, event: string, ctx: SkillContext): Promise<void>;
  /** An email arrived in the owner's Momo inbox while this task was active. */
  onEmail?(task: Task, email: Email, ctx: SkillContext): Promise<void>;
  /** Reverse the committed action recorded in task.undo; returns the reply. */
  undo?(task: Task, ctx: SkillContext): Promise<string>;
}
