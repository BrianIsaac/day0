/**
 * How long a probe holds its card against a routine re-probe (E-88): its one
 * retry's wait (at most the provider backoff's 30 s), two 30 s provider calls
 * and a browser sign-in, with room to spare. A probe that dies without
 * recording its result frees the card when the lease lapses.
 */
export const PROBE_LEASE_MS = 2 * 60_000;

/**
 * Whether a probe is in flight on a card: one started and its lease has not lapsed.
 *
 * @param surface - The card's probe start, absent while none runs.
 * @param now - The moment asked about.
 */
export function probeInFlight(surface: { readonly probeStartedAt?: number }, now: number): boolean {
  return surface.probeStartedAt !== undefined && now - surface.probeStartedAt < PROBE_LEASE_MS;
}
