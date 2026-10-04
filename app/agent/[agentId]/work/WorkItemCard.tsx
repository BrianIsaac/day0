'use client';

import { useRef } from 'react';
import type { Doc } from '@convex/_generated/dataModel';
import { HELD_NOT_APPROVED, isGateRefusal, isSurfaceTool } from '@/surfaces/policy';
import { summariseAction } from '@/surfaces/summary';
import type { SurfaceRecord } from '@/surfaces/types';
import {
  type AutonomyChange,
  autonomyTurnedOnAfterDraft,
  autonomyTurnedOnAfterDraftNote,
} from '@/work/autonomy';
import { rejectionOf, workingFrom } from '@/work/item-display';
import { EVALUATION_ATTEMPTS_SPENT } from '@/work/queue-order';
import {
  OUTCOME_UNKNOWN_REASON,
  providerReconciliationEntries,
  retryRequiresProviderReconciliation,
} from '@/work/reconciliation';
import { replyTargetFor } from '@/work/reply-target';
import { OUT_OF_SCOPE_SKIP_PREFIX, QUALITY_FIT_SKIP_PREFIX } from '@/work/types';
import { usePreviousValue } from '../../../components/previous-value';
import { StatusRegion } from '../../../components/StatusRegion';
import { useChange } from '../../../components/use-change';
import type { KeptCorrection } from '../corrections-panel';
import { clockTime, clockTimeWithSeconds, useAgentZone, useNow } from '../../../components/time';
import { EarlierPlan } from './EarlierPlan';
import { DecisionStamp, ItemHead } from './ItemHead';
import { ItemSection, Lead, Note } from './ItemParts';
import { LandedChanges, NotSentLedger } from './LandedChanges';
import { PendingActions } from './PendingActions';
import { type PlanApproval, PlanApprovalForm } from './PlanApproval';
import { type ItemPlan, PlanSection } from './PlanSection';
import { RejectedSection, type RetryMode, RetrySection, SkippedSection } from './RetrySection';
import { ManagerFeedbackNote, WorkingFromNote } from './RunDetails';
import { RunRecord } from './RunRecord';
import { TicketNowLine } from './TicketNowLine';
import {
  type ItemVerdict,
  ProgressSection,
  type RefusedSkill,
  VerdictSection,
} from './VerdictSection';
import {
  colleagueHolding,
  decisionAttribution,
  failedItemReason,
  heldQuestionOf,
  justLanded,
  landedPlaces,
  pendingVerdicts,
  phasedLedger,
  type RunOutput,
  waitingLine,
} from './work-item';

/** How long a landing plays: the last line's 120 ms and three 70 ms steps, then its 240 ms rise. */
export const LANDING_MS = 570;

/** The states in which the employee is working the item and nothing waits on the manager. */
const WORKING_STATES: ReadonlySet<string> = new Set(['claimed', 'plan-approved', 'executing']);

/**
 * What the item's settling controls are for, read from the row: none while it moves or waits
 * on its own.
 *
 * @throws When the row's state is one the union does not hold (standard 5.1: a state added to
 *   the schema fails the build here, and a row from outside it fails loudly, not silently
 *   controlless).
 */
export function retryModeOf(
  item: Doc<'workItems'>,
  verdictReason: string | undefined,
  heldQuestion: string | undefined,
): RetryMode | undefined {
  switch (item.state) {
    case 'completed':
      return { kind: 'send-back' };
    case 'failed':
      return heldQuestion !== undefined
        ? { kind: 'answer', question: heldQuestion }
        : { kind: 'retry-failed', rejected: rejectionOf(item) !== undefined };
    case 'cancelled':
      return { kind: 'cancelled', hadPlan: item.plan !== undefined };
    case 'skipped':
      // Refused at the claim: the colleague who holds the item works it, and
      // the row comes back by itself if they let it go, so the control is the
      // colleague's card, where the manager can let it go.
      if (colleagueHolding(item)) return undefined;
      // The scope and quality-fit judgements are the employee's; Retry is the
      // manager saying the work is theirs to give, with that rule waived.
      if (verdictReason?.startsWith(OUT_OF_SCOPE_SKIP_PREFIX)) {
        return { kind: 'take', waived: 'scope' };
      }
      if (verdictReason?.startsWith(QUALITY_FIT_SKIP_PREFIX)) {
        return { kind: 'take', waived: 'quality-fit' };
      }
      // Every other skip is re-evaluated by Retry: the manager who disagrees
      // always has a control (P3-1).
      return { kind: 'skip-retry' };
    case 'deferred':
      // A row whose evaluations kept dying waits for this Retry and nothing else (S D3).
      return verdictReason === EVALUATION_ATTEMPTS_SPENT ? { kind: 'parked' } : undefined;
    case 'discovered':
    case 'claimed':
    case 'plan-pending':
    case 'plan-approved':
    case 'executing':
    case 'needs-skill':
    case 'actions-pending':
      return undefined;
    default: {
      const unhandled: never = item.state;
      throw new Error(`no settling controls for a work item in state ${String(unhandled)}`);
    }
  }
}

/** What a settled retry on the card says in its live region. */
function retryDone(mode: RetryMode, title: string): string {
  switch (mode.kind) {
    case 'take':
      return `Taken: ${title} goes back to be evaluated.`;
    case 'answer':
      return `Answer sent: ${title} runs again with it.`;
    case 'send-back':
    case 'retry-failed':
    case 'cancelled':
    case 'skip-retry':
    case 'parked':
      return `Sent back: ${title}.`;
  }
}

/**
 * One work item in its state, as round two section 3.7 draws it: the head (the state in the
 * manager's words, where it came from, the ask), then what the state is about (a skip citing
 * its clause, the plan to approve, the run's progress, the writes held for the manager, what
 * landed, the rejection), then the controls that move it with the consequence beneath them. The
 * card carries `id="item-<id>"`, so the inbox's links land on it, and every decision on it is
 * said in its own live region with focus returned (`useChange`).
 */
export function WorkItemCard({
  item,
  surfaces,
  autonomousActions,
  employeeName = 'the employee',
  questions = [],
  corrections = [],
  autonomyChanges = [],
  onApprovePlan,
  onCancelPlan,
  onRetryFailed,
  onReconcileFailed,
  onApproveActions,
  onRejectActions,
  onResendDecision,
  onDismiss,
  servedByLoop = false,
  refusedSkill,
}: {
  item: Doc<'workItems'>;
  surfaces: SurfaceRecord[];
  autonomousActions: boolean;
  /** The employee's name, for the sentences that say who does what next. */
  employeeName?: string;
  /** The charter's open questions asked at this item's plan and still waiting. */
  questions?: Doc<'managerQuestions'>[];
  /** The employee's kept corrections, for the line saying this plan applied one. */
  corrections?: readonly KeptCorrection[];
  /** The employee's flips of the autonomous-actions switch, for a plan drafted before one. */
  autonomyChanges?: readonly AutonomyChange[];
  onApprovePlan: (decision: PlanApproval) => Promise<unknown> | void;
  onCancelPlan: (reason: string) => Promise<unknown> | void;
  onRetryFailed: (feedback?: string) => Promise<unknown> | void;
  onReconcileFailed: (confirmed: boolean) => Promise<unknown>;
  onApproveActions: (approvedIndexes: number[]) => Promise<unknown>;
  onRejectActions: (reason: string) => Promise<unknown>;
  onResendDecision: () => Promise<unknown>;
  /** Dismiss a failed item (N7); a card offers no Dismiss without it. */
  onDismiss?: () => Promise<unknown>;
  /** Whether the server's loop serves the queue (real mode); the mock page evaluates on its own. */
  servedByLoop?: boolean;
  /** The skill the item waits on, when its draft failed Day0's check (D3). */
  refusedSkill?: RefusedSkill;
}) {
  const now = useNow();
  const zone = useAgentZone();
  const cardRef = useRef<HTMLElement>(null);
  // A decision moves the row, and the control that made it often goes with it,
  // so the outcome is said in the card's own live region and focus comes back
  // to the control when it stayed, or to the card rather than the page.
  const change = useChange(cardRef);
  const deciding = change.busy;
  const decide = (call: () => Promise<unknown> | void, done: string, refused: string): void =>
    change.run(call, { done, refused });
  const verdict = item.verdict as ItemVerdict | undefined;
  const verdictReason = typeof verdict?.reason === 'string' ? verdict.reason : undefined;
  const plan = item.plan as ItemPlan | undefined;
  const output = item.output as RunOutput | undefined;
  const ledger = phasedLedger(output);
  const places = landedPlaces(ledger);
  const landed = places.map((place) => ({ ...ledger[place]!, place }));
  // Rows that land while the page is open are a landing the manager is
  // watching (v3 section 5.2), whether or not the run landed a row before (M7).
  const landedBefore = usePreviousValue(places.join(','), LANDING_MS);
  const fresh = justLanded(landedBefore, places);
  // A row the auto phase deferred is in the gate box, not in the ledger's held list.
  const held = ledger.filter((row) => row.held && !row.awaitingApproval);
  // A row Day0's own gate refused was never sent: it is listed apart from a
  // row the provider failed, whose outcome someone may have to check.
  const unlanded = ledger.filter((row) => !row.ok && !row.held);
  const refused = unlanded.filter((row) => isSurfaceTool(row.tool) && isGateRefusal(row.reason));
  // A row whose response was lost, or one an interrupted apply could not
  // account for, may have landed: it is not listed as never reaching anything.
  const unknown = unlanded.filter(
    (row) =>
      !refused.includes(row) &&
      (row.outcomeUnknown === true || row.reason === OUTCOME_UNKNOWN_REASON),
  );
  const failed = unlanded.filter((row) => !refused.includes(row) && !unknown.includes(row));
  const landedAutonomously = landed.filter((row) => row.authority === 'autonomous').length;
  const autonomyTurnedOnAt = autonomyTurnedOnAfterDraft(
    item.planPendingAt,
    landedAutonomously > 0,
    autonomyChanges,
  );
  const heldQuestion = heldQuestionOf(item);
  const mode = retryModeOf(item, verdictReason, heldQuestion);
  const rejection = rejectionOf(item);
  const from = workingFrom(item);
  const decided = decisionAttribution(item.decision);
  const waiting = servedByLoop ? waitingLine(item, zone) : undefined;
  // The page runs the mock loop until the deployment says it serves the real one.
  const gate = servedByLoop ? 'real' : 'mock';
  const skipped =
    item.state === 'skipped' && verdictReason !== undefined && !colleagueHolding(item);
  // The per-action box already names every action that failed, so the
  // row-level reason only earns its space for the other failures: no
  // registered skill, a model error, a mid-run throw.
  const stopReason =
    item.state === 'failed' && !rejection && failed.length === 0
      ? failedItemReason(item)
      : undefined;
  // What a rejected run held and never sent: the ledger's held rows when the
  // run applied some rows first, else the held actions themselves.
  const notSent =
    held.length > 0 || !rejection
      ? held
      : (output?.actions ?? []).map((action) => ({
          tool: action.tool,
          ok: false,
          held: true,
          effect: summariseAction(action, surfaces, { replyTarget: replyTargetFor(item) }),
          reason: item.skipReason,
        }));
  const landedSection =
    landed.length > 0 ? (
      <ItemSection>
        <LandedChanges
          rows={landed}
          fresh={fresh}
          withheld={held.filter((row) => row.reason === HELD_NOT_APPROVED).length}
          decided={
            item.state === 'completed' && decided ? (
              <DecisionStamp decision={item.decision} zone={zone} />
            ) : undefined
          }
          note={
            autonomyTurnedOnAt !== undefined ? (
              <p className="text-[13px] text-[var(--color-ok)]">
                <time
                  dateTime={new Date(autonomyTurnedOnAt).toISOString()}
                  title={clockTimeWithSeconds(autonomyTurnedOnAt, zone)}
                >
                  {autonomyTurnedOnAfterDraftNote(
                    clockTime(autonomyTurnedOnAt, zone),
                    landedAutonomously,
                    landed.length,
                  )}
                </time>
              </p>
            ) : undefined
          }
        />
        {item.state === 'completed' ? <NotSentLedger rows={held} /> : null}
      </ItemSection>
    ) : null;
  const leadsWithResult = item.state === 'completed' || rejection !== undefined;
  // Writes held for the manager: the draft is read before the controls that decide them.
  const holding =
    item.state === 'actions-pending' && output !== undefined && item.approvedIndexes === undefined;
  const runRecord = (
    <RunRecord
      output={output}
      rows={ledger}
      refused={refused}
      failed={failed}
      unknown={unknown}
      title={item.title}
    />
  );
  const ticketNow =
    servedByLoop && item.sourceCategory === 'ticket-queue' && mode !== undefined ? (
      <TicketNowLine workItemId={item._id} zone={zone} />
    ) : null;
  return (
    <article
      ref={cardRef}
      id={`item-${item._id}`}
      tabIndex={-1}
      aria-labelledby={`work-item-${item._id}`}
      className="scroll-mt-24 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]"
    >
      <ItemHead
        item={item}
        surfaces={surfaces}
        now={now}
        zone={zone}
        busy={deciding}
        stampDecision={!(item.state === 'completed' && landed.length > 0)}
        onAskAgain={(surfaceName) =>
          decide(onResendDecision, `Asked again on ${surfaceName}.`, 'The request was not sent.')
        }
      />
      {waiting ? (
        <ItemSection>
          <p className="text-sm text-[var(--color-fg)]">{waiting}</p>
        </ItemSection>
      ) : (
        <VerdictSection
          item={item}
          verdict={verdict}
          surfaces={surfaces}
          now={now}
          {...(refusedSkill === undefined ? {} : { refusedSkill })}
        />
      )}
      {skipped && verdictReason ? (
        <SkippedSection
          reason={verdictReason}
          scope={verdictReason.startsWith(OUT_OF_SCOPE_SKIP_PREFIX)}
          employeeName={employeeName}
        />
      ) : null}
      {rejection ? (
        <RejectedSection
          rejection={rejection}
          landed={landed.length}
          notSent={notSent}
          zone={zone}
        />
      ) : null}
      {leadsWithResult ? landedSection : null}
      {item.state === 'completed' ? ticketNow : null}
      {from ? (
        <WorkingFromNote
          kind={from.kind}
          feedback={from.feedback}
          earlier={
            servedByLoop ? (
              <EarlierPlan workItemId={item._id} employeeName={employeeName} zone={zone} />
            ) : undefined
          }
        />
      ) : null}
      {WORKING_STATES.has(item.state) ? (
        <ProgressSection item={item} autonomous={autonomousActions} gate={gate} />
      ) : null}
      {plan ? (
        <PlanSection item={item} plan={plan} surfaces={surfaces} corrections={corrections} />
      ) : null}
      {item.state === 'plan-pending' && plan ? (
        <PlanApprovalForm
          key={item._id}
          riskNotes={plan.riskNotes ?? ''}
          questions={questions}
          busy={deciding}
          employeeName={employeeName}
          autonomousActions={autonomousActions}
          gate={gate}
          onApprove={(decision) =>
            decide(
              () => onApprovePlan(decision),
              `Plan approved: ${item.title}.`,
              'The plan was not approved.',
            )
          }
          onCancel={(reason) =>
            decide(
              () => onCancelPlan(reason),
              `Plan cancelled: ${item.title}.`,
              'The plan was not cancelled.',
            )
          }
        />
      ) : null}
      {item.state === 'actions-pending' && output && item.approvedIndexes === undefined ? (
        <>
          {/* What applied on its own is read before the writes still to decide. */}
          {landedSection}
          {output.initial !== undefined ? (
            <ItemSection>
              <p className="text-sm text-[var(--color-fg-2)]">
                Closing actions, authored from the prerequisite ledger below.
              </p>
            </ItemSection>
          ) : null}
          <PendingActions
            key={`${item._id}:${item.pendingRunId ?? ''}`}
            actions={output.actions ?? []}
            verdicts={pendingVerdicts(item.actionVerdicts, output.actions?.length ?? 0)}
            landed={landed.length}
            surfaces={surfaces}
            replyTarget={replyTargetFor(item)}
            autonomousActions={autonomousActions}
            repairs={output.argumentRepairs}
            busy={deciding}
            employeeName={employeeName}
            closing={output.needsDependentPhase === true}
            gate={gate}
            onApprove={(approvedIndexes) =>
              decide(
                () => onApproveActions(approvedIndexes),
                approvedIndexes.length === 0
                  ? `Approved with nothing selected: ${item.title} lands nothing.`
                  : approvedIndexes.length === 1
                    ? 'Approved 1 action: it applies now.'
                    : `Approved ${approvedIndexes.length} actions: they apply now.`,
                'The actions were not approved.',
              )
            }
            onReject={(reason) =>
              decide(
                () => onRejectActions(reason),
                `Run rejected: nothing held on ${item.title} is sent.`,
                'The run was not rejected.',
              )
            }
          >
            {runRecord}
          </PendingActions>
        </>
      ) : item.state === 'actions-pending' && item.approvedIndexes !== undefined ? (
        <ItemSection>
          <Note tone="accent">
            <Lead>Applying the approved actions…</Lead>
          </Note>
        </ItemSection>
      ) : null}
      {leadsWithResult || holding ? null : landedSection}
      {!leadsWithResult && held.length > 0 ? (
        <ItemSection
          title={`${held.length} ${held.length === 1 ? 'action' : 'actions'} held · never sent`}
        >
          <NotSentLedger rows={held} />
        </ItemSection>
      ) : null}
      {holding ? null : runRecord}
      {item.managerFeedback && !rejection && !from ? (
        <ItemSection>
          <ManagerFeedbackNote feedback={item.managerFeedback} />
        </ItemSection>
      ) : null}
      {item.state !== 'completed' ? ticketNow : null}
      {mode ? (
        <RetrySection
          item={item}
          mode={mode}
          reason={stopReason}
          reconciliation={{
            needed: retryRequiresProviderReconciliation(output, item.skipReason),
            entries: item.providerReconciliation?.entries ?? providerReconciliationEntries(output),
            ...(item.providerReconciliation ? { recorded: item.providerReconciliation } : {}),
          }}
          employeeName={employeeName}
          autonomous={autonomousActions}
          gate={gate}
          busy={deciding}
          onRetry={(note) =>
            decide(
              () => onRetryFailed(note),
              retryDone(mode, item.title),
              'The item was not sent back.',
            )
          }
          onReconcile={() =>
            decide(
              () => onReconcileFailed(true),
              'Reconciliation recorded: Retry is enabled.',
              'Could not record reconciliation.',
            )
          }
          {...(item.state === 'failed' &&
          onDismiss &&
          // A write that may have landed keeps the item in the inbox until it is reconciled.
          !(
            retryRequiresProviderReconciliation(output, item.skipReason) &&
            !item.providerReconciliation
          )
            ? {
                dismiss: {
                  ...(item.dismissedAt !== undefined ? { at: item.dismissedAt } : {}),
                  onDismiss: () =>
                    decide(
                      onDismiss,
                      `Dismissed: ${item.title} is out of your inbox and stays in the record.`,
                      'The item was not dismissed.',
                    ),
                },
              }
            : {})}
        />
      ) : null}
      {/* Always in the page, so its first outcome is announced; padded only once it speaks. */}
      <div className="px-4 sm:px-5 [&>p:not(:empty)]:pb-3">
        <StatusRegion outcome={change.outcome} />
      </div>
    </article>
  );
}
