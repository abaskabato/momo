// Device-side client for the coordination cloud. Every call is signed with the
// device key; no bearer tokens exist that could be stolen from the cloud.

import { SIG_HEADERS, signRequest, type DeviceKeys } from "./crypto.ts";
import {
  API,
  type CheckinRequest,
  type CheckinResponse,
  type EnqueueRequest,
  type EnqueueResponse,
  type RegisterDeviceRequest,
  type WakeStrategy,
} from "./types.ts";

export class CloudClient {
  readonly baseUrl: string;
  readonly deviceId: string;
  private readonly keys: DeviceKeys;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, deviceId: string, keys: DeviceKeys, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.deviceId = deviceId;
    this.keys = keys;
    this.fetchImpl = fetchImpl;
  }

  async register(pairCode: string, wake: WakeStrategy): Promise<void> {
    const body: RegisterDeviceRequest = {
      deviceId: this.deviceId,
      pairCode,
      boxPublicKey: this.keys.boxPublicKey,
      signPublicKey: this.keys.signPublicKey,
      wake,
    };
    const res = await this.fetchImpl(this.baseUrl + API.register, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  }

  checkin(req: CheckinRequest, signal?: AbortSignal): Promise<CheckinResponse> {
    return this.signed<CheckinResponse>("POST", API.checkin, req, signal);
  }

  enqueueSelf(req: EnqueueRequest): Promise<EnqueueResponse> {
    return this.signed<EnqueueResponse>("POST", API.enqueue(this.deviceId), req);
  }

  private async signed<T>(method: string, path: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const body = JSON.stringify(payload);
    const { timestamp, signature } = signRequest(this.keys, method, path, body);
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      body,
      signal,
      headers: {
        "content-type": "application/json",
        [SIG_HEADERS.device]: this.deviceId,
        [SIG_HEADERS.timestamp]: timestamp,
        [SIG_HEADERS.signature]: signature,
      },
    });
    if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }
}
