'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@convex/_generated/api';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { StatusRegion } from '../components/StatusRegion';
import { useChange } from '../components/use-change';

/** What a deletion of the manager's data would take, as the backend reads it. */
type Holdings = NonNullable<FunctionReturnType<typeof api.reset.holdings>>;

/**
 * What a deletion came to, in the warning's own verbs. The count of employees is not said: the
 * deletion also clears evaluation agents the roster never shows, so a number would not match the
 * page the manager just saw.
 *
 * @param unlinkedSources - How many documentation sources the deletion unlinked.
 */
export function resetOutcome(unlinkedSources: number): string {
  return unlinkedSources > 0
    ? `Your data is deleted, and ${unlinkedSources} documentation ${unlinkedSources === 1 ? 'source is' : 'sources are'} unlinked.`
    : 'Your data is deleted.';
}

/**
 * What the deletion does, said in its confirmation.
 *
 * @param alsoUnlinkDocumentation - Whether the owner's documentation goes too.
 */
export function resetWarning(alsoUnlinkDocumentation: boolean): string {
  return alsoUnlinkDocumentation
    ? 'This deletes every employee and its data, your skill library and the notes on your handover requests, and unlinks every documentation source. It cannot be undone.'
    : 'This deletes every employee and its data, your skill library and the notes on your handover requests. Your documentation stays linked. It cannot be undone.';
}

/** Each kind of stored row, in the words the card lists it by, in the order it lists them. */
const HELD_WORDS: ReadonlyArray<readonly [keyof Holdings, string]> = [
  ['employees', 'your employees'],
  ['skillLibrary', 'your skill library'],
  ['handoverWords', 'the notes on your handover requests'],
  ['retiredBoundaries', 'the claims your retired employees kept'],
  ['documentation', 'your linked documentation'],
];

/**
 * What is stored for the manager now, so a live button says what it would take and a disabled
 * one says why it is disabled.
 *
 * @param holdings - What the deletion would take, as the backend reads it.
 */
export function heldNow(holdings: Holdings): string {
  const held = HELD_WORDS.filter(([kind]) => holdings[kind]).map(([, words]) => words);
  if (held.length === 0) return 'Nothing of yours is stored now.';
  const listed = held.length === 1 ? held[0] : `${held.slice(0, -1).join(', ')} and ${held.at(-1)}`;
  return `Stored for you now: ${listed}.`;
}

/**
 * Whether a deletion would take anything: any stored row it removes, or the documentation once the
 * manager has chosen to unlink it.
 */
function hasDataToDelete(holdings: Holdings, alsoUnlinkDocumentation: boolean): boolean {
  return (
    holdings.employees ||
    holdings.skillLibrary ||
    holdings.handoverWords ||
    holdings.retiredBoundaries ||
    (alsoUnlinkDocumentation && holdings.documentation)
  );
}

/**
 * The deletion of the manager's data: every employee and what it made, the skill library, the
 * notes on their handover requests, and optionally the documentation. Live whenever the account
 * holds anything the deletion would take, an employee or not (the v0.13.0 walk), and disabled
 * while it holds nothing or the page has not read it yet. Pressing it opens the shared
 * confirmation dialog, Keep my data focused first; what the deletion came to is said on the card
 * and focus comes back to the button, or to the card once nothing is left for the button to take.
 */
export function ResetCard() {
  const holdings = useQuery(api.reset.holdings);
  const reset = useMutation(api.reset.deleteMyData);
  const [alsoUnlinkDocumentation, setAlsoUnlinkDocumentation] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLElement>(null);
  const change = useChange(card);
  const deletable = holdings ? hasDataToDelete(holdings, alsoUnlinkDocumentation) : false;

  const close = (): void => {
    change.clear();
    setConfirming(false);
  };

  return (
    <section
      ref={card}
      tabIndex={-1}
      aria-labelledby="delete-my-data-title"
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-5 outline-none"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id="delete-my-data-title" className="mb-1 text-sm font-semibold">
            Your data
          </h2>
          <p className="text-sm text-[var(--color-muted)]">
            Delete every employee and its workspace, charter, work items, skills and mock
            environment rows, your skill library, and the notes on your handover requests. The
            requests stay in the other manager’s record. Useful between demos.
          </p>
          {holdings ? (
            <p className="mt-1 text-sm text-[var(--color-muted)]">{heldNow(holdings)}</p>
          ) : null}
          <label className="mt-1 flex min-h-11 cursor-pointer items-center gap-2 text-sm text-[var(--color-muted)]">
            <input
              type="checkbox"
              checked={alsoUnlinkDocumentation}
              onChange={(event) => setAlsoUnlinkDocumentation(event.target.checked)}
            />
            Also unlink your documentation sources
          </label>
        </div>
        <Button
          ref={opener}
          variant="danger"
          aria-haspopup="dialog"
          onClick={() => {
            change.clear();
            setConfirming(true);
          }}
          disabled={change.busy || !deletable}
          className="shrink-0 self-start sm:self-center"
        >
          {change.busy ? 'Deleting…' : 'Delete my data'}
        </Button>
      </div>
      <StatusRegion outcome={confirming ? null : change.outcome} />
      {confirming ? (
        <Dialog
          role="alertdialog"
          title="Delete your data?"
          description={resetWarning(alsoUnlinkDocumentation)}
          onClose={close}
          initialFocus={keep}
          busy={change.busy}
        >
          <StatusRegion outcome={change.outcome} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button ref={keep} size="large" disabled={change.busy} onClick={close}>
              Keep my data
            </Button>
            <Button
              variant="danger"
              size="large"
              disabled={change.busy}
              onClick={() =>
                change.run(() => reset({ alsoUnlinkDocumentation }), {
                  done: (result) => resetOutcome(result.unlinkedSources),
                  refused: 'Nothing was deleted.',
                  after: () => setConfirming(false),
                  // The button is disabled once nothing is left to take; the card takes focus then.
                  focus: () =>
                    opener.current && !opener.current.disabled ? opener.current : card.current,
                })
              }
            >
              Delete my data
            </Button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
