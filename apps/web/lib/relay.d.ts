export interface RelayStore {
  get(k: string): Promise<string | null>;
  set(k: string, v: string, ex?: number, nx?: boolean): Promise<boolean>;
  getdel(k: string): Promise<string | null>;
  del(k: string): Promise<unknown>;
  incr(k: string, ex: number): Promise<number>;
  rpush(k: string, v: string, ex: number): Promise<void>;
  popall(k: string, n?: number): Promise<string[]>;
}
export const MODEL_PROVIDERS: Record<string, { baseUrl: string; keyEnv: string }>;
export function operatorConfig(env: Record<string, string | undefined>): {
  model: { name: string; baseUrl: string; key: string } | null;
  botToken: string | null;
  publicUrl: string | null;
};
export function upstashStore(url: string, token: string, f?: typeof fetch): RelayStore;
export function memoryStore(): RelayStore & { dump(): string[] };
export function storeFromEnv(env: Record<string, string | undefined>): RelayStore | null;
export function createRelay(
  store: RelayStore | null,
  opts?: { env?: Record<string, string | undefined>; fetch?: typeof fetch; devicesPerHour?: number; formsPerHour?: number; modelCallsPerHour?: number; sendsPerHour?: number },
): (req: Request) => Promise<Response>;
