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
import { useMemo, useRef, useCallback, useEffect, useState } from 'react';
import { useArrival } from '../../../arrival';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { useListMoves } from '../../../components/list-moves';
import {
  QUEUE_FILTERS,
  QUEUE_FILTER_NAMES,
  type QueueFilter,
  queueFilterOf,
} from '@/work/state-display';
import { PendingDecisionsPanel, pendingDecisionMembers } from './PendingDecisionsPanel';
import { planApprovalRequest } from './PlanApproval';
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
    <div className="grid gap-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          size="small"
          disabled={change.busy}
          onClick={() =>
            change.run(() => check({ agentId }), {
              done: checkForWorkMessage,
              refused: 'The check did not start.',
            })
          }
        >
          {change.busy ? 'Checking…' : 'Check for new work'}
        </Button>
        <p className="text-[13px] text-[var(--color-muted)]">
          Connected surfaces are polled every five minutes.
        </p>
      </div>
      <StatusRegion outcome={change.outcome} />
    </div>
  );
}

/**
 * The Work tab's filters (`agent-work.html`): All, Needs you, In progress, Done and Skipped, each
 * with its count, one pressed at a time. A filter that holds nothing is still offered, so the
 * row never shifts under the pointer.
 */
export function QueueFilters({
  counts,
  selected,
  onSelect,
}: {
  counts: Readonly<Record<QueueFilter, number>>;
  selected: QueueFilter;
  onSelect: (filter: QueueFilter) => void;
}) {
  return (
    <div role="group" aria-label="Show" className="flex flex-wrap gap-2">
      {QUEUE_FILTERS.map((filter) => (
        <Button
          key={filter}
          size="small"
          variant={filter === selected ? 'primary' : 'secondary'}
          aria-pressed={filter === selected}
          onClick={() => onSelect(filter)}
        >
          {QUEUE_FILTER_NAMES[filter]} <span className="tabular-nums">{counts[filter]}</span>
        </Button>
      ))}
    </div>
  );
}

/**
 * Bring the card an inbox link named into view (U17 D13, A D8): `/agent/<id>/work#item-<id>`
 * lands on the item, and focus goes to it, so a keyboard or screen-reader user starts where the
 * link said. The cards arrive after the page, so the browser's own jump to the fragment finds
 * nothing to jump to; a later change of the fragment (back and forward, a link on the page)
 * lands the same way, and a filter hiding the card is cleared first.
 *
 * @param ready - Whether the queue has drawn its cards.
 * @param showAll - Clears the filter, so the named card is drawn.
 */
function useItemAnchor(ready: boolean, showAll: () => void): void {
  // Counts the fragment's changes, so each one lands again once the filter is cleared.
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    const changed = (): void => {
      if (!window.location.hash.startsWith('#item-')) return;
      showAll();
      setChanges((count) => count + 1);
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, [showAll]);
  useEffect(() => {
    if (!ready || !window.location.hash.startsWith('#item-')) return;
    const card = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
    if (!card) return;
    card.scrollIntoView({ block: 'start' });
    card.focus({ preventScroll: true });
  }, [ready, changes]);
}

// A run under way first, then what else needs the manager: skills, then deferrals, which wait
// on a grant or a connection the manager gives and which the roster counts as needing them. A
// failed or stopped run waits on the manager's Retry, so it sits above the skipped rows, which
// wait on nobody.
const QUEUE_ORDER = [
  'run',
  'needs-skill',
  'deferred',
  'discovered',
  'completed',
  'failed',
  'skipped',
  'cancelled',
];

/**
 * The states of one run, from its claim to its last write held for the manager: an item keeps its
 * place through all of them, so a card the manager is watching does not jump down the list as it
 * starts working and back up when its write is held (the hosted walk's m21). Runs sit by when
 * each run began (`claimedAt`), the longest-running first, whatever state each has reached
 * (second pass M5): the run that has waited longest stays on top, never one found earlier but
 * claimed later (the second review's x4, decision 4). A row claimed before the claim was
 * recorded sorts by when it was found.
 */
const RUN_STATES: ReadonlySet<string> = new Set([
  'claimed',
  'plan-pending',
  'plan-approved',
  'executing',
  'actions-pending',
]);

/**
 * The work queue in the order the page lists it.
 *
 * Args:
 *   workItems: The employee's work items.
 *
 * Returns:
 *   A sorted copy; rows of one state keep their order, and runs under way keep theirs whatever
 *   state each has reached.
 */
export function sortedForQueue<
  T extends {
    state: string;
    _creationTime?: number;
    claimedAt?: number;
    priority?: string;
    evaluationAttempts?: number;
    dismissedAt?: number;
  },
>(workItems: readonly T[]): T[] {
  // The rows waiting for a free slot are listed in the order the loop takes
  // them, so the top of the queue is the next one evaluated (U3 D5).
  const waiting = (row: T) => ({ ...row, _creationTime: row._creationTime ?? 0 });
  // A failed row the manager dismissed is filed at the foot, after every open state (N7).
  const rank = (row: T): number =>
    row.state === 'failed' && row.dismissedAt !== undefined
      ? QUEUE_ORDER.length
      : QUEUE_ORDER.indexOf(RUN_STATES.has(row.state) ? 'run' : row.state);
  const runBegan = (row: T): number => row.claimedAt ?? row._creationTime ?? 0;
  return [...workItems].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.state === 'discovered' ? compareWaitingRows(waiting(a), waiting(b)) : 0) ||
      (RUN_STATES.has(a.state) ? runBegan(a) - runBegan(b) : 0),
  );
}

/** No item is known to wait on the manager until the needs-you read answers. */
const NO_ITEMS: ReadonlySet<string> = new Set();

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
  employeeName = 'the employee',
  needsYou = NO_ITEMS,
}: {
  agentId: Id<'agents'>;
  /** The employee's name, for the cards' sentences. */
  employeeName?: string;
  /** The ids of the items the employee's needs-you inbox lists, for the Needs you filter. */
  needsYou?: ReadonlySet<string>;
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
  const dismissFailed = useMutation(api.work.dismissFailed);

  const items = useMemo(() => sortedForQueue(workItems), [workItems]);
  const [filter, setFilter] = useState<QueueFilter>('all');
  const counts = useMemo((): Record<QueueFilter, number> => {
    const tally: Record<QueueFilter, number> = {
      all: items.length,
      'needs-you': 0,
      'in-progress': 0,
      done: 0,
      skipped: 0,
    };
    for (const item of items) tally[queueFilterOf(item, needsYou)] += 1;
    return tally;
  }, [items, needsYou]);
  const shown =
    filter === 'all' ? items : items.filter((item) => queueFilterOf(item, needsYou) === filter);
  const queue = useRef<HTMLElement>(null);
  const cards = useRef<HTMLDivElement>(null);
  const shownOrder = useMemo(() => shown.map((item) => item._id), [shown]);
  // A card that must move (a run landing, a new ask above it) glides to its place (walk m21).
  useListMoves(cards, shownOrder, filter);
  const showAll = useCallback((): void => setFilter('all'), []);
  useItemAnchor(!loading && items.length > 0, showAll);
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
      <div className="grid gap-4">
        {surfaceMode === 'real' && charterApproved ? <CheckForNewWork agentId={agentId} /> : null}
        {loading ? (
          <p className="text-sm text-[var(--color-muted)]">Loading the work queue…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">
            {charterApproved
              ? 'Nothing has come in yet. New work appears here as it is found.'
              : 'Work arrives once you approve the charter.'}
          </p>
        ) : (
          <>
            <QueueFilters counts={counts} selected={filter} onSelect={setFilter} />
            <PendingDecisionsPanel
              members={pendingDecisionMembers(items)}
              surfaces={surfaces}
              onApproveBatch={(members) => approveActionsBatch({ members })}
              fallback={queue}
            />
            {shown.length === 0 ? (
              <p className="text-sm text-[var(--color-muted)]">
                Nothing under {QUEUE_FILTER_NAMES[filter]} now.
              </p>
            ) : null}
            <div
              ref={cards}
              data-cards={arriving ? 'rows' : undefined}
              className="relative grid gap-4"
            >
              {shown.map((item) => (
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
                      : Promise.reject(
                          new Error('The pending run is missing. Refresh the work queue.'),
                        )
                  }
                  onRejectActions={(reason) =>
                    item.pendingRunId
                      ? rejectActions({
                          workItemId: item._id,
                          pendingRunId: item.pendingRunId,
                          reason,
                        })
                      : Promise.reject(
                          new Error('The pending run is missing. Refresh the work queue.'),
                        )
                  }
                  onResendDecision={() => resendDecision({ workItemId: item._id })}
                  onDismiss={() => dismissFailed({ workItemId: item._id })}
                  employeeName={employeeName}
                  servedByLoop={surfaceMode === 'real'}
                />
              ))}
            </div>
          </>
        )}
      </div>
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
