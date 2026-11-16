// The orchestrator. Every inbound message goes through `handle`, in this order:
//   1. owner check (only the owner can start tasks or approve anything)
//   2. control words: STOP, UNDO, STATUS, HELP
//   3. approval replies (parsed by code, never by a model)
//   4. answers to a question a task is waiting on
//   5. a new task for the first skill that matches
// Anything else returns { handled: false } so the host (OpenClaw's general
// agent) can take it.

import type { Channel, InboundMessage, SecureFormSubmission } from "@momo/protocol";
import { ApprovalGate, YES_TO_ALL, type Approval, type ApprovalRequest } from "./approvals.ts";
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
  /** Set up ahead of any errand (onboarding): where to say it was saved. */
  to?: { channel: Channel; threadId: string };
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

/** Something of the owner's that Momo can work with: a website it signs in to, or an app on the computer. */
export interface Connection {
  name: string;
  url?: string;
  app?: string;
  /** Said to the owner when they pick it. */
  note?: string;
}

const CONNECTIONS: Array<Connection & { match: RegExp }> = [
  { name: "Gmail", match: /\bg-?mail\b|\bgoogle mail\b|\be-?mail\b/i, url: "https://mail.google.com" },
  { name: "Google Calendar", match: /\b(google\s+)?calendar\b|\bgcal\b/i, url: "https://calendar.google.com" },
  { name: "Google Drive", match: /\b(google\s+)?(drive|docs|sheets)\b/i, url: "https://drive.google.com" },
  { name: "WhatsApp", match: /\bwhats?\s?(app|up)\b/i, url: "https://web.whatsapp.com", note: "I'll open WhatsApp in my browser window on your computer; scan its QR code with your phone (WhatsApp > Linked devices)." },
  { name: "iMessage", match: /\bi-?messages?\b|\bimsg\b/i, app: "Messages", note: "this only works when I run on a Mac with access to its apps." },
  { name: "Notion", match: /\bnotion\b/i, url: "https://www.notion.so" },
  { name: "Granola", match: /\bgran+ol+a\b|\bgronol+a\b/i, app: "Granola" },
  { name: "Slack", match: /\bslack\b/i, url: "https://app.slack.com" },
  { name: "Outlook", match: /\boutlook\b|\bhotmail\b/i, url: "https://outlook.live.com/mail" },
  { name: "LinkedIn", match: /\blinked\s?in\b/i, url: "https://www.linkedin.com" },
  { name: "Amazon", match: /\bamazon\b/i, url: "https://www.amazon.com" },
];

const list = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/**
 * The services named in a reply. "all" means every one Momo listed. With `strict`
 * (an unprompted reply to the welcome question) only known names count, so an
 * errand texted instead isn't mistaken for a list; after "connect ...", anything
 * else named is kept too, to be found as a website or an app.
 */
export function pickConnections(text: string, strict = false): Connection[] {
  const strip = ({ match: _m, ...c }: Connection & { match: RegExp }): Connection => c;
  if (/^\s*(all|everything|all of (them|it|those)|yes,? all)\b[\s.!]*$/i.test(text)) return CONNECTIONS.map(strip);
  const known = CONNECTIONS.filter((c) => c.match.test(text));
  let rest = text;
  for (const c of known) rest = rest.replace(new RegExp(c.match.source, "gi"), ",");
  const others = rest
    .split(/,|\band\b|&|\+|\n/i)
    .map((w) => w.replace(/\b(my|the|account|accounts|app|too|also|please|all)\b/gi, "").replace(/[.!?]+$/, "").trim())
    .filter((w) => /^[\w .'-]{2,40}$/.test(w));
  if (strict) {
    // A plain list of names and nothing else, or it isn't an answer to the question.
    if (!known.length || others.length) return [];
    return known.map(strip);
  }
  return [...known.map(strip), ...others.map((name) => ({ name: name[0]!.toUpperCase() + name.slice(1) }))];
}

/** "stop", "can you stop it", "please cancel that", "never mind": halt everything in progress. */
export const STOP = /^(?:(?:please|pls|ok|hey|momo)[\s,]+)*(?:(?:can|could|will|would) you\s+)?(?:(?:please|just)\s+)?(?:stop|cancel|abort|quit|halt|never ?mind|nvm)(?:\s+(?:it|that|this|everything|all|now|please|doing that|the task|the errand))*[\s.!?]*$/i;

/**
 * A login texted in reply to "what's your email and password?": "ana@example.com MyPassword",
 * the two on separate lines, or "email is ... password is ...". Anything that reads like a
 * sentence instead is left alone.
 */
export function parseLogin(text: string): { identifier: string; password: string } | undefined {
  const t = text.trim();
  if (t.length > 300) return undefined;
  const labelled = /(?:e-?mail|user(?:name)?|login|id)\s*(?:is\s+|[:=]\s*)?(\S+?)[\s,;]+(?:and\s+)?(?:the\s+)?(?:password|pass|pw)\s*(?:is\s+|[:=]\s*)?(\S.*)$/is.exec(t);
  if (labelled && !labelled[2]!.includes("\n")) return { identifier: labelled[1]!, password: labelled[2]!.trim() };
  const m = /^(\S+)\s*[\s,;|]\s*(\S+)$/.exec(t);
  if (!m) return undefined;
  const [, id, pw] = m as unknown as [string, string, string];
  const looksLikeId = /^[^\s@]+@[^\s@]+\.\w{2,}$/.test(id) || /^\+?\d[\d-]{6,}$/.test(id) || /^\S+\s*\n\s*\S+$/.test(t);
  if (!looksLikeId || pw.length < 4) return undefined;
  return { identifier: id, password: pw };
}

/** Added to the answerer's instructions so anything that needs doing becomes an errand, whatever its wording. */
const DO_HINT =
  "You can also act: you have a web browser, the owner's computer and apps, and can phone businesses. " +
  "If this message asks for something that needs any of those (look at a page or site, open or check something, find, compare, book, buy, send, fill in, download, anything on the computer), " +
  "or asks for a fact that changes and should be looked up rather than remembered (opening hours today, prices, availability, schedules, a delivery's status, the weather, news), " +
  "reply with exactly the single word DO and nothing else, and it will be done. Otherwise just answer.";

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
    // Raw error text from a provider is noise to the model, and has read to its safety filter as an attack.
    const plain = (t: string) => t.replace(/^I couldn't finish that: [\s\S]*$/, "I couldn't finish that (a technical error on my side).");
    return all.slice(-max).map((l) => `${l.who === "owner" ? "Owner" : "Momo"}: ${plain(l.text)}`).join("\n");
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
        // Just ask. The owner can text it like they'd tell a person; the private link is there for those who'd rather not.
        const ask =
          `To do this I need to sign in to ${label}. Text me your email (or username) and password for it, like this:\n` +
          `ana@example.com MyPassword\n` +
          `I keep it encrypted, use it only on ${label}, and never repeat it.`;
        const link = deps.secureLinks ? await deps.secureLinks.create({ kind: "login", label }) : undefined;
        await deps.pendingForms.update((all) =>
          all.concat({ id: link?.id ?? `chat-${task.id}`, kind: "login", origin, label, taskId: task.id, createdAt: now().getTime() }),
        );
        return link
          ? `${ask}\n\nRather not type it in chat? Add it here instead. It's encrypted on your phone before it's sent:\n${link.url}`
          : `${ask}\n\nRather not type it in chat? Save it on your computer with: momo vault add-login ${origin}\nThen text me "done".`;
      },
      requestSecret: async (task, kind) => {
        const what = kind === "card" ? "card" : "delivery address";
        if (!deps.secureLinks) return `I need your ${what}. Save it on your computer with: momo vault add-${kind}\nThen text me "done".`;
        const link = await deps.secureLinks.create({ kind, label: what });
        await deps.pendingForms.update((all) => all.concat({ id: link.id, kind, label: what, taskId: task.id, createdAt: now().getTime() }));
        return kind === "card"
          ? `To pay, add the card you want me to use. It's encrypted on your phone and I never see the number:\n${link.url}`
          : `This one gets delivered, so I need an address to put on the order. Add it here (saved for next time):\n${link.url}`;
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

    // The login Momo asked for, texted back: saved, never kept in the conversation.
    const login = await this.loginFromChat(msg, text);
    if (login) return login;

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

    if (STOP.test(text)) {
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
          `I tell you exactly what I did when it's done. STOP cancels everything in progress. UNDO reverses the last thing I did.`,
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

    // An errand is waiting on a yes or no and the owner said something else: that's for the errand
    // ("yes to all", "use the other profile", "you decide"), not a new errand on top of it.
    const asked = (await this.d.tasks.active(msg.threadId)).filter((t) => t.status === "awaiting_approval");
    const asking1 = asked.at(-1);
    const askSkill = asking1 && this.skill(asking1.skill);
    // (A message that reads as a request of its own still starts its own errand.)
    const itsOwnErrand = !YES_TO_ALL.test(text) && (/https?:\/\//i.test(text) || this.d.skills.some((s) => s.matches(text)));
    if (asking1 && asking1.skill === "web" && askSkill?.onInput && !itsOwnErrand) {
      // Older errands still waiting on an answer nobody gave are closed, so their questions don't pile up.
      for (const old of asked.slice(0, -1)) {
        old.status = "cancelled";
        await this.d.approvals.cancelForTask(old.id);
        await this.d.tasks.save(old, "superseded");
      }
      await this.guard(asking1, () => askSkill.onInput!(asking1, text, this.ctx));
      return { handled: true, taskId: asking1.id };
    }

    const waiting = await this.d.tasks.awaitingInput(msg.threadId);
    if (waiting) {
      const skill = this.skill(waiting.skill);
      if (skill?.onInput) {
        await this.guard(waiting, () => skill.onInput!(waiting, text, this.ctx));
        return { handled: true, taskId: waiting.id };
      }
    }

    // "Gmail, WhatsApp and Notion" after the welcome, or "connect my Slack" any time.
    const connecting = await this.connect(msg, text, say);
    if (connecting) return connecting;

    // "did you book it?" is a question about what happened, not a new booking.
    const asking = !!this.d.answer && ASKING.test(text) && text.length < 80;
    // Sent while Momo was busy with an errand ("I see you opened the browser", "make it Tuesday"): usually a
    // remark on that errand, so its wording alone doesn't start a new one; the model decides.
    const busy = JSON.parse((await this.d.memory.get("busy.last")) ?? "null") as { from: number; until: number; what: string } | null;
    const during = !!this.d.answer && !!busy && msg.receivedAt >= busy.from - 1000 && msg.receivedAt + 1000 < busy.until && !/https?:\/\//i.test(text);
    let skill = asking || during ? undefined : this.d.skills.find((s) => s.matches(text));
    if (!skill && (await this.onboard(msg, text, say))) return { handled: true };
    if (!skill && this.d.answer) {
      // Not obviously an errand by its wording: let the model say whether it's something to DO.
      const doer = asking ? undefined : this.d.skills.find((s) => s.name === "web");
      const name = await this.d.memory.get("owner.name");
      const city = await this.d.memory.get("owner.city");
      const recent = await this.recentConversation();
      const context = [name && `Owner: ${name}.`, city && `City: ${city}.`, `Now: ${this.ctx.now().toString()}`, recent && `\nRecent conversation (oldest first):\n${recent}`].filter(Boolean).join(" ");
      const aside = during
        ? `\n\nThe owner sent this while you were busy with the errand "${busy!.what}", which has since ended (see the recent conversation for how). ` +
          "If it is a remark about that errand, or adds or corrects a detail of it, do not reply DO: answer in a sentence or two, saying how that errand ended and, if it didn't finish, offering to try again with what they added. Reply DO only if it is clearly a separate new request."
        : "";
      const reply = await this.d.answer(text, doer ? `${context}\n\n${DO_HINT}${aside}` : context);
      if (doer && /^\W*DO\W*$/i.test(reply.trim())) {
        skill = doer;
      } else {
        await say(reply || "I'm not sure what you mean. Tell me what you'd like done, in a sentence.");
        return { handled: true };
      }
    }
    if (!skill) return { handled: false };
    const task = await this.d.tasks.create({ skill: skill.name, channel: msg.channel, threadId: msg.threadId, from: msg.from, request: text });
    await this.guard(task, () => skill.start(task, this.ctx));
    return { handled: true, taskId: task.id };
  }

  private async loginFromChat(msg: InboundMessage, text: string): Promise<HandleResult | undefined> {
    const creds = parseLogin(text);
    if (!creds) return undefined;
    const waiting = await this.d.tasks.awaitingInput(msg.threadId);
    const form = waiting && (await this.d.pendingForms.read()).findLast((f) => f.kind === "login" && f.taskId === waiting.id);
    if (!waiting || !form) return undefined;
    await this.d.vault.put("login", form.label, creds, form.origin);
    await this.d.pendingForms.update((all) => all.filter((f) => f.id !== form.id));
    await this.note("owner", `(sent their ${form.label} login)`);
    await this.d.outbound.send(msg.channel, msg.threadId, `Saved your ${form.label} login. Continuing. (You can delete that message from our chat now; I have it.)`);
    const skill = this.skill(waiting.skill);
    if (skill?.onInput) await this.guard(waiting, () => skill.onInput!(waiting, "done", this.ctx));
    return { handled: true, taskId: waiting.id };
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
    const task = form.taskId ? await this.d.tasks.get(form.taskId) : undefined;
    if (!task) {
      if (form.to) await this.d.outbound.send(form.to.channel, form.to.threadId, form.kind === "card" ? "Saved your card. I'll use it when you ask me to buy something." : "Saved your address. Deliveries go there from now on.");
      return;
    }
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
  private async onboard(msg: InboundMessage, text: string, say: (t: string) => Promise<void>): Promise<boolean> {
    const step = (await this.d.owners.state()).onboarding;
    if (step === "welcome") {
      await this.d.owners.setOnboarding("name");
      await say(
        "Hi, I'm Momo. Text me what you need and I'll get it done: bookings, reminders, errands on any website.\n" +
          "One text is enough: I do it, then tell you exactly what I did. Your passwords are encrypted so nobody, including me, reads them in chat.\n\n" +
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
      await this.d.memory.set("connect.ask", "1");
      // Everything an errand might stop to ask for later is offered here, once, in one message.
      const links: string[] = [];
      if (this.d.secureLinks) {
        for (const [kind, label, what] of [["card", "card", "A card, for when you ask me to buy something"], ["address", "delivery address", "An address, for deliveries"]] as const) {
          const link = await this.d.secureLinks.create({ kind, label });
          await this.d.pendingForms.update((all) => all.concat({ id: link.id, kind, label, taskId: "", createdAt: this.ctx.now().getTime(), to: { channel: msg.channel, threadId: msg.threadId } }));
          links.push(`• ${what}: ${link.url}`);
        }
      }
      await say(
        "All set. One last step, so that from here on one text is enough. Reply in one message with whatever applies (or skip it all):\n" +
          "• The phone number and email to put on bookings\n" +
          `• What to connect, so I can work with your own stuff: ${CONNECTIONS.map((c) => c.name).join(", ")}, or anything else you use (or "all")\n` +
          (links.length ? `${links.join("\n")}\n` : "") +
          "For example: 360 555 0142, ana@example.com, Gmail, Google Calendar and Notion\n\n" +
          "Or just text me an errand, like:\n" +
          "• book a table for 2 at Nopa Friday 7pm\n" +
          "• remind me to call mom tomorrow at 6pm\n" +
          "STOP cancels anything I'm doing. UNDO reverses the last thing I did. HELP shows this again.",
      );
      return true;
    }
    return false;
  }

  /** The owner names services to connect: remember them, then go and check each one is signed in. */
  private async connect(msg: InboundMessage, text: string, say: (t: string) => Promise<void>): Promise<HandleResult | undefined> {
    // Waiting for the owner to close their browser, so its sign-ins can be used for what they picked.
    const held = JSON.parse((await this.d.memory.get("connect.wait")) || "null") as { picked: Connection[]; tries: number } | null;
    if (held) {
      await this.d.memory.set("connect.wait", "");
      // An errand texted instead: that comes first; "connect ..." picks this up again any time.
      if (/https?:\/\//i.test(text) || this.d.skills.some((k) => k.matches(text))) return undefined;
      const web = this.skill("web") as (Skill & { retrySignIns?: () => Promise<string> }) | undefined;
      const skip = /^(skip|no|nope|later|not now|can'?t)\b/i.test(text.trim());
      const still = skip ? "" : ((await web?.retrySignIns?.().catch(() => "")) ?? "");
      if (still && held.tries < 2) {
        await this.d.memory.set("connect.wait", JSON.stringify({ picked: held.picked, tries: held.tries + 1 }));
        await say(`${still} still looks open. It can keep running after its windows close: right-click its icon near the clock (or in the menu bar) and choose Exit or Quit. Text me "done" then, or "skip" and I'll ask for logins instead.`);
        return { handled: true };
      }
      return this.startConnecting(msg, held.picked, say, skip || still ? "" : "Got your sign-ins. ");
    }

    const justAsked = (await this.d.memory.get("connect.ask")) === "1";
    if (justAsked) await this.d.memory.set("connect.ask", "");
    const asked = /^(?:please\s+)?connect(?:\s+(?:to|me to|my|with))?\s+(.+)$/i.exec(text)?.[1];
    if (!asked && !justAsked) return undefined;
    if (!asked && /^(skip|no|none|nope|later|not now|nothing)\b[\s.!]*$/i.test(text)) {
      await say("No problem. Say \"connect Gmail\" (or anything else) whenever you want.");
      return { handled: true };
    }
    // The same reply may carry the phone and email for bookings: kept, so no form ever has to stop and ask.
    let rest = asked ?? text;
    const kept: string[] = [];
    if (!asked) {
      const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(rest)?.[0];
      if (email) rest = rest.replace(email, " ");
      const phone = /\+?\d[\d\s().-]{7,}\d/.exec(rest)?.[0];
      if (phone && phone.replace(/\D/g, "").length >= 10) rest = rest.replace(phone, " ");
      if (phone && phone.replace(/\D/g, "").length >= 10) (await this.d.memory.set("pref.phone", phone.trim()), kept.push("phone number"));
      if (email) (await this.d.memory.set("pref.email", email), kept.push("email"));
      rest = rest.replace(/^[\s,;.]+|[\s,;.]+$/g, "").replace(/\s*,(\s*,)+/g, ",");
    }
    const picked = pickConnections(rest, !asked);
    if (!picked.length) {
      if (!kept.length) return undefined; // not an answer to the question: carry on as a normal message
      await say(`Saved your ${list(kept)} for bookings. Say "connect Gmail" (or anything else) whenever you want.`);
      return { handled: true };
    }
    const before = JSON.parse((await this.d.memory.get("owner.connections")) || "[]") as Connection[];
    const all = [...before.filter((b) => !picked.some((p) => p.name === b.name)), ...picked];
    await this.d.memory.set("owner.connections", JSON.stringify(all));
    const saved = kept.length ? `Saved your ${list(kept)} for bookings. ` : "";
    // Their own browser is open, so its sign-ins couldn't be copied yet: get that done first, once,
    // rather than asking for a password per service.
    const waitingOn = (this.skill("web") as (Skill & { signInsWaiting?: () => string }) | undefined)?.signInsWaiting?.() ?? "";
    if (waitingOn) {
      await this.d.memory.set("connect.wait", JSON.stringify({ picked, tries: 1 }));
      await say(`${saved}Before I connect ${list(picked.map((c) => c.name))}: close all your ${waitingOn} windows once, so I can use the accounts you're already signed in to (you can reopen it right after). Text me "done" when they're closed, or "skip" and I'll ask for logins instead.`);
      return { handled: true };
    }
    return this.startConnecting(msg, picked, say, saved);
  }

  private async startConnecting(msg: InboundMessage, picked: Connection[], say: (t: string) => Promise<void>, lead = ""): Promise<HandleResult> {
    const web = this.skill("web");
    const notes = picked.filter((c) => c.note).map((c) => `${c.name}: ${c.note}`);
    await say(`${lead}Connecting ${list(picked.map((c) => c.name))}. I'll open each one and tell you which are ready.${notes.length ? `\n${notes.join("\n")}` : ""}`);
    if (!web) return { handled: true };
    const request =
      `Connect the owner's accounts. For each service below, open it and see whether it is signed in. If it isn't, try the owner's other browser accounts (use_account), then sign_in. ` +
      `Don't read, send or change anything in them. Finish with one short line per service: ready (and under which account), or exactly what the owner needs to do.\n` +
      picked.map((c) => `- ${c.name}${c.url ? `: ${c.url}` : c.app ? `: the ${c.app} app on this computer (computer_open)` : ": find its website or app"}`).join("\n");
    const task = await this.d.tasks.create({ skill: web.name, channel: msg.channel, threadId: msg.threadId, from: msg.from, request });
    await this.guard(task, () => web.start(task, this.ctx));
    return { handled: true, taskId: task.id };
  }

  private skill(name: string): Skill | undefined {
    return this.d.skills.find((s) => s.name === name);
  }

  /** A failed step fails the task and tells the owner; it is never silently retried. */
  private async guard(task: Task, fn: () => Promise<unknown>): Promise<void> {
    const from = Date.now();
    try {
      await fn();
    } catch (e) {
      task.status = "failed";
      await this.d.tasks.save(task, `error: ${(e as Error).message}`);
      await this.d.outbound.send(task.channel, task.threadId, failureText(e as Error));
    }
    // When Momo was last busy, so texts sent meanwhile can be told from new requests.
    await this.d.memory.set("busy.last", JSON.stringify({ from, until: Date.now(), what: task.request.slice(0, 200) })).catch(() => {});
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
  if (/the AI declined to continue/i.test(m)) return `I've stopped this errand: ${m.replace(/^.*?the AI declined/i, "my AI declined")}. Nothing was booked, bought or changed. That's its safety filter, not something you did. Ask me again in different words, or tell me a different way to go about it.`;
  if (/\b413\b|request too large|context.{0,12}length/i.test(m)) return "My AI key's allowance is too small for this errand, even after cutting pages down. Websites need room to read: upgrade the key's plan with its provider, or pick another AI in Momo's settings, then text me again.";
  if (/\b429\b|quota|rate limit/i.test(m)) return "My AI is out of quota or rate-limited right now. Try again in a bit, or switch to a paid key.";
  return `I couldn't finish that: ${m.slice(0, 400)}`;
}
