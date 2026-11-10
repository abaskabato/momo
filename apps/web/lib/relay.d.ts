export interface RelayStore {
  get(k: string): Promise<string | null>;
  set(k: string, v: string, ex?: number, nx?: boolean): Promise<boolean>;
  getdel(k: string): Promise<string | null>;
  del(k: string): Promise<unknown>;
  incr(k: string, ex: number): Promise<number>;
  rpush(k: string, v: string, ex: number): Promise<void>;
  popall(k: string): Promise<string[]>;
}
export function upstashStore(url: string, token: string, f?: typeof fetch): RelayStore;
export function memoryStore(): RelayStore & { dump(): string[] };
export function storeFromEnv(env: Record<string, string | undefined>): RelayStore | null;
export function createRelay(store: RelayStore | null, opts?: { devicesPerHour?: number; formsPerHour?: number }): (req: Request) => Promise<Response>;
