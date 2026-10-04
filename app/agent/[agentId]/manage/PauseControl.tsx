'use client';

import { useRef } from 'react';
import { Button } from '../../../components/Button';
import { StatusRegion } from '../../../components/StatusRegion';
import { clockTime, useAgentZone } from '../../../components/time';
import { useChange } from '../../../components/use-change';

/** What a pause does, said on the card of an employee that is running (the prototype's words). */
export const PAUSE_CARD_COPY =
  'Stops intake and holds every run at its next gate. Nothing is deleted; resume any time.';

/** What a pause leaves running, said beside what it holds (an apply that has claimed its set). */
export const PAUSE_IN_FLIGHT_COPY = 'A write already on its way finishes first.';

/** The body copy of a Manage card; a reason may be one long unbroken string, such as a link. */
const COPY = 'text-sm text-[var(--color-fg-2)] break-words';

/**
 * The manager's pause for one employee, real mode only (Manage tab; wave 12, 12-P): what a pause
 * does, and what it leaves running, with **Pause {name}** while the employee runs; since when it
 * is paused, the reason given, what still waits on the manager and **Resume {name}**, the page's
 * next step, while it is paused. A pause is undone by the resume, so neither asks to confirm. What
 * each change came to is said in a live region and focus stays on the control, whose name changes
 * with the state.
 *
 * @param name - The employee's name.
 * @param pausedAt - When the pause began, or undefined while the employee runs.
 * @param reason - The manager's reason for the pause, if they gave one.
 * @param onPause - Pause the employee.
 * @param onResume - Resume it.
 */
export function PauseControl({
  name,
  pausedAt,
  reason,
  onPause,
  onResume,
}: {
  name: string;
  pausedAt?: number;
  reason?: string;
  onPause: () => Promise<unknown>;
  onResume: () => Promise<unknown>;
}) {
  const control = useRef<HTMLButtonElement>(null);
  const change = useChange(control);
  const zone = useAgentZone();
  const paused = pausedAt !== undefined;

  return (
    <div className="grid justify-items-start gap-3">
      {paused ? (
        <div className="grid gap-1">
          <p className={COPY}>Paused since {clockTime(pausedAt, zone)}.</p>
          {/* The pause may be a previous manager's: the reason is the pause's, not the reader's. */}
          {reason ? <p className={COPY}>Reason: {reason}</p> : null}
          <p className={COPY}>
            {name} takes no new work and starts nothing new. Decisions it already asked still wait
            on you; what you approve runs once you resume {name}.
          </p>
        </div>
      ) : (
        <div className="grid gap-1">
          <p className={COPY}>{PAUSE_CARD_COPY}</p>
          <p className={COPY}>{PAUSE_IN_FLIGHT_COPY}</p>
        </div>
      )}
      <Button
        ref={control}
        variant={paused ? 'primary' : 'secondary'}
        disabled={change.busy}
        // A name runs to 80 characters: the label wraps inside the card rather than past it.
        className="max-w-full !whitespace-normal text-left"
        onClick={() =>
          change.run(paused ? onResume : onPause, {
            done: paused ? `${name} is working again.` : `${name} is paused.`,
            refused: paused ? `${name} was not resumed.` : `${name} was not paused.`,
          })
        }
      >
        {paused ? `Resume ${name}` : `Pause ${name}`}
      </Button>
      <StatusRegion outcome={change.outcome} />
    </div>
  );
}
