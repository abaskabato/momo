// Browser-driven provider for TableNow-style sites. Each real site (Resy,
// OpenTable, Tock) gets its own adapter with the same shape: search -> slot
// list, book -> login if needed with vault injection -> confirm.

import type { Page } from "playwright-core";
import { fillLogin, type BrowserSessionFactory } from "../../browser.ts";
import type { BookingResult, ProviderContext, ReservationProvider, SearchResult, Slot, SlotQuery } from "./provider.ts";

export class TableNowProvider implements ReservationProvider {
  readonly id = "tablenow";
  readonly origin: string;
  private readonly browser: BrowserSessionFactory;

  constructor(origin: string, browser: BrowserSessionFactory) {
    this.origin = new URL(origin).origin;
    this.browser = browser;
  }

  async search(q: SlotQuery, _ctx: ProviderContext): Promise<SearchResult | null> {
    return this.withPage(async (page) => {
      await page.goto(`${this.origin}/search?q=${encodeURIComponent(q.restaurant)}`);
      const venue = page.locator("a.venue").first();
      if ((await venue.count()) === 0) return null;
      const name = (await venue.textContent())!.trim();
      const href = (await venue.getAttribute("href"))!;
      const id = href.split("/").pop()!;
      await page.goto(`${this.origin}/r/${id}?date=${q.date}&party=${q.party}`);
      const times = await page.locator("a.slot").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.time!));
      const fee = Number(await page.locator("#policy").getAttribute("data-noshow"));
      return {
        venue: { id, name },
        slots: times.map((time) => ({ date: q.date, time, party: q.party })),
        policy: { noShowFeePerPersonUsd: fee || undefined },
      };
    });
  }

  async book(venueId: string, slot: Slot, ctx: ProviderContext): Promise<BookingResult> {
    return this.withPage(async (page) => {
      await page.goto(`${this.origin}/r/${venueId}/book?date=${slot.date}&time=${slot.time}&party=${slot.party}`);
      await this.ensureSignedIn(page, ctx);
      await Promise.all([page.waitForLoadState("domcontentloaded"), page.click("#confirm")]);
      const conf = page.locator("#conf");
      if ((await conf.count()) === 0) {
        const err = (await page.locator("#error").textContent().catch(() => null)) ?? "the site didn't confirm";
        throw new Error(`booking failed: ${err}`);
      }
      return { confirmation: (await conf.textContent())!.trim(), chargedUsd: 0 };
    });
  }

  async cancel(confirmation: string, ctx: ProviderContext): Promise<void> {
    await this.withPage(async (page) => {
      await page.goto(`${this.origin}/reservations/${encodeURIComponent(confirmation)}/cancel`);
      await this.ensureSignedIn(page, ctx);
      await Promise.all([page.waitForLoadState("domcontentloaded"), page.click("#cancel")]);
      if ((await page.locator("#cancelled").count()) === 0) throw new Error("the site didn't confirm the cancellation");
    });
  }

  private async ensureSignedIn(page: Page, ctx: ProviderContext): Promise<void> {
    if (!new URL(page.url()).pathname.startsWith("/login")) return;
    const login = await ctx.vault.findLogin(this.origin);
    if (!login) throw new NeedsLoginError(this.origin);
    await fillLogin(ctx.vault, login.handle, page, { identifier: "#email", password: "#password", submit: "#signin" });
    if (new URL(page.url()).pathname.startsWith("/login")) throw new Error("sign-in was rejected; the saved password may be out of date");
  }

  private async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const { page, close } = await this.browser.open();
    try {
      return await fn(page);
    } finally {
      await close();
    }
  }
}

export class NeedsLoginError extends Error {
  readonly origin: string;
  constructor(origin: string) {
    super(`no saved login for ${origin}`);
    this.origin = origin;
  }
}
