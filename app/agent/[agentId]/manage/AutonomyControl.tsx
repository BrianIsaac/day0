'use client';

import { AUTONOMY_WARNING, autonomyLabel } from '@/work/autonomy';
import { useState, useRef, useId } from 'react';
import { useChange, LiveStatus } from '../live-status';

/** What each state of the switch does, for its title. */
const AUTONOMY_TITLES: Record<'off' | 'on', string> = {
  off: 'Supervised: reads and the DM to you apply on their own; every other action waits for your approval of the exact payload.',
  on: 'Autonomous: the employee acts on connected systems without asking, within the connections and skills you have approved.',
};

/** Whether a key press should take the safe path out of the confirmation. */
export function cancelsAutonomyConfirm(key: string, busy: boolean): boolean {
  return key === 'Escape' && !busy;
}

/**
 * The confirmation shown before autonomous actions are turned on.
 *
 * Args:
 *   onConfirm: Turn the switch on.
 *   onCancel: Leave it off.
 *   busy: Whether the change is in flight.
 *
 * Returns:
 *   The warning in the operator's words with its two buttons.
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
  return (
    // It scales in from the corner it hangs from, not its centre (v3 section 5.2).
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Turn on autonomous actions"
      data-dialog=""
      onKeyDown={(event) => {
        if (!cancelsAutonomyConfirm(event.key, busy)) return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
      className="absolute left-0 sm:left-auto sm:right-0 top-full mt-2 origin-top-left sm:origin-top-right w-80 max-w-[calc(100vw-3rem)] p-3 rounded-lg border border-[var(--color-warn)]/40 bg-[var(--color-card)] shadow-lg text-left text-xs text-[var(--color-fg)] z-10"
    >
      <p className="font-medium text-[var(--color-warn)] mb-1">Turn on autonomous actions?</p>
      <p className="mb-3 leading-relaxed">{AUTONOMY_WARNING}</p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="min-h-11 px-3 rounded-md bg-[var(--color-warn)] text-[var(--color-bg)] font-medium disabled:opacity-60"
        >
          Turn on
        </button>
        <button
          type="button"
          autoFocus
          disabled={busy}
          onClick={onCancel}
          className="min-h-11 px-3 rounded-md border border-[var(--color-border)] disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The header chip as the manager's autonomous-actions switch, real mode only.
 *
 * Turning it on opens the confirmation; turning it off needs none. The chip
 * names the state plainly ("Supervised" / "Autonomous") beside the switch.
 *
 * Args:
 *   on: Whether autonomous actions are on.
 *   tone: The chip's colour classes.
 *   onChange: Persist the manager's choice.
 *
 * Returns:
 *   The labelled switch styled as the chip.
 */
export function AutonomyControl({
  on,
  tone,
  onChange,
}: {
  on: boolean;
  tone: string;
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
    <div className="relative">
      <div
        className={`flex items-center gap-2 pl-3 pr-1 rounded-full text-xs font-medium ${tone}`}
        title={AUTONOMY_TITLES[on ? 'on' : 'off']}
      >
        <span>Active · {autonomyLabel(on)}</span>
        <span className="text-[10px] font-normal opacity-80">Autonomous actions</span>
        <span id={describedBy} className="sr-only">
          {AUTONOMY_TITLES[on ? 'on' : 'off']}
        </span>
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
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full disabled:cursor-wait"
        >
          <span
            aria-hidden="true"
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
              on ? 'bg-[var(--color-warn)]' : 'bg-[var(--color-muted)]/40'
            }`}
          >
            <span
              className={`inline-block h-3 w-3 rounded-full bg-[var(--color-bg)] transition-transform ${
                on ? 'translate-x-3.5' : 'translate-x-0.5'
              }`}
            />
          </span>
        </button>
      </div>
      <LiveStatus outcome={change.outcome} />
      {confirming && !on ? (
        <AutonomyConfirm
          busy={change.busy}
          onConfirm={() => persist(true)}
          onCancel={() => {
            setConfirming(false);
            toggle.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
