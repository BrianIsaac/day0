'use client';

import type { Id, Doc } from '@convex/_generated/dataModel';
import { useMutation, useAction } from 'convex/react';
import { api } from '@convex/_generated/api';
import { useChange } from '../../../components/use-change';
import { StatusRegion } from '../../../components/StatusRegion';
import { compareWaitingRows } from '@/work/queue-order';
import type { SurfaceRecord } from '@/surfaces/types';
import type { KeptCorrection } from '../corrections-panel';
import type { AutonomyChange } from '@/work/autonomy';
import { useMemo, useRef, useCallback, useEffect } from 'react';
import { useArrival } from '../../../arrival';
import { Card } from '../../../components/Card';
import {
  PendingDecisionsPanel,
  pendingDecisionMembers,
  planApprovalRequest,
} from './PendingActions';
import { WorkItemCard } from './WorkItemCard';

/**
 * What the queue says after "Check for new work".
 *
 * Args:
 *   result: The check's answer: surfaces scheduled for a poll, and the wait
 *     before the next check when one ran under a minute ago.
 *
 * Returns:
 *   One line for the manager.
 */
export function checkForWorkMessage(result: { scheduled: number; retryInMs?: number }): string {
  if (result.scheduled > 0) {
    const surfaces = result.scheduled === 1 ? 'surface' : 'surfaces';
    return `Checking ${result.scheduled} connected ${surfaces} now; anything new appears here within a minute.`;
  }
  if (result.retryInMs !== undefined) {
    return `Checked under a minute ago; try again in ${Math.ceil(result.retryInMs / 1000)} s.`;
  }
  return 'No connected work surface to check.';
}

/** Poll the employee's connected work surfaces now rather than at the next five-minute sweep. */
export function CheckForNewWork({ agentId }: { agentId: Id<'agents'> }) {
  const check = useMutation(api.workLoop.checkForNewWork);
  const change = useChange();
  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] text-[var(--color-muted)]">
          Connected surfaces are polled every five minutes.
        </p>
        <button
          type="button"
          disabled={change.busy}
          onClick={() =>
            change.run(() => check({ agentId }), {
              done: checkForWorkMessage,
              refused: 'The check did not start.',
            })
          }
          className="shrink-0 min-h-11 px-3 rounded-md text-[10px] border border-[var(--color-border)] hover:border-[var(--color-accent)] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {change.busy ? 'Checking…' : 'Check for new work'}
        </button>
      </div>
      <StatusRegion outcome={change.outcome} />
    </div>
  );
}

// What needs the manager first: literal actions awaiting approval, then plans,
// then skills, then deferrals, which wait on a grant or a connection the manager
// gives and which the roster counts as needing them. A failed or stopped run
// waits on the manager's Retry, so it sits above the skipped rows, which wait
// on nobody.
const QUEUE_ORDER = [
  'actions-pending',
  'plan-pending',
  'needs-skill',
  'deferred',
  'discovered',
  'claimed',
  'plan-approved',
  'executing',
  'completed',
  'failed',
  'skipped',
  'cancelled',
];

/**
 * The work queue in the order the page lists it.
 *
 * Args:
 *   workItems: The employee's work items.
 *
 * Returns:
 *   A sorted copy; rows of one state keep their order.
 */
export function sortedForQueue<
  T extends {
    state: string;
    _creationTime?: number;
    priority?: string;
    evaluationAttempts?: number;
  },
>(workItems: readonly T[]): T[] {
  // The rows waiting for a free slot are listed in the order the loop takes
  // them, so the top of the queue is the next one evaluated (U3 D5).
  const waiting = (row: T) => ({ ...row, _creationTime: row._creationTime ?? 0 });
  return [...workItems].sort(
    (a, b) =>
      QUEUE_ORDER.indexOf(a.state) - QUEUE_ORDER.indexOf(b.state) ||
      (a.state === 'discovered' ? compareWaitingRows(waiting(a), waiting(b)) : 0),
  );
}

/** The employee's work items in the order that puts what needs the manager first. */
export function WorkQueue({
  agentId,
  workItems,
  openQuestions,
  surfaces,
  registeredSkillCount,
  charterApproved,
  autonomousActions,
  surfaceMode,
  corrections = [],
  autonomyChanges = [],
  loading = false,
}: {
  agentId: Id<'agents'>;
  workItems: Doc<'workItems'>[];
  /** The queue's query has not answered yet, which is not the same as an empty queue. */
  loading?: boolean;
  /** The charter's open questions still waiting on the manager, asked at a plan. */
  openQuestions: Doc<'managerQuestions'>[];
  surfaces: SurfaceRecord[];
  registeredSkillCount: number;
  charterApproved: boolean;
  /** Whether the agent's autonomous-actions switch is on, for the cards' wording. */
  autonomousActions: boolean;
  /** The deployment's surface mode, undefined while it loads. Only mock mode drives the loop from here. */
  surfaceMode: 'mock' | 'real' | undefined;
  /** The employee's kept corrections, for the plan cards that applied one. */
  corrections?: KeptCorrection[];
  /** The employee's flips of the autonomous-actions switch, oldest first. */
  autonomyChanges?: readonly AutonomyChange[];
}) {
  const evaluate = useAction(api.workActions.evaluateWorkItem);
  const draftPlan = useAction(api.workActions.draftPlan);
  const executePlan = useAction(api.workActions.executeApprovedPlan);
  const approvePlan = useMutation(api.work.approvePlan);
  const cancelPlan = useMutation(api.work.cancelPlan);
  const retryFailed = useMutation(api.work.retryFailed);
  const reconcileFailed = useMutation(api.work.reconcileFailed);
  const approveActions = useMutation(api.work.approveActions);
  const approveActionsBatch = useMutation(api.work.approveActionsBatch);
  const rejectActions = useMutation(api.work.rejectActions);
  const resendDecision = useMutation(api.work.resendDecisionRequest);

  const items = useMemo(() => sortedForQueue(workItems), [workItems]);
  const queue = useRef<HTMLElement>(null);
  // The items are the Work tab's rows (v4 section 1.3): a tier after the columns' cards.
  const arriving = useArrival(!loading && items.length > 0);

  // One in-flight call per (step, item). Strict Mode runs every effect twice
  // on mount, and a subscription update re-runs them before the first call has
  // moved the row, so without this the same item is handed to the same action
  // several times over. Each step's claim mutation refuses the duplicate, but
  // a refusal is not a reason to keep asking.
  const inFlight = useRef(new Set<string>());
  const once = useCallback((step: string, id: string, call: () => Promise<unknown>) => {
    const key = `${step}:${id}`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    call()
      // A step that fails on the row records the failure there, where the card
      // reads it. A refusal before the row is touched (the item gone, the
      // charter not approved, an ownership refusal, a claim another call
      // already holds) leaves nothing on the row and is dropped here; the
      // promise only holds the in-flight key.
      .catch((): void => undefined)
      .finally(() => inFlight.current.delete(key));
  }, []);

  // Auto-progression, mock mode only: once charter is approved, evaluate every
  // discovered item; once a verdict comes back, draft a plan if claim, etc.
  // The hosted demo and the frozen harness rely on it. In real mode the server
  // schedules every step (`convex/workLoop.ts`), so the work moves with no
  // page open, and this page only renders and sends the manager's decisions.
  const drivesLoop = surfaceMode === 'mock';
  useEffect(() => {
    if (!drivesLoop || !charterApproved) return;
    const next = nextItemToEvaluate(workItems);
    if (next) once('evaluate', next._id, () => evaluate({ workItemId: next._id }));
  }, [drivesLoop, charterApproved, workItems, evaluate, once]);

  useEffect(() => {
    if (!drivesLoop) return;
    for (const it of workItems) {
      if (it.state === 'claimed' && !it.plan) {
        once('draft', it._id, () => draftPlan({ workItemId: it._id }));
      }
      if (it.state === 'plan-approved') {
        once('execute', it._id, () => executePlan({ workItemId: it._id }));
      }
    }
  }, [drivesLoop, workItems, draftPlan, executePlan, once]);

  return (
    <Card
      title={
        `Work queue · ${items.length} ${items.length === 1 ? 'item' : 'items'} · ` +
        `${registeredSkillCount} ${registeredSkillCount === 1 ? 'skill' : 'skills'} available`
      }
      focusRef={queue}
    >
      {surfaceMode === 'real' && charterApproved ? <CheckForNewWork agentId={agentId} /> : null}
      {loading ? (
        <p className="text-xs text-[var(--color-muted)]">loading the work queue…</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">
          {charterApproved ? 'no work seeded yet' : 'work queue lights up after charter approval'}
        </p>
      ) : (
        <div data-cards={arriving ? 'rows' : undefined} className="space-y-3">
          <PendingDecisionsPanel
            members={pendingDecisionMembers(items)}
            surfaces={surfaces}
            onApproveBatch={(members) => approveActionsBatch({ members })}
            fallback={queue}
          />
          {items.map((item) => (
            <WorkItemCard
              key={item._id}
              item={item}
              surfaces={surfaces}
              autonomousActions={autonomousActions}
              questions={openQuestions.filter((question) => question.workItemId === item._id)}
              corrections={corrections}
              autonomyChanges={autonomyChanges}
              onApprovePlan={(decision) => approvePlan(planApprovalRequest(item._id, decision))}
              onCancelPlan={(reason) => cancelPlan(cancelPlanRequest(item._id, reason))}
              onRetryFailed={(feedback) => retryFailed(retryRequest(item._id, feedback))}
              onReconcileFailed={(confirmed) =>
                reconcileFailed({ workItemId: item._id, confirmed })
              }
              onApproveActions={(approvedIndexes) =>
                item.pendingRunId
                  ? approveActions({
                      workItemId: item._id,
                      pendingRunId: item.pendingRunId,
                      approvedIndexes,
                    })
                  : Promise.reject(new Error('The pending run is missing. Refresh the work queue.'))
              }
              onRejectActions={(reason) =>
                item.pendingRunId
                  ? rejectActions({ workItemId: item._id, pendingRunId: item.pendingRunId, reason })
                  : Promise.reject(new Error('The pending run is missing. Refresh the work queue.'))
              }
              onResendDecision={() => resendDecision({ workItemId: item._id })}
              servedByLoop={surfaceMode === 'real'}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * The next item the queue evaluates on its own: the first discovered one.
 *
 * A retried item returns to `discovered`, so the manager's Retry reaches the
 * evaluator through this same pick.
 */
export function nextItemToEvaluate(
  items: readonly Doc<'workItems'>[],
): Doc<'workItems'> | undefined {
  return items.find((item) => item.state === 'discovered');
}

/**
 * What the card's Retry sends: the item and, when the manager wrote one, the note.
 *
 * Args:
 *   workItemId: The item being retried.
 *   feedback: The retry note as typed; a blank note is not sent.
 *
 * Returns:
 *   The arguments for `work.retryFailed`.
 */
export function retryRequest(
  workItemId: Id<'workItems'>,
  feedback?: string,
): { workItemId: Id<'workItems'>; feedback?: string } {
  return { workItemId, ...(feedback?.trim() ? { feedback } : {}) };
}

/**
 * What the plan card's Cancel sends: the item and, when the manager wrote one, the reason.
 *
 * Args:
 *   workItemId: The item whose plan is cancelled.
 *   reason: The reason as typed; a blank reason is not sent.
 *
 * Returns:
 *   The arguments for `work.cancelPlan`.
 */
export function cancelPlanRequest(
  workItemId: Id<'workItems'>,
  reason?: string,
): { workItemId: Id<'workItems'>; reason?: string } {
  return { workItemId, ...(reason?.trim() ? { reason } : {}) };
}
