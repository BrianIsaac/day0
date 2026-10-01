'use client';

import { useId } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { deploymentZone } from '@/lib/zone';
import { HANDED_OVER, handedOverLine, type HandoverDeparture } from '../handover-words';

/**
 * The employees a manager handed over in the last 30 days, accepted ones only, newest first:
 * declines and expiries are said on the People card while the employee is still the manager's
 * (the transfer plan, section 7.4).
 *
 * @param departures - The manager's finished requests, as `managerTransfers.departures` lists them.
 */
export function handedOver(departures: readonly HandoverDeparture[]): HandoverDeparture[] {
  return departures.filter((departure) => departure.state === 'accepted');
}

/**
 * The old manager's notice on their home (plan 7.4): a quiet card under the roster, "Handed
 * over", one line per employee another manager took on in the last 30 days, since the page that
 * would have said it closed to them at acceptance. Nothing is drawn while there is none.
 */
export function HandedOver() {
  const departures = useQuery(api.managerTransfers.departures);
  const headingId = useId();
  const shown = handedOver(departures ?? []);
  if (shown.length === 0) return null;
  const zone = deploymentZone();
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]"
    >
      <h2
        id={headingId}
        className="border-b border-[var(--color-border)] px-5 py-4 text-sm font-semibold"
      >
        {HANDED_OVER}
      </h2>
      <ul className="flex flex-col gap-2 px-5 py-4 text-sm text-[var(--color-fg-2)]">
        {shown.map((departure) => (
          <li key={departure.transferId}>
            {handedOverLine(departure.agentName, departure.toAddress, departure.decidedAt, zone)}
          </li>
        ))}
      </ul>
    </section>
  );
}
