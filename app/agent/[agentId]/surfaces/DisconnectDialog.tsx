'use client';

import { useRef } from 'react';
import { Button } from '../../../components/Button';
import { Dialog } from '../../../components/Dialog';
import { StatusRegion } from '../../../components/StatusRegion';
import { useChange } from '../../../components/use-change';

/** What the Disconnect dialog is drawn from. */
export interface DisconnectDialogProps {
  /** The system as the card names it. */
  readonly system: string;
  /** The employee whose card it is. */
  readonly employee: string;
  /** What happens at the vendor, line by line (`disconnectLines`). */
  readonly lines: readonly string[];
  /** Disconnect the card (`surfaces.disconnect`); rejects with the refusal to say. */
  readonly onConfirm: () => Promise<void>;
  readonly onClose: () => void;
}

/**
 * The confirmation a card's Disconnect asks first (11-AR; the access plan, section 4.4): what
 * stops at once, what happens at the vendor for this card, and the two choices, the safe one
 * holding focus. A refusal is said inside the dialog and leaves it open; a disconnect that lands
 * closes it, and the card, which stays, says the rest.
 */
export function DisconnectDialog({
  system,
  employee,
  lines,
  onConfirm,
  onClose,
}: DisconnectDialogProps) {
  const keep = useRef<HTMLButtonElement>(null);
  const change = useChange(keep);
  return (
    <Dialog
      role="alertdialog"
      title={`Disconnect ${system}?`}
      description={`${employee} stops reading and writing ${system} at once. The card keeps your approval.`}
      onClose={onClose}
      initialFocus={keep}
      busy={change.busy}
    >
      <ul className="grid gap-2 text-[15px] leading-relaxed text-[var(--color-fg-2)]">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <StatusRegion outcome={change.outcome} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button ref={keep} size="large" disabled={change.busy} onClick={onClose}>
          Keep it connected
        </Button>
        <Button
          variant="danger"
          size="large"
          disabled={change.busy}
          onClick={(): void =>
            change.run(onConfirm, {
              done: `${system} is disconnected.`,
              refused: `${system} was not disconnected.`,
              after: onClose,
            })
          }
        >
          {change.busy ? `Disconnecting ${system}…` : `Disconnect ${system}`}
        </Button>
      </div>
    </Dialog>
  );
}
