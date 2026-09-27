/**
 * Q5's access end date as a hard boundary: the day it passes, the surface is
 * not connected for intake, for the manager channel or for an apply, whatever
 * its stored verdict says until the hourly sweep ends it (wave 2 review D4).
 */

import { dayKey } from '../lib/zone';

/**
 * Whether a surface's access end date has passed.
 *
 * @param surface - The surface's end date; a surface with none runs on no clock.
 * @param now - The instant to judge.
 * @returns True from the end date on.
 */
export function accessEnded(surface: { readonly expiresAt?: number }, now: number): boolean {
  return surface.expiresAt !== undefined && surface.expiresAt <= now;
}

/**
 * Why nothing is read from or sent through a surface whose access ended.
 *
 * @param expiresAt - The end date that passed.
 * @param zone - The agent's zone, which the date is named in.
 * @returns The refusal the card and the ledger show.
 */
export function accessEndedReason(expiresAt: number, zone: string): string {
  return `access ended on ${dayKey(expiresAt, zone)}; the manager renews it on the card`;
}
