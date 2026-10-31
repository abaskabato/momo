// "Book a table for 4 at Nopa friday 7pm" -> search -> (pick a slot) ->
// confirm-before-commit -> book -> confirmation + undo + reminder.

import type { Approval } from "../../approvals.ts";
import type { Skill, SkillContext } from "../../skill.ts";
import type { Task } from "../../tasks.ts";
import { humanDate, humanTime, isReservationRequest, missingFields, parseReservation, type MissingField, type ReservationIntent } from "./intent.ts";
import { exposureUsd, rankSlots, type ReservationProvider, type SearchResult, type Slot } from "./provider.ts";

const ACTION = "restaurant.book";
const REMINDER_LEAD_MS = 3 * 3600_000;

interface State {
  intent: ReservationIntent;
  asking?: MissingField | "choice" | "login";
  options?: Slot[];
  venue?: SearchResult["venue"];
  policy?: SearchResult["policy"];
  chosen?: Slot;
  confirmation?: string;
}

const QUESTIONS: Record<MissingField, string> = {
  restaurant: "Which restaurant?",
  date: "What day?",
  time: "What time?",
  party: "How many people?",
};

export class RestaurantSkill implements Skill {
  readonly name = "restaurant";
  readonly description = "book, change, or cancel restaurant reservations";
  private readonly provider: ReservationProvider;

  constructor(provider: ReservationProvider) {
    this.provider = provider;
  }

  matches(text: string): boolean {
    return isReservationRequest(text);
  }

  async start(task: Task, ctx: SkillContext): Promise<void> {
    const intent = parseReservation(task.request, ctx.now());
    if (!intent.party) {
      const usual = await ctx.memory.get("restaurant.party");
      if (usual) intent.party = Number(usual);
    }
    task.data = { intent } satisfies State;
    await this.advance(task, ctx);
  }

  async onInput(task: Task, text: string, ctx: SkillContext): Promise<void> {
    const s = task.data as unknown as State;
    const answer = text.trim();

    if (s.asking === "choice") {
      const n = Number(/^\s*(\d+)/.exec(answer)?.[1]);
      const pick = s.options?.[n - 1] ?? s.options?.find((o) => humanTime(o.time) === answer.toLowerCase().replace(/\s/g, ""));
      if (!pick) return ctx.reply(task, `Reply with a number from 1 to ${s.options?.length ?? 0}.`);
      s.chosen = pick;
      return this.requestApproval(task, ctx);
    }
    if (s.asking === "login") {
      return this.advance(task, ctx);
    }

    // Re-parse the answer as if it were part of the original request.
    const patch = parseReservation(`${answer}`, ctx.now());
    if (s.asking === "party") patch.party ??= Number(/\d+/.exec(answer)?.[0]) || undefined;
    if (s.asking === "restaurant") patch.restaurant ??= answer.replace(/^(at|book)\s+/i, "");
    if (s.asking === "time" && !patch.time) patch.time = parseReservation(`at ${answer}`, ctx.now()).time;
    for (const k of ["restaurant", "date", "time", "party"] as const) {
      if (patch[k] !== undefined && s.intent[k] === undefined) (s.intent as unknown as Record<string, unknown>)[k] = patch[k];
    }
    s.intent.flexible ||= patch.flexible;
    await this.advance(task, ctx);
  }

  private async advance(task: Task, ctx: SkillContext): Promise<void> {
    const s = task.data as unknown as State;
    const missing = missingFields(s.intent);
    if (missing.length) {
      s.asking = missing[0];
      task.status = "awaiting_input";
      await ctx.tasks.save(task, `asked for ${missing[0]}`);
      return ctx.reply(task, QUESTIONS[missing[0]!]);
    }

    // Refuse to ask for approval we couldn't act on: check the login first.
    if (!(await ctx.vault.findLogin(this.provider.origin))) {
      s.asking = "login";
      task.status = "awaiting_input";
      await ctx.tasks.save(task, "needs login");
      return ctx.reply(task, await ctx.requestLogin(task, this.provider.origin, hostOf(this.provider.origin)));
    }

    const { restaurant, date, time, party } = s.intent as Required<ReservationIntent>;
    task.status = "running";
    await ctx.tasks.save(task, `searching ${restaurant}`);
    const found = await this.provider.search({ restaurant, date, time, party }, { vault: ctx.vault });
    if (!found) {
      task.status = "failed";
      await ctx.tasks.save(task, "venue not found");
      return ctx.reply(task, `I couldn't find ${restaurant} on ${hostOf(this.provider.origin)}. Is there another name it goes by?`);
    }
    s.venue = found.venue;
    s.policy = found.policy;

    const ranked = rankSlots(found.slots, time);
    const exact = ranked.find((x) => x.time === time);
    const near = ranked[0];
    const closeEnough = near && s.intent.flexible && Math.abs(minutes(near.time) - minutes(time)) <= 30;

    if (exact || closeEnough) {
      s.chosen = exact ?? near;
      return this.requestApproval(task, ctx);
    }
    if (ranked.length === 0) {
      task.status = "done";
      await ctx.tasks.save(task, "no availability");
      return ctx.reply(task, `${found.venue.name} has nothing near ${humanTime(time)} on ${humanDate(date)}. Want me to try another day?`);
    }
    s.options = ranked.slice(0, 3);
    s.asking = "choice";
    task.status = "awaiting_input";
    await ctx.tasks.save(task, "offered alternatives");
    const list = s.options.map((o, i) => `${i + 1}) ${humanTime(o.time)}`).join("  ");
    return ctx.reply(task, `${humanTime(time)} is taken at ${found.venue.name} on ${humanDate(date)}. Closest: ${list}. Reply with a number.`);
  }

  private bookArgs(s: State): Record<string, unknown> {
    return { provider: this.provider.id, venueId: s.venue!.id, slot: s.chosen! };
  }

  private async requestApproval(task: Task, ctx: SkillContext): Promise<void> {
    const s = task.data as unknown as State;
    const slot = s.chosen!;
    const fee = s.policy?.noShowFeePerPersonUsd;
    const exposure = exposureUsd(s.policy ?? {}, slot.party);
    const terms = fee ? ` No-show fee $${fee}/person ($${exposure} total) if you skip it.` : " No fees.";
    s.asking = undefined;
    task.status = "awaiting_approval";
    await ctx.tasks.save(task, `approval for ${slot.time}`);
    await ctx.askApproval(task, {
      action: ACTION,
      args: this.bookArgs(s),
      risk: exposure > 0 ? "purchase" : "irreversible",
      amountUsd: exposure,
      summary: `Book ${s.venue!.name}, ${humanDate(slot.date, slot.time)}, ${slot.party} ${slot.party === 1 ? "person" : "people"}?${terms}`,
    });
  }

  async onApproved(task: Task, _approval: Approval, ctx: SkillContext): Promise<void> {
    const s = task.data as unknown as State;
    const slot = s.chosen!;
    const exposure = exposureUsd(s.policy ?? {}, slot.party);
    await ctx.spend.approveCap(task, exposure);
    // The commit re-checks the approval against these exact arguments.
    await ctx.approvals.consume(task.id, ACTION, this.bookArgs(s), exposure);

    task.status = "running";
    await ctx.tasks.save(task, "booking");
    const result = await this.provider.book(s.venue!.id, slot, { vault: ctx.vault });
    ctx.spend.charge(task, result.chargedUsd);

    s.confirmation = result.confirmation;
    task.status = "done";
    task.undo = {
      action: "restaurant.cancel",
      args: { confirmation: result.confirmation },
      summary: `cancel ${s.venue!.name} ${humanDate(slot.date, slot.time)}`,
    };
    await ctx.tasks.save(task, `booked ${result.confirmation}`);

    await ctx.memory.set("restaurant.party", String(slot.party));
    await ctx.memory.note(`Booked ${s.venue!.name} ${humanDate(slot.date, slot.time)} for ${slot.party} (${result.confirmation})`);
    const [y, m, d] = slot.date.split("-").map(Number);
    const [hh, mm] = slot.time.split(":").map(Number);
    const at = new Date(y!, m! - 1, d!, hh!, mm!).getTime();
    if (at - REMINDER_LEAD_MS > ctx.now().getTime()) await ctx.timers.add(task.id, "reminder", at - REMINDER_LEAD_MS);

    await ctx.reply(
      task,
      `Booked. ${s.venue!.name}, ${humanDate(slot.date, slot.time)}, ${slot.party} people. Confirmation ${result.confirmation}.\nText UNDO to cancel it.`,
    );
  }

  async onDenied(task: Task, _approval: Approval, ctx: SkillContext): Promise<void> {
    task.status = "cancelled";
    await ctx.tasks.save(task, "owner declined");
    await ctx.reply(task, "OK, I won't book it.");
  }

  async onTimer(task: Task, event: string, ctx: SkillContext): Promise<void> {
    const s = task.data as unknown as State;
    if (event === "reminder" && task.status === "done" && s.chosen) {
      await ctx.reply(task, `Reminder: ${s.venue!.name} at ${humanTime(s.chosen.time)} today, ${s.chosen.party} people. Confirmation ${s.confirmation}.`);
    }
  }

  async undo(task: Task, ctx: SkillContext): Promise<string> {
    const s = task.data as unknown as State;
    await this.provider.cancel(String(task.undo!.args.confirmation), { vault: ctx.vault });
    await ctx.timers.cancelForTask(task.id);
    task.status = "undone";
    task.undo = undefined;
    await ctx.tasks.save(task, "cancelled by owner");
    await ctx.memory.note(`Cancelled ${s.venue!.name} ${s.confirmation}`);
    return `Cancelled your ${s.venue!.name} reservation (${s.confirmation}).`;
  }
}

function minutes(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

function hostOf(origin: string): string {
  return new URL(origin).host;
}
