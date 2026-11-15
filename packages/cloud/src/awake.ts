// Keeping the owner's computer awake, so Momo can always answer.
//
// A computer that goes to sleep takes Momo with it: texts sit unanswered until
// someone touches the keyboard. While Momo runs it holds the computer awake
// (the screen still turns off), through a small helper the operating system
// already has. The helper ends by itself when Momo does, so nothing is left
// changed behind.
//
// Once a day there is a maintenance window (03:00-05:00 unless set otherwise):
// Momo lets go, so the computer can sleep, install updates or restart, and
// holds it awake again afterwards. The window is only kept where the computer
// is set to wake itself at the end of it (the Windows installer arranges that);
// an errand in progress is finished first.

import { spawn, type ChildProcess } from "node:child_process";

export interface Window {
  /** Minutes after local midnight. */
  start: number;
  end: number;
}

/** "03:00-05:00" (or "3-5", "23:30-01:00"). Undefined for "off", nothing, or anything unreadable. */
export function parseWindow(text: string | undefined): Window | undefined {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(text ?? "");
  if (!m) return undefined;
  const [h1, m1, h2, m2] = [Number(m[1]), Number(m[2] ?? 0), Number(m[3]), Number(m[4] ?? 0)];
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return undefined;
  const w = { start: h1 * 60 + m1, end: h2 * 60 + m2 };
  return w.start === w.end ? undefined : w;
}

export function inWindow(w: Window, at: Date): boolean {
  const now = at.getHours() * 60 + at.getMinutes();
  return w.start < w.end ? now >= w.start && now < w.end : now >= w.start || now < w.end; // may cross midnight
}

const two = (n: number) => String(n).padStart(2, "0");
export const showWindow = (w: Window) => `${two(Math.floor(w.start / 60))}:${two(w.start % 60)}-${two(Math.floor(w.end / 60))}:${two(w.end % 60)}`;

/**
 * The helper that holds this kind of computer awake for as long as process `pid` lives.
 * Idle sleep only: the screen may turn off, and closing a laptop's lid still puts it to sleep.
 */
export function holdCommand(platform: NodeJS.Platform, pid: number): { cmd: string; args: string[] } | undefined {
  if (platform === "win32") {
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held by this helper's thread until Momo (its stdin) goes away.
    const script = [
      `$k = Add-Type -PassThru -Namespace Momo -Name Awake -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'`,
      `[void]$k::SetThreadExecutionState([uint32]2147483649)`,
      `[void][Console]::In.ReadLine()`,
    ].join("; ");
    return { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script] };
  }
  if (platform === "darwin") return { cmd: "caffeinate", args: ["-i", "-s", "-w", String(pid)] };
  if (platform === "linux") return { cmd: "systemd-inhibit", args: ["--what=sleep:idle", "--who=Momo", "--why=Momo answers texts while this computer is awake", "tail", `--pid=${pid}`, "-f", "/dev/null"] };
  return undefined;
}

export interface KeepAwakeOptions {
  platform?: NodeJS.Platform;
  /** When the computer may rest. Leave out to hold it awake around the clock. */
  window?: Window;
  /** An errand is in progress: don't let go in the middle of it. */
  busy?: () => boolean;
  now?: () => Date;
  spawn?: (cmd: string, args: string[]) => ChildProcess;
  log?: (m: string) => void;
}

export class KeepAwake {
  private readonly o: KeepAwakeOptions;
  private helper: ChildProcess | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private failed = false;

  constructor(o: KeepAwakeOptions = {}) {
    this.o = o;
  }

  get holding(): boolean {
    return !!this.helper;
  }

  /** Hold or let go, according to the time and what Momo is doing. Returns whether it is holding. */
  tick(): boolean {
    const resting = !!this.o.window && inWindow(this.o.window, this.o.now?.() ?? new Date()) && !this.o.busy?.();
    if (resting) this.release();
    else if (!this.helper && !this.failed) this.hold();
    return this.holding;
  }

  start(everyMs = 30_000): boolean {
    const held = this.tick();
    this.timer = setInterval(() => this.tick(), everyMs);
    this.timer.unref();
    return held;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.release();
  }

  private hold(): void {
    const how = holdCommand(this.o.platform ?? process.platform, process.pid);
    if (!how) {
      this.failed = true;
      return;
    }
    try {
      const child = (this.o.spawn ?? ((c, a) => spawn(c, a, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true })))(how.cmd, how.args);
      this.helper = child;
      // No such helper on this computer: say so once and stop trying.
      child.once("error", (e) => {
        if (this.helper === child) this.helper = undefined;
        this.failed = true;
        this.o.log?.(`keep awake: couldn't start (${(e as Error).message}); this computer will sleep as it usually does`);
      });
      // It ended by itself (killed, logged out): the next tick starts another. One that gives up
      // straight away can't do its job on this computer: say so once and stop trying.
      const began = Date.now();
      child.once("exit", (code) => {
        if (this.helper !== child) return; // Momo let go of it
        this.helper = undefined;
        if (code && Date.now() - began < 5000 && !this.failed) {
          this.failed = true;
          this.o.log?.(`keep awake: ${how.cmd} isn't allowed to hold this computer awake; it will sleep as it usually does`);
        }
      });
    } catch (e) {
      this.failed = true;
      this.o.log?.(`keep awake: couldn't start (${(e as Error).message})`);
    }
  }

  private release(): void {
    const child = this.helper;
    this.helper = undefined;
    child?.kill();
  }
}

/** What the settings ask for: MOMO_AWAKE=off turns it off; MOMO_MAINTENANCE=HH:MM-HH:MM (or off) sets the rest. */
export function awakeFromEnv(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): { on: boolean; window?: Window; note: string } {
  if (env.MOMO_AWAKE === "off") return { on: false, note: "keep awake: off (Momo answers only while this computer is awake)" };
  // Only where something wakes the computer again at the end of the window; elsewhere a rest would never end.
  const window = platform === "win32" ? parseWindow(env.MOMO_MAINTENANCE ?? "03:00-05:00") : undefined;
  const rest = window
    ? `; between ${showWindow(window).replace("-", " and ")} it may sleep, update or restart, and wakes itself after`
    : platform === "win32" || !parseWindow(env.MOMO_MAINTENANCE)
      ? ""
      : "; MOMO_MAINTENANCE is left aside here, because this computer can't wake itself afterwards";
  return { on: true, window, note: `keep awake: on (this computer won't go to sleep while Momo runs; the screen still turns off, and a closed laptop lid still sleeps)${rest}` };
}
