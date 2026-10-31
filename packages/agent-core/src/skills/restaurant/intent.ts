// Turns "book a table for 4 at Nopa friday around 7pm" into a structured
// request. Deterministic rules first; the model router can fill gaps, but the
// common phrasings never need a model call.

export interface ReservationIntent {
  restaurant?: string;
  /** YYYY-MM-DD in the owner's local time. */
  date?: string;
  /** HH:MM, 24h. */
  time?: string;
  party?: number;
  /** "around 7" -> willing to take a nearby slot without asking. */
  flexible: boolean;
}

export type MissingField = "restaurant" | "date" | "time" | "party";

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  a: 1, me: 1, couple: 2,
};
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const STOP_WORDS = new Set([
  "for", "on", "at", "this", "next", "tomorrow", "tonight", "today", "around", "about", "near", "with", "party", "table",
  ...WEEKDAYS, ...WEEKDAYS.map((d) => d.slice(0, 3)),
  ...MONTHS, "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december",
]);

export function isReservationRequest(text: string): boolean {
  return /\b(book|reserve|reservation|table|res)\b/i.test(text) && /\b(table|dinner|lunch|brunch|reservation|restaurant|at\s+\w+|for\s+\w+)\b/i.test(text);
}

export function parseReservation(text: string, today: Date = new Date()): ReservationIntent {
  const t = ` ${text.toLowerCase().replace(/[,!?]/g, " ")} `;
  const out: ReservationIntent = { flexible: /\b(around|about|ish|roughly|or so|anytime|any time)\b/.test(t) };

  // Party size: "for 4", "party of 4", "4 people", "table for two", "for me and my wife".
  const party =
    /\bparty of (\d+|\w+)\b/.exec(t) ??
    /\b(\d+|\w+) (?:people|ppl|guests|of us|persons|pax)\b/.exec(t) ??
    /\b(?:table|reservation|res) for (\d+|\w+)\b/.exec(t) ??
    /\bfor (\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b(?!\s*(?::|am|pm|o'?clock))/.exec(t);
  if (party) {
    const n = /^\d+$/.test(party[1]!) ? Number(party[1]) : NUMBER_WORDS[party[1]!];
    if (n && n > 0 && n <= 20) out.party = n;
  } else if (/\bfor (?:me and|us two|the two of us)\b/.test(t)) {
    out.party = 2;
  }

  // Time: "7pm", "7:30 pm", "19:00", "at 7", "noon".
  const tm = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(t) ?? /\b(\d{1,2}):(\d{2})\b/.exec(t) ?? /\b(?:at|around|about) (\d{1,2})\b(?!\s*(?:people|ppl|guests))/.exec(t);
  if (/\bnoon\b/.test(t)) out.time = "12:00";
  else if (tm) {
    let h = Number(tm[1]);
    const min = tm[2] ? Number(tm[2]) : 0;
    const ampm = tm[3];
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    // "at 7" / "7:30" with no am/pm means evening, unless it's a morning meal.
    if (!ampm && h >= 1 && h <= 10 && !/\b(breakfast|brunch|morning)\b/.test(t)) h += 12;
    if (h <= 23 && min <= 59) out.time = `${pad(h)}:${pad(min)}`;
  } else if (/\btonight\b/.test(t) || /\bdinner\b/.test(t)) {
    out.flexible = true;
    out.time = "19:00";
  } else if (/\blunch\b/.test(t)) {
    out.flexible = true;
    out.time = "12:30";
  } else if (/\bbrunch\b/.test(t)) {
    out.flexible = true;
    out.time = "11:00";
  }

  out.date = parseDate(t, today);

  // Restaurant: "at Nopa", "book Nopa", "reservation at State Bird Provisions".
  const original = ` ${text.replace(/[,!?]/g, " ")} `;
  // Try every trigger word, so "Book a table for 4 at Nopa" still reaches "at Nopa".
  for (const m of original.matchAll(/\b(?:at|book|reserve)\s+|@/gi)) {
    const words: string[] = [];
    for (const w of original.slice(m.index + m[0].length).trim().split(/\s+/)) {
      const lw = w.toLowerCase();
      if (STOP_WORDS.has(lw) || /^\d/.test(lw) || /^(a|an|the|us|me|table|reservation)$/.test(lw)) {
        if (words.length === 0 && /^(a|an|the|table|reservation)$/.test(lw)) continue;
        break;
      }
      words.push(w);
    }
    if (words.length) {
      out.restaurant = words.join(" ");
      break;
    }
  }
  return out;
}

export function missingFields(i: ReservationIntent): MissingField[] {
  const m: MissingField[] = [];
  if (!i.restaurant) m.push("restaurant");
  if (!i.date) m.push("date");
  if (!i.time) m.push("time");
  if (!i.party) m.push("party");
  return m;
}

function parseDate(t: string, today: Date): string | undefined {
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (/\b(today|tonight)\b/.test(t)) return iso(base);
  if (/\btomorrow\b/.test(t)) return iso(addDays(base, 1));

  for (let i = 0; i < 7; i++) {
    const d = WEEKDAYS[i]!;
    const m = new RegExp(`\\b(next |this )?(${d}|${d.slice(0, 3)})\\b`).exec(t);
    if (!m) continue;
    // "friday" said on a Friday means today; "next friday" then means a week out.
    let delta = (i - base.getDay() + 7) % 7;
    if (delta === 0 && m[1] === "next ") delta = 7;
    return iso(addDays(base, delta));
  }

  // "nov 6", "november 6th", "6 nov"
  const md = /\b([a-z]{3})[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?\b/.exec(t) ?? /\b(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3})[a-z]*\b/.exec(t);
  if (md) {
    const [mon, day] = MONTHS.includes(md[1]!) ? [md[1]!, md[2]!] : [md[2]!, md[1]!];
    const mi = MONTHS.indexOf(mon);
    if (mi >= 0) return rollForward(base, mi, Number(day));
  }
  // "11/6"
  const slash = /\b(\d{1,2})\/(\d{1,2})\b/.exec(t);
  if (slash) return rollForward(base, Number(slash[1]) - 1, Number(slash[2]));
  return undefined;
}

function rollForward(base: Date, month: number, day: number): string {
  let d = new Date(base.getFullYear(), month, day);
  if (d < base) d = new Date(base.getFullYear() + 1, month, day);
  return iso(d);
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function iso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function humanDate(isoDate: string, time?: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(y!, m! - 1, d!);
  const day = date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return time ? `${day}, ${humanTime(time)}` : day;
}

export function humanTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h! >= 12 ? "pm" : "am";
  const h12 = h! % 12 === 0 ? 12 : h! % 12;
  return m ? `${h12}:${pad(m)}${suffix}` : `${h12}${suffix}`;
}
