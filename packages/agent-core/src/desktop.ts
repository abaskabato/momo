// Computer use on the owner's machine via vercel-labs/agent-desktop.
//
// agent-desktop reads and operates native apps through the OS accessibility
// tree and prints one JSON envelope per call. It is headless by default (no
// cursor, no focus stealing); we never pass --headed unless the owner turned
// physical input on. For web content it launches the browser with a CDP port
// and hands off to Playwright, which is what the browser providers use.

import { execFile } from "node:child_process";

export interface AdEnvelope<T = unknown> {
  version: string;
  ok: boolean;
  command: string;
  data?: T;
  error?: {
    code: string;
    message: string;
    suggestion?: string;
    disposition: { delivery: string; retry: "safe" | "unsafe" };
    recovery?: { strategy: string; retryable: boolean; requires_fresh_snapshot?: boolean };
    details?: Record<string, unknown>;
  };
}

export class AgentDesktopError extends Error {
  readonly envelope: AdEnvelope;
  constructor(env: AdEnvelope) {
    super(`${env.command}: ${env.error?.code} ${env.error?.message ?? ""}`);
    this.envelope = env;
  }
  /** Only safe when the action provably did not happen. */
  get retrySafe(): boolean {
    return this.envelope.error?.disposition.retry === "safe";
  }
}

export interface AgentDesktopOptions {
  bin?: string;
  /** Allow physical input (cursor, keys). Off unless the owner opted in. */
  headed?: boolean;
  session?: string;
  timeoutMs?: number;
}

export class AgentDesktop {
  private readonly opts: AgentDesktopOptions;

  constructor(opts: AgentDesktopOptions = {}) {
    this.opts = opts;
  }

  /** Run one command; resolves with `data` or throws AgentDesktopError. */
  run<T = unknown>(args: string[]): Promise<T> {
    const argv = [...args];
    if (this.opts.headed) argv.unshift("--headed");
    if (this.opts.session) argv.unshift("--session", this.opts.session);
    return new Promise((resolve, reject) => {
      execFile(this.opts.bin ?? "agent-desktop", argv, { timeout: this.opts.timeoutMs ?? 60_000, maxBuffer: 32 << 20 }, (err, stdout) => {
        // Exit codes 1 and 2 still print an envelope; parse before judging.
        let env: AdEnvelope<T>;
        try {
          env = JSON.parse(stdout) as AdEnvelope<T>;
        } catch {
          return reject(err ?? new Error(`agent-desktop printed no envelope: ${stdout.slice(0, 200)}`));
        }
        if (!env.ok) return reject(new AgentDesktopError(env));
        resolve(env.data as T);
      });
    });
  }

  status() {
    return this.run<{ platform: string; permissions: Record<string, unknown>; supported_surfaces: string[] }>(["status"]);
  }

  snapshot(app: string, opts: { interactive?: boolean; compact?: boolean; skeleton?: boolean; root?: string } = {}) {
    const a = ["snapshot", "--app", app];
    if (opts.interactive ?? true) a.push("-i");
    if (opts.compact ?? true) a.push("--compact");
    if (opts.skeleton) a.push("--skeleton");
    if (opts.root) a.push("--root", opts.root);
    return this.run<{ snapshot_id: string; tree: unknown; complete: boolean }>(a);
  }

  find(app: string, role: string, name: string) {
    return this.run<{ matches: Array<{ ref_id: string; name: string }> }>(["find", "--app", app, "--role", role, "--name", name, "--first"]);
  }

  click(ref: string) {
    return this.run(["click", ref]);
  }

  /** Writes the value through the accessibility API; never via the clipboard. */
  setValue(ref: string, text: string) {
    return this.run(["set-value", ref, text]);
  }

  /**
   * Launch a fresh browser process with a CDP port for Playwright. A browser
   * that is already running can't be attached (`cdp_requires_fresh_launch`).
   */
  async launchBrowserWithCdp(app = "Google Chrome", args: string[] = []): Promise<{ wsEndpoint: string; httpEndpoint: string; pid: number }> {
    const argv = ["launch", app, "--cdp"];
    for (const a of args) argv.push("--arg", a);
    const data = await this.run<{ pid: number; cdp: { websocket_url: string; http_endpoint: string } }>(argv);
    return { wsEndpoint: data.cdp.websocket_url, httpEndpoint: data.cdp.http_endpoint, pid: data.pid };
  }

  /** Closing the app also closes the CDP port, which any local process could use. */
  closeApp(app: string) {
    return this.run(["close-app", app]);
  }
}
