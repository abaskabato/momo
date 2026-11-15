// Browser sessions for skills. Either a private headless Chromium (default,
// isolated profile under the local state dir) or the owner's real browser
// launched by agent-desktop with a CDP port, so sites see their usual
// cookies and device.

import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { AgentDesktop } from "./desktop.ts";
import type { LocalVault } from "./vault.ts";
import type { LoginSecret } from "./vault.ts";

/** One of the owner's browser profiles: a separate set of sign-ins (work, personal, ...). */
export interface BrowserAccount {
  id: string; // the profile's folder name
  name: string; // what the owner called it
  email: string; // the Google account it's signed in to, if any
}

export interface BrowserSessionFactory {
  /** `account`: which of the owner's browser profiles to open in (see accounts()); the usual one when left out. */
  open(account?: string): Promise<{ page: Page; close: () => Promise<void> }>;
  /** The owner's browser profiles, the one in use first. Absent or empty when there is just one browser. */
  accounts?(): Promise<BrowserAccount[]>;
  /** Something the owner should be told about the browser, once (e.g. "close Chrome so I can copy your sign-ins"). */
  notice?(): string | undefined;
}

/** An everyday browser on this computer whose sign-ins Momo can carry over. */
export interface BrowserSource {
  channel: string; // what Playwright calls it: "chrome", "msedge", "chromium"
  name: string; // what the owner calls it
  dir: string; // its "User Data" folder
}

/** The owner's installed Chrome and Edge profiles, Chrome first. */
export function everydayBrowsers(env: Record<string, string | undefined> = process.env, platform: string = process.platform, home: string = homedir()): BrowserSource[] {
  const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  const all: BrowserSource[] =
    platform === "win32"
      ? [
          { channel: "chrome", name: "Chrome", dir: join(local, "Google", "Chrome", "User Data") },
          { channel: "msedge", name: "Edge", dir: join(local, "Microsoft", "Edge", "User Data") },
        ]
      : platform === "darwin"
        ? [
            { channel: "chrome", name: "Chrome", dir: join(home, "Library", "Application Support", "Google", "Chrome") },
            { channel: "msedge", name: "Edge", dir: join(home, "Library", "Application Support", "Microsoft Edge") },
          ]
        : [
            { channel: "chrome", name: "Chrome", dir: join(home, ".config", "google-chrome") },
            { channel: "msedge", name: "Edge", dir: join(home, ".config", "microsoft-edge") },
          ];
  return all.filter((b) => existsSync(join(b.dir, "Local State")));
}

/** Thrown when the everyday browser is open and holding its sign-in files (Windows locks them). */
export class BrowserBusy extends Error {}

// Big, rebuildable, or would make the copy reopen yesterday's tabs. Sign-ins, saved passwords, history,
// bookmarks, autofill and site storage are everything else, and are kept.
const SKIP = new Set([
  "Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "GrShaderCache", "ShaderCache", "GraphiteDawnCache",
  "CacheStorage", "ScriptCache", "Application Cache", "blob_storage", "Extensions", "Sessions", "Current Session", "Current Tabs",
  "Last Session", "Last Tabs", "LOCK", "lockfile", "SingletonLock", "SingletonCookie", "SingletonSocket", "Crashpad", "optimization_guide_model_store",
]);
const SIGN_INS = /^(Cookies|Login Data|Login Data For Account|Web Data)$/;

async function copyTree(from: string, to: string, failed: string[]): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const d of await readdir(from, { withFileTypes: true })) {
    if (SKIP.has(d.name)) continue;
    const a = join(from, d.name);
    const b = join(to, d.name);
    if (d.isDirectory()) await copyTree(a, b, failed);
    else if (d.isFile()) await copyFile(a, b).catch(() => void failed.push(d.name));
  }
}

/**
 * Copy an everyday browser's profile (the one last used) into Momo's own
 * browser folder, so Momo starts out signed in wherever the owner is, with
 * their saved passwords. It's a copy: Momo never drives or changes the owner's
 * own browser. The copy only opens with the same browser on the same computer
 * and account, because the browser encrypts these files to them.
 */
export async function copySignIns(source: BrowserSource, profileDir: string): Promise<{ channel: string; name: string; profile: string }> {
  let profile = "Default";
  try {
    const state = JSON.parse(await readFile(join(source.dir, "Local State"), "utf8")) as { profile?: { last_used?: string } };
    if (state.profile?.last_used && existsSync(join(source.dir, state.profile.last_used))) profile = state.profile.last_used;
  } catch {
    // unreadable Local State: the default profile
  }
  if (!existsSync(join(source.dir, profile))) throw new Error(`${source.name} has no profile to copy`);
  const tmp = `${profileDir}.copying`;
  await rm(tmp, { recursive: true, force: true });
  const failed: string[] = [];
  await mkdir(tmp, { recursive: true });
  // Find out in a moment, not after copying everything, whether the browser is open and holding its sign-in files.
  for (const f of [join(profile, "Network", "Cookies"), join(profile, "Cookies"), join(profile, "Login Data")]) {
    if (!existsSync(join(source.dir, f))) continue;
    try {
      await copyFile(join(source.dir, f), join(tmp, "probe"));
    } catch {
      await rm(tmp, { recursive: true, force: true });
      throw new BrowserBusy(`${source.name} is open and holding its sign-in files`);
    }
  }
  await rm(join(tmp, "probe"), { force: true });
  await copyFile(join(source.dir, "Local State"), join(tmp, "Local State"));
  // Every profile, not only the last one used: people keep work and personal accounts in separate ones.
  const profiles = (await readdir(source.dir, { withFileTypes: true })).filter((d) => d.isDirectory() && /^(Default|Profile \d+)$/.test(d.name)).map((d) => d.name);
  for (const p of profiles.includes(profile) ? profiles : [profile]) await copyTree(join(source.dir, p), join(tmp, p), failed);
  if (failed.some((f) => SIGN_INS.test(f))) {
    await rm(tmp, { recursive: true, force: true });
    throw new BrowserBusy(`${source.name} is open and holding its sign-in files`);
  }
  const copied = { channel: source.channel, name: source.name, profile, at: new Date().toISOString() };
  await writeFile(join(tmp, COPIED), JSON.stringify(copied));
  await rm(profileDir, { recursive: true, force: true });
  await rename(tmp, profileDir);
  return copied;
}
const COPIED = "momo-sign-ins.json";

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

/**
 * On a person's own computer: a real, visible browser window (their installed
 * Chrome or Edge) with a profile of Momo's own that is kept between errands.
 * The first time, that profile is a copy of their everyday browser's, so Momo
 * is already signed in wherever they are and has their saved passwords.
 * They can watch it work and step in (sign in once, pass a CAPTCHA) right
 * there, and sites see an ordinary browser. Each errand gets a tab. If no
 * installed browser can be started, it falls back to the hidden one.
 */
export class VisibleBrowser implements BrowserSessionFactory {
  private context: Promise<BrowserContext> | null = null;
  private readonly o: { profileDir: string; channels: string[]; headless: boolean; timezoneId?: string; signIns: BrowserSource[] };
  /** What actually started: "chrome", "msedge", ... or "hidden". */
  started = "";
  /** Where the sign-ins stand, in words for the log. */
  signIns = "";
  /** The profile folder the window is running in ("" = the usual one). */
  private current = "";
  private waitingFor = ""; // the everyday browser that must be closed once before its sign-ins can be copied
  private tell: string | undefined;
  private tabs = 0;

  /** `signIns`: the everyday browsers whose sign-ins may be copied in (see everydayBrowsers()); none by default. */
  constructor(o: { profileDir: string; channels?: string[]; headless?: boolean; timezoneId?: string; signIns?: BrowserSource[] }) {
    this.o = { channels: ["chrome", "msedge", "chromium"], headless: false, signIns: [], ...o };
  }

  private copied(): { channel: string; name: string; profile: string } | undefined {
    try {
      return JSON.parse(readFileSync(join(this.o.profileDir, COPIED), "utf8"));
    } catch {
      return undefined;
    }
  }

  private preparing: Promise<string> | undefined;

  /** Bring the owner's sign-ins over if that hasn't happened yet. Safe to call again; it only ever copies once. */
  prepare(): Promise<string> {
    // One copy at a time, however many callers.
    return (this.preparing ??= this.copyOnce().finally(() => (this.preparing = undefined)));
  }

  private async copyOnce(): Promise<string> {
    const have = this.copied();
    if (have) return (this.signIns = `carried over from your ${have.name}`);
    const source = this.o.signIns[0];
    if (!source) return (this.signIns = "its own (none found to carry over from Chrome or Edge)");
    try {
      const c = await copySignIns(source, this.o.profileDir);
      if (this.waitingFor) this.tell = `I've copied your ${c.name} sign-ins and saved passwords, so I'm now signed in wherever you are.`;
      this.waitingFor = "";
      return (this.signIns = `carried over from your ${c.name}`);
    } catch (e) {
      if (e instanceof BrowserBusy) {
        if (!this.waitingFor) this.tell = `One thing: to use the sites you're already signed in to, close all your ${source.name} windows once. I'll copy your sign-ins then (you can reopen it right after). Until that, I'm using a browser with no sign-ins.`;
        this.waitingFor = source.name;
        return (this.signIns = `not carried over yet: ${source.name} is open. Close all its windows once and Momo copies them at the next errand`);
      }
      return (this.signIns = `its own (couldn't copy from ${source.name}: ${(e as Error).message.slice(0, 120)})`);
    }
  }

  notice(): string | undefined {
    const t = this.tell;
    this.tell = undefined;
    return t;
  }

  /** The owner's profiles that were copied over, the one in use first. */
  async accounts(): Promise<BrowserAccount[]> {
    const have = this.copied();
    if (!have) return [];
    try {
      const state = JSON.parse(readFileSync(join(this.o.profileDir, "Local State"), "utf8")) as { profile?: { info_cache?: Record<string, { name?: string; user_name?: string }> } };
      const inUse = this.current || have.profile;
      return Object.entries(state.profile?.info_cache ?? {})
        .filter(([id]) => existsSync(join(this.o.profileDir, id)))
        .map(([id, p]) => ({ id, name: p.name ?? id, email: p.user_name ?? "" }))
        .sort((a, b) => Number(b.id === inUse) - Number(a.id === inUse));
    } catch {
      return [];
    }
  }

  private async launch(): Promise<BrowserContext> {
    const { chromium } = await import("playwright-core");
    await this.prepare();
    const have = this.copied();
    if (have && this.current) have.profile = this.current;
    // A copied profile only opens with the browser it came from.
    const channels = have ? [have.channel, ...this.o.channels.filter((c) => c !== have.channel)] : this.o.channels;
    const base = {
      viewport: null,
      timezoneId: this.o.timezoneId,
      args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check", ...(have ? [`--profile-directory=${have.profile}`] : [])],
    };
    for (const channel of this.o.headless ? [] : channels) {
      try {
        // Without these two defaults the browser uses the system's real key store, which is what the
        // owner's cookies and passwords are encrypted with.
        const c = await chromium.launchPersistentContext(this.o.profileDir, { ...base, headless: false, channel, ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"] });
        this.started = channel;
        return c;
      } catch {
        // not installed, or no screen: try the next one
      }
    }
    this.started = "hidden";
    return chromium.launchPersistentContext(this.o.profileDir, { ...base, viewport: { width: 1280, height: 860 }, headless: true });
  }

  async open(account?: string) {
    // Still waiting for the owner to close their browser: try again whenever nothing is in progress.
    if (this.waitingFor && this.tabs === 0 && this.context) await this.dispose();
    if (account) {
      // Another of the owner's profiles: one browser runs one profile, so the window is reopened in that one.
      const all = await this.accounts();
      const want = account.trim().toLowerCase();
      const target = all.find((a) => a.email.toLowerCase() === want || a.id.toLowerCase() === want || a.name.toLowerCase() === want) ?? all.find((a) => a.email.toLowerCase().includes(want) || a.name.toLowerCase().includes(want));
      if (!target) throw new Error(`no browser account "${account}" here. There ${all.length === 1 ? "is" : "are"}: ${all.map((a) => `${a.name}${a.email ? ` (${a.email})` : ""}`).join(", ") || "none copied yet"}`);
      if (target.id !== (this.current || this.copied()?.profile)) {
        if (this.tabs > 0) throw new Error("another errand is using the browser; switch accounts when it has finished");
        await this.dispose();
        this.current = target.id;
      }
    }
    let context = await (this.context ??= this.launch());
    let page: Page;
    try {
      page = await context.newPage();
    } catch {
      // The owner closed the window: open it again.
      this.context = this.launch();
      context = await this.context;
      page = await context.newPage();
    }
    await page.bringToFront().catch(() => {});
    this.tabs++;
    let open = true;
    return {
      page,
      close: async () => {
        if (open) this.tabs--;
        open = false;
        await page.close().catch(() => {});
      },
    };
  }

  async dispose(): Promise<void> {
    const c = await this.context?.catch(() => undefined);
    this.context = null;
    await c?.close().catch(() => {});
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
