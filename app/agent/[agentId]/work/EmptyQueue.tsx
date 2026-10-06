'use client';

import type { Id } from '@convex/_generated/dataModel';
import { api } from '@convex/_generated/api';
import { useMutation, useQuery } from 'convex/react';
import { useRef } from 'react';
import { Button } from '../../../components/Button';
import { StatusRegion } from '../../../components/StatusRegion';
import { useChange } from '../../../components/use-change';

/**
 * What an empty Work tab says (12-J item 6, option C; 12-FX's "an empty queue with nothing
 * said"): before the charter is approved, that work arrives once it is; once it is, how the
 * seeding of the approved charter stands when it did not finish, with "Find work again" once every
 * attempt failed; otherwise that new work appears as it is found.
 */
export function EmptyQueue({
  agentId,
  charterApproved,
}: {
  agentId: Id<'agents'>;
  charterApproved: boolean;
}) {
  const standing = useQuery(api.charterSeeding.standing, charterApproved ? { agentId } : 'skip');
  const findWorkAgain = useMutation(api.charterSeeding.findWorkAgain);
  const change = useChange();
  // The press removes its own button once the seeding is under way again: focus goes to the line
  // that says so, never to the page's start.
  const line = useRef<HTMLParagraphElement>(null);
  if (!charterApproved) {
    return (
      <p className="text-sm text-[var(--color-muted)]">
        Work arrives once you approve the charter.
      </p>
    );
  }
  return (
    <div className="grid gap-2">
      <p
        ref={line}
        tabIndex={-1}
        className={`text-sm ${
          standing?.state === 'stopped' ? 'text-[var(--color-warn)]' : 'text-[var(--color-muted)]'
        }`}
      >
        {standing
          ? standing.line
          : 'Nothing has come in yet. New work appears here as it is found.'}
      </p>
      {standing?.state === 'stopped' ? (
        <div>
          <Button
            size="small"
            disabled={change.busy}
            onClick={() =>
              change.run(() => findWorkAgain({ agentId }), {
                done: 'Finding work again. It appears here as it is found.',
                refused: 'Finding work again did not start.',
                after: () => line.current?.focus(),
              })
            }
          >
            {change.busy ? 'Starting…' : 'Find work again'}
          </Button>
        </div>
      ) : null}
      <StatusRegion outcome={change.outcome} />
    </div>
  );
}
