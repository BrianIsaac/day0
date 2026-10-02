'use client';

import { useId, useRef, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@convex/_generated/api';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
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

/** One kind of stored row a deletion takes, in the words the card and its warning say it by. */
interface HeldKind {
  readonly kind: Exclude<keyof Holdings, 'documentation'>;
  /** As the card lists what is stored. */
  readonly stored: string;
  /** As the warning lists what goes. */
  readonly goes: string;
}

/** Each kind of stored row a deletion always takes, in the order they are said. */
const HELD_KINDS: readonly HeldKind[] = [
  { kind: 'employees', stored: 'your employees', goes: 'every employee and its data' },
  { kind: 'skillLibrary', stored: 'your skill library', goes: 'your skill library' },
  {
    kind: 'handoverWords',
    stored: 'the notes on your handover requests',
    goes: 'the notes on your handover requests',
  },
  {
    kind: 'retiredBoundaries',
    stored: 'the claims and rejections your retired employees kept',
    goes: 'the claims and rejections your retired employees kept',
  },
];

/** Phrases joined as a sentence lists them: "a", "a and b", "a, b and c". */
function listed(phrases: readonly string[]): string {
  return phrases.length <= 1
    ? (phrases[0] ?? '')
    : `${phrases.slice(0, -1).join(', ')} and ${phrases.at(-1)}`;
}

/**
 * What is stored for the manager now, so a live button says what it would take and a disabled
 * one says why. Linked documentation is said apart, since only the unlink choice takes it.
 *
 * @param holdings - What the deletion would take, as the backend reads it.
 * @param alsoUnlinkDocumentation - Whether the manager has ticked the unlink choice.
 */
export function heldNow(holdings: Holdings, alsoUnlinkDocumentation: boolean): string {
  const held = HELD_KINDS.filter(({ kind }) => holdings[kind]).map(({ stored }) => stored);
  if (held.length === 0) {
    if (!holdings.documentation) return 'Nothing of yours is stored now.';
    return alsoUnlinkDocumentation
      ? 'Only your linked documentation is stored now, and it goes with the box ticked.'
      : 'Only your linked documentation is stored now: tick the box below to unlink it.';
  }
  const documentation = !holdings.documentation
    ? ''
    : alsoUnlinkDocumentation
      ? ' Your linked documentation goes too.'
      : ' Your linked documentation stays unless you tick the box below.';
  return `Stored for you now: ${listed(held)}.${documentation}`;
}

/**
 * What the deletion does, said in its confirmation: what goes, from what is stored, and what
 * stays.
 *
 * @param holdings - What the deletion would take, as the backend reads it.
 * @param alsoUnlinkDocumentation - Whether the owner's documentation goes too.
 */
export function deletionWarning(holdings: Holdings, alsoUnlinkDocumentation: boolean): string {
  const goes = HELD_KINDS.filter(({ kind }) => holdings[kind]).map(({ goes: words }) => words);
  const unlinks = alsoUnlinkDocumentation && holdings.documentation;
  const what =
    goes.length === 0
      ? 'This unlinks every documentation source.'
      : `This deletes ${listed(goes)}${unlinks ? ', and unlinks every documentation source' : ''}.`;
  const requests = holdings.handoverWords
    ? ' The requests stay in the other manager’s record.'
    : '';
  const documentation =
    holdings.documentation && !alsoUnlinkDocumentation ? ' Your documentation stays linked.' : '';
  return `${what}${requests}${documentation} Your sign-in stays. It cannot be undone.`;
}

/**
 * Whether a deletion would take anything: any stored row it removes, or the documentation once the
 * manager has chosen to unlink it.
 */
function hasDataToDelete(holdings: Holdings, alsoUnlinkDocumentation: boolean): boolean {
  return (
    HELD_KINDS.some(({ kind }) => holdings[kind]) ||
    (alsoUnlinkDocumentation && holdings.documentation)
  );
}

/**
 * The deletion of the manager's data: every employee and what it made, the skill library, the
 * notes on their handover requests, and optionally the documentation. Live whenever the account
 * holds anything the deletion would take, an employee or not (the v0.13.0 walk), and disabled
 * while it holds nothing or the page has not read it yet; the line under the words says which.
 * A danger card, as Retire's is. Pressing it opens the shared confirmation dialog, Keep my data
 * focused first; what the deletion came to is said on the card and focus comes back to the
 * button, or to the card once nothing is left for the button to take.
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
  const storedId = useId();
  const deletable = holdings ? hasDataToDelete(holdings, alsoUnlinkDocumentation) : false;

  const close = (): void => {
    change.clear();
    setConfirming(false);
  };

  return (
    <Card title="Your data" tone="danger" focusRef={card}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-[var(--color-muted)]">
            Deletes your employees and everything they made, your skill library and the notes on
            your handover requests. Your sign-in stays, and the requests stay in the other manager’s
            record.
          </p>
          <p id={storedId} className="mt-2 text-sm text-[var(--color-fg)]">
            {holdings
              ? heldNow(holdings, alsoUnlinkDocumentation)
              : 'Checking what is stored for you…'}
          </p>
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
          aria-describedby={storedId}
          onClick={() => {
            change.clear();
            setConfirming(true);
          }}
          disabled={change.busy || !deletable}
          className="shrink-0 self-start sm:self-center"
        >
          {change.busy ? 'Deleting…' : 'Delete my data…'}
        </Button>
      </div>
      <StatusRegion outcome={confirming ? null : change.outcome} />
      {confirming && holdings ? (
        <Dialog
          role="alertdialog"
          title="Delete your data?"
          description={deletionWarning(holdings, alsoUnlinkDocumentation)}
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
    </Card>
  );
}
