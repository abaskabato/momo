import type { LocalVault } from "../../vault.ts";

export interface SlotQuery {
  restaurant: string;
  date: string;
  time: string;
  party: number;
}

export interface Slot {
  date: string;
  time: string;
  party: number;
}

export interface VenuePolicy {
  /** Charged only if you don't show up / cancel late. */
  noShowFeePerPersonUsd?: number;
  /** Charged at booking. */
  depositUsd?: number;
  cancelBy?: string;
}

export interface SearchResult {
  venue: { id: string; name: string };
  slots: Slot[];
  policy: VenuePolicy;
}

export interface BookingResult {
  confirmation: string;
  chargedUsd: number;
}

export interface ProviderContext {
  vault: LocalVault;
  signal?: AbortSignal;
}

/**
 * One booking site. Implementations drive the site on the owner's machine
 * (their browser, their session, their vault); nothing goes through our cloud.
 */
export interface ReservationProvider {
  readonly id: string;
  readonly origin: string;
  search(q: SlotQuery, ctx: ProviderContext): Promise<SearchResult | null>;
  book(venueId: string, slot: Slot, ctx: ProviderContext): Promise<BookingResult>;
  cancel(confirmation: string, ctx: ProviderContext): Promise<void>;
}

/** Worst-case money the owner is agreeing to put at risk. */
export function exposureUsd(policy: VenuePolicy, party: number): number {
  return (policy.depositUsd ?? 0) + (policy.noShowFeePerPersonUsd ?? 0) * party;
}

/** Exact slot, else the closest one within `windowMin` minutes. */
export function rankSlots(slots: Slot[], wanted: string, windowMin = 90): Slot[] {
  const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const w = mins(wanted);
  return slots
    .map((s) => ({ s, d: Math.abs(mins(s.time) - w) }))
    .filter((x) => x.d <= windowMin)
    .sort((a, b) => a.d - b.d || mins(a.s.time) - mins(b.s.time))
    .map((x) => x.s);
}
