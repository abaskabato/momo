// Wire types between device and cloud. Everything the cloud can read is listed
// here on purpose: ids, timing, and routing metadata. Task content only ever
// travels inside `sealed`.

import type { B64 } from "./crypto.ts";

export type Channel = "imessage" | "telegram" | "whatsapp" | "sms" | "signal" | "app";

/** "now" asks the cloud to wake the device; "batch" waits for the next natural check-in. */
export type Urgency = "now" | "batch";

export type EnvelopeKind = "task" | "message" | "cancel" | "timer" | "vault";

/** What the cloud stores. Opaque except for routing metadata. */
export interface Envelope {
  id: string;
  deviceId: string;
  kind: EnvelopeKind;
  urgency: Urgency;
  sealed: B64;
  createdAt: number;
  /** Do not deliver before this time (ms epoch). Used for deferred follow-ups. */
  notBefore?: number;
  /** Delivery attempts so far; a lease that expires without an ack redelivers. */
  attempts: number;
}

/** The plaintext inside a sealed task envelope. Only the device sees this. */
export interface InboundMessage {
  channel: Channel;
  /** Channel-native sender handle (phone, @user, chat id). */
  from: string;
  /** Thread to reply in. */
  threadId: string;
  text: string;
  receivedAt: number;
}

export type WakeStrategy =
  /** POST an empty body to a push URL (ntfy, APNs relay, a companion app). */
  | { kind: "push"; url: string }
  /** No wake path: always queue-and-batch. */
  | { kind: "none" };

export interface RegisterDeviceRequest {
  deviceId: string;
  /** One-time code shown on the device and typed into the pairing flow. */
  pairCode: string;
  boxPublicKey: B64;
  signPublicKey: B64;
  wake: WakeStrategy;
  /** Channel handles routed to this device (e.g. a Telegram chat id). Hashed by the cloud. */
  handles?: string[];
}

export interface DevicePublicInfo {
  deviceId: string;
  boxPublicKey: B64;
  online: boolean;
  lastSeenAt: number | null;
}

export type DeviceState = "awake" | "going-to-sleep";

export interface CheckinRequest {
  state: DeviceState;
  /** Envelope ids fully handled since the last check-in. */
  ack: string[];
  /** Long-poll up to this many ms when the queue is empty (max 25s). */
  waitMs?: number;
  /** Earliest local deferred job; the cloud wakes the device for it. */
  nextLocalDueAt?: number | null;
}

export interface CheckinResponse {
  envelopes: Envelope[];
  serverTime: number;
  /** When to check in next if nothing wakes the device sooner. */
  nextCheckinMs: number;
}

export interface EnqueueRequest {
  kind: EnvelopeKind;
  urgency: Urgency;
  sealed: B64;
  notBefore?: number;
}

export interface EnqueueResponse {
  id: string;
  /** How the cloud will get this to the device. */
  delivery: "long-poll" | "woken" | "queued";
}

/** What a secure link asks for. Shown to the person filling it in. */
export interface SecureFormSpec {
  kind: "login" | "card" | "address";
  /** e.g. "resy.com". The device keeps its own copy of the origin; this is display only. */
  label: string;
}

/** Sealed inside a "vault" envelope; only the device can open it. */
export interface SecureFormSubmission {
  formId: string;
  fields: Record<string, string>;
}

export const API = {
  register: "/v1/devices",
  device: (id: string) => `/v1/devices/${encodeURIComponent(id)}`,
  enqueue: (id: string) => `/v1/devices/${encodeURIComponent(id)}/envelopes`,
  checkin: "/v1/checkin",
  form: (id: string) => `/v1/forms/${encodeURIComponent(id)}`,
  formPage: (id: string) => `/s/${encodeURIComponent(id)}`,
  telegramWebhook: "/v1/channels/telegram/webhook",
  health: "/healthz",
} as const;
