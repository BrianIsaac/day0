'use client';

import { useRef, useState } from 'react';
import { MANAGER_FEEDBACK_MAX_CHARS } from '@/work/manager-channel';
import { Button } from '../../../components/Button';
import { Dialog } from '../../../components/Dialog';
import { Field, INPUT_CLASS } from '../../../components/Field';
import { StatusRegion } from '../../../components/StatusRegion';
import { useChange } from '../../../components/use-change';

/** A name that starts a sentence: the default "the employee" takes a capital there. */
function capitalised(name: string): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/**
 * What stopping does, said before the manager decides (wave 12, 12-W; wording drafts).
 *
 * @param employeeName - Who is working the item.
 * @param applying - Whether the run is sending the writes the manager approved, so one may land.
 */
export function stopDialogDescription(employeeName: string, applying: boolean): string {
  const name = capitalised(employeeName);
  return applying
    ? `${name} is sending the writes you approved. Stopping sends nothing more, but a write in flight may still land: the item lists each one for you to check before any retry.`
    : `${name} stops now and sends nothing more. Anything already sent stays sent; the item waits for you, stopped, with Retry.`;
}

/**
 * What the Stop control of a working card does, said under it.
 *
 * @param employeeName - Who is working the item.
 */
export function stopWhy(employeeName: string): string {
  return `${capitalised(employeeName)}, once stopped, sends nothing more, and the item waits for you with Retry.`;
}

/**
 * The words a stop the manager made comes to, for the card's live region.
 *
 * @param title - The item's title.
 */
export function stoppedOutcome(title: string): string {
  return `Stopped: ${title}. It waits for you with Retry.`;
}

/**
 * The Stop dialog of a working card (wave 12, 12-W, over the shared `Dialog`): it asks before a
 * run under way is stopped, says what stopping does and what it cannot undo, and takes an optional
 * reason kept with the item. Keep working holds focus; a refusal is said inside the dialog and
 * leaves it open; once the stop lands the dialog closes and the card says it.
 *
 * @param title - The item's title, which the heading names.
 * @param employeeName - Who is working it.
 * @param applying - Whether the run is sending the writes the manager approved.
 * @param onStop - Stop the run with the reason as typed (empty when none).
 * @param onClose - Close the dialog without stopping.
 * @param onDone - The stop landed, with what the card's live region says.
 */
export function StopDialog({
  title,
  employeeName,
  applying,
  onStop,
  onClose,
  onDone,
}: {
  title: string;
  employeeName: string;
  applying: boolean;
  onStop: (reason: string) => Promise<unknown> | void;
  onClose: () => void;
  onDone: (words: string) => void;
}) {
  const [reason, setReason] = useState('');
  const keep = useRef<HTMLButtonElement>(null);
  const change = useChange(keep);
  return (
    <Dialog
      role="alertdialog"
      title={`Stop work on “${title}”?`}
      description={stopDialogDescription(employeeName, applying)}
      onClose={onClose}
      initialFocus={keep}
      busy={change.busy}
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (change.busy) return;
          change.run(() => onStop(reason.trim()), {
            done: stoppedOutcome(title),
            refused: 'The run was not stopped.',
            after: () => onDone(stoppedOutcome(title)),
          });
        }}
      >
        <Field label="Reason (optional)" hint="Shown on the item and kept in the record.">
          {(control) => (
            <input
              {...control}
              name="reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={MANAGER_FEEDBACK_MAX_CHARS}
              autoComplete="off"
              disabled={change.busy}
              className={`${INPUT_CLASS} w-full`}
            />
          )}
        </Field>
        <StatusRegion outcome={change.outcome} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button ref={keep} size="large" disabled={change.busy} onClick={onClose}>
            Keep working
          </Button>
          <Button type="submit" variant="danger" size="large" disabled={change.busy}>
            {change.busy ? 'Stopping…' : 'Stop the run'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
