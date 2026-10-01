'use client';

import { useId } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { deploymentZone } from '@/lib/zone';
import { HANDED_OVER, handedOverLine, type HandoverDeparture } from '../handover-words';

/**
 * The employees a manager handed over in the last 30 days, accepted ones only, newest first:
 * declines and expiries are said on the People card while the employee is still the manager's
 * (the transfer plan, section 7.4). An employee the manager holds again, handed back since, is
 * on the roster and is left out here, and one handed over twice is named once, where it went last
 * (the wave 9 review's U4-m3).
 *
 * @param departures - The manager's finished requests, newest first, as
 *   `managerTransfers.departures` lists them.
 * @param held - The employees the manager holds now.
 */
export function handedOver(
  departures: readonly HandoverDeparture[],
  held: readonly string[],
): HandoverDeparture[] {
  const named = new Set(held);
  return departures.filter((departure) => {
    if (departure.state !== 'accepted' || named.has(departure.agentId)) return false;
    named.add(departure.agentId);
    return true;
  });
}

/**
 * The old manager's notice on their home (plan 7.4): a quiet card under the roster, "Handed
 * over", one line per employee another manager took on in the last 30 days, since the page that
 * would have said it closed to them at acceptance. Nothing is drawn while there is none, or while
 * the roster that says which employees came back is still read.
 *
 * @param held - The employees the manager holds now, from the roster; undefined while it loads.
 */
export function HandedOver({ held }: { readonly held: readonly string[] | undefined }) {
  const departures = useQuery(api.managerTransfers.departures);
  const headingId = useId();
  const shown = held === undefined ? [] : handedOver(departures ?? [], held);
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
