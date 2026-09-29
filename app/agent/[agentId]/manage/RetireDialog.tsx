'use client';

import { useRef, useState, type ReactNode } from 'react';
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
 * What retiring the employee does, line by line, in the manager's words (round two section 3.9):
 * what is revoked, deleted and kept, and what waits on the manager and goes undecided. The
 * hosted office wipes and keeps nothing, so it says so rather than promising a record.
 *
 * @param preview - What `reset.retirePreview` says the retire would do.
 * @param waiting - What waits on the manager, in words; empty when nothing does.
 */
export function retireLines(preview: RetirePreview, waiting: string): RetireLine[] {
  const deleted = { term: 'Deleted', details: [sentence(deletedWords(preview))] };
  const waits = {
    term: 'Waiting on you',
    details: [waiting === '' ? 'Nothing.' : sentence(`${waiting}, discarded undecided`)],
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
  const kept = [
    'One record under your account: the name, the rows each table lost and the date, so the audit export can say the employee existed.',
    ...(preview.kept.length > 0
      ? [
          sentence(
            `${credentialsWords(preview.kept)}, which another employee or a documentation source still uses`,
          ),
        ]
      : []),
    ...(preview.keptClaims > 0
      ? [
          `The claim on ${preview.keptClaims === 1 ? 'the item' : `${preview.keptClaims} items`} it may already have written, so no colleague repeats the write.`,
        ]
      : []),
  ];
  return [
    {
      term: 'Revoked',
      details: [
        preview.revoked.length > 0
          ? `${sentence(`${credentialsWords(preview.revoked)}, at once`)} A write reaching a system after this moment is refused.`
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
 * `reset.retirePreview` and the employee's needs-you inbox before anything is done; a typed
 * confirmation; Keep, which holds focus, and Retire, enabled once the words match; and the
 * alternative for a manager who is not sure. A refusal is said inside the dialog and leaves it
 * open.
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
  const inbox = useQuery(api.work.needsYouForAgent, { agentId: agent._id });
  const retire = useMutation(api.reset.retire);
  const [typed, setTyped] = useState('');
  const keep = useRef<HTMLButtonElement>(null);
  const change = useChange(keep);
  const phrase = retirePhrase(agent.name);
  const ready = preview !== undefined && preview !== null && inbox !== undefined;
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
        {retireLines(preview, waitingWords(inbox.entries, inbox.total)).map((line) => (
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
      initialFocus={keep}
      busy={change.busy}
    >
      <p className="text-[var(--color-fg-2)]">
        {mode === 'mock'
          ? `This removes ${agent.name} and everything it made in the hosted office. It cannot be undone.`
          : `This ends ${agent.name}'s employment now. It cannot be undone.`}
      </p>
      {account}
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready || !matches || change.busy) return;
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
              disabled={change.busy}
              className={`${INPUT_CLASS} w-full`}
            />
          )}
        </Field>
        <StatusRegion outcome={change.outcome} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button ref={keep} size="large" disabled={change.busy} onClick={onClose}>
            Keep {agent.name}
          </Button>
          <Button
            type="submit"
            variant="danger"
            size="large"
            disabled={!ready || !matches || change.busy}
          >
            {change.busy ? `Retiring ${agent.name}…` : `Retire ${agent.name}`}
          </Button>
        </div>
      </form>
      <p className="text-[13px] text-[var(--color-muted)]">{retireAlternative(agent, mode)}</p>
    </Dialog>
  );
}
