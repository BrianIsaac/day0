'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { autonomousActionsOn } from '@/work/autonomy';
import { Button } from '../../../components/Button';
import { Dialog } from '../../../components/Dialog';
import { Field, INPUT_CLASS } from '../../../components/Field';
import { StatusRegion } from '../../../components/StatusRegion';
import { useChange } from '../../../components/use-change';
import {
  retireBlockedByAcceptance,
  retireCancelsHandover,
  type OpenHandover,
} from '../../../handover-words';
import {
  confirmationMatches,
  credentialsWords,
  deletedWords,
  waitingWords,
  type RetirePreview,
} from './retire-words';

/**
 * The phrase the manager types to retire an employee.
 *
 * @param name - The employee's name.
 */
export function retirePhrase(name: string): string {
  return `retire ${name}`;
}

/** One line of the dialog's account of what a retire does: its term and the sentences under it. */
interface RetireLine {
  readonly term: string;
  readonly details: readonly string[];
}

/**
 * A sentence from words that may start lower case: capitalised, with its full stop.
 *
 * @param words - The words.
 */
function sentence(words: string): string {
  return `${words.charAt(0).toLocaleUpperCase('en-GB')}${words.slice(1)}.`;
}

/**
 * The claims the retire keeps, in a sentence: one, several, or a floor when the preview stopped
 * counting its items, oldest first (the later ones may hold claims even when those counted held none).
 */
function keptClaimsLine(
  preview: Pick<RetirePreview, 'keptClaims' | 'keptClaimsAtLeast'>,
): string | undefined {
  const rest = 'it may already have written, so no colleague repeats those writes.';
  if (preview.keptClaimsAtLeast) {
    return preview.keptClaims > 0
      ? `The claims on at least ${preview.keptClaims} items ${rest}`
      : `The claims on any of its later items ${rest}`;
  }
  if (preview.keptClaims === 0) return undefined;
  return preview.keptClaims === 1
    ? 'The claim on the item it may already have written, so no colleague repeats the write.'
    : `The claims on ${preview.keptClaims} items ${rest}`;
}

/**
 * What retiring the employee does, line by line, in the manager's words (round two section 3.9):
 * what is revoked, deleted and kept, and what waits on the manager and goes undecided, with an
 * asked handover, which the retire cancels (the transfer plan, section 7.5). The hosted office
 * wipes and keeps nothing, so it says so rather than promising a record.
 *
 * @param preview - What `reset.retirePreview` says the retire would do.
 * @param waiting - What waits on the manager, in words; empty when nothing does.
 * @param handover - The handover open on the employee, if any.
 */
export function retireLines(
  preview: RetirePreview,
  waiting: string,
  handover?: OpenHandover | null,
): RetireLine[] {
  const deleted = { term: 'Deleted', details: [sentence(deletedWords(preview))] };
  const waits = {
    term: 'Waiting on you',
    details: [
      waiting === '' ? 'Nothing.' : sentence(`${waiting}, discarded undecided`),
      ...(handover?.state === 'asked' ? [retireCancelsHandover(handover.toAddress)] : []),
    ],
  };
  if (preview.mode === 'mock') {
    return [
      deleted,
      {
        term: 'Kept',
        details: ['Nothing: the hosted office keeps no record of a retired employee.'],
      },
      waits,
    ];
  }
  const claims = keptClaimsLine(preview);
  const kept = [
    'One record under your account: the name, the rows each table lost and the date, so the audit export can say the employee existed.',
    ...(preview.kept.length > 0
      ? [
          sentence(
            `${credentialsWords(preview.kept)}, which another employee or a documentation source still uses`,
          ),
        ]
      : []),
    ...(claims === undefined ? [] : [claims]),
  ];
  return [
    {
      term: 'Revoked',
      details: [
        preview.revoked.length > 0
          ? `${sentence(`${credentialsWords(preview.revoked)}: Day0 deletes its copy at once, so no later run can use it`)} The token stays valid at the provider until you revoke it there.`
          : 'Nothing: no credential is bound only by this employee.',
      ],
    },
    deleted,
    { term: 'Kept', details: kept },
    waits,
  ];
}

/**
 * Where the manager who is not sure goes instead of retiring. Day0 has no pause for one employee
 * (the state machine has no paused state), so the alternative offered is the one that holds
 * every write for the manager: supervision.
 *
 * @param agent - The employee.
 * @param mode - The deployment's surface mode.
 */
export function retireAlternative(agent: Doc<'agents'>, mode: RetirePreview['mode']): string {
  if (mode === 'mock') {
    return `Not sure? Keep ${agent.name}: in the hosted office nothing it does leaves the mock office, and every write waits for your decision.`;
  }
  return autonomousActionsOn(agent)
    ? `Not sure? Keep ${agent.name} and turn autonomous actions off instead: nothing but reads and the DM to you lands without your approval, and nothing is deleted.`
    : `Not sure? Keep ${agent.name}: with autonomous actions off, nothing but reads and the DM to you lands without your approval, and nothing is deleted.`;
}

/**
 * The retire dialog (round two's `retire-dialog.html`, decisions Q15 and N1): what retiring the
 * employee revokes, deletes and keeps and what waiting work goes with it, read from
 * `reset.retirePreview`, the employee's needs-you inbox and its open handover before anything is
 * done; a typed confirmation; Keep, which holds focus, and Retire, enabled once the words match;
 * and the alternative for a manager who is not sure. A refusal is said inside the dialog and
 * leaves it open. While a handover is accepting, Retire stays off and the dialog says why: the
 * acceptance cannot be undone, and a retire would destroy what the new manager accepted (the
 * transfer plan, section 7.5).
 *
 * @param agent - The employee to retire.
 * @param mode - The deployment's surface mode: a retire in real mode, a wipe in the hosted office.
 * @param onClose - Close the dialog without retiring.
 * @param onRetired - The retire landed; the employee is gone.
 */
export function RetireDialog({
  agent,
  mode,
  onClose,
  onRetired,
}: {
  agent: Doc<'agents'>;
  mode: RetirePreview['mode'];
  onClose: () => void;
  onRetired: (name: string) => void;
}) {
  const preview = useQuery(api.reset.retirePreview, { agentId: agent._id });
  // Once the employee is gone the preview answers null; the inbox, which refuses a missing
  // employee, is not asked again.
  const inbox = useQuery(
    api.work.needsYouForAgent,
    preview === null ? 'skip' : { agentId: agent._id },
  );
  const handover = useQuery(
    api.managerTransfers.openForAgent,
    preview === null ? 'skip' : { agentId: agent._id },
  );
  const retire = useMutation(api.reset.retire);
  const [typed, setTyped] = useState('');
  const keep = useRef<HTMLButtonElement>(null);
  const change = useChange(keep);
  const blockedId = useId();
  const phrase = retirePhrase(agent.name);
  const ready =
    preview !== undefined && preview !== null && inbox !== undefined && handover !== undefined;
  const accepting = handover?.state === 'accepting' ? handover : undefined;
  const matches = confirmationMatches(typed, phrase);

  let account: ReactNode;
  if (!ready) {
    account = (
      <p role="status" className="text-sm text-[var(--color-muted)]">
        Counting what retiring {agent.name} would change
      </p>
    );
  } else {
    account = (
      <dl className="grid gap-x-4 gap-y-2 text-[15px] sm:grid-cols-[max-content_minmax(0,1fr)]">
        {retireLines(preview, waitingWords(inbox.entries, inbox.total), handover).map((line) => (
          <div key={line.term} className="contents">
            <dt className="font-medium text-[var(--color-fg)]">{line.term}</dt>
            <dd className="mb-1 grid gap-1 text-[var(--color-fg-2)] sm:mb-0">
              {line.details.map((detail) => (
                <span key={detail}>{detail}</span>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  return (
    <Dialog
      role="alertdialog"
      title={`Retire ${agent.name}?`}
      onClose={onClose}
      description={
        mode === 'mock'
          ? `This removes ${agent.name} and everything it made in the hosted office. It cannot be undone.`
          : `This ends ${agent.name}'s employment now. It cannot be undone.`
      }
      initialFocus={keep}
      busy={change.busy}
    >
      {account}
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready || !matches || accepting !== undefined || change.busy) return;
          change.run(() => retire({ agentId: agent._id }), {
            done: (result) => `${result.agentName} is retired.`,
            refused: `${agent.name} was not retired.`,
            after: (result) => onRetired(result.agentName),
          });
        }}
      >
        <Field
          label={
            <>
              Type <b className="font-semibold text-[var(--color-fg)]">{phrase}</b> to confirm
            </>
          }
        >
          {(control) => (
            <input
              {...control}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={change.busy || accepting !== undefined}
              className={`${INPUT_CLASS} w-full`}
            />
          )}
        </Field>
        {accepting === undefined ? null : (
          <p id={blockedId} className="text-[15px] text-[var(--color-fg-2)]">
            {retireBlockedByAcceptance(agent.name, accepting.toAddress)}
          </p>
        )}
        <StatusRegion outcome={change.outcome} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button ref={keep} size="large" disabled={change.busy} onClick={onClose}>
            Keep {agent.name}
          </Button>
          <Button
            type="submit"
            variant="danger"
            size="large"
            disabled={!ready || !matches || accepting !== undefined || change.busy}
            aria-describedby={accepting === undefined ? undefined : blockedId}
          >
            {change.busy ? `Retiring ${agent.name}…` : `Retire ${agent.name}`}
          </Button>
        </div>
      </form>
      <p className="text-[13px] text-[var(--color-muted)]">{retireAlternative(agent, mode)}</p>
    </Dialog>
  );
}
