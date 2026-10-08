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
  readonly kind: Exclude<keyof Holdings, 'documentation' | 'credentials'>;
  /** As the card lists what is stored. */
  readonly stored: string;
  /** As the warning lists what goes. */
  readonly goes: string;
}

/** Each kind of stored row a deletion always takes, in the order they are said. */
const heldKinds: readonly HeldKind[] = [
  { kind: 'employees', stored: 'your employees', goes: 'every employee and its data' },
  { kind: 'skillLibrary', stored: 'your skill library', goes: 'your skill library' },
  {
    kind: 'people',
    stored: 'the people and working agreements you keep',
    goes: 'the people and working agreements you keep',
  },
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

/** What only the unlink choice takes, as the card lists it: the documentation, then the credentials. */
function takenByUnlink(holdings: Holdings): string[] {
  return [
    ...(holdings.documentation ? ['your linked documentation'] : []),
    ...(holdings.credentials ? ['the credentials you stored'] : []),
  ];
}

/**
 * What is stored for the manager now, so a live button says what it would take and a disabled
 * one says why. Linked documentation and the credentials the manager stored are said apart, since
 * only the unlink choice takes them (the wave 11 review's m15).
 *
 * @param holdings - What the deletion would take, as the backend reads it.
 * @param alsoUnlinkDocumentation - Whether the manager has ticked the unlink choice.
 */
export function heldNow(holdings: Holdings, alsoUnlinkDocumentation: boolean): string {
  const held = heldKinds.filter(({ kind }) => holdings[kind]).map(({ stored }) => stored);
  const apart = takenByUnlink(holdings);
  if (held.length === 0) {
    if (apart.length === 0) {
      // The owner's own entry alone never makes the control live: the next sign-in writes it again.
      return holdings.ownEntry === true
        ? 'Nothing of yours is stored now except your own entry among your people, which Day0 writes again each time you open this page.'
        : 'Nothing of yours is stored now.';
    }
    if (!holdings.credentials) {
      return alsoUnlinkDocumentation
        ? 'Only your linked documentation is stored now, and it goes with the box ticked.'
        : 'Only your linked documentation is stored now: tick the box below to unlink it.';
    }
    const verb = holdings.documentation ? 'unlink and delete' : 'delete';
    return alsoUnlinkDocumentation
      ? `Only ${listed(apart)} remain, and they go with the box ticked.`
      : `Only ${listed(apart)} remain: tick the box below to ${verb} them.`;
  }
  if (apart.length === 0) return `Stored for you now: ${listed(held)}.`;
  // One phrase is a single thing (`stays`), two or the credentials are many (`stay`).
  const many = holdings.credentials;
  const subject = listed(apart);
  const said = `${subject.charAt(0).toUpperCase()}${subject.slice(1)}`;
  const fate = alsoUnlinkDocumentation
    ? `${many ? 'go' : 'goes'} too.`
    : `${many ? 'stay' : 'stays'} unless you tick the box below.`;
  return `Stored for you now: ${listed(held)}. ${said} ${fate}`;
}

/**
 * What the deletion does, said in its confirmation: what goes, from what is stored, and what
 * stays.
 *
 * @param holdings - What the deletion would take, as the backend reads it.
 * @param alsoUnlinkDocumentation - Whether the owner's documentation goes too.
 */
export function deletionWarning(holdings: Holdings, alsoUnlinkDocumentation: boolean): string {
  const goes = heldKinds.filter(({ kind }) => holdings[kind]).map(({ goes: words }) => words);
  const unlinks = alsoUnlinkDocumentation && holdings.documentation;
  // The credentials the manager stored go with the box ticked, said as one more thing deleted.
  const deleted = [
    ...goes,
    ...(alsoUnlinkDocumentation && holdings.credentials ? ['the credentials you stored'] : []),
  ];
  const what =
    deleted.length > 0
      ? `This deletes ${listed(deleted)}${unlinks ? ', and unlinks every documentation source' : ''}.`
      : unlinks
        ? 'This unlinks every documentation source.'
        : 'There is nothing left to delete.';
  const requests = holdings.handoverWords
    ? ' The requests stay in the other manager’s record.'
    : '';
  const documentation =
    holdings.documentation && !alsoUnlinkDocumentation ? ' Your documentation stays linked.' : '';
  const credentials =
    holdings.credentials && !alsoUnlinkDocumentation ? ' The credentials you stored stay.' : '';
  if (deleted.length === 0 && !unlinks) return `${what}${documentation}${credentials}`;
  return `${what}${requests}${documentation}${credentials} Your sign-in stays. It cannot be undone.`;
}

/**
 * The unlink choice's label, naming only what the box takes for this manager: the documentation
 * sources, the credentials they stored, or both; the documentation while nothing is read yet.
 *
 * @param holdings - What the deletion would take, or undefined or null before it is read.
 */
export function unlinkLabel(holdings: Holdings | null | undefined): string {
  const takes = [
    ...(!holdings?.credentials || holdings.documentation
      ? ['unlink your documentation sources']
      : []),
    ...(holdings?.credentials ? ['delete the credentials you stored'] : []),
  ];
  return `Also ${takes.join(' and ')}`;
}

/**
 * What the card says the deletion takes: in the hosted office, where no person and no working
 * agreement is kept, it names neither, as its dialog does not (the v0.17.0 redeploy's finding 4).
 *
 * @param mode - The deployment's mode, or undefined while it is read.
 */
export function whatItDeletes(mode: 'mock' | 'real' | undefined): string {
  const takes =
    mode === 'mock'
      ? 'your employees and everything they made, your skill library and the notes on your handover requests'
      : 'your employees and everything they made, your skill library, the people and working agreements you keep (including your own entry among your people) and the notes on your handover requests';
  return `Deletes ${takes}. Your sign-in stays, and the requests stay in the other manager’s record.`;
}

/**
 * Whether a deletion would take anything: any stored row it removes, or the documentation once the
 * manager has chosen to unlink it.
 */
function hasDataToDelete(holdings: Holdings, alsoUnlinkDocumentation: boolean): boolean {
  return (
    heldKinds.some(({ kind }) => holdings[kind]) ||
    (alsoUnlinkDocumentation && (holdings.documentation || holdings.credentials))
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
export function ResetCard({ mode }: { readonly mode?: 'mock' | 'real' } = {}) {
  const holdings = useQuery(api.reset.holdings);
  const reset = useMutation(api.reset.deleteMyData);
  const [alsoUnlinkDocumentation, setAlsoUnlinkDocumentation] = useState(false);
  // What was stored when the dialog opened: its warning stays the one the manager is answering,
  // though Convex applies the emptied holdings before the deletion resolves.
  const [confirming, setConfirming] = useState<Holdings | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLElement>(null);
  const change = useChange(card);
  const storedId = useId();
  const deletable = holdings ? hasDataToDelete(holdings, alsoUnlinkDocumentation) : false;

  const close = (): void => {
    change.clear();
    setConfirming(null);
  };

  return (
    <Card title="Your data" tone="danger" focusRef={card}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-[var(--color-muted)]">{whatItDeletes(mode)}</p>
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
            {unlinkLabel(holdings)}
          </label>
        </div>
        <Button
          ref={opener}
          variant="danger"
          aria-haspopup="dialog"
          aria-describedby={storedId}
          onClick={() => {
            change.clear();
            setConfirming(holdings ?? null);
          }}
          disabled={change.busy || !deletable}
          className="shrink-0 self-start sm:self-center"
        >
          {change.busy ? 'Deleting…' : 'Delete my data…'}
        </Button>
      </div>
      <StatusRegion outcome={confirming !== null ? null : change.outcome} />
      {confirming !== null ? (
        <Dialog
          role="alertdialog"
          title="Delete your data?"
          description={deletionWarning(confirming, alsoUnlinkDocumentation)}
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
                  after: () => setConfirming(null),
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
