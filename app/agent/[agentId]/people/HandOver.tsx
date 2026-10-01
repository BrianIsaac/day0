'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { transferExpiresAt } from '@/agent/manager-transfer';
import { deploymentZone } from '@/lib/zone';
import type { SurfaceRecord } from '@/surfaces/types';
import { Button } from '../../../components/Button';
import { Dialog } from '../../../components/Dialog';
import { Field, INPUT_CLASS } from '../../../components/Field';
import { StatusRegion } from '../../../components/StatusRegion';
import type { Change } from '../../../components/use-change';
import { useNow } from '../../../components/time';
import {
  askedWords,
  askLabel,
  CANCEL_HANDOVER_DESCRIPTION,
  CANCEL_THE_HANDOVER,
  cancelHandoverTitle,
  cancelledWords,
  HANDOVER_ADDRESS_HINT,
  HANDOVER_ADDRESS_LABEL,
  HANDOVER_NOTE_HINT,
  HANDOVER_NOTE_LABEL,
  handOverLines,
  handOverTitle,
  KEEP_THE_HANDOVER,
  madeYouWords,
  MAKE_IT_YOU,
  WHAT_HAPPENS,
} from '../../../handover-words';

/**
 * The verdicts that stand on the old manager's approval of a card: a handover cuts each, as
 * `surfaceHandoverOf` in `convex/surfaces.ts` decides for the move. The card's record carries the
 * verdict and the bound credential, which is what the decision reads; the approval stamp itself
 * is not on the record, so a card approved and since refused is not named here.
 */
const CUT_VERDICTS: ReadonlySet<SurfaceRecord['verdict']> = new Set([
  'approved',
  'connected',
  'ungranted',
  'listed-dead',
]);

/**
 * The systems a handover would cut, by the name the Surfaces tab gives each: every card bound to
 * a credential or standing on the old manager's approval, as the move decides it (the transfer
 * plan, section 6.3).
 *
 * @param surfaces - The employee's cards, as the page reads them.
 */
export function cutSystems(surfaces: readonly SurfaceRecord[]): string[] {
  const cut = surfaces.filter(
    (surface) => surface.credentialId !== undefined || CUT_VERDICTS.has(surface.verdict),
  );
  return [...new Set(cut.map((surface) => surface.displayName))];
}

/** The request a dialog names another address for, when it changes one rather than asks. */
export interface ChangingHandover {
  readonly transferId: Id<'managerTransfers'>;
  readonly toAddress: string;
  readonly note?: string;
}

/** What the hand-over dialog is drawn from. */
export interface HandOverDialogProps {
  readonly agent: Doc<'agents'>;
  readonly mode: 'mock' | 'real';
  readonly surfaces: readonly SurfaceRecord[];
  /** The address the field starts with: the flagged address, or the asked one being changed. */
  readonly address?: string;
  /** The open request whose address this changes; a new ask when absent. */
  readonly changing?: ChangingHandover;
  /** The card's change: busy while the ask runs, said inside the dialog while it is open. */
  readonly change: Change;
  /** Where focus goes once the ask lands, since the control that opened the dialog goes with it. */
  readonly landed: () => HTMLElement | null;
  readonly onClose: () => void;
}

/**
 * The hand-over dialog (plan 7.1): the new manager's address, a note for them, and what happens,
 * line by line, before anything is asked. It asks through `managerTransfers.ask`, or, for an open
 * request, names another address through `managerTransfers.changeAddress`. A refusal is said in
 * the dialog's own status region and leaves it open (m38); an ask that lands closes it and is said
 * on the card.
 */
export function HandOverDialog({
  agent,
  mode,
  surfaces,
  address = '',
  changing,
  change,
  landed,
  onClose,
}: HandOverDialogProps) {
  const ask = useMutation(api.managerTransfers.ask);
  const changeAddress = useMutation(api.managerTransfers.changeAddress);
  const [to, setTo] = useState(changing?.toAddress ?? address);
  const [note, setNote] = useState(changing?.note ?? '');
  const now = useNow();
  const zone = deploymentZone();
  const lines = handOverLines({
    name: agent.name,
    mode,
    cutSystems: cutSystems(surfaces),
    expiresAt: transferExpiresAt(now),
    zone,
  });

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (change.busy) return;
    const toAddress = to.trim();
    const kept = note.trim();
    change.run(
      () =>
        changing === undefined
          ? ask({
              agentId: agent._id,
              toAddress,
              ...(kept === '' ? {} : { note: kept }),
            })
          : // An empty note removes the one the request carried; a changed one replaces it.
            changeAddress({ transferId: changing.transferId, toAddress, note: kept }),
      {
        done: askedWords(agent.name, toAddress),
        refused: `${agent.name} was not handed over.`,
        after: onClose,
        focus: landed,
      },
    );
  };

  return (
    <Dialog title={handOverTitle(agent.name)} onClose={onClose} busy={change.busy}>
      <form className="grid gap-4" onSubmit={submit}>
        <Field label={HANDOVER_ADDRESS_LABEL} hint={HANDOVER_ADDRESS_HINT}>
          {(control) => (
            <input
              {...control}
              type="email"
              required
              autoComplete="off"
              spellCheck={false}
              value={to}
              disabled={change.busy}
              onChange={(event) => setTo(event.target.value)}
              className={`${INPUT_CLASS} w-full`}
            />
          )}
        </Field>
        <Field label={HANDOVER_NOTE_LABEL} hint={HANDOVER_NOTE_HINT}>
          {(control) => (
            <textarea
              {...control}
              rows={3}
              value={note}
              disabled={change.busy}
              onChange={(event) => setNote(event.target.value)}
              className={`${INPUT_CLASS} w-full resize-y`}
            />
          )}
        </Field>
        <div className="grid gap-2">
          <h3 className="text-[13px] font-medium text-[var(--color-fg-2)]">{WHAT_HAPPENS}</h3>
          <ul className="grid list-disc gap-1.5 pl-5 text-[15px] text-[var(--color-fg-2)]">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        <StatusRegion outcome={change.outcome} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="large" disabled={change.busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={change.busy}>
            {change.busy ? 'Asking…' : askLabel(to)}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** What the cancel's confirmation is drawn from. */
export interface CancelHandoverDialogProps {
  readonly transferId: Id<'managerTransfers'>;
  readonly toAddress: string;
  readonly change: Change;
  readonly landed: () => HTMLElement | null;
  readonly onClose: () => void;
}

/**
 * The confirmation behind **Cancel the handover** (plan 7.1): it says the request leaves the named
 * manager's inbox. Keep holds focus; the cancel goes through `managerTransfers.cancel`, and a
 * refusal is said here and leaves the confirmation open.
 */
export function CancelHandoverDialog({
  transferId,
  toAddress,
  change,
  landed,
  onClose,
}: CancelHandoverDialogProps) {
  const cancel = useMutation(api.managerTransfers.cancel);
  const keep = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      role="alertdialog"
      title={cancelHandoverTitle(toAddress)}
      description={CANCEL_HANDOVER_DESCRIPTION}
      initialFocus={keep}
      onClose={onClose}
      busy={change.busy}
    >
      <StatusRegion outcome={change.outcome} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button ref={keep} size="large" disabled={change.busy} onClick={onClose}>
          {KEEP_THE_HANDOVER}
        </Button>
        <Button
          variant="danger"
          size="large"
          disabled={change.busy}
          onClick={() =>
            change.run(() => cancel({ transferId }), {
              done: cancelledWords(toAddress),
              refused: 'The handover was not cancelled.',
              after: onClose,
              focus: landed,
            })
          }
        >
          {change.busy ? 'Cancelling…' : CANCEL_THE_HANDOVER}
        </Button>
      </div>
    </Dialog>
  );
}

/** What **Make it you** is drawn from. */
export interface MakeItYouProps {
  readonly agent: Doc<'agents'>;
  readonly change: Change;
  readonly landed: () => HTMLElement | null;
}

/**
 * **Make it you** (section 11.2): the owner's verified address becomes the employee's, through
 * `agents.adoptManagerAddress`. Said on the card, where focus goes once the flag is gone.
 */
export function MakeItYou({ agent, change, landed }: MakeItYouProps) {
  const adopt = useMutation(api.agents.adoptManagerAddress);
  return (
    <Button
      size="small"
      disabled={change.busy}
      onClick={() =>
        change.run(() => adopt({ agentId: agent._id }), {
          done: madeYouWords(agent.name),
          refused: `${agent.name}'s manager was not changed.`,
          focus: landed,
        })
      }
    >
      {MAKE_IT_YOU}
    </Button>
  );
}
