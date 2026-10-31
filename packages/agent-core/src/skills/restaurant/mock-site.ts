// "TableNow": a small OpenTable-like site used by the end-to-end test and the
// local demo. It is real HTML driven by a real browser: login form, slot
// buttons, a confirm page, and a cancel button, so the browser provider runs
// exactly the code path it would run against a live site adapter.

import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";

export interface MockVenue {
  slug: string;
  name: string;
  times: string[];
  noShowFeePerPersonUsd?: number;
}

export interface MockSiteState {
  account: { email: string; password: string };
  venues: MockVenue[];
  reservations: Map<string, { slug: string; date: string; time: string; party: number; cancelled: boolean }>;
  logins: number;
}

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

export async function startMockSite(
  venues: MockVenue[] = [{ slug: "nopa", name: "Nopa", times: ["17:30", "18:45", "19:00", "21:15"], noShowFeePerPersonUsd: 25 }],
  account = { email: "owner@example.com", password: "hunter2-correct-horse" },
): Promise<{ origin: string; state: MockSiteState; close: () => Promise<void> }> {
  const state: MockSiteState = { account, venues, reservations: new Map(), logins: 0 };
  const sessions = new Set<string>();

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const sid = /sid=(\w+)/.exec(req.headers.cookie ?? "")?.[1];
    const authed = sid !== undefined && sessions.has(sid);
    const body = req.method === "POST" ? new URLSearchParams(await readBody(req)) : new URLSearchParams();
    const html = (status: number, s: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "text/html", ...headers });
      res.end(s);
    };

    if (url.pathname === "/search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const hits = venues.filter((v) => v.name.toLowerCase().includes(q) || v.slug === q);
      return html(200, page("Search", hits.map((v) => `<a class="venue" href="/r/${v.slug}">${v.name}</a>`).join("")));
    }

    if (url.pathname === "/login" && req.method === "GET") {
      const next = url.searchParams.get("next") ?? "/";
      return html(200, page("Sign in", `<form method="post" action="/login?next=${encodeURIComponent(next)}">
        <input id="email" name="email" type="email"><input id="password" name="password" type="password">
        <button id="signin" type="submit">Sign in</button></form>`));
    }
    if (url.pathname === "/login" && req.method === "POST") {
      if (body.get("email") !== account.email || body.get("password") !== account.password) {
        return html(401, page("Sign in", `<p id="error">Wrong email or password</p>`));
      }
      const id = randomBytes(8).toString("hex");
      sessions.add(id);
      state.logins++;
      return html(303, "", { location: url.searchParams.get("next") ?? "/", "set-cookie": `sid=${id}; Path=/; HttpOnly` });
    }

    const venueMatch = /^\/r\/([\w-]+)(\/book)?$/.exec(url.pathname);
    if (venueMatch) {
      const v = venues.find((x) => x.slug === venueMatch[1]);
      if (!v) return html(404, page("Not found", ""));
      const date = url.searchParams.get("date") ?? body.get("date") ?? "";
      const time = url.searchParams.get("time") ?? body.get("time") ?? "";
      const party = Number(url.searchParams.get("party") ?? body.get("party") ?? 2);

      if (!venueMatch[2]) {
        const taken = new Set([...state.reservations.values()].filter((r) => r.slug === v.slug && r.date === date && !r.cancelled).map((r) => r.time));
        const slots = v.times.filter((t) => !taken.has(t));
        return html(200, page(v.name, `<p id="policy" data-noshow="${v.noShowFeePerPersonUsd ?? 0}">Cancellation policy</p>
          <ul>${slots.map((t) => `<li><a class="slot" data-time="${t}" href="/r/${v.slug}/book?date=${date}&time=${t}&party=${party}">${t}</a></li>`).join("")}</ul>`));
      }
      if (!authed) return html(303, "", { location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` });
      if (req.method === "GET") {
        return html(200, page(`Confirm ${v.name}`, `<form method="post" action="/r/${v.slug}/book">
          <input type="hidden" name="date" value="${date}"><input type="hidden" name="time" value="${time}">
          <input type="hidden" name="party" value="${party}"><button id="confirm" type="submit">Complete reservation</button></form>`));
      }
      if (!v.times.includes(time)) return html(409, page("Unavailable", `<p id="error">That time is gone</p>`));
      const conf = `TN-${randomBytes(3).toString("hex").toUpperCase()}`;
      state.reservations.set(conf, { slug: v.slug, date, time, party, cancelled: false });
      return html(200, page("You're booked", `<p>Confirmation <span id="conf">${conf}</span></p>`));
    }

    const cancel = /^\/reservations\/([\w-]+)\/cancel$/.exec(url.pathname);
    if (cancel) {
      if (!authed) return html(303, "", { location: `/login?next=${encodeURIComponent(url.pathname)}` });
      const r = state.reservations.get(cancel[1]!);
      if (!r) return html(404, page("Not found", ""));
      if (req.method === "GET") {
        return html(200, page("Cancel reservation", `<form method="post"><button id="cancel" type="submit">Cancel reservation</button></form>`));
      }
      r.cancelled = true;
      return html(200, page("Cancelled", `<p id="cancelled">Your reservation was cancelled</p>`));
    }

    html(404, page("Not found", ""));
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });
}
