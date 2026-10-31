// "remind me to call mom tomorrow at 6pm", "remind me in 20 minutes to
// move the car", "follow up with Sam on friday".

import type { Approval } from "../approvals.ts";
import type { Skill, SkillContext } from "../skill.ts";
import type { Task } from "../tasks.ts";
import { humanDate, humanTime, parseReservation } from "./restaurant/intent.ts";

export interface ParsedReminder {
  what: string;
  at: number;
}

export function parseReminder(text: string, now: Date): ParsedReminder | null {
  const t = text.trim();
  if (!/^(remind me|reminder|ping me|follow up|nudge me)\b/i.test(t)) return null;

  const rel = /\bin (\d+|an?|half an?)\s*(min(?:ute)?s?|hours?|hrs?|days?)\b/i.exec(t);
  let at: number | null = null;
  if (rel) {
    const n = /^half/i.test(rel[1]!) ? 0.5 : /^an?$/i.test(rel[1]!) ? 1 : Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const ms = unit.startsWith("min") ? 60_000 : unit.startsWith("h") ? 3600_000 : 86_400_000;
    at = now.getTime() + n * ms;
  } else {
    const p = parseReservation(t.replace(/\b(dinner|lunch|brunch)\b/gi, ""), now);
    const date = p.date ?? (p.time ? isoToday(now) : undefined);
    if (date) {
      // A time that already passed today means tomorrow; no time means 9am.
      const time = p.time ?? (/\b(tonight|evening)\b/i.test(t) ? "19:00" : "09:00");
      const [y, m, d] = date.split("-").map(Number);
      const [hh, mm] = time.split(":").map(Number);
      at = new Date(y!, m! - 1, d!, hh!, mm!).getTime();
      if (!p.date && at <= now.getTime()) at += 86_400_000;
    }
  }
  if (at === null) return null;

  const what = t
    .replace(/^(remind me|reminder|ping me|nudge me)\s*(to|about|that)?\s*/i, "")
    .replace(/\bin (\d+|an?|half an?)\s*(min(?:ute)?s?|hours?|hrs?|days?)\b/i, "")
    .replace(/\b(today|tonight|tomorrow|(next |this )?(mon|tues|wednes|thurs|fri|satur|sun)day)\b/gi, "")
    .replace(/\b(at|around|by)\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/gi, "")
    .replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^(to|about)\s+/i, "")
    .replace(/[.!]+$/, "");
  return { what: what || "your reminder", at };
}

function isoToday(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class RemindersSkill implements Skill {
  readonly name = "reminders";
  readonly description = "set reminders and follow-ups";

  matches(text: string): boolean {
    return /^(remind me|reminder|ping me|follow up|nudge me)\b/i.test(text.trim());
  }

  async start(task: Task, ctx: SkillContext): Promise<void> {
    const r = parseReminder(task.request, ctx.now());
    if (!r) {
      task.status = "awaiting_input";
      await ctx.tasks.save(task, "asked when");
      return ctx.reply(task, "When should I remind you?");
    }
    await this.schedule(task, ctx, r);
  }

  async onInput(task: Task, text: string, ctx: SkillContext): Promise<void> {
    const r = parseReminder(`remind me ${text}`, ctx.now());
    if (!r) return ctx.reply(task, 'Try something like "tomorrow at 9" or "in 2 hours".');
    const original = parseReminder(`${task.request} in 1 minute`, ctx.now());
    await this.schedule(task, ctx, { what: original?.what ?? r.what, at: r.at });
  }

  private async schedule(task: Task, ctx: SkillContext, r: ParsedReminder): Promise<void> {
    task.data = { what: r.what, at: r.at };
    task.status = "waiting";
    task.undo = { action: "reminders.cancel", args: {}, summary: `cancel reminder: ${r.what}` };
    await ctx.timers.add(task.id, "remind", r.at);
    await ctx.tasks.save(task, `scheduled ${new Date(r.at).toISOString()}`);
    const d = new Date(r.at);
    const iso = isoToday(d);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const when = iso === isoToday(ctx.now()) ? `today at ${humanTime(hhmm)}` : humanDate(iso, hhmm);
    await ctx.reply(task, `Got it. I'll remind you ${when}: ${r.what}.`);
  }

  async onApproved(_t: Task, _a: Approval, _c: SkillContext): Promise<void> {}

  async onTimer(task: Task, event: string, ctx: SkillContext): Promise<void> {
    if (event !== "remind" || task.status !== "waiting") return;
    task.status = "done";
    task.undo = undefined;
    await ctx.tasks.save(task, "reminded");
    await ctx.reply(task, `Reminder: ${String(task.data.what)}`);
  }

  async undo(task: Task, ctx: SkillContext): Promise<string> {
    await ctx.timers.cancelForTask(task.id);
    task.status = "cancelled";
    task.undo = undefined;
    await ctx.tasks.save(task, "reminder cancelled");
    return `Cancelled the reminder: ${String(task.data.what)}.`;
  }
}
