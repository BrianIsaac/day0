'use client';

import type { FunctionReturnType } from 'convex/server';
import type { api } from '@convex/_generated/api';
import { deploymentZone } from '@/lib/zone';
import {
  adoptionWords,
  stalledReason,
  verifiedOnDay,
  type AdoptionCardState,
} from '@/work/skill-adoption';
import { Button } from '../../../components/Button';
import { useAgentZone } from '../../../components/time';
import { ScopeChips } from './skill-parts';

/** One adoption as the backend draws it (`skillAdoption.adoptions`). */
export type Adoption = FunctionReturnType<typeof api.skillAdoption.adoptions>[number];

/** The note's border, by state: a failure in its tone, the rest on the page's own hairline. */
const NOTE_BORDER: Readonly<Record<AdoptionCardState, string>> = {
  offered: 'border-[var(--color-border)]',
  verifying: 'border-[var(--color-border)]',
  stalled: 'border-[var(--color-warn-line)]',
  failed: 'border-[var(--color-danger-line)]',
  declined: 'border-[var(--color-border)]',
};

/**
 * The sandbox's log of a failed re-verification, in a bounded box that scrolls, named apart from
 * the authoring's own verification log so the page never holds two regions of one name.
 */
function CheckLog({ name, log }: { name: string; log: string }) {
  return (
    <div
      tabIndex={0}
      role="region"
      aria-label={`Re-verification log: ${name}`}
      className="max-h-40 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-inset)] p-3 font-mono text-xs leading-snug whitespace-pre-wrap break-words text-[var(--color-fg-2)]"
    >
      {log}
    </div>
  );
}

/**
 * A sibling's verified skill offered to the employee in place of writing its own (A3), in each
 * state the decision goes through: offered, with **Adopt for {name}**, **Write a new one
 * instead** and **Decline**; verifying, while the sandbox checks it again under the employee's
 * own connection, with nothing to press; stalled, when that check stopped short, with why,
 * **Check it again**, **Write a new one instead** and **Decline**; failed, with the sandbox's log,
 * **Write a new one instead** and **Decline**; and declined. The proposal's own lines (its name and the item that
 * needs it) are the panel's; this is the note and the controls under them.
 *
 * @param adoption - The adoption as the backend draws it.
 * @param state - The state to draw: the adoption's own, or `declined` once the manager declined.
 * @param adopterName - The employee.
 * @param writeRefusal - Why the approval path refuses now (its target surface is not connected),
 *   which withholds Write a new one instead and Adopt alike, said with a link to the Surfaces tab.
 * @param busy - Whether a decision is in flight on the panel.
 */
export function AdoptionCard({
  adoption,
  state,
  adopterName,
  writeRefusal,
  busy,
  onAdopt,
  onCheckAgain,
  onWriteNew,
  onDecline,
}: {
  adoption: Adoption;
  state: AdoptionCardState;
  adopterName: string;
  writeRefusal?: string;
  busy: boolean;
  onAdopt: () => void;
  onCheckAgain: () => void;
  onWriteNew: () => void;
  onDecline: () => void;
}) {
  const zone = useAgentZone() ?? deploymentZone();
  const words = adoptionWords({
    state,
    adopterName,
    authorName: adoption.authorName,
    skillName: adoption.name,
    verifiedOn: verifiedOnDay(adoption.verifiedAt, zone),
    ...(adoption.connection !== undefined ? { connection: adoption.connection } : {}),
  });
  // The approval's own refusal is said once, with where to fix it; the offer's own, when it
  // differs, is said beside it, since it withholds Adopt alone.
  const offerRefusal = adoption.refusal !== writeRefusal ? adoption.refusal : undefined;
  const adoptRefusal = writeRefusal ?? adoption.refusal;
  const decides = state === 'offered' || state === 'failed' || state === 'stalled';
  const alerting = state === 'failed' || state === 'stalled';
  const reason = stalledReason(adoption.log);
  return (
    <div className="grid gap-3" data-adoption={state}>
      <div
        {...(alerting ? { role: 'alert' } : {})}
        className={`rounded-lg border bg-[var(--color-inset)] px-3 py-2 text-[13px] leading-relaxed text-[var(--color-fg-2)] ${NOTE_BORDER[state]}`}
      >
        <p className="break-words">
          <span className="text-[var(--color-fg)]">{words.lead}</span> {words.body}
        </p>
        {state === 'offered' ? (
          <p className="mt-1.5 text-xs text-[var(--color-muted)]">
            {adoption.missingScopes.length > 0 ? (
              <ScopeChips scopes={adoption.missingScopes} lead={`${words.scopesLead}:`} />
            ) : (
              words.noScopes
            )}
          </p>
        ) : null}
      </div>
      {state === 'failed' && adoption.log ? (
        <CheckLog name={adoption.name} log={adoption.log} />
      ) : null}
      {state === 'stalled' && reason ? (
        <p className="text-[13px] text-[var(--color-fg-2)] break-words">
          Why it stopped: {reason.replace(/[.!?]+$/, '')}.
        </p>
      ) : null}
      {decides && state !== 'stalled' && writeRefusal ? (
        <p className="text-[13px] text-[var(--color-warn)] break-words">
          Cannot approve yet: {writeRefusal}{' '}
          <a href="#surfaces" className="underline underline-offset-4">
            Surfaces tab
          </a>
        </p>
      ) : null}
      {state === 'offered' && offerRefusal ? (
        <p className="text-[13px] text-[var(--color-warn)] break-words">
          Cannot adopt now: {offerRefusal}
        </p>
      ) : null}
      {state === 'stalled' && adoption.refusal ? (
        <p className="text-[13px] text-[var(--color-warn)] break-words">
          Cannot check it again: {adoption.refusal}
        </p>
      ) : null}
      {decides ? (
        <div className="flex flex-wrap gap-2">
          {state === 'offered' ? (
            <Button
              variant="approve"
              size="small"
              disabled={busy || Boolean(adoptRefusal)}
              title={adoptRefusal}
              aria-label={`Adopt for ${adopterName}: ${adoption.name}`}
              onClick={onAdopt}
            >
              Adopt for {adopterName}
            </Button>
          ) : null}
          {state === 'stalled' ? (
            <Button
              variant="retry"
              size="small"
              disabled={busy || Boolean(adoption.refusal)}
              title={adoption.refusal}
              aria-label={`Check it again: ${adoption.name}`}
              onClick={onCheckAgain}
            >
              Check it again
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="small"
            disabled={busy || (state !== 'stalled' && Boolean(writeRefusal))}
            title={state !== 'stalled' ? writeRefusal : undefined}
            aria-label={`Write a new one instead of ${adoption.name}`}
            onClick={onWriteNew}
          >
            Write a new one instead
          </Button>
          <Button
            variant="quiet"
            size="small"
            disabled={busy}
            aria-label={`Decline ${adoption.name}`}
            onClick={onDecline}
          >
            Decline
          </Button>
        </div>
      ) : null}
    </div>
  );
}
