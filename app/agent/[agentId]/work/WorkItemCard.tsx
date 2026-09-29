'use client';

import Link from 'next/link';
import type { Doc } from '@convex/_generated/dataModel';
import type { SurfaceRecord } from '@/surfaces/types';
import { type KeptCorrection, AppliedCorrectionsLine } from '../corrections-panel';
import {
  type AutonomyChange,
  autonomyTurnedOnAfterDraft,
  autonomyTurnedOnAfterDraftNote,
} from '@/work/autonomy';
import { PendingActions } from './PendingActions';
import { type PlanApproval, PlanApprovalForm } from './PlanApproval';
import { useNow, useAgentZone, clockTimeWithSeconds, clockTime } from '../time';
import { useRef, useState } from 'react';
import { useChange } from '../../../components/use-change';
import { StatusRegion } from '../../../components/StatusRegion';
import {
  type PlanObligationsRow,
  type RunOutput,
  phasedLedger,
  TAKE_IT_ANYWAY,
  colleagueHolding,
  heldQuestionOf,
  retryNoteToken,
  type TypedRetryNote,
  liveRetryNote,
  decisionAttribution,
  waitingLine,
  cancelledReason,
  pendingVerdicts,
  failedItemReason,
  landedPlaces,
  justLanded,
  ANSWER_AND_RETRY,
  SKIP_RETRY_NOTE,
} from './work-item';
import { isSurfaceTool, isGateRefusal } from '@/surfaces/policy';
import {
  OUTCOME_UNKNOWN_REASON,
  providerReconciliationEntries,
  retryRequiresProviderReconciliation,
} from '@/work/reconciliation';
import { usePreviousValue } from '../../../components/previous-value';
import { QUALITY_FIT_SKIP_PREFIX, OUT_OF_SCOPE_SKIP_PREFIX } from '@/work/types';
import { undeliveredDecisionReason, draftedWithoutLine } from '@/work/manager-channel';
import { connectedManagerChannel } from '../manager-channel';
import { isStopped } from '@/work/stop';
import { EVALUATION_ATTEMPTS_SPENT } from '@/work/queue-order';
import {
  StateChip,
  PlanObligationsLine,
  ManagerFeedbackNote,
  PhaseLabel,
  RepairNote,
  SessionRestoreNote,
  PlanExecutionLedger,
  RefusedBlockedSteps,
  RefusedClosingDetails,
  WithheldActionsDetails,
  DraftDetails,
  ProviderReconciliationControl,
} from './RunDetails';
import { verdictFor } from '@/surfaces/verdict';
import { LandedChanges } from './LandedChanges';
import { replyTargetFor } from '@/work/reply-target';

/** How long a landing plays: the last line's 120 ms and three 70 ms steps, then its 240 ms rise. */
export const LANDING_MS = 570;

/** One work item: its verdict, plan, held actions, ledger and the controls the state allows. */
export function WorkItemCard({
  item,
  surfaces,
  autonomousActions,
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
  servedByLoop = false,
}: {
  item: Doc<'workItems'>;
  surfaces: SurfaceRecord[];
  autonomousActions: boolean;
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
  /** Whether the server's loop serves the queue (real mode); the mock page evaluates on its own. */
  servedByLoop?: boolean;
}) {
  const now = useNow();
  const zone = useAgentZone();
  const cardRef = useRef<HTMLDivElement>(null);
  // A decision moves the row, and the control that made it often goes with it,
  // so the outcome is said in the card's own live region and focus comes back
  // to the control when it stayed, or to the card rather than the page.
  const change = useChange(cardRef);
  const deciding = change.busy;
  const decide = (call: () => Promise<unknown> | void, done: string, refused: string): void =>
    change.run(call, { done, refused });
  const verdict = item.verdict as
    | {
        decision: string;
        reason?: string;
        suggestedSkillName?: string;
        missingSurface?: string;
        missingPermissions?: string[];
      }
    | undefined;
  const plan = item.plan as
    | {
        summary: string;
        steps: string[];
        riskNotes: string;
        reversibility: string;
        estimatedMinutes: number;
        expectedOutputType: string;
        obligations?: PlanObligationsRow;
        obligationsFailedOpen?: string;
        appliedCorrections?: string[];
        correctionsRedaction?: 'structural-only';
      }
    | undefined;
  const output = item.output as RunOutput | undefined;
  const appliedActions = phasedLedger(output);
  // A row the auto phase deferred is in the gate box above, not in the ledger's held list.
  const heldActions = appliedActions.filter((a) => a.held && !a.awaitingApproval);
  // A row Day0's own gate refused was never sent: it is listed apart from a
  // row the provider failed, whose outcome someone may have to check.
  const unlandedActions = appliedActions.filter((a) => !a.ok && !a.held);
  const refusedActions = unlandedActions.filter(
    (a) => isSurfaceTool(a.tool) && isGateRefusal(a.reason),
  );
  // A row whose response was lost, or one an interrupted apply could not
  // account for, may have landed: it is not listed as never reaching anything.
  const unknownActions = unlandedActions.filter(
    (a) =>
      !refusedActions.includes(a) &&
      (a.outcomeUnknown === true || a.reason === OUTCOME_UNKNOWN_REASON),
  );
  const failedActions = unlandedActions.filter(
    (a) => !refusedActions.includes(a) && !unknownActions.includes(a),
  );
  const places = landedPlaces(appliedActions);
  const landedActions = places.map((place) => ({ ...appliedActions[place]!, place }));
  // Rows that land while the page is open are a landing the manager is
  // watching (v3 section 5.2), whether or not the run landed a row before.
  const landedBefore = usePreviousValue(places.join(','), LANDING_MS);
  const freshPlaces = justLanded(landedBefore, places);
  const landedAutonomously = landedActions.filter((a) => a.authority === 'autonomous').length;
  const autonomyTurnedOnAt = autonomyTurnedOnAfterDraft(
    item.planPendingAt,
    landedAutonomously > 0,
    autonomyChanges,
  );
  const reconciliationEntries =
    item.providerReconciliation?.entries ?? providerReconciliationEntries(output);
  const needsProviderReconciliation = retryRequiresProviderReconciliation(output, item.skipReason);
  const retryBlocked = needsProviderReconciliation && !item.providerReconciliation;
  // The quality-fit filter's skip is the agent's judgement, not the manager's;
  // Retry hands the item back with that filter waived.
  const skipVerdictReason =
    item.state === 'skipped' &&
    typeof (verdict as { reason?: unknown } | undefined)?.reason === 'string'
      ? (verdict as { reason: string }).reason
      : undefined;
  const qualityFitSkipped = skipVerdictReason?.startsWith(QUALITY_FIT_SKIP_PREFIX) === true;
  // The scope judgement is the agent's reading of the charter and the
  // documented systems; Retry is the manager saying the work is theirs to give.
  const outOfScopeSkipped = skipVerdictReason?.startsWith(OUT_OF_SCOPE_SKIP_PREFIX) === true;
  const skipWaivable = qualityFitSkipped || outOfScopeSkipped;
  // A skipped row's control is not a retry of a run: it hands the agent an
  // item it set aside. Named apart so the page holds one Retry when a run stops.
  const takeAnywayNote = qualityFitSkipped
    ? `${TAKE_IT_ANYWAY} re-evaluates this item without the quality-fit filter; its plan still needs your approval.`
    : outOfScopeSkipped
      ? `${TAKE_IT_ANYWAY} re-evaluates this item as in scope, on your decision; its plan still needs your approval.`
      : undefined;
  // Refused at the claim: the colleague who holds the item works it, and the
  // row comes back by itself if they let it go, so the control is the
  // colleague's card, where the manager can let it go.
  const heldByColleague = colleagueHolding(item);
  // Every other skip (a skill tried and found not to cover it, the employee's
  // own claim elsewhere, a low value) is re-evaluated by Retry: the manager
  // who disagrees always has a control (P3-1).
  const skipRetryable = item.state === 'skipped' && !skipWaivable && !heldByColleague;
  // A run that stopped on its own question is answered here: the note is the
  // answer, and only a note on this stop answers it (review D2), so the
  // control says so and waits for one (U2 decision 5).
  const heldQuestion = heldQuestionOf(item);
  const noteToken = retryNoteToken(item);
  const [typedRetryNote, setTypedRetryNote] = useState<TypedRetryNote>({
    text: '',
    token: noteToken,
  });
  const retryNote = liveRetryNote(typedRetryNote, noteToken);
  const sendingBack = item.state === 'completed' && retryNote.trim() !== '';
  // A plan the manager cancelled: Retry drafts a new one, never runs this one.
  const cancelledPlan = item.state === 'cancelled' && plan !== undefined;
  const awaitingSurface =
    verdict?.decision === 'defer' && verdict.reason === 'awaiting-connection'
      ? surfaces.find((surface) => surface.slug === verdict.missingSurface)
      : undefined;
  const decidedFrom = decisionAttribution(item.decision);
  // The phone request is shown only when it is known not to have arrived: a
  // recorded failure, or a silent send past the recovery bound. In flight,
  // delivered and decided requests say nothing here.
  const undelivered =
    item.state === 'plan-pending' || item.state === 'actions-pending'
      ? undeliveredDecisionReason(item.decision, now)
      : undefined;
  // Resend and Ask share one mutation; what it came to is the card's to say.
  const askAgain = (surfaceName: string): void =>
    decide(onResendDecision, `Asked again on ${surfaceName}.`, 'The request was not sent.');
  // A row that parked while no manager channel was connected was never asked;
  // once a channel is, the card can ask (the sweep also does, a lease later).
  const askableChannel =
    !item.decision &&
    (item.state === 'plan-pending' ||
      (item.state === 'actions-pending' && item.approvedIndexes === undefined))
      ? connectedManagerChannel(surfaces, now)
      : undefined;
  // A failed item whose run landed nothing and left nothing to decide is
  // shown as stopped: Retry stands, and the badge says no harm was done.
  const shownState = item.state === 'failed' && isStopped(item.skipReason) ? 'stopped' : item.state;
  // A row whose evaluations kept dying waits for this Retry and nothing else (S D3).
  const parkedForRetry =
    item.state === 'deferred' &&
    (verdict as { reason?: unknown } | undefined)?.reason === EVALUATION_ATTEMPTS_SPENT;
  const waiting = servedByLoop ? waitingLine(item, zone) : undefined;
  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      aria-labelledby={`work-item-${item._id}`}
      className="border border-[var(--color-border)] rounded-lg p-3"
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <StateChip state={shownState} />
            <span className="text-[10px] text-[var(--color-muted)]">
              {item.sourceSystem}/{item.sourceCategory}
            </span>
            {item.priority ? (
              <span className="text-[10px] text-[var(--color-warn)]">{item.priority}</span>
            ) : null}
          </div>
          <h3 id={`work-item-${item._id}`} className="text-sm font-medium text-[var(--color-fg)]">
            {item.title}
          </h3>
          <p className="text-xs text-[var(--color-muted)] mt-1 line-clamp-2">
            {item.contentSummary}
          </p>
        </div>
      </div>

      {decidedFrom ? (
        <p className="mt-1 text-[10px] text-[var(--color-muted)]">{decidedFrom}</p>
      ) : null}

      {askableChannel ? (
        <p className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-[var(--color-muted)]">
          <span>
            {item.state === 'plan-pending' ? 'This plan was' : 'These actions were'} not asked on{' '}
            {askableChannel.displayName} yet: they parked while no manager channel was connected.
          </span>
          <button
            type="button"
            disabled={deciding}
            onClick={() => askAgain(askableChannel.displayName)}
            className="min-h-11 px-3 rounded-md border border-[var(--color-border)] text-[10px] text-[var(--color-fg)] disabled:opacity-50"
          >
            Ask on {askableChannel.displayName}
          </button>
        </p>
      ) : null}

      {undelivered && item.decision ? (
        <p className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-[var(--color-warn)]">
          <span>
            {item.decision.surfaceName} request not delivered
            {undelivered === 'request not delivered' ? '' : ` (${undelivered})`}
          </span>
          <button
            type="button"
            disabled={deciding}
            onClick={() => askAgain(item.decision?.surfaceName ?? 'the manager channel')}
            className="min-h-11 px-3 rounded-md border border-[var(--color-border)] text-[10px] text-[var(--color-fg)] disabled:opacity-50"
          >
            Resend
          </button>
        </p>
      ) : null}

      {waiting ? (
        <p className="mt-2 text-xs text-[var(--color-fg)]">{waiting}</p>
      ) : item.state === 'cancelled' ? (
        <div className="mt-2 text-xs">
          <span className="text-[var(--color-muted)]">cancelled:</span>{' '}
          <span className="text-[var(--color-fg)]">
            {cancelledReason({ skipReason: item.skipReason, verdict, plan })}
          </span>
        </div>
      ) : verdict ? (
        <div className="mt-2 text-xs">
          <span className="text-[var(--color-muted)]">verdict:</span>{' '}
          {verdict.decision === 'defer' && verdict.reason === 'awaiting-connection' ? (
            <span className="text-[var(--color-fg)]">
              defer - awaiting-connection: {verdict.missingSurface ?? '(unnamed system)'}
              {awaitingSurface ? ` (${verdictFor(awaitingSurface, now)})` : ' (not listed)'}{' '}
              <a href="#surfaces" className="text-[var(--color-accent)] underline">
                Surfaces tab
              </a>
            </span>
          ) : verdict.decision === 'defer' && verdict.reason === 'awaiting-charter' ? (
            <span className="text-[var(--color-fg)]">
              defer - waiting for you to approve the charter; it is evaluated once you do
            </span>
          ) : verdict.decision === 'defer' &&
            verdict.reason === 'awaiting-permission' &&
            verdict.missingPermissions?.length ? (
            <span className="text-[var(--color-fg)]">
              defer - awaiting-permission: needs {verdict.missingPermissions.join(', ')}
            </span>
          ) : heldByColleague ? (
            <span className="text-[var(--color-fg)]">
              skip · another employee holds this:{' '}
              <Link
                href={`/agent/${heldByColleague.agentId}`}
                className="inline-flex min-h-11 items-center text-[var(--color-accent)] underline"
              >
                {heldByColleague.name}
              </Link>
              <span className="block text-[10px] text-[var(--color-muted)]">
                To give it to this employee instead, cancel it on {heldByColleague.name}&apos;s
                card; it comes back here by itself once they let it go.
              </span>
            </span>
          ) : (
            <span className="text-[var(--color-fg)]">
              {verdict.decision}
              {verdict.reason ? ` - ${verdict.reason}` : ''}
            </span>
          )}
        </div>
      ) : null}

      {plan ? (
        <div className="mt-3 p-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs">
          <div className="font-medium text-[var(--color-fg)] mb-1">
            Plan ({plan.estimatedMinutes}m, {plan.reversibility})
          </div>
          <div className="text-[var(--color-muted)] mb-2">{plan.summary}</div>
          <ol className="list-decimal pl-5 space-y-0.5 text-[var(--color-fg)]">
            {plan.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          <AppliedCorrectionsLine
            ids={plan.appliedCorrections ?? []}
            corrections={corrections}
            workItemId={item._id}
            redaction={plan.correctionsRedaction}
          />
          <PlanObligationsLine
            steps={plan.steps}
            obligations={plan.obligations}
            failedOpen={plan.obligationsFailedOpen}
          />
          {autonomyTurnedOnAt !== undefined ? (
            <p className="mt-2 text-[var(--color-ok)]">
              <time
                dateTime={new Date(autonomyTurnedOnAt).toISOString()}
                title={clockTimeWithSeconds(autonomyTurnedOnAt, zone)}
              >
                {autonomyTurnedOnAfterDraftNote(
                  clockTime(autonomyTurnedOnAt, zone),
                  landedAutonomously,
                  landedActions.length,
                )}
              </time>
            </p>
          ) : null}
          {item.state === 'plan-pending' && item.planDraftedWithout !== undefined ? (
            <p className="mt-2 text-[var(--color-warn)]">
              {draftedWithoutLine({
                system:
                  surfaces.find((surface) => surface.slug === item.planDraftedWithout?.surfaceSlug)
                    ?.displayName ?? item.planDraftedWithout.surfaceSlug,
                subject: item.planDraftedWithout.subject,
                cause: item.planDraftedWithout.cause,
              })}
            </p>
          ) : null}
          {item.state === 'plan-pending' && item.planRejectedAt !== undefined ? (
            <p className="mt-2 text-[var(--color-warn)]">
              This plan was redrafted after you rejected an earlier plan. It waits for your approval
              even while autonomous actions are on.
            </p>
          ) : null}
          {item.state === 'plan-pending' ? (
            <PlanApprovalForm
              key={item._id}
              riskNotes={plan.riskNotes ?? ''}
              questions={questions}
              busy={deciding}
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
          {item.state !== 'plan-pending' &&
          item.managerAnswers &&
          item.managerAnswers.length > 0 ? (
            <div className="mt-2 text-[var(--color-muted)]">
              <p className="text-[10px] uppercase tracking-wider mb-0.5">Answered at approval</p>
              <ul className="space-y-0.5">
                {item.managerAnswers.map((entry) => (
                  <li key={`${entry.question}:${entry.answeredAt}`}>
                    {entry.question}{' '}
                    <span className="text-[var(--color-fg)]">- {entry.answer}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {item.managerFeedback ? <ManagerFeedbackNote feedback={item.managerFeedback} /> : null}

      {item.state === 'executing' && item.applyPhase === 'auto' ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          applying {item.approvedIndexes?.length ?? 0}{' '}
          {(item.approvedIndexes?.length ?? 0) === 1 ? 'action' : 'actions'}{' '}
          {autonomousActions ? 'autonomously' : 'automatically'}…
        </p>
      ) : null}

      {item.state === 'actions-pending' && output?.initial !== undefined ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Closing actions, authored from the prerequisite ledger below.
        </p>
      ) : null}

      {item.state === 'actions-pending' && output && item.approvedIndexes === undefined ? (
        <PendingActions
          key={`${item._id}:${item.pendingRunId ?? ''}`}
          actions={output.actions ?? []}
          verdicts={pendingVerdicts(item.actionVerdicts, output.actions?.length ?? 0)}
          surfaces={surfaces}
          replyTarget={replyTargetFor(item)}
          autonomousActions={autonomousActions}
          repairs={output.argumentRepairs}
          busy={deciding}
          onApprove={(approvedIndexes) =>
            decide(
              () => onApproveActions(approvedIndexes),
              approvedIndexes.length === 0
                ? `Approved with nothing selected: ${item.title} lands nothing.`
                : `Approved ${approvedIndexes.length} ${approvedIndexes.length === 1 ? 'action' : 'actions'}: they apply now.`,
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
        />
      ) : item.state === 'actions-pending' && item.approvedIndexes !== undefined ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">applying the approved actions…</p>
      ) : null}

      {/* The record of the run, ahead of the prose that describes it. The draft
          is written before a single action is applied, so it is the agent's
          account of the work; this list is what the work environment actually
          received. A reader who only ever sees the draft cannot tell the two
          apart, which is the whole of the failure this panel answers. */}
      {appliedActions.some((action) => action.redaction === 'structural-only') ? (
        <p className="mt-3 p-2 rounded-md border border-[var(--color-warn)]/30 text-xs text-[var(--color-warn)]">
          Limited redaction: some provider evidence was checked only against known credential values
          and credential formats. It may still contain secrets or personal data.
        </p>
      ) : null}

      {landedActions.length > 0 ? <LandedChanges rows={landedActions} fresh={freshPlaces} /> : null}

      {/* Held is its own list, not a success and not a failure: the gate or the
          manager kept it back, and the ledger says so. */}
      {heldActions.length > 0 ? (
        <div className="mt-2 p-2 rounded-md bg-[var(--color-muted)]/10 border border-[var(--color-border)] text-xs">
          <p className="text-[var(--color-muted)] font-medium mb-1">
            {heldActions.length} {heldActions.length === 1 ? 'action' : 'actions'} held · never sent
          </p>
          <ul className="space-y-0.5 text-[var(--color-muted)]">
            {heldActions.map((a, i) => (
              <li key={i}>
                <span className="font-mono text-[10px]">{a.tool}</span> - {a.reason ?? 'held'}
                <PhaseLabel phase={a.phase} />
                {a.effect ? (
                  <code className="block font-mono text-[10px] whitespace-pre-wrap break-words">
                    {a.effect}
                  </code>
                ) : null}
                <RepairNote repair={a.repair} />
                <SessionRestoreNote restore={a.sessionRestore} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <PlanExecutionLedger outcomes={output?.planStepOutcomes ?? []} />

      <RefusedBlockedSteps refused={output?.refusedClosing} />

      <RefusedClosingDetails refused={output?.refusedClosing} />

      <WithheldActionsDetails
        withheld={[
          ...(output?.initial?.withheldActions ?? []),
          ...(output?.withheldActions ?? []),
          ...(output?.refusedClosing?.withheldActions ?? []),
        ]}
      />

      {output ? <DraftDetails output={output} title={item.title} /> : null}

      {refusedActions.length > 0 ? (
        <div className="mt-2 p-2 rounded-md bg-[var(--color-warn)]/10 border border-[var(--color-warn)]/30 text-xs">
          <p className="text-[var(--color-warn)] font-medium mb-1">
            {refusedActions.length} {refusedActions.length === 1 ? 'action' : 'actions'} refused by
            Day0&apos;s gate · never sent
          </p>
          <ul className="space-y-0.5 text-[var(--color-warn)]">
            {refusedActions.map((a, i) => (
              <li key={i}>
                {a.tool} - {a.reason}
                <PhaseLabel phase={a.phase} />
                <RepairNote repair={a.repair} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Not inside the details element above: an action that never reached the
          work environment is the headline of this card, not a footnote to the
          draft it produced. */}
      {failedActions.length > 0 ? (
        <div className="mt-2 p-2 rounded-md bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/30 text-xs">
          <p className="text-[var(--color-danger)] font-medium mb-1">
            {failedActions.length} {failedActions.length === 1 ? 'action' : 'actions'} did not reach
            the work environment
          </p>
          <ul className="space-y-0.5 text-[var(--color-danger)]">
            {failedActions.map((a, i) => (
              <li key={i}>
                {a.tool} - {a.reason ?? 'unknown reason'}
                <PhaseLabel phase={a.phase} />
                <RepairNote repair={a.repair} />
                <SessionRestoreNote restore={a.sessionRestore} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {unknownActions.length > 0 ? (
        <div className="mt-2 p-2 rounded-md bg-[var(--color-warn)]/10 border border-[var(--color-warn)]/30 text-xs">
          <p className="text-[var(--color-warn)] font-medium mb-1">
            {unknownActions.length} {unknownActions.length === 1 ? 'action' : 'actions'} with an
            unknown outcome · may have landed
          </p>
          <ul className="space-y-0.5 text-[var(--color-warn)]">
            {unknownActions.map((a, i) => (
              <li key={i}>
                {a.tool} - {a.reason ?? 'the response was lost'}
                <PhaseLabel phase={a.phase} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {item.state === 'failed' ||
      item.state === 'completed' ||
      skipWaivable ||
      skipRetryable ||
      parkedForRetry ||
      item.state === 'cancelled' ? (
        <div className="mt-2">
          {/* The per-action box above already names every action that failed, so
              the row-level reason only earns its space for the other failures:
              no registered skill, a model error, a mid-run throw, a rejection. */}
          {item.state === 'failed' &&
          failedActions.length === 0 &&
          failedItemReason(item) &&
          !(item.managerFeedback && item.skipReason?.startsWith('rejected by the manager')) ? (
            <p className="text-[10px] text-[var(--color-muted)] italic mb-1.5">
              {failedItemReason(item)}
            </p>
          ) : null}
          {/* A finished item is sent back only with a note, so its checklist
              waits until the manager has started writing one. */}
          {(needsProviderReconciliation || item.providerReconciliation) &&
          (item.state !== 'completed' || sendingBack) ? (
            <ProviderReconciliationControl
              entries={reconciliationEntries}
              reconciliation={item.providerReconciliation}
              busy={deciding}
              onConfirm={() =>
                decide(
                  () => onReconcileFailed(true),
                  'Reconciliation recorded: Retry is enabled.',
                  'Could not record reconciliation.',
                )
              }
            />
          ) : null}
          {item.state === 'failed' || item.state === 'completed' || cancelledPlan ? (
            <>
              <label
                htmlFor={`retry-note-${item._id}`}
                className="block text-[10px] text-[var(--color-muted)]"
              >
                {heldQuestion
                  ? `Your answer to: “${heldQuestion}”`
                  : item.state === 'completed'
                    ? 'Note for the retry: say what to change or answer what the employee asked'
                    : cancelledPlan
                      ? 'Note for the new plan (optional)'
                      : 'Note for the retry (optional): answer what the employee asked, or say what to change'}
              </label>
              <input
                id={`retry-note-${item._id}`}
                type="text"
                value={retryNote}
                disabled={deciding}
                onChange={(event) =>
                  setTypedRetryNote({ text: event.target.value, token: noteToken })
                }
                className="min-h-11 w-full mb-1.5 px-2 rounded-md border border-[var(--color-border)] bg-transparent text-xs"
              />
            </>
          ) : null}
          <button
            type="button"
            onClick={() =>
              decide(
                () => onRetryFailed(retryNote),
                takeAnywayNote
                  ? `Taken: ${item.title} goes back to be evaluated.`
                  : heldQuestion
                    ? `Answer sent: ${item.title} runs again with it.`
                    : `Sent back: ${item.title}.`,
                'The item was not sent back.',
              )
            }
            disabled={
              deciding ||
              retryBlocked ||
              (item.state === 'completed' && !sendingBack) ||
              (heldQuestion !== undefined && retryNote.trim() === '')
            }
            title={takeAnywayNote}
            className="min-h-11 px-3 rounded-md bg-[var(--color-warn)]/20 text-[var(--color-warn)] text-xs font-medium hover:bg-[var(--color-warn)]/30 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {takeAnywayNote ? TAKE_IT_ANYWAY : heldQuestion ? ANSWER_AND_RETRY : 'Retry'}
          </button>
          {retryBlocked && (item.state !== 'completed' || sendingBack) ? (
            <p className="text-[10px] text-[var(--color-muted)] mt-1">
              Retry remains disabled until provider reconciliation is recorded.
            </p>
          ) : null}
          {item.state === 'completed' ? (
            <p className="text-[10px] text-[var(--color-muted)] mt-1">
              Retry with a note sends this finished work back; the note reaches the employee as your
              direction, and its writes are held again unless autonomous actions are on.
            </p>
          ) : null}
          {item.state === 'cancelled' && !cancelledPlan ? (
            <p className="text-[10px] text-[var(--color-muted)] mt-1">
              Retry evaluates this item again from the start; if it still needs a skill, a new
              proposal comes to you.
            </p>
          ) : null}
          {cancelledPlan ? (
            <p className="text-[10px] text-[var(--color-muted)] mt-1">
              {autonomousActions
                ? 'Retry drafts a new plan and your reason goes with it; the plan comes back to you before anything runs, even while autonomous actions are on.'
                : 'Retry drafts a new plan and your reason goes with it; the plan comes back to you before anything runs.'}
            </p>
          ) : null}
          {takeAnywayNote ? (
            <p className="text-[10px] text-[var(--color-muted)] mt-1">{takeAnywayNote}</p>
          ) : null}
          {skipRetryable ? (
            <p className="text-[10px] text-[var(--color-muted)] mt-1">{SKIP_RETRY_NOTE}</p>
          ) : null}
        </div>
      ) : null}
      <StatusRegion outcome={change.outcome} />
    </div>
  );
}
