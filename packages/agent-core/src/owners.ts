// Who the assistant works for. Set up entirely by text: the computer shows a
// one-time code at install, and the first person to text that code becomes
// the owner. Further handles (a second phone, Telegram) are added the same way
// with a fresh code. Guessing is rate-limited per handle.

import { randomInt } from "node:crypto";
import type { Doc } from "./store.ts";

export type OnboardingStep = "welcome" | "name" | "city" | "done";

export interface OwnerState {
  handles: string[];
  claimCode: string;
  attempts: Record<string, number>;
  onboarding: OnboardingStep;
}

const MAX_ATTEMPTS = 5;

export class Owners {
  private readonly file: Doc<OwnerState>;

  constructor(file: Doc<OwnerState>) {
    this.file = file;
  }

  static fresh(seed: string[] = [], onboarding?: OnboardingStep): OwnerState {
    return { handles: seed, claimCode: newCode(), attempts: {}, onboarding: onboarding ?? (seed.length ? "done" : "name") };
  }

  async state(): Promise<OwnerState> {
    return this.file.read();
  }

  async isOwner(handle: string): Promise<boolean> {
    return (await this.file.read()).handles.includes(handle);
  }

  /** The code to show on the computer (and in logs) for claiming by text. */
  async claimCode(): Promise<string> {
    const s = await this.file.read();
    await this.file.write(s); // persist the generated code on first read
    return s.claimCode;
  }

  /** Returns "claimed", "wrong" (counted), "locked", or "none" if the text isn't a claim attempt. */
  async tryClaim(text: string, handle: string): Promise<"claimed" | "wrong" | "locked" | "none"> {
    const m = /\b(\d{6})\b/.exec(text);
    if (!m) return "none";
    const s = await this.file.read();
    const tries = s.attempts[handle] ?? 0;
    if (tries >= MAX_ATTEMPTS) return "locked";
    if (m[1] !== s.claimCode) {
      s.attempts[handle] = tries + 1;
      await this.file.write(s);
      return "wrong";
    }
    s.handles.push(handle);
    s.claimCode = newCode(); // single use
    delete s.attempts[handle];
    await this.file.write(s);
    return "claimed";
  }

  async setOnboarding(step: OnboardingStep): Promise<void> {
    await this.file.update((s) => void (s.onboarding = step));
  }
}

function newCode(): string {
  return String(randomInt(100000, 1000000));
}
