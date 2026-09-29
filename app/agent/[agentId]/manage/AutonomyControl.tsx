'use client';

import { AUTONOMY_WARNING } from '@/work/autonomy';
import { useState, useRef, useId } from 'react';
import { Button } from '../../../components/Button';
import { Dialog } from '../../../components/Dialog';
import { useChange } from '../../../components/use-change';
import { StatusRegion } from '../../../components/StatusRegion';

/** What each state of the switch does, said under its name. */
export const AUTONOMY_TITLES: Readonly<Record<'off' | 'on', string>> = {
  off: 'Supervised: reads and the DM to you apply on their own; every other action waits for your approval of the exact payload.',
  on: 'Autonomous: the employee acts on connected systems without asking, within the connections and skills you have approved.',
};

/**
 * The confirmation shown before autonomous actions are turned on: the warning in the operator's
 * words (`AUTONOMY_WARNING`, untouched), Cancel holding focus, and Turn on. It is the product's
 * one dialog (`Dialog`, M's scale-in moment): focus is kept inside it, and Escape or a press on
 * the page behind cancels, unless the change is in flight.
 *
 * @param onConfirm - Turn the switch on.
 * @param onCancel - Leave it off.
 * @param busy - Whether the change is in flight.
 */
export function AutonomyConfirm({
  onConfirm,
  onCancel,
  busy = false,
}: {
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      role="alertdialog"
      title="Turn on autonomous actions?"
      onClose={onCancel}
      initialFocus={cancel}
      busy={busy}
    >
      <p className="leading-relaxed text-[var(--color-fg-2)]">{AUTONOMY_WARNING}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button ref={cancel} size="large" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="retry" size="large" disabled={busy} onClick={onConfirm}>
          Turn on
        </Button>
      </div>
    </Dialog>
  );
}

/**
 * The manager's autonomous-actions switch, real mode only (Manage tab): its name and what the
 * current state does, beside a switch drawn 24 by 44 inside its 44 px target. Turning it on
 * opens the confirmation; turning it off needs none. What each change came to is said in a live
 * region and focus comes back to the switch.
 *
 * @param on - Whether autonomous actions are on.
 * @param onChange - Persist the manager's choice.
 */
export function AutonomyControl({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (on: boolean) => Promise<unknown>;
}) {
  const [confirming, setConfirming] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const change = useChange(toggle);
  const describedBy = useId();

  function persist(next: boolean): void {
    change.run(() => onChange(next), {
      done: next
        ? 'Autonomous actions are on: the employee acts on connected systems without asking.'
        : 'Autonomous actions are off: every action but reads and the DM to you waits for your approval.',
      refused: 'The switch was not changed.',
      after: () => setConfirming(false),
    });
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[15px] font-medium text-[var(--color-fg)]">Autonomous actions</p>
          <p id={describedBy} className="text-sm text-[var(--color-fg-2)]">
            {AUTONOMY_TITLES[on ? 'on' : 'off']}
          </p>
        </div>
        <button
          ref={toggle}
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Autonomous actions"
          aria-describedby={describedBy}
          disabled={change.busy}
          onClick={() => {
            if (on) persist(false);
            else setConfirming(true);
          }}
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full disabled:cursor-wait"
        >
          <span
            aria-hidden="true"
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-[180ms] ${
              on ? 'bg-[var(--color-warn)]' : 'bg-[var(--color-border-2)]'
            }`}
          >
            <span
              className={`inline-block h-5 w-5 rounded-full bg-[var(--color-fg)] transition-transform duration-[180ms] ease-out ${
                on ? 'translate-x-[22px]' : 'translate-x-0.5'
              }`}
            />
          </span>
        </button>
      </div>
      <p className="text-[13px] text-[var(--color-muted)]">
        Turning it on asks you to confirm first; turning it off takes effect at once.
      </p>
      <StatusRegion outcome={change.outcome} />
      {confirming && !on ? (
        <AutonomyConfirm
          busy={change.busy}
          onConfirm={() => persist(true)}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
}
