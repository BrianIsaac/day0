'use client';

import { useId } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { deploymentZone } from '@/lib/zone';
import { arrivingLine, ON_ITS_WAY } from '../handover-words';

/**
 * The acceptor's employees on their way (the transfer plan, section 4.2: `accepting` "is shown to
 * both managers as accepted, handing over"): one line per accepted handover whose employee is
 * finishing its runs for the old manager, read live, so it says so across reloads and goes once
 * the employee has arrived on the roster. Nothing is drawn while there is none.
 */
export function OnItsWay() {
  const arriving = useQuery(api.managerTransfers.arriving);
  const headingId = useId();
  if (arriving === undefined || arriving.length === 0) return null;
  const zone = deploymentZone();
  return (
    <section
      aria-labelledby={headingId}
      className="mb-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]"
    >
      <h2
        id={headingId}
        className="border-b border-[var(--color-border)] px-5 py-4 text-sm font-semibold"
      >
        {ON_ITS_WAY}
      </h2>
      <ul className="flex flex-col gap-2 px-5 py-4 text-sm text-[var(--color-fg-2)] [overflow-wrap:anywhere]">
        {arriving.map((transfer) => (
          <li key={transfer.transferId}>
            {arrivingLine({
              name: transfer.agentName,
              from: transfer.fromAddress,
              runs: transfer.runsInFlight,
              settleBy: transfer.settleBy,
              zone,
            })}
          </li>
        ))}
      </ul>
    </section>
  );
}
