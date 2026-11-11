// The orchestrator. Every inbound message goes through `handle`, in this order:
//   1. owner check (only the owner can start tasks or approve anything)
//   2. control words: STOP, UNDO, STATUS, HELP
//   3. approval replies (parsed by code, never by a model)
//   4. answers to a question a task is waiting on
//   5. a new task for the first skill that matches
// Anything else returns { handled: false } so the host (OpenClaw's general
// agent) can take it.

import type { Channel, InboundMessage, SecureFormSubmission } from "@momo/protocol";
import { ApprovalGate, type Approval, type ApprovalRequest } from "./approvals.ts";
import type { Outbound } from "./channels.ts";
import { guessCode, type Email, type Inbox } from "./inbox.ts";
import type { Owners } from "./owners.ts";
import type { Memory } from "./memory.ts";
import type { ModelRouter } from "./models.ts";
import type { CalendarEvent, LiveViews, PhoneCaller, SecureLinks, Skill, SkillContext } from "./skill.ts";
import type { Doc } from "./store.ts";
import { ACTIVE, type SpendPolicy, type Task, type TaskStore } from "./tasks.ts";
import type { Timers } from "./timers.ts";
import type { LocalVault } from "./vault.ts";

export interface AssistantDeps {
  skills: Skill[];
  tasks: TaskStore;
  approvals: ApprovalGate;
  spend: SpendPolicy;
  vault: LocalVault;
  memory: Memory;
  timers: Timers;
  outbound: Outbound;
  models?: ModelRouter;
  /** Who the assistant works for; claimed by text with a one-time code. */
  owners: Owners;
  secureLinks?: SecureLinks;
  liveViews?: LiveViews;
  phone?: PhoneCaller;
  inbox?: Inbox;
  /** Where to text the owner about things no task started (hosted: their chat). */
  home?: { channel: Channel; threadId: string };
  /** Public base URL in hosted mode; calendar links point at its .ics endpoint. */
  publicUrl?: string;
  /** Answers anything that isn't an errand (questions, chit-chat). Hosted mode has no other brain. */
  answer?: (text: string, context: string) => Promise<string>;
  /** The last few messages each way, so follow-ups and "did you book it?" have something to stand on. */
  chat?: Doc<ChatLine[]>;
  /** Secure links awaiting an answer; the origin is kept here, not trusted from the link. */
  pendingForms: Doc<PendingForm[]>;
  now?: () => Date;
}

export interface PendingForm {
  id: string;
  kind: "login" | "card" | "address";
  /** Logins only. */
  origin?: string;
  label: string;
  taskId: string;
  createdAt: number;
}

export interface HandleResult {
  handled: boolean;
  taskId?: string;
}

const DIRECT_CHANNELS = new Set(["imessage", "sms", "telegram", "whatsapp", "signal", "app"]);

export interface ChatLine {
  who: "owner" | "momo";
  text: string;
  at: number;
}
const CHAT_KEEP = 24;

/** A question about what happened, not a new errand ("did you book it?", "what is done"). */
const ASKING = /^(did|have|has|had|what|what'?s|whats|why|when|where|who|how|is|are|was|were|do you|does|any (update|news|luck)|status|so)\b/i;

export class Assistant {
  private readonly d: AssistantDeps;
  private readonly ctx: SkillContext;

  /** Remember a message (either direction). */
  private async note(who: ChatLine["who"], text: string): Promise<void> {
    if (!this.d.chat) return;
    const at = (this.d.now ?? (() => new Date()))().getTime();
    await this.d.chat.update((all) => all.concat({ who, text: text.slice(0, 600), at }).slice(-CHAT_KEEP));
  }

  /** The recent conversation as text, oldest first. */
  async recentConversation(max = 12): Promise<string> {
    const all = this.d.chat ? await this.d.chat.read() : [];
    return all.slice(-max).map((l) => `${l.who === "owner" ? "Owner" : "Momo"}: ${l.text}`).join("\n");
  }

  constructor(deps: AssistantDeps) {
    // Everything Momo says is remembered, whoever says it (the assistant or a skill).
    const send = deps.outbound.send.bind(deps.outbound);
    deps = { ...deps, outbound: { ...deps.outbound, send: async (channel, to, text) => { await send(channel, to, text); await this.note("momo", text); } } };
    this.d = deps;
    const now = deps.now ?? (() => new Date());
    this.ctx = {
      tasks: deps.tasks,
      approvals: deps.approvals,
      spend: deps.spend,
      vault: deps.vault,
      memory: deps.memory,
      timers: deps.timers,
      models: deps.models,
      now,
      reply: (task, text) => deps.outbound.send(task.channel, task.threadId, text),
      requestLogin: async (task, origin, label) => {
        if (!deps.secureLinks) {
          return `I need your ${label} login. Save it on your computer (it never leaves it):\nmomo vault add-login ${origin}\nThen text me "done".`;
        }
        const link = await deps.secureLinks.create({ kind: "login", label });
        await deps.pendingForms.update((all) =>
          all.concat({ id: link.id, kind: "login", origin, label, taskId: task.id, createdAt: now().getTime() }),
        );
        return `To do this I need your ${label} login. Add it here. It's encrypted on your phone before it's sent, and I never see it in chat:\n${link.url}`;
      },
      requestSecret: async (task, kind) => {
        const what = kind === "card" ? "card" : "delivery address";
        if (!deps.secureLinks) return `I need your ${what}. Save it on your computer with: momo vault add-${kind}\nThen text me "done".`;
        const link = await deps.secureLinks.create({ kind, label: what });
        await deps.pendingForms.update((all) => all.concat({ id: link.id, kind, label: what, taskId: task.id, createdAt: now().getTime() }));
        return kind === "card"
          ? `To pay, add the card you want me to use. It's encrypted on your phone, I never see the number, and I still ask before every purchase:\n${link.url}`
          : `Where should it go? Add your address here (saved for next time):\n${link.url}`;
      },
      recentConversation: () => this.recentConversation(),
      liveViews: deps.liveViews,
      phone: deps.phone,
      inbox: deps.inbox,
      calendarLink: (ev) => calendarLink(ev, deps.publicUrl),
      askApproval: async (task: Task, req: Omit<ApprovalRequest, "taskId">): Promise<Approval> => {
        const a = await deps.approvals.request({ ...req, taskId: task.id });
        await deps.outbound.send(task.channel, task.threadId, ApprovalGate.prompt(a));
        return a;
      },
    };
  }

  isOwner(msg: InboundMessage): Promise<boolean> {
    return this.d.owners.isOwner(msg.from);
  }

  async handle(msg: InboundMessage): Promise<HandleResult> {
    const text = msg.text.trim();
    const say = (t: string) => this.d.outbound.send(msg.channel, msg.threadId, t);

    if (!(await this.isOwner(msg))) {
      // Strangers can only claim with the code shown on the computer.
      const claim = await this.d.owners.tryClaim(text, msg.from);
      if (claim === "claimed") {
        const first = (await this.d.owners.state()).handles.length === 1;
        if (first) {
          await say(
            "Hi! I'm your assistant. I run on your own computer, so your passwords and cards never leave it.\n" +
              "I'll always ask before I book or buy anything.\n\nWhat should I call you?",
          );
        } else {
          await say("Got it, this number is linked too.");
        }
        return { handled: true };
      }
      if (claim === "wrong") await say("That code didn't match. Check the code on your computer.");
      // Everyone else: not ours to answer; the host decides.
      return { handled: claim !== "none" };
    }

    await this.note("owner", text);

    // Fix what Momo knows about you, any time.
    const rename = /^(?:call me|my name is|my name'?s)\s+(.{1,60}?)[.!]*$/i.exec(text);
    if (rename) {
      await this.d.memory.set("owner.name", rename[1]!.trim());
      await say(`Got it, ${rename[1]!.trim()}.`);
      return { handled: true };
    }
    const moved = /^(?:i live in|i'?m in|i am in|my city is|i moved to)\s+(.{1,80}?)[.!]*$/i.exec(text);
    if (moved && (await this.d.owners.state()).onboarding === "done") {
      await this.d.memory.set("owner.city", moved[1]!.trim());
      await say(`Got it, you're in ${moved[1]!.trim()}.`);
      return { handled: true };
    }

    if (/^(stop|stop all|cancel all|abort)$/i.test(text)) {
      const active = await this.d.tasks.active(msg.threadId);
      for (const t of active) {
        t.status = "cancelled";
        await this.d.approvals.cancelForTask(t.id);
        await this.d.timers.cancelForTask(t.id);
        await this.d.tasks.save(t, "stopped by owner");
      }
      await say(active.length ? `Stopped ${active.length} task${active.length > 1 ? "s" : ""}. Nothing else will happen.` : "Nothing is running.");
      return { handled: true };
    }

    if (/^undo$/i.test(text)) {
      const t = await this.d.tasks.lastUndoable(msg.threadId);
      const skill = t && this.skill(t.skill);
      if (!t || !skill?.undo) {
        await say("There's nothing I can undo.");
        return { handled: true };
      }
      // A failed undo leaves the original booking (and its undo record) intact.
      try {
        await say(await skill.undo(t, this.ctx));
      } catch (e) {
        await this.d.tasks.save(t, `undo failed: ${(e as Error).message}`);
        await say(`I couldn't undo it: ${(e as Error).message}. It's still booked.`);
      }
      return { handled: true, taskId: t.id };
    }

    if (/^(status|what are you doing\??)$/i.test(text)) {
      const active = await this.d.tasks.active();
      await say(active.length ? active.map((t) => `• ${t.request} (${t.status.replace("_", " ")})`).join("\n") : "Nothing in progress.");
      return { handled: true };
    }

    if (/^(what'?s )?(my )?(momo )?e-?mail( address)?\??$/i.test(text) && this.d.inbox) {
      await say(
        `Your Momo email is ${this.d.inbox.address}\n` +
          "Sites can send sign-in codes and confirmations there and I'll handle them. " +
          "To let me see codes sent to your own email, forward them there (in Gmail: Settings → Forwarding, or a filter for \"code\" emails).",
      );
      return { handled: true };
    }

    if (/^help$/i.test(text)) {
      await say(
        `I can ${this.d.skills.map((s) => s.description).join("; ")}.\n` +
          `I always ask before I book or buy. STOP cancels everything in progress. UNDO reverses the last thing I did.`,
      );
      return { handled: true };
    }

    const verdict = await this.d.approvals.resolveReply(text, {
      fromOwner: true,
      directChannel: DIRECT_CHANNELS.has(msg.channel),
    });
    if (verdict.kind === "ambiguous") {
      await say(verdict.message);
      return { handled: true };
    }
    if (verdict.kind === "approved" || verdict.kind === "denied") {
      const t = await this.d.tasks.get(verdict.approval.taskId);
      const skill = t && this.skill(t.skill);
      if (t && skill && ACTIVE.has(t.status)) {
        await this.guard(t, () =>
          verdict.kind === "approved"
            ? skill.onApproved(t, verdict.approval, this.ctx)
            : skill.onDenied?.(t, verdict.approval, this.ctx) ?? Promise.resolve(),
        );
      }
      return { handled: true, taskId: t?.id };
    }

    const waiting = await this.d.tasks.awaitingInput(msg.threadId);
    if (waiting) {
      const skill = this.skill(waiting.skill);
      if (skill?.onInput) {
        await this.guard(waiting, () => skill.onInput!(waiting, text, this.ctx));
        return { handled: true, taskId: waiting.id };
      }
    }

    // "did you book it?" is a question about what happened, not a new booking.
    const asking = !!this.d.answer && ASKING.test(text) && text.length < 80;
    const skill = asking ? undefined : this.d.skills.find((s) => s.matches(text));
    if (!skill && (await this.onboard(text, say))) return { handled: true };
    if (!skill && this.d.answer) {
      const name = await this.d.memory.get("owner.name");
      const city = await this.d.memory.get("owner.city");
      const recent = await this.recentConversation();
      const context = [name && `Owner: ${name}.`, city && `City: ${city}.`, `Now: ${this.ctx.now().toString()}`, recent && `\nRecent conversation (oldest first):\n${recent}`].filter(Boolean).join(" ");
      await say((await this.d.answer(text, context)) || "I'm not sure what you mean. Tell me what you'd like done, in a sentence.");
      return { handled: true };
    }
    if (!skill) return { handled: false };
    const task = await this.d.tasks.create({ skill: skill.name, channel: msg.channel, threadId: msg.threadId, from: msg.from, request: text });
    await this.guard(task, () => skill.start(task, this.ctx));
    return { handled: true, taskId: task.id };
  }

  /** A secure-link submission arrived (already decrypted for this user only). */
  async onSecretSubmitted(sub: SecureFormSubmission): Promise<void> {
    const all = await this.d.pendingForms.read();
    const form = all.find((f) => f.id === sub.formId);
    if (!form) return; // unknown or already used
    await this.d.pendingForms.write(all.filter((f) => f.id !== sub.formId));
    const f = sub.fields;
    const clean = (k: string) => (f[k] ?? "").trim();
    if (form.kind === "login") {
      if (!f.identifier || !f.password) return;
      await this.d.vault.put("login", form.label, { identifier: f.identifier, password: f.password }, form.origin);
    } else if (form.kind === "card") {
      const number = clean("number").replace(/[\s-]/g, "");
      const exp = /^(\d{1,2})\s*\/\s*(\d{2,4})$/.exec(clean("exp"));
      if (!/^\d{12,19}$/.test(number) || !exp || !/^\d{3,4}$/.test(clean("cvc"))) return;
      const year = exp[2]!.length === 2 ? `20${exp[2]}` : exp[2]!;
      await this.d.vault.put("payment", "card", { name: clean("name"), number, expMonth: exp[1]!.padStart(2, "0"), expYear: year, cvc: clean("cvc"), zip: clean("zip") || undefined });
    } else {
      if (!clean("line1") || !clean("city") || !clean("postal")) return;
      await this.d.vault.put("address", "home", {
        name: clean("name"), line1: clean("line1"), line2: clean("line2") || undefined, city: clean("city"), region: clean("region"),
        postal: clean("postal"), country: clean("country") || "US", phone: clean("phone") || undefined,
      });
    }
    const task = await this.d.tasks.get(form.taskId);
    if (!task) return;
    await this.d.outbound.send(task.channel, task.threadId, `Saved your ${form.label}${form.kind === "login" ? " login" : ""}. Continuing.`);
    const skill = this.skill(task.skill);
    if (skill?.onInput && task.status === "awaiting_input") await this.guard(task, () => skill.onInput!(task, "done", this.ctx));
  }

  /** An email reached the owner's Momo inbox (already stored there). */
  async onEmail(email: Email): Promise<void> {
    let used = false;
    for (const t of await this.d.tasks.active()) {
      const skill = this.skill(t.skill);
      if (skill?.onEmail) {
        used = true;
        await this.guard(t, () => skill.onEmail!(t, email, this.ctx));
      }
    }
    // Setting up forwarding (e.g. Gmail) sends a confirmation code here; pass it on.
    if (!used && /forward/i.test(`${email.from} ${email.subject}`)) {
      const to = this.d.home ?? (await this.d.tasks.all()).at(-1);
      const code = guessCode(email);
      if (to) await this.d.outbound.send(to.channel, to.threadId, `Email forwarding confirmation: ${email.subject}${code ? `\nCode: ${code}` : ""}`);
    }
  }

  /**
   * Continue a task that was waiting on something outside the chat: the owner
   * finished in the live view, or a phone call ended.
   */
  async resumeTask(taskId: string, text: string): Promise<void> {
    const task = await this.d.tasks.get(taskId);
    const skill = task && this.skill(task.skill);
    if (task && skill?.onInput && ACTIVE.has(task.status)) await this.guard(task, () => skill.onInput!(task, text, this.ctx));
  }

  /** Fire due timers. Returns the next due time for wake scheduling. */
  async tick(): Promise<number | null> {
    for (const timer of await this.d.timers.takeDue(this.ctx.now().getTime())) {
      const t = await this.d.tasks.get(timer.taskId);
      const skill = t && this.skill(t.skill);
      if (t && skill?.onTimer) await this.guard(t, () => skill.onTimer!(t, timer.event, this.ctx));
    }
    return this.d.timers.nextDueAt();
  }

  /** One question per text; any task request skips straight past it. */
  private async onboard(text: string, say: (t: string) => Promise<void>): Promise<boolean> {
    const step = (await this.d.owners.state()).onboarding;
    if (step === "welcome") {
      await this.d.owners.setOnboarding("name");
      await say(
        "Hi, I'm Momo. Text me what you need and I'll get it done: bookings, reminders, errands on any website.\n" +
          "I always ask before I book or buy, and your passwords are encrypted so nobody, including me, reads them in chat.\n\n" +
          "What should I call you?",
      );
      return true;
    }
    if (step === "name") {
      const name = text.replace(/^(i'?m|i am|it'?s|call me|my name is|this is)\s+/i, "").replace(/[.!]+$/, "").trim();
      await this.d.memory.set("owner.name", name);
      await this.d.owners.setOnboarding("city");
      await say(`Nice to meet you, ${name}. What city are you in? (So "Friday at 7" means your Friday at 7.)`);
      return true;
    }
    if (step === "city") {
      await this.d.memory.set("owner.city", text.replace(/^(i'?m in|in)\s+/i, "").replace(/[.!]+$/, "").trim());
      await this.d.owners.setOnboarding("done");
      await say(
        "All set. Text me things like:\n" +
          "• book a table for 2 at Nopa Friday 7pm\n" +
          "• remind me to call mom tomorrow at 6pm\n" +
          "STOP cancels anything I'm doing. UNDO reverses the last thing I did. HELP shows this again.",
      );
      return true;
    }
    return false;
  }

  private skill(name: string): Skill | undefined {
    return this.d.skills.find((s) => s.name === name);
  }

  /** A failed step fails the task and tells the owner; it is never silently retried. */
  private async guard(task: Task, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      task.status = "failed";
      await this.d.tasks.save(task, `error: ${(e as Error).message}`);
      await this.d.outbound.send(task.channel, task.threadId, failureText(e as Error));
    }
  }
}

/** An .ics link in hosted mode (works for iPhone and Google), else a Google Calendar link. */
export function calendarLink(ev: CalendarEvent, publicUrl?: string): string {
  const compact = (t: string) => t.replace(/[-:]/g, "").slice(0, 13) + "00";
  const end = ev.end ?? new Date(Date.parse(`${ev.start}:00Z`) + 2 * 3600_000).toISOString().slice(0, 16);
  if (publicUrl) {
    const q = new URLSearchParams({ t: ev.title, s: ev.start, e: end, ...(ev.location && { l: ev.location }) });
    return `${publicUrl.replace(/\/$/, "")}/ics?${q}`;
  }
  const q = new URLSearchParams({ action: "TEMPLATE", text: ev.title, dates: `${compact(ev.start)}/${compact(end)}`, ...(ev.location && { location: ev.location }) });
  return `https://calendar.google.com/calendar/render?${q}`;
}

/** What to text the person when something failed: AI setup problems in plain words, anything else as it is. */
export function failureText(e: Error): string {
  const m = e.message;
  if (/\b(401|403)\b|invalid.*api.?key|unauthorized/i.test(m)) return "I can't reach my AI: its key was refused. Check the key in Momo's settings, then text me again.";
  if (/\b404\b|model.*(not found|does not exist|decommissioned)|unknown model/i.test(m)) return "I can't reach my AI: the model name in Momo's settings doesn't exist. Fix the model name, then text me again.";
  if (/\b429\b|quota|rate limit/i.test(m)) return "My AI is out of quota or rate-limited right now. Try again in a bit, or switch to a paid key.";
  return `I couldn't finish that: ${m.slice(0, 400)}`;
}
