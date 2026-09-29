'use client';

import type { MockAction } from '@/work/types';
import type { SurfaceRecord } from '@/surfaces/types';
import { summariseAction } from '@/surfaces/summary';
import type { Id, Doc } from '@convex/_generated/dataModel';
import { type RunOutput, pendingVerdicts } from './work-item';
import { ActionPayload } from './RunDetails';
import { useChange } from '../../../components/use-change';
import { StatusRegion } from '../../../components/StatusRegion';
import { Button } from '../../../components/Button';
import { Disclosure } from '../../../components/Disclosure';

/** One member of the cross-item approval: the held rows of a parked run. */
export interface PendingDecisionMember {
  workItemId: Id<'workItems'>;
  pendingRunId: Id<'events'>;
  title: string;
  actions: MockAction[];
  heldIndexes: number[];
  refused: number;
}

/**
 * The held action sets open across the queue, read from each parked item.
 *
 * Args:
 *   items: The work items.
 *
 * Returns:
 *   One member per item whose run is parked with rows awaiting the manager.
 */
export function pendingDecisionMembers(
  items: readonly Doc<'workItems'>[],
): PendingDecisionMember[] {
  return items.flatMap((item): PendingDecisionMember[] => {
    if (
      item.state !== 'actions-pending' ||
      !item.pendingRunId ||
      item.approvedIndexes !== undefined
    ) {
      return [];
    }
    const actions = ((item.output ?? {}) as RunOutput).actions ?? [];
    const verdicts = pendingVerdicts(item.actionVerdicts, actions.length);
    const heldIndexes = verdicts.flatMap((verdict, index) =>
      verdict.disposition === 'held' ? [index] : [],
    );
    if (heldIndexes.length === 0) return [];
    return [
      {
        workItemId: item._id,
        pendingRunId: item.pendingRunId,
        title: item.title,
        actions,
        heldIndexes,
        refused: verdicts.filter((verdict) => verdict.disposition === 'refused').length,
      },
    ];
  });
}

/**
 * Every held action set across the queue, approvable from one place.
 *
 * Each member is shown with the same literal payloads its own card shows,
 * and the one button sends the same exact approval per member that the
 * card's "Approve all" sends: the parked run and its held indexes. A member
 * with a refused row is listed but left to its card, as the card's own rule
 * is. Shown only when more than one item is waiting; one item is its card.
 */
export function PendingDecisionsPanel({
  members,
  surfaces,
  onApproveBatch,
  fallback,
}: {
  members: PendingDecisionMember[];
  surfaces: SurfaceRecord[];
  onApproveBatch: (
    members: Array<{
      workItemId: Id<'workItems'>;
      pendingRunId: Id<'events'>;
      approvedIndexes: number[];
    }>,
  ) => Promise<unknown>;
  /** Where focus goes when the approval empties the panel: the work queue. */
  fallback?: React.RefObject<HTMLElement | null>;
}) {
  const change = useChange(fallback);
  // The panel keeps its live region when an approval empties it, so what the
  // approval came to is still said.
  if (members.length < 2) return <StatusRegion outcome={change.outcome} />;
  const eligible = members.filter((member) => member.refused === 0);
  const heldCount = eligible.reduce((sum, member) => sum + member.heldIndexes.length, 0);
  return (
    <div className="grid gap-3 rounded-xl border border-[var(--color-warn-line)] bg-[var(--color-warn-soft)] px-4 py-3.5 sm:px-5">
      <p className="text-[15px] font-semibold text-[var(--color-warn)]">
        {members.length} items have actions awaiting your approval
      </p>
      <ul className="grid gap-3">
        {members.map((member) => (
          <li key={member.workItemId}>
            <p className="text-[15px] font-medium text-[var(--color-fg)]">{member.title}</p>
            {member.refused > 0 ? (
              <p className="text-[13px] text-[var(--color-muted)]">
                {member.refused} {member.refused === 1 ? 'row is' : 'rows are'} refused by the gate;
                decide this one on its card.
              </p>
            ) : null}
            <ul className="ml-3 grid gap-1">
              {member.heldIndexes.map((index) => (
                <li key={index} className="text-sm break-words text-[var(--color-fg-2)]">
                  {summariseAction(member.actions[index], surfaces)}
                  <Disclosure summary="Exact payload">
                    <ActionPayload action={member.actions[index]} />
                  </Disclosure>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          variant="approve"
          disabled={change.busy || eligible.length === 0}
          onClick={() =>
            change.run(
              () =>
                onApproveBatch(
                  eligible.map((member) => ({
                    workItemId: member.workItemId,
                    pendingRunId: member.pendingRunId,
                    approvedIndexes: member.heldIndexes,
                  })),
                ),
              {
                done: `Approved ${heldCount} held ${heldCount === 1 ? 'action' : 'actions'} across ${eligible.length} ${eligible.length === 1 ? 'item' : 'items'}: they apply now.`,
                refused: 'Nothing was approved.',
              },
            )
          }
        >
          Approve {heldCount} held {heldCount === 1 ? 'action' : 'actions'} across {eligible.length}{' '}
          {eligible.length === 1 ? 'item' : 'items'}
        </Button>
        <span className="text-[13px] text-[var(--color-muted)]">
          Each item is approved exactly as shown; if one has moved on, nothing is approved and the
          list refreshes.
        </span>
      </div>
      <StatusRegion outcome={change.outcome} />
    </div>
  );
}
