'use client';

import { useRef } from 'react';
import { Button } from '../../../components/Button';
import { StatusRegion } from '../../../components/StatusRegion';
import { clockTime, useAgentZone } from '../../../components/time';
import { useChange } from '../../../components/use-change';

/** What a pause does, said on the card of an employee that is running (the prototype's words). */
export const PAUSE_CARD_COPY =
  'Stops intake and holds every run at its next gate. Nothing is deleted; resume any time.';

/** The body copy of a Manage card. */
const COPY = 'text-sm text-[var(--color-fg-2)]';

/**
 * The manager's pause for one employee, real mode only (Manage tab; wave 12, 12-P): what a pause
 * does and **Pause {name}** while the employee runs; since when it is paused, the reason given,
 * what still waits on the manager and **Resume {name}** while it is paused. A pause is undone by
 * the resume, so neither asks to confirm. What each change came to is said in a live region and
 * focus stays on the control, whose name changes with the state.
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
          {reason ? <p className={COPY}>Your reason: {reason}</p> : null}
          <p className={COPY}>
            {name} takes no new work and starts no step. Decisions it already asked still wait on
            you, and what you approve runs once you resume.
          </p>
        </div>
      ) : (
        <p className={COPY}>{PAUSE_CARD_COPY}</p>
      )}
      <Button
        ref={control}
        variant={paused ? 'retry' : 'secondary'}
        disabled={change.busy}
        onClick={() =>
          change.run(paused ? onResume : onPause, {
            done: paused
              ? `${name} is working again: what was held goes on now.`
              : `${name} is paused: it takes no new work, and each run holds at its next gate.`,
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
