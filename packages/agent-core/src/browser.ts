// Browser sessions for skills. Either a private headless Chromium (default,
// isolated profile under the local state dir) or the owner's real browser
// launched by agent-desktop with a CDP port, so sites see their usual
// cookies and device.

import type { Browser, BrowserContext, Page } from "playwright-core";
import type { AgentDesktop } from "./desktop.ts";
import type { LocalVault } from "./vault.ts";
import type { LoginSecret } from "./vault.ts";

export interface BrowserSessionFactory {
  open(): Promise<{ page: Page; close: () => Promise<void> }>;
}

/**
 * One shared Chromium process; every session gets its own isolated context
 * (cookie jar, storage), so one user's sign-ins are never visible to another.
 */
const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export class HeadlessBrowser implements BrowserSessionFactory {
  private browser: Promise<Browser> | null = null;
  private readonly timezoneId?: string;

  constructor(opts: { timezoneId?: string } = {}) {
    this.timezoneId = opts.timezoneId;
  }

  async open() {
    this.browser ??= import("playwright-core").then(({ chromium }) =>
      chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] }),
    );
    // Look like an ordinary desktop Chrome; many sites turn away obvious bots.
    const context: BrowserContext = await (await this.browser).newContext({
      userAgent: DESKTOP_UA,
      viewport: { width: 1280, height: 860 },
      locale: "en-US",
      timezoneId: this.timezoneId,
    });
    await context.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => undefined }));
    const page = await context.newPage();
    return { page, close: () => context.close() };
  }

  async dispose(): Promise<void> {
    const b = await this.browser;
    this.browser = null;
    await b?.close();
  }
}

export class DesktopBrowser implements BrowserSessionFactory {
  private readonly desktop: AgentDesktop;
  private readonly app: string;

  constructor(desktop: AgentDesktop, app = "Google Chrome") {
    this.desktop = desktop;
    this.app = app;
  }

  async open() {
    const { chromium } = await import("playwright-core");
    const { wsEndpoint } = await this.desktop.launchBrowserWithCdp(this.app);
    const browser = await chromium.connectOverCDP(wsEndpoint);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    return {
      page,
      close: async () => {
        await browser.close();
        await this.desktop.closeApp(this.app).catch(() => {});
      },
    };
  }
}

/**
 * Types a vault login into a page. The values go from the vault straight into
 * the DOM; they are never returned, logged, or shown to the model. The vault
 * refuses if the page isn't on the login's bound origin.
 */
export async function fillLogin(
  vault: LocalVault,
  handle: string,
  page: Page,
  selectors: { identifier: string; password: string; submit: string },
): Promise<void> {
  await vault.use(handle, page.url(), async (secret) => {
    const s = secret as LoginSecret;
    await page.fill(selectors.identifier, s.identifier);
    await page.fill(selectors.password, s.password);
  });
  const navigated = page
    .waitForEvent("framenavigated", { predicate: (f) => f === page.mainFrame(), timeout: 2000 })
    .then(() => true, () => false);
  await page.click(selectors.submit);
  if (await navigated) await page.waitForLoadState("domcontentloaded").catch(() => {});
}
