'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { MAX_TRANSFER_NOTE_LENGTH, transferExpiresAt } from '@/agent/manager-transfer';
import { deploymentZone } from '@/lib/zone';
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
  changeAddressDescription,
  HANDOVER_ADDRESS_HINT,
  HANDOVER_ADDRESS_LABEL,
  HANDOVER_NOTE_HINT,
  HANDOVER_NOTE_LABEL,
  handOverLines,
  handOverTitle,
  KEEP_THE_ADDRESS,
  KEEP_THE_HANDOVER,
  madeYouWords,
  MAKE_IT_YOU,
  WHAT_HAPPENS,
} from '../../../handover-words';

/**
 * The verdicts that stand on the old manager's approval of a card: a handover cuts each, as
 * `surfaceHandoverOf` in `convex/surfaces.ts` decides for the move.
 */
const CUT_VERDICTS: ReadonlySet<Doc<'surfaces'>['verdict']> = new Set([
  'approved',
  'connected',
  'ungranted',
  'listed-dead',
]);

/** What the cut is decided from: a card as `surfaces.listForAgent` lists it. */
export type CutCandidate = Pick<
  Doc<'surfaces'>,
  'displayName' | 'verdict' | 'credentialId' | 'provisioning' | 'managerApprovedAt'
>;

/**
 * The systems a handover would cut, by the name the Surfaces tab gives each: every card bound to
 * a credential (its own or its provisioned app's secret) or standing on the old manager's
 * approval, the rule `surfaceHandoverOf` states for the move (the transfer plan, section 6.3).
 *
 * @param surfaces - The employee's cards.
 */
export function cutSystems(surfaces: readonly CutCandidate[]): string[] {
  const cut = surfaces.filter(
    (surface) =>
      surface.credentialId !== undefined ||
      surface.provisioning !== undefined ||
      surface.managerApprovedAt !== undefined ||
      CUT_VERDICTS.has(surface.verdict),
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
  address = '',
  changing,
  change,
  landed,
  onClose,
}: HandOverDialogProps) {
  const ask = useMutation(api.managerTransfers.ask);
  const changeAddress = useMutation(api.managerTransfers.changeAddress);
  // Only real mode cuts a connection; the cards are read here, as the move reads them.
  const surfaces = useQuery(
    api.surfaces.listForAgent,
    mode === 'real' ? { agentId: agent._id } : 'skip',
  );
  // The account of what happens is complete before anything can be asked.
  const counted = mode === 'mock' || surfaces !== undefined;
  const [to, setTo] = useState(changing?.toAddress ?? address);
  const [note, setNote] = useState(changing?.note ?? '');
  const now = useNow();
  const zone = deploymentZone();
  const lines = handOverLines({
    name: agent.name,
    mode,
    cutSystems: cutSystems(surfaces ?? []),
    expiresAt: transferExpiresAt(now),
    zone,
  });

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (change.busy || !counted) return;
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
    <Dialog
      title={handOverTitle(agent.name)}
      description={
        changing === undefined ? undefined : changeAddressDescription(changing.toAddress)
      }
      onClose={onClose}
      busy={change.busy}
    >
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
              maxLength={MAX_TRANSFER_NOTE_LENGTH}
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
            {changing === undefined ? 'Cancel' : KEEP_THE_ADDRESS}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="large"
            disabled={change.busy || !counted}
            // An address is one word: it wraps anywhere rather than run out of a phone's dialog.
            className="!whitespace-normal text-left [overflow-wrap:anywhere]"
          >
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
  /** The flag's sentence, which says what the control answers. */
  readonly describedBy?: string;
}

/**
 * **Make it you** (section 11.2): the owner's verified address becomes the employee's, through
 * `agents.adoptManagerAddress`. Said on the card, where focus goes once the flag is gone.
 */
export function MakeItYou({ agent, change, landed, describedBy }: MakeItYouProps) {
  const adopt = useMutation(api.agents.adoptManagerAddress);
  return (
    <Button
      size="small"
      disabled={change.busy}
      aria-describedby={describedBy}
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
