'use client';

import type { Doc } from '@convex/_generated/dataModel';
import type { SurfaceRecord } from '@/surfaces/types';
import { type AuthoringAttempt, AUTHORING_UNFINISHED } from './authoring';
import { useMutation, useAction } from 'convex/react';
import { api } from '@convex/_generated/api';
import { useNow } from '../time';
import { useChange, refusalText, LiveStatus } from '../live-status';
import { Card } from '../../../components/Card';
import { skillApprovalRefusal } from '@/surfaces/policy';

/** The skills the agent proposed and the manager has not decided, each with Approve and Reject. */
export function ProposedSkillsPanel({
  skills,
  surfaces,
  onAuthoringAttempt,
  fallback,
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

  // The panel keeps its live region when the last row leaves it, so the
  // outcome of that decision is still said.
  if (skills.length === 0) return <LiveStatus outcome={change.outcome} />;
  return (
    <Card title="Proposed skills · awaiting your call" tone="warn">
      <div className="space-y-3">
        {skills.map((s) => {
          const refusal = skillApprovalRefusal(
            s.targetSurface,
            surfaces.find((surface) => surface.slug === s.targetSurface),
            now,
          );
          return (
            <div key={s._id} className="border border-[var(--color-border)] rounded-lg p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-x-2 mb-1">
                <span className="font-medium text-[var(--color-fg)] break-words">{s.name}</span>
                <span className="text-[10px] text-[var(--color-muted)]">
                  requires: {(s.requiredScopes ?? []).join(', ')}
                </span>
              </div>
              <p className="text-[var(--color-muted)] text-xs mb-2">
                {s.rationale ?? s.description}
              </p>
              {refusal ? (
                <p className="text-[10px] text-[var(--color-warn)] mb-2">
                  Cannot approve yet: {refusal}{' '}
                  <a href="#surfaces" className="underline">
                    Surfaces tab
                  </a>
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={Boolean(refusal) || change.busy}
                  title={refusal}
                  onClick={() => onApprove(s)}
                  className="min-h-11 px-3 rounded-md bg-[var(--color-ok)]/20 text-[var(--color-ok)] hover:bg-[var(--color-ok)]/30 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[var(--color-ok)]/20"
                >
                  Approve · author and verify
                </button>
                <button
                  type="button"
                  disabled={change.busy}
                  aria-label={`Reject ${s.name}`}
                  onClick={() =>
                    change.run(() => reject({ skillId: s._id }), {
                      done: `Rejected ${s.name}: the employee will not author it.`,
                      refused: `${s.name} was not rejected.`,
                    })
                  }
                  className="min-h-11 px-3 rounded-md border border-[var(--color-border)] hover:border-[var(--color-danger)] text-xs disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            </div>
          );
        })}
        <LiveStatus outcome={change.outcome} />
      </div>
    </Card>
  );
}
