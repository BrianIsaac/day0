'use client';

import type { Doc } from '@convex/_generated/dataModel';
import type { SurfaceRecord } from '@/surfaces/types';
import { type AuthoringAttempt, AUTHORING_UNFINISHED } from './authoring';
import { useMutation, useAction } from 'convex/react';
import { api } from '@convex/_generated/api';
import { useNow } from '../../../components/time';
import { useChange, refusalText } from '../../../components/use-change';
import { StatusRegion } from '../../../components/StatusRegion';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { skillApprovalRefusal } from '@/surfaces/policy';
import { AdoptionRow } from './AdoptionRow';
import { plainSkillName, ScopeChips } from './skill-parts';
import { rationaleBesideItem } from '@/work/skill-rationale';

/**
 * The skills the employee proposed and the manager has not decided, each with the item that
 * first needs it, what approving grants, where adoption would be offered, and Approve and Reject.
 * Every decision is said in the panel's one live region.
 */
export function ProposedSkillsPanel({
  skills,
  surfaces,
  onAuthoringAttempt,
  fallback,
  name,
  itemTitles,
}: {
  skills: Doc<'skills'>[];
  /** The agent's surfaces in real mode; a skill targeting one that is not
   *  connected cannot be approved yet, and the button says why. */
  surfaces: SurfaceRecord[];
  /** Approving moves the row out of this panel, so the authoring's verdict has
   *  to be reported somewhere that survives the unmount. `null` opens an
   *  attempt and retires whatever the last one said. */
  onAuthoringAttempt: (attempt: AuthoringAttempt | null) => void;
  /** Where focus goes when the decided row leaves the panel: the Skills card it moves to. */
  fallback?: React.RefObject<HTMLElement | null>;
  /** The employee's name. */
  name: string;
  /** The employee's work item titles by id, for the item that first needs each skill. */
  itemTitles: ReadonlyMap<string, string>;
}) {
  const approve = useMutation(api.skills.approve);
  const reject = useMutation(api.skills.reject);
  const author = useAction(api.skillActions.authorAndRegisterSkill);
  const now = useNow();
  const change = useChange(fallback);

  // The approval is the manager's decision and is said here; the authoring it
  // starts runs for minutes and files its verdict with the Skills card.
  function onApprove(skill: Doc<'skills'>): void {
    const file = (reason?: string): void =>
      onAuthoringAttempt({ skillId: skill._id, name: skill.name, ...(reason ? { reason } : {}) });
    change.run(() => approve({ skillId: skill._id }), {
      done: `Approved ${skill.name}: the employee is authoring it now, and the Skills card says when it is callable.`,
      refused: `${skill.name} was not approved.`,
      after: () => {
        onAuthoringAttempt(null);
        // Discarded because both outcomes are handled here and filed as the
        // attempt the Skills card shows in its live region.
        void author({ skillId: skill._id }).then(
          (result) => file(result.ok ? undefined : (result.reason ?? AUTHORING_UNFINISHED)),
          (err: unknown) => file(refusalText(err, AUTHORING_UNFINISHED)),
        );
      },
    });
  }

  // One live region, outside the card and in the same place whether or not
  // the card is drawn: the last row leaving takes the card, and a region put
  // in anew already holding its words is not announced.
  return (
    <>
      {skills.length > 0 ? (
        <Card title="Proposed · waiting on you" meta={`${skills.length}`} tone="warn">
          <ul className="grid gap-5">
            {skills.map((s) => {
              const refusal = skillApprovalRefusal(
                s.targetSurface,
                surfaces.find((surface) => surface.slug === s.targetSurface),
                now,
              );
              const item = s.proposedFor ? itemTitles.get(s.proposedFor) : undefined;
              return (
                <li
                  key={s._id}
                  className="grid gap-2 border-t border-[var(--color-border)] pt-5 first:border-t-0 first:pt-0"
                >
                  <p className="text-sm text-[var(--color-fg)] break-words">
                    <span className="font-medium">{s.name}</span>
                    <span className="text-[var(--color-fg-2)]"> · {plainSkillName(s)}</span>
                  </p>
                  <p className="text-[13px] leading-relaxed text-[var(--color-fg-2)]">
                    {item ? <>First needed by &ldquo;{item}&rdquo;. </> : null}
                    {s.rationale ? (item ? rationaleBesideItem(s.rationale) : s.rationale) : null}
                  </p>
                  {s.requiredScopes && s.requiredScopes.length > 0 ? (
                    <p className="text-xs leading-relaxed text-[var(--color-muted)]">
                      <ScopeChips scopes={s.requiredScopes} lead="Approving grants" />
                    </p>
                  ) : null}
                  {refusal ? (
                    <p className="text-[13px] text-[var(--color-warn)]">
                      Cannot approve yet: {refusal}{' '}
                      <a href="#surfaces" className="underline underline-offset-4">
                        Surfaces tab
                      </a>
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="approve"
                      size="small"
                      disabled={Boolean(refusal) || change.busy}
                      title={refusal}
                      onClick={() => onApprove(s)}
                    >
                      Approve · author and verify
                    </Button>
                    <Button
                      variant="quiet"
                      size="small"
                      disabled={change.busy}
                      aria-label={`Reject ${s.name}`}
                      onClick={() =>
                        change.run(() => reject({ skillId: s._id }), {
                          done: `Rejected ${s.name}: the employee will not author it.`,
                          refused: `${s.name} was not rejected.`,
                        })
                      }
                    >
                      Reject
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="mt-4">
            <AdoptionRow name={name} />
          </div>
          <p className="mt-3 text-xs leading-relaxed text-[var(--color-muted)]">
            Approving writes the skill and checks it in a sandbox, then evaluates again the item
            that needs it. Whether that work is within {name}&apos;s charter is judged separately.
          </p>
        </Card>
      ) : null}
      <StatusRegion outcome={change.outcome} />
    </>
  );
}
