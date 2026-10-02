'use client';

import { useId } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { deploymentZone } from '@/lib/zone';
import { endedHandoverLine, notFinishedHeading } from '../handover-words';

/**
 * The acceptor's handovers that ended without the move (decision 4; the cockpit's item): one line
 * per handover the manager accepted that could not finish and was ended in the last 30 days, while
 * that is still so, saying the employee stays with the manager who asked. The old manager reads
 * the same on the employee's record. Nothing is drawn while there is none.
 */
export function HandoverEnded() {
  const ended = useQuery(api.managerTransfers.endedForMe);
  const headingId = useId();
  if (ended === undefined || ended.length === 0) return null;
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
        {notFinishedHeading(ended.length)}
      </h2>
      <ul className="flex flex-col gap-2 px-5 py-4 text-sm text-[var(--color-fg-2)] [overflow-wrap:anywhere]">
        {ended.map((transfer) => (
          <li key={transfer.transferId}>
            {endedHandoverLine({
              name: transfer.agentName,
              from: transfer.fromAddress,
              acceptedAt: transfer.acceptedAt,
              zone,
            })}
          </li>
        ))}
      </ul>
    </section>
  );
}
