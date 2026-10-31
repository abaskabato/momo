// Wires a local agent from a state directory. Everything here lives on the
// owner's device: keys, vault, tasks, approvals, timers, preferences.

import { join } from "node:path";
import { generateDeviceKeys, type Channel, type DeviceKeys } from "@momo/protocol";
import { ApprovalGate, type Approval } from "./approvals.ts";
import { Assistant, type PendingForm } from "./assistant.ts";
import { Owners, type OnboardingStep, type OwnerState } from "./owners.ts";
import type { LiveViews, PhoneCaller, SecureLinks } from "./skill.ts";
import type { Outbound } from "./channels.ts";
import { Inbox, type Email } from "./inbox.ts";
import { LocalMemory } from "./memory.ts";
import type { ModelRouter } from "./models.ts";
import type { Skill } from "./skill.ts";
import { JsonFile, type Doc } from "./store.ts";
import { DEFAULT_SPEND, SpendPolicy, TaskStore, type SpendPolicyConfig, type Task } from "./tasks.ts";
import { Timers, type Timer } from "./timers.ts";
import { defaultKeyProvider, LocalVault, type KeyProvider, type VaultFile } from "./vault.ts";

/** Opens a named JSON document for this user/device. */
export type DocFactory = <T>(name: string, fallback: () => T) => Doc<T>;

export interface AgentOptions {
  docs: DocFactory;
  skills: (vault: LocalVault) => Skill[];
  outbound: Outbound;
  /** Pre-authorized handles; empty means "claim by text with the code". */
  ownerHandles?: string[];
  /** Where a seeded owner starts onboarding ("welcome" for hosted sign-ups). */
  onboarding?: OnboardingStep;
  answer?: (text: string, context: string) => Promise<string>;
  /** Hosted secure links for secrets; absent on a device without a cloud. */
  secureLinks?: SecureLinks;
  liveViews?: LiveViews;
  phone?: PhoneCaller;
  publicUrl?: string;
  /** The owner's Momo email address (hosted); enables the inbox. */
  inboxAddress?: string;
  home?: { channel: Channel; threadId: string };
  keyProvider?: KeyProvider;
  spend?: SpendPolicyConfig;
  models?: ModelRouter;
  /** OpenClaw workspace memory dir, so OpenClaw's memory search sees our notes. */
  memoryNotesDir?: string;
  now?: () => Date;
}

export interface LocalAgentOptions extends Omit<AgentOptions, "docs" | "keyProvider"> {
  stateDir: string;
  keyProvider?: KeyProvider;
}

/** On a device: one JSON file per document under stateDir. */
export function createLocalAgent(o: LocalAgentOptions) {
  const docs: DocFactory = (name, fallback) => new JsonFile(join(o.stateDir, `${name}.json`), fallback);
  return createAgent({ ...o, docs, keyProvider: o.keyProvider ?? defaultKeyProvider(join(o.stateDir, "vault.key")) });
}

export async function createAgent(o: AgentOptions & { keyProvider: KeyProvider }) {
  const now = o.now ?? (() => new Date());
  const nowMs = () => now().getTime();
  const vault = new LocalVault(o.docs<VaultFile>("vault", () => ({ version: 1, items: [] })), o.keyProvider);
  const tasks = new TaskStore(o.docs<Task[]>("tasks", () => []), nowMs);
  const approvals = new ApprovalGate(o.docs<Approval[]>("approvals", () => []), nowMs);
  const spend = new SpendPolicy(tasks, o.spend ?? DEFAULT_SPEND, nowMs);
  const timers = new Timers(o.docs<Timer[]>("timers", () => []));
  const memory = new LocalMemory(o.docs<Record<string, string>>("preferences", () => ({})), o.memoryNotesDir, now);
  const owners = new Owners(o.docs<OwnerState>("owner", () => Owners.fresh(o.ownerHandles ?? [], o.onboarding)));
  const claimCode = await owners.claimCode();
  const inbox = o.inboxAddress ? new Inbox(o.inboxAddress, o.docs<Email[]>("inbox", () => []), nowMs) : undefined;
  const assistant = new Assistant({
    skills: o.skills(vault),
    tasks,
    approvals,
    spend,
    vault,
    memory,
    timers,
    outbound: o.outbound,
    models: o.models,
    owners,
    secureLinks: o.secureLinks,
    liveViews: o.liveViews,
    phone: o.phone,
    publicUrl: o.publicUrl,
    inbox,
    home: o.home,
    answer: o.answer,
    pendingForms: o.docs<PendingForm[]>("forms", () => []),
    now,
  });
  return { assistant, vault, tasks, approvals, timers, memory, spend, owners, claimCode, inbox };
}

/** Device identity: generated once, stored locally, never uploaded except public halves. */
export async function loadOrCreateDeviceKeys(stateDir: string): Promise<DeviceKeys> {
  const f = new JsonFile<DeviceKeys | null>(join(stateDir, "device-keys.json"), () => null);
  const existing = await f.read();
  if (existing) return existing;
  const keys = generateDeviceKeys();
  await f.write(keys);
  return keys;
}
