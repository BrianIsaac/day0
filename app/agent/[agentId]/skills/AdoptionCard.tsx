'use client';

import type { FunctionReturnType } from 'convex/server';
import type { api } from '@convex/_generated/api';
import { deploymentZone } from '@/lib/zone';
import { adoptionWords, verifiedOnDay, type AdoptionCardState } from '@/work/skill-adoption';
import { Button } from '../../../components/Button';
import { useAgentZone } from '../../../components/time';
import { ScopeChips, SkillStatusLine } from './skill-parts';

/** One adoption as the backend draws it (`skillAdoption.adoptions`). */
export type Adoption = FunctionReturnType<typeof api.skillAdoption.adoptions>[number];

/** The note's border, by state: a failure in its tone, the rest on the page's own hairline. */
const NOTE_BORDER: Readonly<Record<AdoptionCardState, string>> = {
  offered: 'border-[var(--color-border)]',
  verifying: 'border-[var(--color-border)]',
  failed: 'border-[var(--color-danger-line)]',
  declined: 'border-[var(--color-border)]',
};

/**
 * A sibling's verified skill offered to the employee in place of writing its own (A3), in each
 * state the decision goes through: offered, with **Adopt for {name}**, **Write a new one
 * instead** and **Decline**; verifying, while the sandbox checks it again under the employee's
 * own connection, with nothing to press; failed, with the sandbox's log, **Write a new one
 * instead** and **Decline**; and declined. The proposal's own lines (its name and the item that
 * needs it) are the panel's; this is the note and the controls under them.
 *
 * @param adoption - The adoption as the backend draws it.
 * @param state - The state to draw: the adoption's own, or `declined` once the manager declined.
 * @param adopterName - The employee.
 * @param writeRefusal - Why the approval path refuses now (its target surface is not connected),
 *   which withholds Write a new one instead and Adopt alike.
 * @param busy - Whether a decision is in flight on the panel.
 */
export function AdoptionCard({
  adoption,
  state,
  adopterName,
  writeRefusal,
  busy,
  onAdopt,
  onWriteNew,
  onDecline,
}: {
  adoption: Adoption;
  state: AdoptionCardState;
  adopterName: string;
  writeRefusal?: string;
  busy: boolean;
  onAdopt: () => void;
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
  const adoptRefusal = adoption.refusal ?? writeRefusal;
  const decides = state === 'offered' || state === 'failed';
  return (
    <div className="grid gap-3" data-adoption={state}>
      <div
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
        <SkillStatusLine skill={adoption.name} text={adoption.log} />
      ) : null}
      {state === 'offered' && adoptRefusal ? (
        <p className="text-[13px] text-[var(--color-warn)] break-words">
          Cannot adopt yet: {adoptRefusal}
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
          <Button
            variant="secondary"
            size="small"
            disabled={busy || Boolean(writeRefusal)}
            title={writeRefusal}
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
