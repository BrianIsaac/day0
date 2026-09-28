/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  /** Mutations and actions that reject, by function name, with the text they reject with. */
  refusals: {} as Record<string, string>,
  /** What a mutation or action resolves with, by function name; undefined otherwise. */
  results: {} as Record<string, unknown>,
  /** Every call made, by function name, with its arguments. */
  calls: [] as Array<{ name: string; args: unknown }>,
  /** What a query answers, by function name; undefined (loading) otherwise. */
  queries: {} as Record<string, unknown>,
}));

vi.mock('convex/react', () => {
  const call =
    (reference: unknown): ((args?: unknown) => Promise<unknown>) =>
    async (args?: unknown): Promise<unknown> => {
      const name = getFunctionName(reference as never);
      backend.calls.push({ name, args });
      const refusal = backend.refusals[name];
      if (refusal !== undefined) throw new Error(refusal);
      return backend.results[name];
    };
  return {
    useQuery: (reference: unknown): unknown => backend.queries[getFunctionName(reference as never)],
    useMutation: call,
    useAction: call,
  };
});

import { declareUndeclaredInputs } from '../../../../src/work/skill-inputs';
import type { Doc, Id } from '../../../../convex/_generated/dataModel';
import type { AgentMetrics } from '../../../../src/metrics/types';
import { dashboardMetrics } from '../../../fixtures/dashboard/metrics';
import type { MockAction } from '../../../../src/work/types';
import { PILOT_FIGURES } from '../../../../app/CompanySupervision';
import type { SurfaceRecord } from '../../../../src/surfaces/types';
import {
  ActionPayload,
  AgentDashboard,
  AmendCharterPanel,
  AutonomyControl,
  CheckForNewWork,
  ZoneLine,
  EventTicker,
  WorkQueue,
  NotificationModeControl,
  PendingDecisionsPanel,
  CharterCard,
  ConstraintList,
  DashboardHeader,
  ManagerFeedbackNote,
  ProviderReconciliationControl,
  DraftDetails,
  ManagerLine,
  MetricsCard,
  defaultRuleClause,
  PendingActions,
  PlanApprovalForm,
  PlanExecutionLedger,
  RefusedBlockedSteps,
  RefusedClosingDetails,
  RefusedDraftDetails,
  ProposedSkillsPanel,
  RegisteredSkillsPanel,
  WithheldActionsDetails,
  retryVerifiesSavedDraft,
  failedItemReason,
  RepairNote,
  SessionRestoreNote,
  WorkItemCard,
  sortedForQueue,
  phasedLedger,
  PermissionRows,
  PermissionsCard,
  eventItemTitle,
  planApprovalRequest,
  ANSWER_AND_RETRY,
  SKIP_RETRY_NOTE,
  TAKE_IT_ANYWAY,
  TICKET_REREAD_STOP,
  typedEstimateMinutes,
  waitingLine,
} from '../../../../app/agent/[agentId]/AgentDashboard';
import {
  button,
  choose,
  focusedName,
  mount,
  press,
  said,
  settle,
  typeInto,
} from '../../../fixtures/dom/press';
import {
  ticketRereadStopReason,
  withheldBeforeFirstWrite,
} from '../../../../src/work/ticket-ownership';
import { AgentZoneContext } from '../../../../app/agent/[agentId]/time';
import { DECISION_REQUEST_RECOVERY_MS } from '../../../../src/work/manager-channel';
import {
  HELD_BEFORE_AUTONOMY_NOTE,
  HELD_WITHHELD_TRANSITION_NOTE,
} from '../../../../src/work/autonomy';
import { HELD_WITHHELD_TRANSITION } from '../../../../src/surfaces/policy';
import { strikeOutcome, strikePreview } from '../../../../src/agent/charter-constraints';
import type { Charter } from '../../../../src/agent/charter';
import { strikeRefusalBody } from '../../../fixtures/charter-strike-refusal-2026-09-15';
import { slackPhaseOne } from '../../../fixtures/browser-phase-split-2026-09-16';
import { REFUSED_CREATE_RUN } from '../../../fixtures/refused-ticket-create-2026-09-19';
import { gateRefusalStop } from '../../../../src/work/stop';
import {
  log1FirstStopRefusedClosing,
  log1RefusedClosing,
} from '../../../fixtures/work/full-run-3-2026-09-19-log-1';
import { log1PhaseOne as sitting4Log1PhaseOne } from '../../../fixtures/work/full-run-4-2026-09-19-log-1';
import { openQuestionStopReason, withheldForAnswerReason } from '../../../../src/work/obligations';
import {
  OPEN_QUESTIONS_2026_09_16,
  RECORDED_QUESTIONS_2026_09_16,
  SYNTHESIS_SELF_CHECK_NOTE_2026_09_16,
} from '../../../fixtures/charter-synthesis-notes-2026-09-16';

describe('the panels the dashboard loads on demand', (): void => {
  // Resolved by path: under jsdom, Vite rewrites `new URL(path, import.meta.url)`
  // into a served asset address rather than a file.
  const source = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../app/agent/[agentId]/AgentDashboard.tsx',
    ),
    'utf8',
  );

  it('loads the chat room, the voice room and the work environment as their own chunks, the voice room never on the server', (): void => {
    for (const panel of ['ChatRoom', 'VoiceRoom', 'MockEnvironment']) {
      expect(source).not.toMatch(new RegExp(`import \\{ ${panel} \\} from './${panel}'`));
      expect(source).toMatch(new RegExp(`const ${panel} = dynamic\\(`));
    }
    const voice = /const VoiceRoom = dynamic\([\s\S]*?\}\);/.exec(source)?.[0] ?? '';
    expect(voice).toContain('ssr: false');
  });
});

describe('held action payload', (): void => {
  it('renders the verb with the arguments it reads and none of the empty flat-bag defaults', (): void => {
    const markup = renderToStaticMarkup(
      <ActionPayload
        action={{
          tool: 'mcp.call',
          args: {
            body: '',
            cells: [],
            channelSlug: '',
            status: 'open',
            surface: 'linear',
            tool: 'get_issue',
            toolArgsJson: '{"id":"REVOPS-5"}',
            tweetSlug: '',
          },
        }}
      />,
    );
    expect(markup).toContain('&quot;tool&quot;: &quot;mcp.call&quot;');
    expect(markup).toContain('&quot;surface&quot;: &quot;linear&quot;');
    expect(markup).toContain('REVOPS-5');
    expect(markup).not.toContain('channelSlug');
    expect(markup).not.toContain('&quot;status&quot;');
    expect(markup).not.toContain('cells');
  });
});

describe('a write re-authored once before the hold', (): void => {
  const reason =
    'Tool input validation failed against the probed schema: unknown argument comment for save_comment on linear; the schema accepts issueId, body';
  const first = '{"issueId":"REVOPS-7","comment":"Set to 74%."}';
  const held = {
    tool: 'mcp.call' as const,
    args: {
      surface: 'linear',
      tool: 'save_comment',
      toolArgsJson: '{"issueId":"REVOPS-7","body":"Set to 74%."}',
    },
  };
  const resolved = async (): Promise<void> => undefined;

  it('tells the manager the held payload is the second attempt and shows the first beside it', (): void => {
    const markup = renderToStaticMarkup(
      <PendingActions
        actions={[held]}
        verdicts={[{ disposition: 'held', reason: 'held for approval' }]}
        surfaces={[]}
        repairs={[{ index: 0, reason, toolArgsJson: first, repaired: true }]}
        onApprove={resolved}
        onReject={resolved}
      />,
    );
    expect(markup).toContain(
      'arguments re-authored once before the hold · this payload is the second attempt',
    );
    expect(markup).toContain('the schema accepts issueId, body');
    expect(markup).toContain(
      'first attempt: {&quot;issueId&quot;:&quot;REVOPS-7&quot;,&quot;comment&quot;',
    );
    expect(markup).toContain('Set to 74%.');
  });

  it('says when the one repair produced nothing and the first attempt stands, and stays silent with no repair', (): void => {
    const failed = renderToStaticMarkup(
      <RepairNote repair={{ reason, toolArgsJson: first, repaired: false }} />,
    );
    expect(failed).toContain('the one repair produced nothing usable · first attempt stands');
    expect(renderToStaticMarkup(<RepairNote repair={undefined} />)).toBe('');
    const untouched = renderToStaticMarkup(
      <PendingActions
        actions={[held]}
        verdicts={[{ disposition: 'held', reason: 'held for approval' }]}
        surfaces={[]}
        onApprove={resolved}
        onReject={resolved}
      />,
    );
    expect(untouched).not.toContain('re-authored');
  });
});

describe('a ticket state change the plan withholds', (): void => {
  const resolved = async (): Promise<void> => undefined;
  const done = {
    tool: 'mcp.call' as const,
    args: {
      surface: 'linear',
      tool: 'save_issue',
      toolArgsJson: '{"id":"REVOPS-5","state":"Done"}',
    },
  };

  it("says the move is the manager's call, not that the run predates the switch", (): void => {
    const markup = renderToStaticMarkup(
      <PendingActions
        actions={[done]}
        verdicts={[{ disposition: 'held', reason: HELD_WITHHELD_TRANSITION }]}
        surfaces={[]}
        autonomousActions
        onApprove={resolved}
        onReject={resolved}
      />,
    );
    expect(markup).toContain(HELD_WITHHELD_TRANSITION_NOTE);
    expect(markup).not.toContain(HELD_BEFORE_AUTONOMY_NOTE);
    expect(markup).toContain(HELD_WITHHELD_TRANSITION);
  });
});

describe('a question at plan approval', (): void => {
  const question = {
    _id: 'q1',
    _creationTime: 1,
    agentId: 'a1',
    key: 'who owns the looker pipeline tile',
    question: 'Who owns the Looker pipeline tile.',
    context: {
      touchedBy: 'plan',
      text: 'Refresh the Looker pipeline tile.',
      words: ['looker', 'pipeline', 'tile'],
    },
    askedAt: 1,
    workItemId: 'w1',
    charterId: 'c1',
  } as unknown as Doc<'managerQuestions'>;
  const noop = (): void => undefined;

  it("shows the question with where it came from, an answer field, the planner's note, and one approve button", (): void => {
    const markup = renderToStaticMarkup(
      <PlanApprovalForm
        riskNotes="The runbook does not say which figure to enter if the deck and the sheet disagree."
        questions={[question]}
        onApprove={noop}
        onCancel={noop}
      />,
    );
    expect(markup).toContain('A question for you before this plan runs');
    expect(markup).toContain('Who owns the Looker pipeline tile.');
    expect(markup).toContain('from the charter · touched by the plan: looker, pipeline, tile');
    expect(markup).toContain('aria-label="answer: Who owns the Looker pipeline tile."');
    expect(markup).toContain('Planner');
    expect(markup).toContain('which figure to enter if the deck and the sheet disagree');
    expect(markup).toMatch(
      /<label for="[^"]*-note"[^>]*>Your answer to the note, for this run \(optional\)<\/label>/,
    );
    expect(markup).not.toContain('aria-label="answer to the planner');
    expect(markup).toContain('Approve plan with answers');
    expect(markup).toContain('Cancel');
  });

  it('keeps the plain approve button when the plan raises nothing, and skips an answered question', (): void => {
    const plain = renderToStaticMarkup(
      <PlanApprovalForm riskNotes="" questions={[]} onApprove={noop} onCancel={noop} />,
    );
    expect(plain).toContain('>Approve plan<');
    expect(plain).not.toContain('aria-label="answer');
    const answered = renderToStaticMarkup(
      <PlanApprovalForm
        riskNotes=""
        questions={[
          {
            ...question,
            answer: { text: 'Priya.', answeredAt: 2, via: 'dashboard' },
          } as Doc<'managerQuestions'>,
        ]}
        onApprove={noop}
        onCancel={noop}
      />,
    );
    expect(answered).not.toContain('Who owns the Looker pipeline tile.');
    expect(answered).toContain('>Approve plan<');
  });
});

describe('refused closing set', (): void => {
  it('shows the refused actions, the reason and the outcomes the set claimed, and nothing when there is none', (): void => {
    const markup = renderToStaticMarkup(
      <RefusedClosingDetails
        refused={{
          actions: [
            {
              tool: 'mcp.call',
              args: {
                surface: 'linear',
                tool: 'save_comment',
                toolArgsJson: '{"issueId":"REVOPS-7","body":"Refreshed the tile to 74%."}',
              },
            },
          ],
          planStepOutcomes: [
            { step: 3, status: 'satisfied', evidence: 'the audit comment in this response' },
          ],
          draft: 'd',
          notes: '',
          reason:
            'approved plan step 3 promised a Linear read, but no landed read or blocking ledger reason was recorded',
          at: 1,
        }}
      />,
    );
    expect(markup).toContain('Refused closing set · 1 action · never sent');
    expect(markup).toContain('approved plan step 3 promised a Linear read');
    expect(markup).toContain('mcp.call linear · save_comment');
    expect(markup).toContain('Refreshed the tile to 74%.');
    expect(markup).toContain('Step 3 · satisfied - the audit comment in this response');
    expect(renderToStaticMarkup(<RefusedClosingDetails refused={undefined} />)).toBe('');
  });
});

describe("the employee's own blocked steps beside the gate's reason (SH-4471, 19 September)", (): void => {
  it('shows each step the refused closing phase recorded as blocked, in the open, with its reason', (): void => {
    const markup = renderToStaticMarkup(
      <RefusedBlockedSteps refused={log1FirstStopRefusedClosing} />,
    );
    expect(markup).not.toContain('<details');
    expect(markup).toContain('The employee recorded 2 steps as blocked');
    expect(markup).toContain('Step 3 · blocked - No manager answer is in the applied ledger');
    expect(markup).toContain('Step 4 · blocked - Depends on step 3');
    expect(markup).not.toContain('Step 1');
    expect(markup).not.toContain(log1FirstStopRefusedClosing.reason);
  });

  it('shows one step in the singular, and one the phase could not verify', (): void => {
    const [first, , third] = log1FirstStopRefusedClosing.planStepOutcomes;
    const markup = renderToStaticMarkup(
      <RefusedBlockedSteps
        refused={{
          ...log1FirstStopRefusedClosing,
          planStepOutcomes: [{ ...first!, status: 'not-verifiable' }, third!],
        }}
      />,
    );
    expect(markup).toContain('The employee recorded 2 steps as blocked or not verifiable');
    expect(markup).toContain('Step 1 · not-verifiable - ');
    const one = renderToStaticMarkup(
      <RefusedBlockedSteps
        refused={{ ...log1FirstStopRefusedClosing, planStepOutcomes: [third!] }}
      />,
    );
    expect(one).toContain('The employee recorded 1 step as blocked');
  });

  it('shows nothing when every step was reported satisfied, and nothing without a refused set', (): void => {
    expect(renderToStaticMarkup(<RefusedBlockedSteps refused={log1RefusedClosing} />)).toBe('');
    expect(renderToStaticMarkup(<RefusedBlockedSteps refused={undefined} />)).toBe('');
  });

  it('is shown for a refused set with no actions at all, where the disclosure shows nothing', (): void => {
    const empty = { ...log1FirstStopRefusedClosing, actions: [] };
    expect(renderToStaticMarkup(<RefusedClosingDetails refused={empty} />)).toBe('');
    expect(renderToStaticMarkup(<RefusedBlockedSteps refused={empty} />)).toContain(
      'Step 3 · blocked',
    );
  });
});

describe('actions an audit withheld', (): void => {
  it('shows each withheld action with its reason and payload, and nothing when there is none', (): void => {
    const markup = renderToStaticMarkup(
      <WithheldActionsDetails
        withheld={[
          {
            action: {
              tool: 'http.request',
              args: {
                surface: 'slack',
                method: 'POST',
                path: '/chat.postMessage',
                headersJson: '{}',
                body: '{"channel":"D0MANAGER","text":"REVOPS-5 audit comment posted with the three checks."}',
              },
            },
            reason:
              'asserted a fact the ledger, the documentation and the manager\'s feedback do not carry: action 6 (http.request slack · POST /chat.postMessage) says "REVOPS-5 audit comment posted with the three checks"',
          },
        ]}
      />,
    );
    expect(markup).toContain('Withheld by the evidence check · 1 action · never sent');
    expect(markup).toContain('asserted a fact the ledger');
    expect(markup).toContain('REVOPS-5 audit comment posted with the three checks.');
    expect(renderToStaticMarkup(<WithheldActionsDetails withheld={[]} />)).toBe('');
    expect(renderToStaticMarkup(<WithheldActionsDetails withheld={undefined} />)).toBe('');
  });

  it("sets writes that wait on the manager's answer apart from the evidence check's, and says how to answer", (): void => {
    const [, , comment, done] = sitting4Log1PhaseOne.actions;
    const waiting = [comment!, done!].map((action, index) => ({
      action,
      reason: withheldForAnswerReason(index + 2),
    }));
    const markup = renderToStaticMarkup(<WithheldActionsDetails withheld={waiting} />);
    expect(markup).toContain('Waiting on your answer · 2 actions · never sent');
    expect(markup).not.toContain('evidence check');
    expect(markup).toContain('leaves step 2 to the manager&#x27;s answer');
    expect(markup).toContain('Retry with a note answers it');
    const mixed = renderToStaticMarkup(
      <WithheldActionsDetails
        withheld={[
          ...waiting,
          { action: comment!, reason: 'asserted a fact the ledger does not carry' },
        ]}
      />,
    );
    expect(mixed).toContain('Waiting on your answer · 2 actions · never sent');
    expect(mixed).toContain('Withheld by the evidence check · 1 action · never sent');
  });

  it('reads a stop with the question open as one the manager answers with Retry', (): void => {
    const reason = openQuestionStopReason({
      question: 'Which template should the notice use?',
      steps: [2, 3],
    });
    expect(
      failedItemReason({
        skipReason: `stopped: ${reason}`,
        output: { openQuestion: { question: 'q', steps: [2, 3] } },
      }),
    ).toBe(
      `stopped with a question open for you, and the writes that wait on it were never sent; answer it with Retry with a note: ${reason}`,
    );
    expect(failedItemReason({ skipReason: `stopped: ${reason}`, output: {} })).toBe(
      `stopped, nothing landed and nothing to decide: ${reason}`,
    );
  });

  it('names a stop at the closing gate as one the prerequisites survived', (): void => {
    expect(failedItemReason({ skipReason: 'stopped: the read did not land' })).toBe(
      'stopped, nothing landed and nothing to decide: the read did not land',
    );
    expect(
      failedItemReason({
        skipReason:
          'stopped: dependent phase omitted the approved ticket state transition without a blocked plan step',
        output: {
          refusedClosing: {
            actions: [],
            planStepOutcomes: [],
            draft: '',
            notes: '',
            reason: 'r',
            at: 1,
          },
        },
      }),
    ).toBe(
      'stopped at the closing gate, the prerequisites landed and Retry resumes there: dependent phase omitted the approved ticket state transition without a blocked plan step',
    );
  });
});

describe('plan execution ledger', (): void => {
  it('shows the explicit reason a promised read did not run', (): void => {
    const markup = renderToStaticMarkup(
      <PlanExecutionLedger
        outcomes={[
          {
            step: 1,
            status: 'blocked',
            evidence: 'No Linear list or get action exists in the applied ledger.',
          },
        ]}
      />,
    );
    expect(markup).toContain('Plan execution ledger');
    expect(markup).toContain('Step 1 · blocked');
    expect(markup).toContain('No Linear list or get action exists');
  });
});

describe('a run with two phases', (): void => {
  const twoPhase = {
    draft: 'Verified the tile and closed REVOPS-7.',
    notes: '',
    actions: [
      {
        tool: 'mcp.call' as const,
        args: { surface: 'linear', tool: 'save_issue', toolArgsJson: '{}' },
      },
    ],
    applied: [{ tool: 'mcp.call', ok: true, effect: 'save_issue on linear · Done' }],
    initial: {
      applied: [{ tool: 'mcp.call', ok: true, effect: 'browser_snapshot on looker · 74%' }],
    },
    planStepOutcomes: [{ step: 1, status: 'satisfied' as const, evidence: '74%' }],
  };

  it('labels every ledger row with the phase that applied it, and none when there was one phase', (): void => {
    expect(phasedLedger(twoPhase).map((row) => [row.phase, row.effect])).toEqual([
      ['prerequisite', 'browser_snapshot on looker · 74%'],
      ['closing', 'save_issue on linear · Done'],
    ]);
    expect(
      phasedLedger({ draft: 'd', notes: '', applied: twoPhase.applied }).map((row) => row.phase),
    ).toEqual([undefined]);
  });

  it('says the closing draft was written after the prerequisite ledger, not before anything applied', (): void => {
    const closing = renderToStaticMarkup(<DraftDetails output={twoPhase} />);
    expect(closing).toContain('written after the prerequisite actions were applied');
    expect(closing).not.toContain('written before anything was applied');
    const single = renderToStaticMarkup(
      <DraftDetails output={{ draft: 'd', notes: '', applied: twoPhase.applied }} />,
    );
    expect(single).toContain('written before anything was applied');
  });
});

describe('a browser signed in again before a row', (): void => {
  const [navigate, signIn, clickSignIn] = slackPhaseOne;
  const step = (action: typeof navigate, replayOf?: string, reason?: string) => ({
    ok: reason === undefined,
    ...(reason ? { reason } : {}),
    ...(replayOf ? { replayOf } : {}),
    action,
  });

  it('names the replayed calls and the rows they repeat', (): void => {
    const markup = renderToStaticMarkup(
      <SessionRestoreNote
        restore={{
          steps: [
            step(navigate, 'wi:run:0'),
            step(signIn, 'wi:run:1'),
            step(clickSignIn, 'wi:run:2'),
          ],
        }}
      />,
    );
    expect(markup).toContain(
      'signed in again first: navigate, fill, click (replays of rows 0 to 2)',
    );
    expect(markup).toContain(
      'Day0 sent the page restoration calls shown above before this row; this row&#x27;s action was not replayed.',
    );
  });

  it('says when the page was opened from the surface itself because the run never navigated', (): void => {
    const markup = renderToStaticMarkup(
      <SessionRestoreNote
        restore={{
          steps: [step(navigate), step(signIn, 'wi:run:0'), step(clickSignIn, 'wi:run:1')],
        }}
      />,
    );
    expect(markup).toContain(
      'signed in again first: navigate, fill, click (the surface&#x27;s own page, then replays of rows 0 to 1)',
    );
  });

  it('says where a replay stopped and why', (): void => {
    const markup = renderToStaticMarkup(
      <SessionRestoreNote
        restore={{
          steps: [step(navigate, 'wi:run:0'), step(signIn, 'wi:run:1', 'no grant (looker:write)')],
        }}
      />,
    );
    expect(markup).toContain(
      'could not sign in again first: navigate, fill (replays of rows 0 to 1)',
    );
    expect(markup).toContain('stopped at fill: no grant (looker:write)');
    expect(markup).toContain('this row and the rest on the surface were not sent');
    expect(markup).not.toContain('were sent again');
  });

  it('says the page was opened again, not a sign-in, when the run never signed in', (): void => {
    const markup = renderToStaticMarkup(
      <SessionRestoreNote restore={{ steps: [step(navigate, 'wi:run:0')] }} />,
    );
    expect(markup).toContain('opened the page again first: navigate (replays of row 0)');
    expect(markup).toContain('this row&#x27;s action was not replayed.');
  });

  it('stays silent on a row sent without a replay', (): void => {
    expect(renderToStaticMarkup(<SessionRestoreNote restore={undefined} />)).toBe('');
  });

  it('shows the note under the closing row that needed the page, on the item card', (): void => {
    const landed = (effect: string, key: string) => ({
      tool: 'mcp.call',
      ok: true,
      effect,
      idempotencyKey: key,
    });
    const row = {
      _id: 'w1',
      _creationTime: 1,
      agentId: 'a1',
      state: 'completed',
      title: 'Slack mention in #revops-asks',
      contentSummary: 'Confirm pipeline coverage.',
      sourceSystem: 'slack',
      sourceCategory: 'event-stream',
      externalId: 'x',
      observedAt: 1,
      contentRefs: [],
      output: {
        draft: 'Refreshed the tile to 74%.',
        notes: '',
        initial: {
          applied: [landed('browser_snapshot on looker · visible figure 68%', 'wi:run:3')],
        },
        applied: [
          {
            ...landed('browser_fill_form on looker · ok', 'wi:run:4'),
            sessionRestore: {
              steps: [
                step(navigate, 'wi:run:0'),
                step(signIn, 'wi:run:1'),
                step(clickSignIn, 'wi:run:2'),
              ],
            },
          },
          landed('browser_click on looker · ok', 'wi:run:5'),
        ],
        planStepOutcomes: [{ step: 1, status: 'satisfied', evidence: '74%' }],
      },
    } as unknown as Doc<'workItems'>;
    const markup = renderToStaticMarkup(
      <WorkItemCard
        item={row}
        surfaces={[]}
        autonomousActions={true}
        onApprovePlan={(): void => undefined}
        onCancelPlan={(): void => undefined}
        onRetryFailed={(): void => undefined}
        onReconcileFailed={async (): Promise<void> => undefined}
        onApproveActions={async (): Promise<void> => undefined}
        onRejectActions={async (): Promise<void> => undefined}
        onResendDecision={async (): Promise<void> => undefined}
      />,
    );
    expect(markup.match(/signed in again first/g)).toHaveLength(1);
    expect(markup.indexOf('browser_fill_form on looker')).toBeLessThan(
      markup.indexOf('signed in again first'),
    );
    expect(markup.indexOf('signed in again first')).toBeLessThan(
      markup.indexOf('browser_click on looker'),
    );
  });
});

describe('a landed change reused from an earlier run', (): void => {
  it('says which run sent the change the row reuses', (): void => {
    const row = {
      _id: 'w1',
      _creationTime: 1,
      agentId: 'a1',
      state: 'completed',
      title: 'Close REVOPS-5',
      contentSummary: 'Add the audit note and close the ticket.',
      sourceSystem: 'linear',
      sourceCategory: 'ticket-queue',
      externalId: 'REVOPS-5',
      observedAt: 1,
      contentRefs: [],
      output: {
        draft: 'Audited and closed.',
        notes: '',
        applied: [
          {
            tool: 'mcp.call',
            ok: true,
            effect: 'save_comment on linear',
            idempotencyKey: 'wi:retry:0',
          },
          {
            tool: 'mcp.call',
            ok: true,
            effect: 'save_issue on linear',
            providerId: 'REVOPS-5',
            idempotencyKey: 'wi:retry:1',
            reusedFrom: 'wi:first:1',
            reusedFromRun: 1,
          },
        ],
      },
    } as unknown as Doc<'workItems'>;
    const markup = renderToStaticMarkup(
      <WorkItemCard
        item={row}
        surfaces={[]}
        autonomousActions={true}
        onApprovePlan={(): void => undefined}
        onCancelPlan={(): void => undefined}
        onRetryFailed={(): void => undefined}
        onReconcileFailed={async (): Promise<void> => undefined}
        onApproveActions={async (): Promise<void> => undefined}
        onRejectActions={async (): Promise<void> => undefined}
        onResendDecision={async (): Promise<void> => undefined}
      />,
    );
    expect(markup.match(/reused from run 1/g)).toHaveLength(1);
    expect(markup.indexOf('save_issue on linear')).toBeLessThan(
      markup.indexOf('reused from run 1'),
    );
  });
});

describe('sending a finished item back', (): void => {
  const landedDm = {
    draft: 'Told the manager.',
    notes: '',
    actions: [
      {
        tool: 'http.request' as const,
        args: {
          surface: 'slack',
          method: 'POST',
          path: 'chat.postMessage',
          headersJson: '{}',
          body: '{}',
        },
      },
    ],
    applied: [
      {
        tool: 'http.request',
        ok: true,
        effect: 'sent the manager DM',
        providerId: 'dm-1',
        idempotencyKey: 'dm',
      },
    ],
  };
  const item = (state: 'completed' | 'failed'): Doc<'workItems'> =>
    ({
      _id: 'w1',
      _creationTime: 1,
      agentId: 'a1',
      state,
      title: 'Answer the ask in the thread',
      contentSummary: 'Confirm the figure.',
      sourceSystem: 'slack',
      sourceCategory: 'event-stream',
      externalId: 'x',
      observedAt: 1,
      contentRefs: [],
      output: landedDm,
    }) as unknown as Doc<'workItems'>;
  const noop = (): void => undefined;
  const resolved = async (): Promise<void> => undefined;
  const render = (row: Doc<'workItems'>): string =>
    renderToStaticMarkup(
      <WorkItemCard
        item={row}
        surfaces={[]}
        autonomousActions={false}
        onApprovePlan={noop}
        onCancelPlan={noop}
        onRetryFailed={noop}
        onReconcileFailed={resolved}
        onApproveActions={resolved}
        onRejectActions={resolved}
        onResendDecision={resolved}
      />,
    );

  it('shows what the plan declares it owes, who declared it, and when the judgement could not be reached', (): void => {
    const plan = {
      summary: 'Audit note.',
      steps: ['Check 1', 'Check 3', 'Check 2', 'Comment', 'Done'],
      riskNotes: '',
      reversibility: 'r',
      estimatedMinutes: 1,
      expectedOutputType: 'ticket-update',
    };
    const judged = render({
      ...item('completed'),
      plan: {
        ...plan,
        obligations: {
          steps: [
            { kind: 'write', reads: ['looker-pipeline-tile'], writes: ['looker-pipeline-tile'] },
            { kind: 'read', reads: ['linear'], writes: [] },
            { kind: 'report', reads: [], writes: [] },
            { kind: 'write', reads: [], writes: ['linear'] },
            { kind: 'conditional-write', reads: [], writes: ['linear'] },
          ],
          transition: 'conditional-on-manager',
          transitionStep: 5,
          basis: 'judgement',
        },
      },
    } as unknown as Doc<'workItems'>);
    expect(judged).toContain('Declared obligations');
    expect(judged).toContain('judged');
    expect(judged).toContain('ticket state moved only on your approval, held for you (step 5)');
    expect(judged).toContain('step 1 reads looker-pipeline-tile; step 2 reads linear');
    expect(judged).not.toContain('could not be reached');

    const noSurface = { kind: 'report', reads: [], writes: [] };
    const disagreed = render({
      ...item('completed'),
      plan: {
        ...plan,
        obligations: {
          steps: plan.steps.map(() => noSurface),
          transition: 'conditional-on-evidence',
          transitionStep: 5,
          basis: 'judgement',
          plannerTransition: 'withheld',
        },
      },
    } as unknown as Doc<'workItems'>);
    expect(disagreed).toContain('The planner declared the ticket state left where it is');
    expect(disagreed).toContain('held for your decision');

    const unchecked = render({
      ...item('completed'),
      plan: {
        ...plan,
        obligations: {
          steps: [],
          transition: 'withheld',
          transitionStep: 5,
          basis: 'planner',
          failedOpen: 'provider unavailable',
        },
      },
    } as unknown as Doc<'workItems'>);
    expect(unchecked).toContain('unchecked');
    expect(unchecked).toContain('could not be reached (provider unavailable)');

    const open = render({
      ...item('completed'),
      plan: { ...plan, obligationsFailedOpen: 'the judgement reply did not satisfy the schema' },
    } as unknown as Doc<'workItems'>);
    expect(open).toContain(
      'Obligations not settled: the judgement reply did not satisfy the schema',
    );
    expect(open).toContain('verify no read or ticket state change for this plan');

    const mock = render({ ...item('completed'), plan } as unknown as Doc<'workItems'>);
    expect(mock).not.toContain('Declared obligations');
    expect(mock).not.toContain('Obligations not settled');
  });

  it('says a planner and judgement disagreement holds the state change only when the gate holds it (19 Sep run)', (): void => {
    const base = {
      summary: 'Close status note.',
      riskNotes: '',
      reversibility: 'r',
      estimatedMinutes: 1,
      expectedOutputType: 'ticket-update',
    };
    const read = { kind: 'read', reads: ['linear'], writes: [] };
    const report = { kind: 'report', reads: [], writes: [] };
    const slackWrite = { kind: 'write', reads: [], writes: ['slack'] };
    const linearWrite = { kind: 'write', reads: [], writes: ['linear'] };
    const linearMove = { kind: 'conditional-write', reads: [], writes: ['linear'] };
    const card = (steps: string[], obligations: Record<string, unknown>): string =>
      render({
        ...item('completed'),
        plan: { ...base, steps, obligations: { basis: 'judgement', ...obligations } },
      } as unknown as Doc<'workItems'>);

    // FIN-1: planner `promised`, judgement `conditional-on-evidence`; the move to Done landed autonomously.
    const fin1 = card(
      [
        'Read the step tickets',
        'Compose the note',
        'Comment on FIN-1',
        'Move FIN-1 to Done',
        'Answer close questions',
      ],
      {
        steps: [
          read,
          report,
          linearWrite,
          { ...linearMove, reads: ['linear'] },
          { kind: 'conditional-write', reads: ['slack'], writes: ['slack'] },
        ],
        transition: 'conditional-on-evidence',
        transitionStep: 4,
        plannerTransition: 'promised',
      },
    );
    expect(fin1).toContain('The planner declared the ticket state moved by the plan');
    expect(fin1).toContain(
      'the judgement read it as moved when what the run reads shows the condition holds',
    );
    expect(fin1).toContain(
      'Neither reading leaves the state change to you, so it is not held on that account',
    );
    expect(fin1).toContain(
      'a state change it makes goes through the autonomy switch like any other write',
    );
    expect(fin1).not.toContain('held for you');

    // The `#finance-close` ask: the planner left the move to the manager, the judgement did not; the gate held it.
    const ask = card(
      [
        'Read the close tickets',
        'Draft to the manager',
        'Reply in the thread',
        'Comment on the status ticket',
        'Move it to Done',
      ],
      {
        steps: [read, slackWrite, slackWrite, linearWrite, linearMove],
        transition: 'conditional-on-evidence',
        transitionStep: 5,
        plannerTransition: 'conditional-on-manager',
      },
    );
    expect(ask).toContain(
      'The planner declared the ticket state moved only on your approval, held for you',
    );
    expect(ask).toContain(
      'One of the two readings leaves the state change to you, so a state change the run makes is held for your decision',
    );

    // LOG-2: the judgement left the move to the manager, the planner did not; the gate held it.
    const log2 = card(
      ['Draft the notice', 'Draft to the manager', 'Comment on LOG-2', 'Move LOG-2 to Done'],
      {
        steps: [report, slackWrite, linearMove, linearMove],
        transition: 'conditional-on-manager',
        transitionStep: 4,
        plannerTransition: 'promised',
      },
    );
    expect(log2).toContain('a retry note from you that names the state is that decision');
    expect(log2).toContain(
      'One of the two readings leaves the state change to you, so a state change the run makes is held for your decision',
    );

    // Obligations that no longer line up with the steps hold nothing at the gate, so the card claims no hold.
    const unusable = card(['One step'], {
      steps: [],
      transition: 'conditional-on-evidence',
      transitionStep: 1,
      plannerTransition: 'withheld',
    });
    expect(unusable).not.toContain('held for your decision');
    expect(unusable).toContain('no longer line up with the plan');
  });

  it('shows what the manager answered at approval once the plan is running', (): void => {
    const row = {
      ...item('completed'),
      plan: {
        summary: 'Refresh the tile.',
        steps: ['Refresh'],
        riskNotes: '',
        reversibility: 'r',
        estimatedMinutes: 1,
        expectedOutputType: 'ticket-update',
      },
      managerAnswers: [
        { question: 'Who owns the Looker pipeline tile.', answer: 'Priya owns it.', answeredAt: 2 },
      ],
    } as unknown as Doc<'workItems'>;
    const markup = render(row);
    expect(markup).toContain('Answered at approval');
    expect(markup).toContain('Who owns the Looker pipeline tile.');
    expect(markup).toContain('Priya owns it.');
    expect(render(item('completed'))).not.toContain('Answered at approval');
  });

  it('shows a landed row that was re-authored before the hold with its first attempt', (): void => {
    const row = item('completed');
    const markup = render({
      ...row,
      output: {
        ...landedDm,
        applied: [
          {
            ...landedDm.applied[0]!,
            repair: {
              reason: 'unknown argument comment for save_comment on linear',
              toolArgsJson: '{"comment":"x"}',
            },
          },
        ],
      },
    } as unknown as Doc<'workItems'>);
    expect(markup).toContain('arguments re-authored once before the hold');
    expect(markup).toContain('unknown argument comment for save_comment on linear');
    expect(markup).toContain('first attempt: {&quot;comment&quot;:&quot;x&quot;}');
    expect(render(row)).not.toContain('re-authored');
  });

  it('distinguishes degraded provider evidence in both successful and failed runs', () => {
    for (const state of ['completed', 'failed'] as const) {
      const row = item(state);
      const markup = render({
        ...row,
        output: {
          ...landedDm,
          applied: [
            {
              ...landedDm.applied[0],
              ok: state === 'completed',
              redaction: 'structural-only',
            },
          ],
        },
      });
      expect(markup).toContain('Limited redaction');
      expect(markup).toContain('may still contain secrets or personal data');
      expect(render(row)).not.toContain('Limited redaction');
    }
  });

  it('offers a finished item the note and Retry only, keeping the reconciliation checklist for a note in progress', (): void => {
    const markup = render(item('completed'));
    expect(markup).toContain('Note for the retry: say what to change');
    expect(markup).toContain('Retry with a note sends this finished work back');
    expect(markup).not.toContain('Provider reconciliation required');
    expect(markup).not.toContain(
      'Retry remains disabled until provider reconciliation is recorded',
    );
  });

  it('still asks a failed run with a landed write to reconcile before Retry', (): void => {
    const markup = render(item('failed'));
    expect(markup).toContain('Provider reconciliation required');
    expect(markup).toContain('Retry remains disabled until provider reconciliation is recorded');
  });
});

describe('header state pill', (): void => {
  const agent = {
    _id: 'agent-1',
    _creationTime: 1,
    bossEmail: 'boss@day0.local',
    name: 'Day0',
    state: 'active',
    createdAt: 1,
  } as unknown as Doc<'agents'>;
  const charter = {
    _id: 'charter-1',
    _creationTime: 2,
    agentId: agent._id,
    version: '0.0',
    body: {},
    approved: true,
    createdAt: 2,
  } as unknown as Doc<'charters'>;

  it('names the supervised state on an active agent, not the retired posture ladder', (): void => {
    const markup = renderToStaticMarkup(<DashboardHeader agent={agent} charter={charter} />);
    expect(markup).toContain('Active · Supervised');
    expect(markup).not.toContain('cold-start');
    expect(markup).not.toContain('posture');
  });
});

describe("the employee's day on the page (N12, review M8)", (): void => {
  const AT = Date.UTC(2026, 8, 27, 16, 5, 9);
  const agent = {
    _id: 'agent-1',
    _creationTime: 1,
    bossEmail: 'boss@day0.local',
    name: 'Day0',
    state: 'active',
    zone: 'Asia/Singapore',
    createdAt: 1,
  } as unknown as Doc<'agents'>;

  it("names the agent's zone under the manager and offers to change it", (): void => {
    const markup = renderToStaticMarkup(<DashboardHeader agent={agent} charter={null} />);
    expect(markup).toContain('Times on this page are in <span');
    expect(markup).toContain('>Asia/Singapore</span>, the employee&#x27;s day.');
    expect(markup).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Change zone<\/button>/);
    expect(markup).toContain('role="status"');
  });

  it('prints the confirmed reconciliation in the agent\u2019s zone, not as a UTC ISO string', (): void => {
    const markup = renderToStaticMarkup(
      <AgentZoneContext value="Asia/Singapore">
        <ProviderReconciliationControl
          entries={[]}
          reconciliation={{ actor: 'boss@day0.local', confirmedAt: AT }}
          onConfirm={async () => undefined}
        />
      </AgentZoneContext>,
    );
    expect(markup).toContain('>28 Sep 2026, 00:05</time>');
    expect(markup).toContain('dateTime="2026-09-27T16:05:09.000Z"');
    expect(markup).not.toContain('>2026-09-27T16:05:09.000Z<');
  });

  it("stamps the manager's note and the feed's tooltip in the agent's zone", (): void => {
    const markup = renderToStaticMarkup(
      <AgentZoneContext value="Asia/Singapore">
        <ManagerFeedbackNote feedback={{ reason: 'Use template B.', at: AT, kind: 'retry-note' }} />
      </AgentZoneContext>,
    );
    expect(markup).toContain('28 Sep 2026, 00:05:09');
    expect(markup).not.toContain('27 Sep 2026, 16:05:09');
  });
});

describe('the manager line', (): void => {
  it('names the manager and offers the change on the header', (): void => {
    const markup = renderToStaticMarkup(
      <ManagerLine bossEmail="boss@day0.local" onChange={async () => undefined} />,
    );
    expect(markup).toContain('Agent reporting to');
    expect(markup).toContain('boss@day0.local');
    expect(markup).toContain('Change manager');
    expect(markup).not.toContain('could not find this manager');
  });

  it('says a failed manager lookup is the manager, not the credential', (): void => {
    const markup = renderToStaticMarkup(
      <ManagerLine
        bossEmail="left@day0.local"
        lookupFailure="the manager email left@day0.local is not a member of this Slack workspace (users_not_found)."
        onChange={async () => undefined}
      />,
    );
    expect(markup).toContain(
      'could not find this manager: the manager email left@day0.local is not a member of this Slack workspace (users_not_found). The',
    );
    expect(markup).toContain('credential still works; change the manager');
    expect(markup).not.toContain('..');
  });
});

describe('retrying a skipped item', (): void => {
  const skipped = (reason: string): Doc<'workItems'> =>
    ({
      _id: 'w1',
      _creationTime: 1,
      agentId: 'a1',
      state: 'skipped',
      title: 'Reconcile the partner invoice',
      contentSummary: 'A finance ask.',
      sourceSystem: 'linear',
      sourceCategory: 'ticket-queue',
      externalId: 'FIN-3',
      observedAt: 1,
      contentRefs: [],
      verdict: { decision: 'skip', reason },
      skipReason: reason,
    }) as unknown as Doc<'workItems'>;
  const noop = (): void => undefined;
  const resolved = async (): Promise<void> => undefined;
  const render = (row: Doc<'workItems'>): string =>
    renderToStaticMarkup(
      <WorkItemCard
        item={row}
        surfaces={[]}
        autonomousActions={false}
        onApprovePlan={noop}
        onCancelPlan={noop}
        onRetryFailed={noop}
        onReconcileFailed={resolved}
        onApproveActions={resolved}
        onRejectActions={resolved}
        onResendDecision={resolved}
      />,
    );

  it('shows a stopped run as stopped, with the reason and Retry', (): void => {
    const markup = render({
      ...skipped('unused'),
      state: 'failed',
      verdict: undefined,
      skipReason:
        'stopped: 1 of 1 actions did not change the work environment: mcp.call (snapshot timed out)',
    } as unknown as Doc<'workItems'>);
    expect(markup).toContain('>stopped<');
    expect(markup).not.toContain('>failed<');
    expect(markup).toContain(
      'stopped, nothing landed and nothing to decide: 1 of 1 actions did not change',
    );
    expect(markup).toContain('Retry');
  });

  it("shows the 19 Sep run's refused ticket create as the gate's refusal, not as a failure", (): void => {
    const applied = REFUSED_CREATE_RUN.applied.map((row) => ({ ...row }));
    const reason = gateRefusalStop(REFUSED_CREATE_RUN.actions as never, applied as never);
    const markup = render({
      ...skipped('unused'),
      state: 'failed',
      verdict: undefined,
      skipReason: reason,
      output: { draft: '', notes: '', actions: REFUSED_CREATE_RUN.actions, applied },
    } as unknown as Doc<'workItems'>);
    expect(markup).toContain('>stopped<');
    expect(markup).not.toContain('>failed<');
    expect(markup).toContain('1 action refused by Day0&#x27;s gate · never sent');
    expect(markup).not.toContain('did not reach');
    expect(markup).toContain('stopped at a step Day0&#x27;s gate refused');
    expect(markup).not.toContain('nothing landed and nothing to decide');
  });

  it("offers Retry on an out-of-scope skip as the manager's scope decision", (): void => {
    const markup = render(skipped('out-of-scope: no charter or current documented-system overlap'));
    expect(markup).toContain('>Take it anyway<');
    expect(markup).toContain('Take it anyway re-evaluates this item as in scope, on your decision');
    expect(markup).not.toContain('without the quality-fit filter');
  });

  // P3-1 and E-47: the manager who disagrees with a skip no rule waives has a
  // control too; Retry evaluates the item again and says it may be skipped again.
  it('offers Retry on every skip no rule waives, saying the item is evaluated again', (): void => {
    for (const reason of [
      'already-claimed: state=executing',
      'registered skill "update-linear-ticket" was tried and does not cover this item',
      'low-value: 10',
    ]) {
      const markup = render(skipped(reason));
      expect(markup).toMatch(/<button[^>]*class="min-h-11 [^"]*"[^>]*>Retry<\/button>/);
      expect(markup).toContain(SKIP_RETRY_NOTE);
      expect(markup).not.toContain(TAKE_IT_ANYWAY);
    }
  });

  it('names the colleague who holds the item, links to their dashboard and offers no Retry', (): void => {
    const reason = 'claimed-by-colleague: Priya holds it (Slack mention in #ops-requests)';
    const markup = render({
      ...skipped(reason),
      verdict: {
        decision: 'skip',
        reason,
        claimedBy: {
          claimId: 'c1',
          agentId: 'a2',
          workItemId: 'w9',
          name: 'Priya',
          title: 'Slack mention in #ops-requests',
        },
      },
    } as unknown as Doc<'workItems'>);
    expect(markup).toMatch(
      /another employee holds this: <a [^>]*href="\/agent\/a2"[^>]*>Priya<\/a>/,
    );
    expect(markup).not.toContain('claimed-by-colleague:');
    expect(markup).not.toContain('>Retry<');
    // The colleague's card is the control: cancelling there lets the item come back here.
    expect(markup).toContain(
      'To give it to this employee instead, cancel it on Priya&#x27;s card; it comes back here by itself once they let it go.',
    );
  });
});

describe('phone approval delivery', (): void => {
  const parked = (decision: Record<string, unknown>): Doc<'workItems'> =>
    ({
      _id: 'w2',
      _creationTime: 1,
      agentId: 'a1',
      state: 'plan-pending',
      title: 'Close the quarter',
      contentSummary: 'Post the close summary.',
      sourceSystem: 'linear',
      sourceCategory: 'ticket',
      externalId: 'REVOPS-7',
      observedAt: 1,
      contentRefs: [],
      plan: {
        summary: 'Post it.',
        steps: ['Post.'],
        estimatedMinutes: 5,
        reversibility: 'reversible',
      },
      decision: {
        id: 'ab3xyz',
        kind: 'plan',
        channel: 'D0MANAGER',
        surfaceSlug: 'slack',
        surfaceName: 'Slack',
        ...decision,
      },
    }) as unknown as Doc<'workItems'>;
  const noop = (): void => undefined;
  const resolved = async (): Promise<void> => undefined;
  const render = (row: Doc<'workItems'>): string =>
    renderToStaticMarkup(
      <WorkItemCard
        item={row}
        surfaces={[]}
        autonomousActions={false}
        onApprovePlan={noop}
        onCancelPlan={noop}
        onRetryFailed={noop}
        onReconcileFailed={resolved}
        onApproveActions={resolved}
        onRejectActions={resolved}
        onResendDecision={resolved}
      />,
    );

  it('says a request the channel never confirmed was not delivered and offers a resend', (): void => {
    const stale = render(parked({ requestedAt: Date.now() - DECISION_REQUEST_RECOVERY_MS - 1 }));
    expect(stale).toContain('request not delivered');
    expect(stale).toContain('Resend');
    const failed = render(
      parked({
        requestedAt: Date.now(),
        requestFailedAt: Date.now(),
        requestFailure: 'no grant (boss:message)',
      }),
    );
    expect(failed).toContain('request not delivered');
    expect(failed).toContain('no grant (boss:message)');
    expect(failed).toContain('Resend');
  });

  it('stays quiet while a request is in flight, delivered or decided', (): void => {
    for (const decision of [
      { requestedAt: Date.now() },
      { requestedAt: Date.now() - DECISION_REQUEST_RECOVERY_MS - 1, ts: '1787768406.604379' },
      { requestedAt: 1, ts: '1.1', decidedAt: 2, outcome: 'approved', decidedVia: 'channel' },
    ]) {
      const markup = render(parked(decision));
      expect(markup).not.toContain('request not delivered');
      expect(markup).not.toContain('Resend');
    }
  });
});

describe('charter confirm-or-strike list', (): void => {
  const constraints = [
    {
      kind: 'candidate-property' as const,
      quote: "if it's a ticket it has an owner and a priority",
      wording: ['owned, prioritized'],
      origin: 'synthesis' as const,
    },
    {
      kind: 'system-boundary' as const,
      quote: 'Never post to public channels.',
      wording: ['Post to public Slack channels.'],
      origin: 'derived' as const,
      struck: true,
    },
  ];

  it("shows each rule in the manager's words beside the clause phrase, with Strike and Restore before approval", (): void => {
    const markup = renderToStaticMarkup(
      <ConstraintList
        constraints={constraints}
        approved={false}
        onStrike={() => undefined}
        onRestore={() => undefined}
      />,
    );
    expect(markup).toContain('Confirm or strike each one');
    expect(markup).toContain('if it&#x27;s a ticket it has an owner and a priority');
    expect(markup).toContain('owned, prioritized');
    expect(markup).toContain('what work qualifies');
    expect(markup).toContain('found by checking the clauses');
    expect(markup).toContain('>Strike<');
    expect(markup).toContain('>Restore<');
    expect(markup).toContain('line-through');
  });

  it('keeps the list as a record after approval; Strike amends, nothing restores', (): void => {
    const record = renderToStaticMarkup(
      <ConstraintList constraints={constraints} approved={true} />,
    );
    expect(record).toContain('Rules this charter enforces');
    expect(record).toContain('struck');
    expect(record).not.toContain('>Strike<');
    expect(record).not.toContain('>Restore<');
    const amendable = renderToStaticMarkup(
      <ConstraintList constraints={constraints} approved={true} onStrike={() => undefined} />,
    );
    expect(amendable).toContain('>Strike<');
    expect(amendable).not.toContain('>Restore<');
  });

  it('renders nothing for a charter drafted before constraints existed', (): void => {
    expect(renderToStaticMarkup(<ConstraintList constraints={[]} approved={false} />)).toBe('');
  });

  it('names the struck count on the Approve button', (): void => {
    const charter = {
      _id: 'charter-1',
      _creationTime: 1,
      agentId: 'agent-1',
      version: '0.0',
      approved: false,
      createdAt: 1,
      body: {
        whyThisHire: 'Close week.',
        proposedFunction:
          'Own routine revenue operations work from owned, prioritized Linear tickets.',
        shortTermGoals: { day30: 'a', day60: 'b', day90: 'c' },
        proposedBoundaries: { willDo: [], willNotDo: [], escalationTriggers: [] },
        namedCollaborators: [],
        priorityReading: [],
        openQuestions: [],
        constraints,
      },
    } as unknown as Doc<'charters'>;
    const markup = renderToStaticMarkup(<CharterCard charter={charter} />);
    expect(markup).toContain('>Approve, 1 rule struck<');
    const twoStruck = {
      ...charter,
      body: { ...charter.body, constraints: constraints.map((c) => ({ ...c, struck: true })) },
    } as unknown as Doc<'charters'>;
    expect(renderToStaticMarkup(<CharterCard charter={twoStruck} />)).toContain(
      '>Approve, 2 rules struck<',
    );
  });

  it.each([
    ['Strike', 0, false],
    ['Restore', 1, true],
  ] as const)(
    'shows why a %s the backend refused was not recorded, on the card',
    async (label, index, struck): Promise<void> => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      backend.refusals = {
        'charters:setConstraintStruck': `[CONVEX M(charters:setConstraintStruck)] [Request ID: 1] Server Error\nUncaught Error: The charter was approved while this page was open.\n    at handler (../convex/charters.ts:1:1)`,
      };
      const charter = {
        _id: 'charter-1',
        _creationTime: 1,
        agentId: 'agent-1',
        version: '0.0',
        approved: false,
        createdAt: 1,
        body: {
          whyThisHire: 'Close week.',
          proposedFunction:
            'Own routine revenue operations work from owned, prioritized Linear tickets.',
          shortTermGoals: { day30: 'a', day60: 'b', day90: 'c' },
          proposedBoundaries: { willDo: [], willNotDo: [], escalationTriggers: [] },
          namedCollaborators: [],
          priorityReading: [],
          openQuestions: [],
          constraints,
        },
      } as unknown as Doc<'charters'>;
      expect(constraints[index]?.struck === true).toBe(struck);
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      act((): void => root.render(<CharterCard charter={charter} />));

      const button = [...container.querySelectorAll('button')].find(
        (candidate) => candidate.textContent === label && !candidate.disabled,
      );
      expect(button).toBeDefined();
      await act(async (): Promise<void> => {
        button?.click();
      });

      expect(container.textContent).toContain('The charter was approved while this page was open.');
      expect(container.textContent).not.toContain('Request ID');
      act((): void => root.unmount());
      container.remove();
      backend.refusals = {};
    },
  );

  it('says what a strike removes, and disables one the effective charter refuses with the reason', (): void => {
    const markup = renderToStaticMarkup(
      <ConstraintList
        constraints={constraints}
        approved={false}
        onStrike={() => undefined}
        previewStrike={(index) =>
          index === 0
            ? {
                removedClauses: ['Handle owned, prioritized Linear tickets.'],
                rewrittenClauses: [
                  { from: 'Own the close checklist.', to: 'Run the close checklist.' },
                ],
              }
            : { removedClauses: [], rewrittenClauses: [] }
        }
      />,
    );
    expect(markup).toContain('strikes the clause: “Handle owned, prioritized Linear tickets.”');
    expect(markup).toContain(
      'rewrites the clause: “Own the close checklist.” to “Run the close checklist.”',
    );
    expect(markup).not.toContain('disabled=""');

    const refused = renderToStaticMarkup(
      <ConstraintList
        constraints={constraints}
        approved={false}
        onStrike={() => undefined}
        previewStrike={() => ({
          removedClauses: [],
          rewrittenClauses: [],
          refusal: 'strike refused: the only clause that bounds Linear',
        })}
      />,
    );
    expect(refused).toContain(
      'cannot be struck: strike refused: the only clause that bounds Linear',
    );
    expect(refused).toMatch(
      /<button[^>]*disabled=""[^>]*title="strike refused: the only clause that bounds Linear"[^>]*>Strike<\/button>/,
    );

    const plain = renderToStaticMarkup(
      <ConstraintList
        constraints={constraints}
        approved={false}
        onStrike={() => undefined}
        previewStrike={() => ({ removedClauses: [], rewrittenClauses: [] })}
      />,
    );
    expect(plain).not.toContain('strikes the clause');
    expect(plain).not.toContain('cannot be struck');
  });
});

describe('the charter card and the strikes approval can honour', (): void => {
  function draft(body: Charter): Doc<'charters'> {
    return {
      _id: 'charter-3',
      _creationTime: 3,
      agentId: 'agent-1',
      version: '0.0',
      approved: false,
      createdAt: 3,
      body,
    } as unknown as Doc<'charters'>;
  }

  /** The Strike buttons in order, with whether each is disabled. */
  function strikeButtons(markup: string): boolean[] {
    return [...markup.matchAll(/<button([^>]*)>Strike<\/button>/g)].map((match) =>
      match[1]!.includes('disabled=""'),
    );
  }

  it('offers the 15 September strike as the clause it removes, and disables the one strike that was always refused', (): void => {
    const markup = renderToStaticMarkup(<CharterCard charter={draft(strikeRefusalBody(false))} />);
    expect(markup).toContain(
      'strikes the clause: “Take ownership of Northstar CRM-dependent work that Sam must handle.”',
    );
    expect(markup).toContain(
      'cannot be struck: strike or edit the whole will-not-do clause; removing only part could change its boundary',
    );
    expect(strikeButtons(markup)).toEqual([false, true, false]);
  });

  it('refuses up front the strike that would drop the only clause bounding a system', (): void => {
    const body = strikeRefusalBody(false);
    body.proposedBoundaries.willNotDo = [
      'Take ownership of Northstar CRM-dependent work that Sam must handle.',
    ];
    body.proposedBoundaries.escalationTriggers = [];
    const markup = renderToStaticMarkup(<CharterCard charter={draft(body)} />);
    expect(markup).toContain(
      'cannot be struck: strike refused: “Take ownership of Northstar CRM-dependent work that Sam must handle.” is the only clause that bounds Northstar CRM',
    );
    expect(strikeButtons(markup)[2]).toBe(true);
  });

  it('enables exactly the strikes whose toggled charter approval would apply', (): void => {
    const bounded = strikeRefusalBody(false);
    bounded.proposedBoundaries.willNotDo = [
      'Take ownership of Northstar CRM-dependent work that Sam must handle.',
    ];
    bounded.proposedBoundaries.escalationTriggers = [];
    for (const body of [strikeRefusalBody(false), bounded]) {
      const markup = renderToStaticMarkup(<CharterCard charter={draft(body)} />);
      const refusedAtApproval = body.constraints!.map((_, index) => {
        const toggled = {
          ...body,
          constraints: body.constraints!.map((c, i) => (i === index ? { ...c, struck: true } : c)),
        };
        return !strikeOutcome(toggled).ok;
      });
      expect(strikeButtons(markup)).toEqual(refusedAtApproval);
      body.constraints!.forEach((_, index) => {
        expect(strikePreview(body, index).refusal !== undefined).toBe(refusedAtApproval[index]);
      });
    }
  });
});

describe("the synthesiser's notes on the charter card", (): void => {
  const charter = {
    _id: 'charter-3',
    _creationTime: 3,
    agentId: 'agent-1',
    version: '0.0',
    approved: true,
    approvedAt: 3,
    createdAt: 3,
    body: {
      whyThisHire: 'Close week.',
      proposedFunction: 'Own routine revenue operations work from Linear tickets.',
      shortTermGoals: { day30: 'a', day60: 'b', day90: 'c' },
      proposedBoundaries: { willDo: [], willNotDo: [], escalationTriggers: [] },
      namedCollaborators: [],
      priorityReading: [],
      openQuestions: [...OPEN_QUESTIONS_2026_09_16],
      synthesisNotes: [SYNTHESIS_SELF_CHECK_NOTE_2026_09_16],
      constraints: [
        {
          kind: 'system-boundary',
          quote: 'Never post to public channels.',
          wording: ['Post to public Slack channels.'],
          origin: 'synthesis',
        },
      ],
    },
  } as unknown as Doc<'charters'>;

  it('shows each note under the rules and offers no answer box for it', (): void => {
    const markup = renderToStaticMarkup(<CharterCard charter={charter} />);
    const rules = markup.indexOf('Rules this charter enforces');
    const notes = markup.indexOf('Notes from drafting');
    expect(rules).toBeGreaterThan(-1);
    expect(notes).toBeGreaterThan(rules);
    expect(markup.slice(notes)).toContain('Evidence check: 1 clause in this draft');
    const answerBoxes = markup.split('>Answer<').length - 1;
    expect(answerBoxes).toBe(OPEN_QUESTIONS_2026_09_16.length);
  });

  it('files a note an older charter recorded as a question under the notes, not the questions', (): void => {
    const legacy = {
      ...charter,
      body: {
        ...(charter.body as object),
        openQuestions: [...RECORDED_QUESTIONS_2026_09_16],
        synthesisNotes: undefined,
      },
    } as unknown as Doc<'charters'>;
    const markup = renderToStaticMarkup(<CharterCard charter={legacy} />);
    expect(markup.split('>Answer<').length - 1).toBe(OPEN_QUESTIONS_2026_09_16.length);
    expect(markup.slice(markup.indexOf('Notes from drafting'))).toContain(
      'Evidence check: 1 clause',
    );
  });
});

describe('amending an approved charter from the card', (): void => {
  const charter = {
    _id: 'charter-2',
    _creationTime: 2,
    agentId: 'agent-1',
    version: '0.1',
    approved: true,
    approvedAt: 2,
    supersedes: 'charter-1',
    createdAt: 2,
    body: {},
  } as unknown as Doc<'charters'>;
  const body = {
    whyThisHire: 'Close week.',
    proposedFunction: 'Own routine revenue operations work from Linear tickets.',
    shortTermGoals: { day30: 'a', day60: 'b', day90: 'c' },
    proposedBoundaries: {
      willDo: ['Handle Linear tickets in the Q3 close project.'],
      willNotDo: ['Post to public Slack channels.'],
      escalationTriggers: [],
    },
    namedCollaborators: [],
    namedSystems: [{ name: 'Linear', class: 'kanban', whereMentioned: 'Work is in Linear.' }],
    priorityReading: [],
    openQuestions: ['Whether Northstar CRM access will be granted.'],
    answeredQuestions: [
      { question: 'Who owns the Looker tile.', answer: 'Priya.', answeredAt: 'x' },
    ],
  };

  it('offers every typed change: the function, each clause list, the open questions, a rule and the systems', (): void => {
    const markup = renderToStaticMarkup(
      <AmendCharterPanel charter={charter} body={body} busy={false} onAmend={() => undefined} />,
    );
    expect(markup).toContain('next version v0.2');
    expect(markup).toContain('value="Own routine revenue operations work from Linear tickets."');
    expect(markup).toContain('value="Handle Linear tickets in the Q3 close project."');
    expect(markup).toContain('Add to escalation triggers');
    expect(markup).toContain('Whether Northstar CRM access will be granted.');
    expect(markup).toContain('>Answer<');
    expect(markup).toContain('Who owns the Looker tile.');
    expect(markup).toContain('- Priya.');
    expect(markup).toContain('>Add rule<');
    expect(markup).toContain('Linear (kanban)');
    expect(markup).toContain('>Add system<');
    expect(markup).toContain('>Remove<');
  });

  it("offers no approval chain of its own: the manager is the agent row's, changed from the header (U9 D3 (b))", (): void => {
    const panel = renderToStaticMarkup(
      <AmendCharterPanel charter={charter} body={body} busy={false} onAmend={() => undefined} />,
    );
    expect(panel.toLowerCase()).not.toMatch(/approval chain|approver|who approves/);
    const card = renderToStaticMarkup(
      <CharterCard charter={{ ...charter, body }} manager="ana@kestrel.example" />,
    );
    expect(card).toContain('ana@kestrel.example, the manager named in the header; change it there');
  });

  it("says the backend's refusal in the card's live region, with the panel closed or open, and keeps focus on the control", async (): Promise<void> => {
    backend.refusals = {
      'charters:amend': `[CONVEX M(charters:amend)] [Request ID: 1] Server Error\nUncaught Error: the amendment changes nothing\n    at handler (../convex/charters.ts:1:1)`,
    };
    const view = mount(<CharterCard charter={{ ...charter, body }} />);
    await press(view.container, 'Remove: Linear');

    expect(said(view.container)).toEqual(['the amendment changes nothing']);
    expect(focusedName()).toBe('Remove: Linear');
    view.unmount();
    backend.refusals = {};
  });

  it('says the new version once an amendment lands, and empties the field it came from', async (): Promise<void> => {
    const view = mount(<CharterCard charter={{ ...charter, body }} />);
    const field = [...view.container.querySelectorAll<HTMLLabelElement>('label')].find(
      (label) => label.textContent === 'Add to escalation triggers',
    )?.control as HTMLInputElement | null;
    if (!field) throw new Error('no field labelled for the escalation triggers');
    typeInto(field, 'A close figure moves by more than 5 points.');
    const add = [...view.container.querySelectorAll('button')].find(
      (candidate) =>
        candidate.textContent === 'Add' && candidate.parentElement?.contains(field) === true,
    );
    add?.focus();
    await act(async (): Promise<void> => {
      add?.click();
    });
    await settle();

    expect(said(view.container)).toEqual(['Charter amended: version 0.2 is the one in force.']);
    expect(field.value).toBe('');
    expect(document.activeElement).toBe(field);
    view.unmount();
  });

  it('is absent from a charter awaiting approval', (): void => {
    const draft = { ...charter, approved: false, body } as unknown as Doc<'charters'>;
    const markup = renderToStaticMarkup(<CharterCard charter={draft} />);
    expect(markup).not.toContain('Amend this charter');
    expect(markup).toContain('>Approve<');
  });
});

describe('the refused skill draft', (): void => {
  it('shows the refused SKILL.md and smoke test behind a disclosure', (): void => {
    const markup = renderToStaticMarkup(
      <RefusedDraftDetails
        skill={{
          refusedBody: '# Refresh\n## Inputs\n- analytics-surface: the tile',
          refusedSmokeTest: 'def run(inputs: dict) -> dict:\n    return {}',
        }}
      />,
    );
    expect(markup).toContain('<details');
    expect(markup).toContain('Refused draft');
    expect(markup).toContain('SKILL.md');
    expect(markup).toContain('smoke.py');
    expect(markup).toContain('- analytics-surface: the tile');
    expect(markup).toContain('def run(inputs: dict) -&gt; dict:');
    expect(markup).toContain('not registered');
  });

  it('renders nothing for a row that kept no draft', (): void => {
    expect(renderToStaticMarkup(<RefusedDraftDetails skill={{}} />)).toBe('');
    expect(renderToStaticMarkup(<RefusedDraftDetails skill={{ refusedBody: '' }} />)).toBe('');
  });
});

/**
 * Render a panel in a document, have the named backend call refuse with the
 * transport's envelope around a message, click the named button and return the
 * attempts the panel filed.
 */
async function clickAndRecord(
  label: string,
  refusedCall: string,
  message: string,
  panel: (record: (attempt: unknown) => void) => React.ReactNode,
): Promise<unknown[]> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  backend.refusals = {
    [refusedCall]: `[CONVEX A(${refusedCall})] [Request ID: 1] Server Error\nUncaught Error: ${message}\n    at handler (../convex/x.ts:1:1)`,
  };
  const attempts: unknown[] = [];
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    act((): void => root.render(panel((attempt): void => void attempts.push(attempt))));
    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === label,
    );
    expect(button).toBeDefined();
    await act(async (): Promise<void> => {
      button?.click();
    });
    return attempts;
  } finally {
    act((): void => root.unmount());
    container.remove();
    backend.refusals = {};
  }
}

describe('what Retry does to an unregistered skill', (): void => {
  const noop = (): void => undefined;
  const base = {
    _id: 'skill-1',
    _creationTime: 0,
    agentId: 'agent-1',
    name: 'refresh-the-tile',
    description: 'refresh the analytics tile',
    sourceType: 'agent-authored',
    createdAt: 0,
  };
  const parked = {
    ...base,
    state: 'authoring',
    body: '# Refresh the tile\n## Inputs\n- analytics-surface: the tile',
    pendingSmokeTest: 'def run(inputs: dict) -> dict:\n    return {}',
    verificationLog:
      'the verification sandbox was busy with another skill for 5 minutes; ' +
      'the body is kept and Retry runs the smoke test when it is free',
  } as unknown as Doc<'skills'>;
  const refused = {
    ...base,
    _id: 'skill-2',
    state: 'failed',
    body: '',
    verificationLog: 'the authored skill is not a reusable procedure: it repeats one item values',
  } as unknown as Doc<'skills'>;

  function panel(unregistered: Doc<'skills'>[]): string {
    return renderToStaticMarkup(
      <RegisteredSkillsPanel
        skills={[]}
        unregistered={unregistered}
        authoringFailure={null}
        onAuthoringAttempt={noop}
      />,
    );
  }

  it('offers a parked skill the check it is waiting for, not a new authoring call', (): void => {
    const markup = panel([parked]);
    expect(markup).toContain('title="Run the body and smoke test this skill already has');
    expect(markup).not.toContain('Author this skill again');
  });

  it('files a refused Retry as the attempt, in the words written for a person', async (): Promise<void> => {
    const attempts = await clickAndRecord(
      'Retry',
      'skillActions:authorAndRegisterSkill',
      'The sandbox component is not running.',
      (record) => (
        <RegisteredSkillsPanel
          skills={[]}
          unregistered={[refused]}
          authoringFailure={null}
          onAuthoringAttempt={record}
        />
      ),
    );
    expect(attempts).toEqual([
      null,
      {
        skillId: 'skill-2',
        name: 'refresh-the-tile',
        reason: 'The sandbox component is not running.',
      },
    ]);
  });

  it("says a refused Approve in the panel's live region in the words written for a person, and files no authoring attempt", async (): Promise<void> => {
    const proposed = { ...base, state: 'proposed', requiredScopes: [] } as unknown as Doc<'skills'>;
    backend.refusals = {
      'skills:approve': `[CONVEX M(skills:approve)] [Request ID: 1] Server Error\nUncaught Error: cannot approve "refresh-the-tile": it is approved, not proposed\n    at handler (../convex/skills.ts:1:1)`,
    };
    const attempts: unknown[] = [];
    const view = mount(
      <ProposedSkillsPanel
        skills={[proposed]}
        surfaces={[]}
        onAuthoringAttempt={(attempt) => void attempts.push(attempt)}
      />,
    );
    await press(view.container, 'Approve · author and verify');

    expect(said(view.container)).toEqual([
      'cannot approve "refresh-the-tile": it is approved, not proposed',
    ]);
    expect(attempts).toEqual([]);
    expect(focusedName()).toBe('Approve · author and verify');
    view.unmount();
    backend.refusals = {};
  });

  it('says an approval, then files what the authoring it started came to', async (): Promise<void> => {
    const proposed = { ...base, state: 'proposed', requiredScopes: [] } as unknown as Doc<'skills'>;
    backend.results = { 'skillActions:authorAndRegisterSkill': { ok: true } };
    const attempts: unknown[] = [];
    const view = mount(
      <ProposedSkillsPanel
        skills={[proposed]}
        surfaces={[]}
        onAuthoringAttempt={(attempt) => void attempts.push(attempt)}
      />,
    );
    await press(view.container, 'Approve · author and verify');

    expect(said(view.container)).toEqual([
      'Approved refresh-the-tile: the employee is authoring it now, and the Skills card says when it is callable.',
    ]);
    expect(attempts).toEqual([null, { skillId: 'skill-1', name: 'refresh-the-tile' }]);
    view.unmount();
    backend.results = {};
  });

  it('rejects a proposed skill with an outcome said in the panel (the wave 4 Reject ruling)', async (): Promise<void> => {
    const proposed = { ...base, state: 'proposed', requiredScopes: [] } as unknown as Doc<'skills'>;
    backend.refusals = {
      'skills:reject': `[CONVEX M(skills:reject)] [Request ID: 1] Server Error\nUncaught Error: cannot reject "refresh-the-tile": it is registered\n    at handler (../convex/skills.ts:1:1)`,
    };
    const refused = mount(
      <ProposedSkillsPanel skills={[proposed]} surfaces={[]} onAuthoringAttempt={noop} />,
    );
    await press(refused.container, 'Reject refresh-the-tile');
    expect(said(refused.container)).toEqual(['cannot reject "refresh-the-tile": it is registered']);
    expect(focusedName()).toBe('Reject refresh-the-tile');
    refused.unmount();
    backend.refusals = {};

    const rejected = mount(
      <ProposedSkillsPanel skills={[proposed]} surfaces={[]} onAuthoringAttempt={noop} />,
    );
    await press(rejected.container, 'Reject refresh-the-tile');
    expect(said(rejected.container)).toEqual([
      'Rejected refresh-the-tile: the employee will not author it.',
    ]);
    // The row leaves when the query answers; the panel keeps its live region.
    act((): void =>
      rejected.root.render(
        <ProposedSkillsPanel skills={[]} surfaces={[]} onAuthoringAttempt={noop} />,
      ),
    );
    expect(said(rejected.container)).toEqual([
      'Rejected refresh-the-tile: the employee will not author it.',
    ]);
    rejected.unmount();
  });

  it('files a registered Retry as the attempt and gives focus back to Retry once its run lets go', async (): Promise<void> => {
    backend.results = { 'skillActions:authorAndRegisterSkill': { ok: true } };
    const attempts: unknown[] = [];
    const view = mount(
      <RegisteredSkillsPanel
        skills={[]}
        unregistered={[refused]}
        authoringFailure={null}
        onAuthoringAttempt={(attempt) => void attempts.push(attempt)}
      />,
    );
    await press(view.container, 'Retry refresh-the-tile');
    expect(attempts).toEqual([null, { skillId: 'skill-2', name: 'refresh-the-tile' }]);
    expect(focusedName()).toBe('Retry refresh-the-tile');
    view.unmount();
    backend.results = {};
  });

  it('gives focus to the Skills card when a registered Retry takes its row out of the list', async (): Promise<void> => {
    backend.results = { 'skillActions:authorAndRegisterSkill': { ok: true } };
    const panel = (rows: Doc<'skills'>[]) => (
      <RegisteredSkillsPanel
        skills={[]}
        unregistered={rows}
        authoringFailure={null}
        onAuthoringAttempt={noop}
        focusRef={{ current: null }}
      />
    );
    const view = mount(panel([refused]));
    const retry = button(view.container, 'Retry refresh-the-tile');
    retry.focus();
    await act(async (): Promise<void> => {
      retry.click();
      // The row registers and leaves the list before the run's promise settles.
      view.root.render(panel([]));
    });
    await settle();
    expect(focusedName()).toBe('Skills · 0 registered');
    view.unmount();
    backend.results = {};
  });

  it('says a registration and an authoring failure in the Skills card live region, and gives each control a 44 px target', (): void => {
    const done = renderToStaticMarkup(
      <RegisteredSkillsPanel
        skills={[]}
        unregistered={[refused]}
        authoringFailure={null}
        registered="refresh-the-tile"
        onAuthoringAttempt={noop}
      />,
    );
    expect(done).toMatch(
      /<div role="status" aria-live="polite" aria-atomic="true"><p[^>]*>refresh-the-tile is registered: it passed the check and is callable\.<\/p><\/div>/,
    );
    expect(done).toMatch(/<button[^>]*class="min-h-11 [^"]*"[^>]*>Retry<\/button>/);
    const failed = renderToStaticMarkup(
      <RegisteredSkillsPanel
        skills={[]}
        unregistered={[]}
        authoringFailure="refresh-the-tile: the sandbox component is not running"
        onAuthoringAttempt={noop}
      />,
    );
    expect(failed).toMatch(/<div role="status"[^>]*><p[^>]*>Authoring did not finish: /);
  });

  it('offers a refused skill a fresh authoring call', (): void => {
    const markup = panel([refused]);
    expect(markup).toContain('title="Author this skill again, with the reason it stopped');
    expect(markup).not.toContain('already has');
  });

  it('authors again for a row whose run stopped before a smoke test was saved', (): void => {
    const interrupted = { ...parked, pendingSmokeTest: undefined } as unknown as Doc<'skills'>;
    expect(panel([interrupted])).toContain('title="Author this skill again');
    expect(retryVerifiesSavedDraft(parked)).toBe(true);
    expect(retryVerifiesSavedDraft(interrupted)).toBe(false);
    expect(retryVerifiesSavedDraft(refused)).toBe(false);
  });

  it('states both cases in the help text, keeping the sandbox and one-run-at-a-time rules', (): void => {
    const markup = panel([parked, refused]);
    expect(markup).not.toContain('Retry re-authors the skill');
    expect(markup).toContain('is checked again as it stands, with no second authoring call');
    expect(markup).toContain('is authored again, with the reason fed back');
    expect(markup).toContain('pnpm sandbox:up');
    expect(markup).toContain('DAYTONA_API_KEY');
    expect(markup).toContain('Only one authoring run holds a skill at a time');
  });

  // Rehearsal 1, 0:29: a traceback's caret line has no break opportunity, so
  // the column kept its full width and pushed Retry past the card's edge.
  it('lets the text column shrink beside Retry and wraps a log with no spaces, so Retry stays in the card', (): void => {
    const carets = '^'.repeat(56);
    const traceback = {
      ...refused,
      verificationLog: `verification in the local sandbox failed - smoke test exited 1. stderr: ${carets} AssertionError`,
    } as unknown as Doc<'skills'>;
    const markup = panel([traceback]);
    expect(markup).toMatch(
      /<div class="flex-1 min-w-0"><div class="font-medium[^"]*">refresh-the-tile</,
    );
    expect(markup).toMatch(
      new RegExp(
        `<div class="[^"]*\\bbreak-words\\b[^"]*">verification in the local sandbox failed[^<]*\\^{56}`,
      ),
    );
  });

  it('says Revise is the one that always authors again', (): void => {
    const registered = {
      ...base,
      state: 'registered',
      body: '# Refresh',
    } as unknown as Doc<'skills'>;
    const markup = renderToStaticMarkup(
      <RegisteredSkillsPanel
        skills={[registered]}
        unregistered={[]}
        authoringFailure={null}
        onAuthoringAttempt={noop}
      />,
    );
    expect(markup).toContain('title="Discard this body and author the skill again');
    expect(markup).toContain('>Revise<');
  });

  // The manager approves a skill before its body exists, so the skill's own
  // row is the first place its inputs can be shown, and it has to say which of
  // them the author never declared.
  describe('the inputs a skill declares, and which of them the system declared for its author', (): void => {
    const authored = declareUndeclaredInputs(
      [
        '# Close',
        '',
        '## Inputs',
        '',
        '- `<record-id>`: the ticket.',
        '',
        '## Procedure',
        '',
        'Set `<record-id>` to `<closing-state>`.',
      ].join('\n'),
    ).body;

    it('lists them on a registered skill and marks the one Day0 added, saying so', (): void => {
      const registered = {
        ...base,
        state: 'registered',
        body: authored,
      } as unknown as Doc<'skills'>;
      const markup = renderToStaticMarkup(
        <RegisteredSkillsPanel
          skills={[registered]}
          unregistered={[]}
          authoringFailure={null}
          onAuthoringAttempt={noop}
        />,
      );
      expect(markup).toMatch(/>inputs<\/span>[^&]*<code[^>]*>&lt;record-id&gt;<\/code>/);
      expect(markup).toMatch(/<code[^>]*>&lt;closing-state&gt;<\/code> \(added by Day0\)/);
      // A placeholder never wraps inside its own name.
      expect(markup).toMatch(
        /<code class="[^"]*\bwhitespace-nowrap\b[^"]*">&lt;record-id&gt;<\/code>/,
      );
      expect(markup).toContain(
        'The author used the input marked &quot;added by Day0&quot; without declaring it',
      );
      expect(markup).toContain(
        'the executor reads it from the candidate or its runbook at run time',
      );
    });

    it('says nothing was added when the author declared everything, and nothing at all for a builtin', (): void => {
      const complete = {
        ...base,
        state: 'registered',
        body: '# Close\n\n## Inputs\n\n- `<record-id>`: the ticket.\n',
      } as unknown as Doc<'skills'>;
      const builtin = {
        ...complete,
        _id: 'skill-3',
        sourceType: 'builtin',
        body: '# See docs',
      } as unknown as Doc<'skills'>;
      const markup = renderToStaticMarkup(
        <RegisteredSkillsPanel
          skills={[complete, builtin]}
          unregistered={[]}
          authoringFailure={null}
          onAuthoringAttempt={noop}
        />,
      );
      expect(markup).toContain('&lt;record-id&gt;');
      expect(markup).not.toContain('added by Day0');
      expect(markup.match(/>inputs</g)).toHaveLength(1);
    });

    it('lists them on a failed attempt too, read from the draft the row kept', (): void => {
      const failed = { ...refused, body: '', refusedBody: authored } as unknown as Doc<'skills'>;
      expect(panel([failed])).toMatch(/<code[^>]*>&lt;closing-state&gt;<\/code> \(added by Day0\)/);
    });
  });

  // Demo rehearsal 2, 19 Sep 2026, finding 1: a skill registered before
  // `<reply-surface>` was taught still runs, because the executor binds the
  // input for it in real mode; the inputs line says so.
  describe('the reply surface on the inputs line', (): void => {
    const before = [
      '# Close',
      '',
      '## Inputs',
      '',
      '- `<record-id>`: the ticket.',
      '- `<reply-channel>` and `<reply-thread>`: the Reply target line.',
      '',
      '## Procedure',
      '',
      'Comment on `<record-id>`, then reply to `<reply-channel>` in `<reply-thread>`.',
    ].join('\n');
    const taught = before.replace(
      '## Procedure',
      '- `<reply-surface>`: the chat surface.\n\n## Procedure',
    );
    const render = (body: string, surfaceMode?: 'mock' | 'real'): string =>
      renderToStaticMarkup(
        <RegisteredSkillsPanel
          skills={[{ ...base, state: 'registered', body } as unknown as Doc<'skills'>]}
          unregistered={[]}
          authoringFailure={null}
          onAuthoringAttempt={noop}
          surfaceMode={surfaceMode}
        />,
      );

    it('lists the input Day0 binds for a skill registered before it was taught, in real mode', (): void => {
      const markup = render(before, 'real');
      expect(markup).toMatch(
        /<code class="[^"]*\bwhitespace-nowrap\b[^"]*">&lt;reply-surface&gt;<\/code> \(bound by Day0\)/,
      );
      expect(markup).toContain(
        'This skill was registered before Day0 taught the input marked &quot;bound by Day0&quot;: the executor binds it from the Reply target, so the reply goes to the chat surface the ask came from.',
      );
    });

    it('says nothing of the kind on a failed attempt, which was never registered and is authored again on Retry', (): void => {
      const failed = { ...refused, body: '', refusedBody: before } as unknown as Doc<'skills'>;
      const markup = renderToStaticMarkup(
        <RegisteredSkillsPanel
          skills={[]}
          unregistered={[failed]}
          authoringFailure={null}
          onAuthoringAttempt={noop}
          surfaceMode="real"
        />,
      );
      expect(markup).toContain('&lt;reply-channel&gt;');
      expect(markup).not.toContain('bound by Day0');
    });

    it('lists it as the author declared it once taught, and adds nothing in mock mode', (): void => {
      expect(render(taught, 'real')).toContain('&lt;reply-surface&gt;');
      expect(render(taught, 'real')).not.toContain('bound by Day0');
      expect(render(before, 'mock')).not.toContain('reply-surface');
      expect(render(before)).not.toContain('reply-surface');
    });
  });

  // The author's open item 3: a traceback rendered as one run of text cannot be read on camera.
  describe('a verification log with line breaks', (): void => {
    const log = [
      'verification in the local sandbox (local:1f2e) failed - smoke test exited 1',
      '',
      'stderr:',
      'smoke harness: run() raised KeyError on case 2',
      '  File "authored_smoke.py", line 8, in run',
      "KeyError: 'closing-state'",
    ].join('\n');

    it('keeps its line breaks, in a box bounded in height that scrolls, still wrapping a line with no spaces', (): void => {
      const markup = panel([{ ...refused, verificationLog: log } as unknown as Doc<'skills'>]);
      const block =
        /<div tabindex="0" role="region" aria-label="Verification log: refresh-the-tile" class="([^"]*)" data-skill-log="multiline">([^<]*)<\/div>/.exec(
          markup,
        );
      // A scroll box is reachable from the keyboard and named, as axe's
      // scrollable-region-focusable asks (X2's siblings).
      expect(block).not.toBeNull();
      const classes = block![1]!.split(' ');
      expect(classes).toEqual(
        expect.arrayContaining([
          'whitespace-pre-wrap',
          'break-words',
          'max-h-40',
          'overflow-y-auto',
          'font-mono',
        ]),
      );
      expect(block![2]).toContain(
        'failed - smoke test exited 1\n\nstderr:\nsmoke harness: run() raised KeyError on case 2\n  File',
      );
    });

    it('leaves a one-line reason as the prose it was', (): void => {
      const markup = panel([refused]);
      expect(markup).not.toContain('data-skill-log="multiline"');
      expect(markup).toMatch(
        /<div class="[^"]*\bbreak-words\b[^"]*">the authored skill is not a reusable procedure/,
      );
    });
  });
});

describe('the card agrees with the server (P6-6)', (): void => {
  const dmAction = {
    tool: 'http.request',
    args: {
      surface: 'slack',
      method: 'POST',
      path: '/chat.postMessage',
      body: '{"channel":"D0MANAGER","text":"Started."}',
    },
  };

  /**
   * One work item as the card receives it.
   *
   * Args:
   *   fields: The fields this case sets over a failed Linear item.
   *
   * Returns:
   *   The row.
   */
  function row(fields: Record<string, unknown>): Doc<'workItems'> {
    return {
      _id: 'w1',
      _creationTime: 1,
      agentId: 'a1',
      state: 'failed',
      title: 'Close REVOPS-5',
      contentSummary: 'Add the audit note and close the ticket.',
      sourceSystem: 'linear',
      sourceCategory: 'ticket-queue',
      externalId: 'REVOPS-5',
      observedAt: 1,
      contentRefs: [],
      ...fields,
    } as unknown as Doc<'workItems'>;
  }

  /** The card's markup for one row. */
  function card(item: Doc<'workItems'>): string {
    return renderToStaticMarkup(
      <WorkItemCard
        item={item}
        surfaces={[]}
        autonomousActions={false}
        onApprovePlan={(): void => undefined}
        onCancelPlan={(): void => undefined}
        onRetryFailed={(): void => undefined}
        onReconcileFailed={async (): Promise<void> => undefined}
        onApproveActions={async (): Promise<void> => undefined}
        onRejectActions={async (): Promise<void> => undefined}
        onResendDecision={async (): Promise<void> => undefined}
      />,
    );
  }

  it('lists a deferred row with the rows that wait on the manager, as the roster counts it', (): void => {
    const order = sortedForQueue([
      { state: 'completed' },
      { state: 'skipped' },
      { state: 'discovered' },
      { state: 'deferred' },
      { state: 'needs-skill' },
    ]).map((item) => item.state);
    expect(order).toEqual(['needs-skill', 'deferred', 'discovered', 'completed', 'skipped']);
  });

  it('names the scope an awaiting-permission deferral is waiting for', (): void => {
    const markup = card(
      row({
        state: 'deferred',
        verdict: {
          decision: 'defer',
          reason: 'awaiting-permission',
          missingPermissions: ['linear:write', 'slack:write'],
        },
      }),
    );
    expect(markup).toContain('awaiting-permission: needs linear:write, slack:write');
  });

  it('keeps a row whose outcome is unknown out of the did-not-reach list', (): void => {
    const markup = card(
      row({
        output: {
          draft: '',
          notes: '',
          applied: [
            {
              tool: 'mcp.call',
              ok: false,
              outcomeUnknown: true,
              reason: 'the provider connection closed after the request was sent',
            },
          ],
        },
      }),
    );
    expect(markup).not.toContain('did not reach');
    expect(markup).toContain('1 action with an unknown outcome');
  });

  it('never tells a stop that landed a write it landed nothing', (): void => {
    const stopped = {
      skipReason: 'stopped: the ticket was already closed',
      output: {
        draft: '',
        notes: '',
        actions: [dmAction],
        applied: [{ tool: 'http.request', ok: true, effect: 'Sent the manager a DM' }],
      },
    };
    const reason = failedItemReason(stopped);
    expect(reason).not.toContain('nothing landed');
    expect(reason).toContain('confirm the provider below before Retry');
    expect(failedItemReason({ ...stopped, providerReconciliation: { confirmedAt: 1 } })).toContain(
      'a write landed before it stopped',
    );
    expect(failedItemReason({ skipReason: 'stopped: the ticket was already closed' })).toContain(
      'stopped, nothing landed and nothing to decide',
    );
  });

  it('says a closing-gate stop waits for reconciliation before Retry resumes there', (): void => {
    const reason = failedItemReason({
      skipReason: 'stopped: the closing gate refused the close',
      output: {
        refusedClosing: { actions: [] },
        initial: {
          actions: [dmAction],
          applied: [{ tool: 'http.request', ok: true, effect: 'Sent the manager a DM' }],
        },
      },
    });
    expect(reason).toContain('confirm them below and Retry resumes there');
  });

  it('offers Retry on an item cancelled before it had a plan, as the server accepts', (): void => {
    const markup = card(
      row({
        state: 'cancelled',
        verdict: { decision: 'needs-skill', suggestedSkillName: 'linear-close' },
        skipReason: 'skill proposal "linear-close" rejected by the manager',
      }),
    );
    expect(markup).toContain('>Retry</button>');
    expect(markup).toContain('Retry evaluates this item again from the start');
  });
});

describe('what an outage leaves on the card (P7-18)', (): void => {
  it('offers to ask on the chat surface for a parked row that was never asked', (): void => {
    const item = {
      _id: 'w1',
      _creationTime: 1,
      agentId: 'a1',
      state: 'plan-pending',
      title: 'Close REVOPS-5',
      contentSummary: 'Add the audit note and close the ticket.',
      sourceSystem: 'linear',
      sourceCategory: 'ticket-queue',
      externalId: 'REVOPS-5',
      observedAt: 1,
      contentRefs: [],
    } as unknown as Doc<'workItems'>;
    const slack = {
      slug: 'slack',
      displayName: 'Slack',
      class: 'chat',
      verdict: 'connected',
      credentialLanded: true,
      lastVerifiedAt: Date.now(),
      managerDmChannelId: 'D0MANAGER',
      managerUserId: 'UMANAGER',
    } as unknown as SurfaceRecord;
    const render = (surfaces: SurfaceRecord[]): string =>
      renderToStaticMarkup(
        <WorkItemCard
          item={item}
          surfaces={surfaces}
          autonomousActions={false}
          onApprovePlan={(): void => undefined}
          onCancelPlan={(): void => undefined}
          onRetryFailed={(): void => undefined}
          onReconcileFailed={async (): Promise<void> => undefined}
          onApproveActions={async (): Promise<void> => undefined}
          onRejectActions={async (): Promise<void> => undefined}
          onResendDecision={async (): Promise<void> => undefined}
        />,
      );
    expect(render([slack])).toContain('not asked on Slack yet');
    expect(render([slack])).toContain('Ask on Slack');
    expect(render([])).not.toContain('Ask on');
  });
});

describe('dashboard decisions on the supervision card (P6-9)', (): void => {
  const metrics = dashboardMetrics;

  it('counts decisions made on the dashboard when nothing was asked on a chat surface', (): void => {
    const markup = renderToStaticMarkup(<MetricsCard metrics={metrics()} />);
    expect(markup).toContain('2 / 1');
    expect(markup).toContain('3 / 0');
    expect(markup).toContain('0 asked on a chat surface');
    // Only the revocation row has no evidence yet.
    expect(markup.match(/not yet/g)).toHaveLength(1);
  });

  it('counts writes as automatic changes, with the reads and the manager message on their own line, and shows the pilot figures (U12 D4, N11)', (): void => {
    const recorded = {
      ...metrics(),
      actions: {
        ...metrics().actions,
        autoApplied: 25,
        automatic: { reads: 12, managerMessages: 1, writes: 12 },
      },
      pilot: {
        ...metrics().pilot,
        hoursSaved: { estimatedItems: 2, hours: 1.25 },
      },
    } as AgentMetrics;
    const markup = renderToStaticMarkup(<MetricsCard metrics={recorded} />).replace(/\s+/g, ' ');
    expect(markup).toContain('12 automatic changes');
    expect(markup).not.toContain('25 actions automatic');
    expect(markup).toContain('Also applied on their own: 12 reads, 1 manager message.');
    // A heading above the list, not a row inside it: a dl holds only dt and dd groups.
    expect(markup).toMatch(/<h3[^>]*>Pilot figures<\/h3><dl/);
    expect(markup).toContain('1 of 3 (33%)');
    expect(markup).toContain('2 min / 3 min (2 done)');
    expect(markup).toContain('1 of 1 answer');
    expect(markup).toMatch(/hours saved<span[^>]*>your estimates, internal gauge<\/span>/);
    expect(markup).toContain('1.3 h over 2 items');
    expect(markup).toContain('not measured yet');
  });
});

describe('the charter card carries what step 4 stored (U18 carried members)', (): void => {
  const baseBody = {
    whyThisHire: 'Close week.',
    proposedFunction: 'Own routine revenue operations work.',
    shortTermGoals: { day30: 'a', day60: 'b', day90: 'c' },
    proposedBoundaries: { willDo: [], willNotDo: [], escalationTriggers: [] },
    namedCollaborators: [],
    priorityReading: [],
    openQuestions: [],
  };

  it('shows the adjacent roles the scope check reads, which the manager could not see', (): void => {
    const charter = {
      _id: 'charter-1',
      _creationTime: 1,
      agentId: 'agent-1',
      version: '1.0',
      approved: true,
      createdAt: 1,
      body: {
        ...baseBody,
        adjacentRoles: [{ who: 'Finance ops', staysOutOfTheirLaneBy: 'never touching invoices' }],
      },
    } as unknown as Doc<'charters'>;
    const markup = renderToStaticMarkup(<CharterCard charter={charter} />);
    expect(markup).toContain('Adjacent roles');
    expect(markup).toContain('Finance ops - never touching invoices');
  });

  it("says a rule no clause carries is not verified, and marks derived wording as the charter's", (): void => {
    const markup = renderToStaticMarkup(
      <ConstraintList
        approved={true}
        constraints={[
          {
            kind: 'candidate-property',
            quote: 'Only owned tickets.',
            wording: [],
            origin: 'synthesis',
          },
          {
            kind: 'system-boundary',
            quote: 'Post to public Slack channels.',
            wording: ['Post to public Slack channels.'],
            origin: 'derived',
          },
        ]}
      />,
    );
    expect(markup).toContain(
      'not verified: no clause carries these words, so striking it changes nothing',
    );
    expect(markup).not.toContain('no clause carries it<');
    expect(markup).toContain('the charter&#x27;s wording, not a sentence of yours');
    expect(markup).not.toContain('&ldquo;Post to public Slack channels.&rdquo;');
    expect(markup).not.toContain('\u201cPost to public Slack channels.\u201d');
  });

  it('names the charter clause a closing step was decided under', (): void => {
    const markup = renderToStaticMarkup(
      <PlanExecutionLedger
        outcomes={[
          {
            step: 2,
            status: 'blocked',
            evidence: 'The close was withheld.',
            charterClause: {
              field: 'willNotDo',
              text: 'Close a ticket without an audit comment.',
              charterVersion: '1.2',
            },
          },
        ]}
      />,
    );
    expect(markup).toContain('under the charter clause');
    expect(markup).toContain('Close a ticket without an audit comment.');
    expect(markup).toContain('(will not do, charter v1.2)');
  });

  it('puts a prohibition under will-not-do by default, and anything else under will-do', (): void => {
    expect(defaultRuleClause('')).toBe('willNotDo');
    expect(defaultRuleClause('Never close a ticket on a Friday.')).toBe('willNotDo');
    expect(defaultRuleClause("Don't post in #general.")).toBe('willNotDo');
    expect(defaultRuleClause('No refunds over 500.')).toBe('willNotDo');
    expect(defaultRuleClause('Only tickets with an owner.')).toBe('willDo');
  });

  it('says a row parked on the charter waits for its approval', (): void => {
    const markup = renderToStaticMarkup(
      <WorkItemCard
        item={
          {
            _id: 'w1',
            _creationTime: 1,
            agentId: 'a1',
            state: 'deferred',
            title: 'Close REVOPS-5',
            contentSummary: 'Close it.',
            sourceSystem: 'linear',
            sourceCategory: 'ticket-queue',
            externalId: 'REVOPS-5',
            observedAt: 1,
            contentRefs: [],
            verdict: { decision: 'defer', reason: 'awaiting-charter', missingPermissions: [] },
          } as unknown as Doc<'workItems'>
        }
        surfaces={[]}
        autonomousActions={false}
        onApprovePlan={(): void => undefined}
        onCancelPlan={(): void => undefined}
        onRetryFailed={(): void => undefined}
        onReconcileFailed={async (): Promise<void> => undefined}
        onApproveActions={async (): Promise<void> => undefined}
        onRejectActions={async (): Promise<void> => undefined}
        onResendDecision={async (): Promise<void> => undefined}
      />,
    );
    expect(markup).toContain('waiting for you to approve the charter');
  });
});

describe("the loop's card states (U3 D5, E-70 D3, S D3)", (): void => {
  const AT = Date.UTC(2026, 8, 27, 16, 5, 9);
  const waiting = (fields: Record<string, unknown>): Doc<'workItems'> =>
    ({
      _id: 'w-wait',
      _creationTime: 1,
      agentId: 'a1',
      state: 'discovered',
      title: 'Reconcile the Q3 pipeline',
      contentSummary: 'Pipeline hygiene.',
      sourceSystem: 'linear',
      sourceCategory: 'ticket-queue',
      externalId: 'REVOPS-30',
      observedAt: 1,
      contentRefs: [],
      ...fields,
    }) as unknown as Doc<'workItems'>;
  const render = (item: Doc<'workItems'>, servedByLoop = true): string =>
    renderToStaticMarkup(
      <AgentZoneContext value="Asia/Singapore">
        <WorkItemCard
          item={item}
          surfaces={[]}
          autonomousActions={false}
          onApprovePlan={(): void => undefined}
          onCancelPlan={(): void => undefined}
          onRetryFailed={(): void => undefined}
          onReconcileFailed={async (): Promise<void> => undefined}
          onApproveActions={async (): Promise<void> => undefined}
          onRejectActions={async (): Promise<void> => undefined}
          onResendDecision={async (): Promise<void> => undefined}
          servedByLoop={servedByLoop}
        />
      </AgentZoneContext>,
    );

  it('says a row with no verdict is waiting for a free slot, in real mode only', (): void => {
    expect(render(waiting({}))).toContain(
      'Waiting for a free slot: Day0 evaluates the most urgent item first, then the oldest, as work finishes.',
    );
    expect(render(waiting({}), false)).not.toContain('Waiting for a free slot');
  });

  it('reads a row Retry sent back as waiting for a free slot, not by the verdict it carried before', (): void => {
    const markup = render(
      waiting({
        verdict: {
          decision: 'defer',
          reason: 'evaluation-attempts-spent',
          attempts: 3,
          missingPermissions: [],
        },
      }),
    );
    expect(markup).toContain('Waiting for a free slot');
    expect(markup).not.toContain('evaluation-attempts-spent');
    expect(
      waitingLine(
        {
          state: 'discovered',
          verdict: { decision: 'queue', reason: 'WIP cap reached' },
        } as Doc<'workItems'>,
        undefined,
      ),
    ).toBeUndefined();
  });

  it("gives the parked row's time in the employee's day and the cause the row keeps, with no event in the feed (K D2 (b))", (): void => {
    const markup = render(
      waiting({
        evaluationClaimedAt: AT - 1_000,
        evaluationUnavailableAt: AT,
        evaluationUnavailableCause: 'timeout after 60 s',
        evaluationAttempts: 1,
      }),
    );
    expect(markup).toContain(
      'Waiting: the scope check could not reach the model at 28 Sep 2026, 00:05 (timeout after 60 s). Day0 tries again after ten minutes; nothing runs until it answers.',
    );
    expect(markup).not.toContain('>Retry<');
  });

  it('says when a running evaluation started and which attempt it is', (): void => {
    expect(
      waitingLine(
        { state: 'discovered', evaluationClaimedAt: AT, evaluationAttempts: 2 } as Doc<'workItems'>,
        'Asia/Singapore',
      ),
    ).toBe(
      'Evaluation started 28 Sep 2026, 00:05, attempt 2 of 3; if it does not answer, the item waits for the next free slot.',
    );
  });

  it('parks a row its evaluations kept failing with Retry as the way out', (): void => {
    const markup = render(
      waiting({
        state: 'deferred',
        evaluationAttempts: 3,
        verdict: {
          decision: 'defer',
          reason: 'evaluation-attempts-spent',
          attempts: 3,
          missingPermissions: [],
        },
      }),
    );
    expect(markup).toContain(
      'Parked: 3 evaluations of this item stopped without a verdict, so it no longer takes a slot. Retry sends it back to be evaluated.',
    );
    expect(markup).toMatch(/>Retry<\/button>/);
    expect(markup).not.toContain('evaluation-attempts-spent');
  });

  it('points a row parked on an unreachable model at Check for new work, with no Retry', (): void => {
    const markup = render(
      waiting({
        state: 'deferred',
        evaluationUnavailableAt: AT,
        evaluationUnavailableCause: 'HTTP 503',
        verdict: {
          decision: 'defer',
          reason: 'scope-judgement-unavailable',
          attempts: 3,
          missingPermissions: [],
        },
      }),
    );
    expect(markup).toContain(
      'Waiting: the scope check could not reach the model at 28 Sep 2026, 00:05 (HTTP 503), 3 times. Check for new work asks it again; nothing runs until it answers.',
    );
    expect(markup).not.toMatch(/>Retry<\/button>/);
  });

  it("lists the waiting rows in the loop's order: unattempted, then the most urgent, then the oldest", (): void => {
    const order = sortedForQueue([
      { state: 'discovered', title: 'new-low', _creationTime: 9, priority: 'Low' },
      { state: 'plan-pending', title: 'plan', _creationTime: 1 },
      {
        state: 'discovered',
        title: 'died-urgent',
        _creationTime: 1,
        priority: 'Urgent',
        evaluationAttempts: 1,
      },
      { state: 'discovered', title: 'new-urgent', _creationTime: 8, priority: 'Urgent' },
      { state: 'discovered', title: 'old-urgent', _creationTime: 2, priority: 'Urgent' },
      { state: 'discovered', title: 'old-low', _creationTime: 3, priority: 'Low' },
    ]).map((item) => item.title);
    expect(order).toEqual([
      'plan',
      'old-urgent',
      'new-urgent',
      'old-low',
      'new-low',
      'died-urgent',
    ]);
  });

  it("says boss:message is the manager channel's own scope and what revoking it does", (): void => {
    const markup = renderToStaticMarkup(<PermissionsCard agentId={'a1' as Id<'agents'>} />).replace(
      /&#x27;/g,
      "'",
    );
    expect(markup).toContain(
      "boss:message is the manager channel's own scope: revoking it makes the channel one-way, so Day0 stops messaging you there and decisions wait on this dashboard, and new work waits until you grant it again.",
    );
  });
});

describe('a stop with a question open that is not the question stop (wave 1.5 m1, O1)', (): void => {
  const open = { openQuestion: { question: 'Which template?', steps: [2] } };

  it('reads the re-read before the first write as the re-read, and says a note does not answer the question', (): void => {
    const stop = ticketRereadStopReason(
      withheldBeforeFirstWrite('REVOPS-5', 'the assignee is now Ana'),
      [],
    );
    expect(stop.startsWith(TICKET_REREAD_STOP)).toBe(true);
    expect(failedItemReason({ skipReason: `stopped: ${stop}`, output: open })).toBe(
      `stopped before its question could be answered, and a note does not answer it on this stop; retry once the ticket is back, then answer the question when it is asked again: ${stop}`,
    );
  });

  it('says the same of any other stop, without the ticket', (): void => {
    expect(
      failedItemReason({
        skipReason: 'stopped: the model call failed after 5 attempts',
        output: { initial: open },
      }),
    ).toBe(
      'stopped before its question could be answered, and a note does not answer it on this stop; retry, then answer the question when it is asked again: the model call failed after 5 attempts',
    );
  });
});

describe("the plan card's minutes field (N11)", (): void => {
  it('asks for the manual estimate beside the approval, optional and labelled', (): void => {
    const markup = renderToStaticMarkup(
      <PlanApprovalForm
        riskNotes=""
        questions={[]}
        onApprove={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(markup).toMatch(/<label for="[^"]+">This would have taken me about<\/label>/);
    expect(markup).toContain('type="number"');
    expect(markup).toContain('>minutes</span>');
    expect(markup).toContain(
      'Optional. Summed over finished work as hours saved, a gauge for you, never a headline.',
    );
  });

  it('sends the minutes with the approval only when given, and reads the field as the server does', (): void => {
    const workItemId = 'w1' as Id<'workItems'>;
    expect(planApprovalRequest(workItemId, { answers: [], manualEstimateMinutes: 45 })).toEqual({
      workItemId,
      manualEstimateMinutes: 45,
    });
    expect(planApprovalRequest(workItemId, { answers: [] })).toEqual({ workItemId });
    expect(typedEstimateMinutes('')).toBeUndefined();
    expect(typedEstimateMinutes(' 45 ')).toBe(45);
    expect(typedEstimateMinutes('0')).toBeNull();
    expect(typedEstimateMinutes('1.5')).toBeNull();
    expect(typedEstimateMinutes('-3')).toBeNull();
  });
});

describe('the live feed names the item an event is about', (): void => {
  it("reads the item's title from the queue, and nothing for an event about no listed item", (): void => {
    const titles = new Map([['w1', 'Close REVOPS-5']]);
    expect(eventItemTitle({ payload: { workItemId: 'w1' } }, titles)).toBe('Close REVOPS-5');
    expect(eventItemTitle({ payload: { workItemId: 'w9' } }, titles)).toBeUndefined();
    expect(eventItemTitle({ payload: { surfaceId: 's1' } }, titles)).toBeUndefined();
    expect(eventItemTitle({ payload: null }, titles)).toBeUndefined();
  });
});

describe('a plan drafted without its ticket (P7-18)', (): void => {
  it('says so on the card, as the manager DM does', (): void => {
    const row = {
      _id: 'w1',
      _creationTime: 1,
      agentId: 'a1',
      state: 'plan-pending',
      title: 'Close REVOPS-5',
      contentSummary: 'Close the month.',
      sourceSystem: 'linear',
      sourceCategory: 'ticket-queue',
      externalId: 'REVOPS-5',
      observedAt: 1,
      contentRefs: [],
      plan: {
        summary: 'Close the month.',
        steps: ['Comment the figures.'],
        estimatedMinutes: 5,
        reversibility: 'reversible',
        riskNotes: '',
      },
      planDraftedWithout: { surfaceSlug: 'linear', subject: 'record', cause: 'not-connected' },
    } as unknown as Doc<'workItems'>;
    const markup = renderToStaticMarkup(
      <WorkItemCard
        item={row}
        surfaces={[{ slug: 'linear', displayName: 'Linear' } as SurfaceRecord]}
        autonomousActions={false}
        onApprovePlan={(): void => undefined}
        onCancelPlan={(): void => undefined}
        onRetryFailed={(): void => undefined}
        onReconcileFailed={async (): Promise<void> => undefined}
        onApproveActions={async (): Promise<void> => undefined}
        onRejectActions={async (): Promise<void> => undefined}
        onResendDecision={async (): Promise<void> => undefined}
      />,
    );
    expect(markup).toContain(
      'Drafted without reading the ticket: Linear was not connected. Day0 drafts the plan again when Linear is back; approving now runs it as drafted.',
    );
  });
});

/** A backend refusal as it reaches the browser: the transport's envelope around the sentence. */
function refusal(call: string, sentence: string): Error {
  return new Error(
    `[CONVEX M(${call})] [Request ID: 1] Server Error\nUncaught Error: ${sentence}\n    at handler (../convex/x.ts:1:1)`,
  );
}

describe('the header controls say what each change came to and give focus back (step 45, K D6)', (): void => {
  it('turns autonomy on through the confirmation, says so, and hands focus back to the switch', async (): Promise<void> => {
    const calls: boolean[] = [];
    const view = mount(
      <AutonomyControl
        on={false}
        tone=""
        onChange={async (next) => {
          calls.push(next);
        }}
      />,
    );
    await press(view.container, 'Autonomous actions');
    await press(view.container, 'Turn on');

    expect(calls).toEqual([true]);
    expect(said(view.container)).toEqual([
      'Autonomous actions are on: the employee acts on connected systems without asking.',
    ]);
    expect(focusedName()).toBe('Autonomous actions');
    expect(view.container.querySelector('[role="alertdialog"]')).toBeNull();
    view.unmount();
  });

  it('keeps the confirmation open on a refusal, says why, and gives Cancel focus back to the switch', async (): Promise<void> => {
    const view = mount(
      <AutonomyControl
        on={false}
        tone=""
        onChange={async () => {
          throw refusal('agents:setAutonomousActions', 'Only the owner can change this.');
        }}
      />,
    );
    await press(view.container, 'Autonomous actions');
    await press(view.container, 'Turn on');

    expect(said(view.container)).toEqual(['Only the owner can change this.']);
    expect(focusedName()).toBe('Turn on');
    await press(view.container, 'Cancel');
    expect(focusedName()).toBe('Autonomous actions');
    view.unmount();
  });

  it('gives the switch a 44 px target around its drawn track', (): void => {
    const view = mount(<AutonomyControl on={false} tone="" onChange={async () => undefined} />);
    expect(button(view.container, 'Autonomous actions').className).toMatch(
      /\bmin-h-11\b.*\bmin-w-11\b/,
    );
    view.unmount();
  });

  it('says the manager DM setting it saved, and the refusal when it did not', async (): Promise<void> => {
    const saved = mount(
      <NotificationModeControl mode="per-run" onChange={async () => undefined} />,
    );
    const select = saved.container.querySelector('select');
    if (!select) throw new Error('no select');
    await choose(select, 'digest');
    expect(said(saved.container)).toEqual(['Manager DMs: hourly digest.']);
    expect(document.activeElement).toBe(select);
    saved.unmount();

    const refused = mount(
      <NotificationModeControl
        mode="per-run"
        onChange={async () => {
          throw refusal('agents:setManagerNotifications', 'No manager channel is connected.');
        }}
      />,
    );
    const again = refused.container.querySelector('select');
    if (!again) throw new Error('no select');
    await choose(again, 'digest');
    expect(said(refused.container)).toEqual(['No manager channel is connected.']);
    refused.unmount();
  });

  it('changes the manager, says who the employee reports to now, and gives focus back to Change manager', async (): Promise<void> => {
    const sent: string[] = [];
    const view = mount(
      <ManagerLine
        bossEmail="boss@day0.local"
        onChange={async (next) => {
          sent.push(next);
        }}
      />,
    );
    await press(view.container, 'Change manager');
    const field = view.container.querySelector<HTMLInputElement>('#manager-email');
    if (!field) throw new Error('no field');
    typeInto(field, ' lead@day0.local ');
    await press(view.container, 'Save');

    expect(sent).toEqual(['lead@day0.local']);
    expect(said(view.container)).toEqual(['The employee now reports to lead@day0.local.']);
    expect(focusedName()).toBe('Change manager');
    view.unmount();
  });

  it('keeps the editor open on a refusal and says it without the envelope', async (): Promise<void> => {
    const view = mount(
      <ManagerLine
        bossEmail="boss@day0.local"
        onChange={async () => {
          throw refusal('agents:setBossEmail', 'That is not an e-mail address.');
        }}
      />,
    );
    await press(view.container, 'Change manager');
    await press(view.container, 'Save');

    expect(said(view.container)).toEqual(['That is not an e-mail address.']);
    expect(focusedName()).toBe('Save');
    view.unmount();
  });
});

describe('the charter card says what each change came to (step 45, K D6)', (): void => {
  const draft = {
    _id: 'charter-1',
    _creationTime: 1,
    agentId: 'agent-1',
    version: '0.1',
    approved: false,
    createdAt: 1,
    body: {
      whyThisHire: 'Close week.',
      proposedFunction: 'Own routine revenue operations work from Linear tickets.',
      shortTermGoals: { day30: 'a', day60: 'b', day90: 'c' },
      proposedBoundaries: { willDo: [], willNotDo: [], escalationTriggers: [] },
      namedCollaborators: [],
      priorityReading: [],
      openQuestions: [],
      constraints: [
        {
          kind: 'candidate-property',
          quote: 'only the close tickets',
          wording: ['close tickets'],
          origin: 'manager-said',
        },
      ],
    },
  } as unknown as Doc<'charters'>;

  beforeEach((): void => {
    backend.calls = [];
  });

  afterEach((): void => {
    backend.refusals = {};
    backend.results = {};
    backend.calls = [];
  });

  it('strikes a rule, says what approval will leave out, and keeps focus on the control', async (): Promise<void> => {
    backend.results = { 'charters:setConstraintStruck': { ok: true } };
    const view = mount(<CharterCard charter={draft} />);
    await press(view.container, 'Strike: only the close tickets');

    expect(backend.calls).toEqual([
      {
        name: 'charters:setConstraintStruck',
        args: { charterId: 'charter-1', index: 0, struck: true },
      },
    ]);
    expect(said(view.container)).toEqual([
      'Struck “only the close tickets”: approval leaves its clauses out.',
    ]);
    expect(focusedName()).toBe('Strike: only the close tickets');
    view.unmount();
  });

  it("says the strike the backend refused in the server's own words", async (): Promise<void> => {
    backend.results = {
      'charters:setConstraintStruck': { ok: false, reason: 'the rule is the only one on Linear' },
    };
    const view = mount(<CharterCard charter={draft} />);
    await press(view.container, 'Strike: only the close tickets');
    expect(said(view.container)).toEqual(['the rule is the only one on Linear']);
    view.unmount();
  });

  it('approves the charter and says the employee starts, with 44 px decision buttons', async (): Promise<void> => {
    backend.results = { 'charters:approve': { ok: true } };
    const view = mount(<CharterCard charter={draft} />);
    for (const name of ['Approve', 'Request changes']) {
      expect(button(view.container, name).className).toMatch(/\bmin-h-11\b/);
    }
    await press(view.container, 'Approve');
    expect(said(view.container)).toEqual([
      'Charter approved: the employee starts on the work it implies.',
    ]);
    view.unmount();
  });

  it('says the draft is withdrawn and tells the page which draft went', async (): Promise<void> => {
    const page: string[] = [];
    const view = mount(<CharterCard charter={draft} onSentBack={(id) => page.push(id)} />);
    await press(view.container, 'Request changes');
    expect(backend.calls.map((entry) => entry.name)).toEqual(['charters:requestChanges']);
    expect(said(view.container)).toEqual(['Charter sent back: this draft is withdrawn.']);
    expect(page).toEqual(['charter-1']);
    view.unmount();
  });

  it('lays the 30, 60 and 90-day goals out in one column on a phone', (): void => {
    expect(renderToStaticMarkup(<CharterCard charter={draft} />)).toContain(
      'grid grid-cols-1 sm:grid-cols-3',
    );
  });
});

describe('checking for new work now (step 45)', (): void => {
  afterEach((): void => {
    backend.refusals = {};
    backend.results = {};
  });

  it('says what the check started, then the refusal of the next one in its place, keeping focus on the button', async (): Promise<void> => {
    backend.results = { 'workLoop:checkForNewWork': { scheduled: 2 } };
    const view = mount(<CheckForNewWork agentId={'agent-1' as Id<'agents'>} />);
    expect(button(view.container, 'Check for new work').className).toMatch(/\bmin-h-11\b/);
    await press(view.container, 'Check for new work');
    expect(said(view.container)).toEqual([
      'Checking 2 connected surfaces now; anything new appears here within a minute.',
    ]);
    expect(focusedName()).toBe('Check for new work');

    backend.refusals = {
      'workLoop:checkForNewWork': `[CONVEX M(workLoop:checkForNewWork)] [Request ID: 1] Server Error\nUncaught Error: The employee is retired.\n    at handler (../convex/workLoop.ts:1:1)`,
    };
    await press(view.container, 'Check for new work');
    expect(said(view.container)).toEqual(['The employee is retired.']);
    view.unmount();
  });
});

describe('every decision on a work item card is said in its live region and gives focus back (step 45)', (): void => {
  const base = {
    _id: 'w-card',
    _creationTime: 1,
    agentId: 'a1',
    title: 'Close summary for REVOPS-9',
    contentSummary: 'Post the close summary.',
    sourceSystem: 'linear',
    sourceCategory: 'ticket-queue',
    externalId: 'REVOPS-9',
    observedAt: 1,
    contentRefs: [],
  };
  const plan = {
    summary: 'Comment then close.',
    steps: ['comment', 'close'],
    expectedOutputType: 'ticket-update',
    riskNotes: '',
    reversibility: 'reversible',
    estimatedMinutes: 5,
  };
  const dmAction: MockAction = {
    tool: 'http.request',
    args: {
      surface: 'slack',
      method: 'POST',
      path: '/chat.postMessage',
      headersJson: '{"Authorization":"Bearer {{secret}}"}',
      body: JSON.stringify({ channel: 'D0MANAGER', text: 'Draft ready.' }),
    },
  };
  const refusedWith = (sentence: string) => async (): Promise<never> => {
    throw refusal('work:x', sentence);
  };

  /** The card with every decision wired to a recorder, and one handler overridden. */
  function card(
    item: Record<string, unknown>,
    handlers: Partial<Record<string, (...args: never[]) => Promise<unknown>>> = {},
  ) {
    const calls: Array<[string, unknown]> = [];
    const record =
      (name: string) =>
      async (arg?: unknown): Promise<void> => {
        calls.push([name, arg]);
        await (handlers[name] as ((value?: unknown) => Promise<unknown>) | undefined)?.(arg);
      };
    const view = mount(
      <WorkItemCard
        item={{ ...base, ...item } as unknown as Doc<'workItems'>}
        surfaces={[]}
        autonomousActions={false}
        onApprovePlan={record('approvePlan')}
        onCancelPlan={record('cancelPlan')}
        onRetryFailed={record('retry')}
        onReconcileFailed={record('reconcile')}
        onApproveActions={record('approveActions')}
        onRejectActions={record('rejectActions')}
        onResendDecision={record('resend')}
      />,
    );
    return { ...view, calls };
  }

  it('approves a plan, says so, and keeps focus on the control while the row has not moved', async (): Promise<void> => {
    const view = card({ state: 'plan-pending', plan });
    await press(view.container, 'Approve plan');
    expect(view.calls.map(([name]) => name)).toEqual(['approvePlan']);
    expect(said(view.container)).toEqual(['Plan approved: Close summary for REVOPS-9.']);
    expect(focusedName()).toBe('Approve plan');
    view.unmount();
  });

  it('gives focus to the card when the decided control leaves with the row', async (): Promise<void> => {
    const view = card({ state: 'plan-pending', plan });
    const approve = button(view.container, 'Approve plan');
    approve.focus();
    await act(async (): Promise<void> => {
      approve.click();
      // The subscription answers before the call settles: the row has moved on.
      view.root.render(
        <WorkItemCard
          item={{ ...base, state: 'plan-approved', plan } as unknown as Doc<'workItems'>}
          surfaces={[]}
          autonomousActions={false}
          onApprovePlan={async () => undefined}
          onCancelPlan={async () => undefined}
          onRetryFailed={async () => undefined}
          onReconcileFailed={async () => undefined}
          onApproveActions={async () => undefined}
          onRejectActions={async () => undefined}
          onResendDecision={async () => undefined}
        />,
      );
    });
    await settle();
    expect(focusedName()).toBe('Close summary for REVOPS-9');
    view.unmount();
  });

  it('says a refused cancel without the envelope, and keeps focus on Cancel', async (): Promise<void> => {
    const view = card(
      { state: 'plan-pending', plan },
      { cancelPlan: refusedWith('The plan already ran.') },
    );
    await press(view.container, 'Cancel');
    expect(said(view.container)).toEqual(['The plan already ran.']);
    expect(focusedName()).toBe('Cancel');
    view.unmount();
  });

  it('says the refused Retry P8-1 names (another employee holds this) instead of dropping it', async (): Promise<void> => {
    const view = card(
      { state: 'failed', plan, skipReason: 'stopped: nothing landed' },
      { retry: refusedWith('another employee holds this: Mateo holds REVOPS-9') },
    );
    await press(view.container, 'Retry');
    expect(said(view.container)).toEqual(['another employee holds this: Mateo holds REVOPS-9']);
    expect(focusedName()).toBe('Retry');
    view.unmount();
  });

  it('approves and rejects held actions from the card, each said once', async (): Promise<void> => {
    const held = {
      state: 'actions-pending',
      plan,
      pendingRunId: 'run-1',
      output: { draft: 'd', notes: '', actions: [dmAction] },
      actionVerdicts: [
        { disposition: 'held', reason: 'system-of-record mutation held for the manager' },
      ],
    };
    const approving = card(held);
    await press(approving.container, 'Approve all');
    expect(approving.calls).toEqual([['approveActions', [0]]]);
    expect(said(approving.container)).toEqual(['Approved 1 action: they apply now.']);
    approving.unmount();

    const rejecting = card(held);
    const reason = [...rejecting.container.querySelectorAll('label')].find(
      (label) => label.textContent === 'Reason for rejecting the run',
    )?.control as HTMLInputElement | null;
    if (!reason) throw new Error('the reason field has no visible label');
    typeInto(reason, 'wrong ticket');
    await press(rejecting.container, 'Reject run');
    expect(rejecting.calls).toEqual([['rejectActions', 'wrong ticket']]);
    expect(said(rejecting.container)).toEqual([
      'Run rejected: nothing held on Close summary for REVOPS-9 is sent.',
    ]);
    rejecting.unmount();
  });

  it('resends an undelivered decision request and says where it asked', async (): Promise<void> => {
    const view = card({
      state: 'plan-pending',
      plan,
      decision: {
        kind: 'plan',
        surfaceName: 'Slack',
        requestedAt: 1,
        requestFailedAt: 2,
        requestFailure: 'channel_not_found',
      },
    });
    await press(view.container, 'Resend');
    expect(view.calls.map(([name]) => name)).toEqual(['resend']);
    expect(said(view.container)).toEqual(['Asked again on Slack.']);
    expect(focusedName()).toBe('Resend');
    view.unmount();
  });

  it('records a reconciliation and says Retry is enabled', async (): Promise<void> => {
    const view = card({
      state: 'failed',
      plan,
      skipReason: 'a write may have landed',
      output: {
        draft: 'd',
        notes: '',
        actions: [dmAction],
        applied: [
          {
            tool: 'http.request',
            ok: false,
            outcomeUnknown: true,
            reason: 'socket closed after the request',
            idempotencyKey: 'w-card:run:0',
          },
        ],
      },
    });
    const box = view.container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    act((): void => box?.click());
    await press(view.container, 'Confirm reconciliation');
    expect(view.calls).toEqual([['reconcile', true]]);
    expect(said(view.container)).toEqual(['Reconciliation recorded: Retry is enabled.']);
    view.unmount();
  });

  it('gives every decision control on the card a 44 px target', (): void => {
    const view = card({ state: 'plan-pending', plan });
    for (const name of ['Approve plan', 'Cancel']) {
      expect(button(view.container, name).className).toMatch(/\bmin-h-11\b/);
    }
    for (const field of view.container.querySelectorAll('input')) {
      expect(field.className).toMatch(/\bmin-h-11\b/);
    }
    view.unmount();
  });
});

describe('approving held actions across items at once (step 45)', (): void => {
  const action: MockAction = {
    tool: 'http.request',
    args: {
      surface: 'slack',
      method: 'POST',
      path: '/chat.postMessage',
      headersJson: '{"Authorization":"Bearer {{secret}}"}',
      body: JSON.stringify({ channel: 'C0PUBLIC', text: 'Covered.' }),
    },
  };
  const member = (id: string) => ({
    workItemId: id as Id<'workItems'>,
    pendingRunId: `run-${id}` as Id<'events'>,
    title: `Answer ${id}`,
    actions: [action],
    heldIndexes: [0],
    refused: 0,
  });

  it('says what the batch came to, and keeps saying it once the panel has emptied', async (): Promise<void> => {
    const sent: unknown[] = [];
    const panel = (members: ReturnType<typeof member>[]) => (
      <PendingDecisionsPanel
        members={members}
        surfaces={[]}
        onApproveBatch={async (batch) => {
          sent.push(batch);
        }}
      />
    );
    const view = mount(panel([member('w1'), member('w2')]));
    expect(button(view.container, 'Approve 2 held actions across 2 items').className).toMatch(
      /\bmin-h-11\b/,
    );
    await press(view.container, 'Approve 2 held actions across 2 items');
    expect(sent).toHaveLength(1);
    act((): void => view.root.render(panel([])));
    expect(said(view.container)).toEqual([
      'Approved 2 held actions across 2 items: they apply now.',
    ]);
    view.unmount();
  });
});

describe('revoking and granting a permission from the card (step 45, P6-7)', (): void => {
  it('gives two scopes that differ only in punctuation two button ids', (): void => {
    const markup = renderToStaticMarkup(
      <PermissionRows
        scopes={[
          { scope: 'linear:write', active: true, source: 'deploy', grantedAt: 1, revokedAt: null },
          { scope: 'linear-write', active: true, source: 'manager', grantedAt: 1, revokedAt: null },
        ]}
        confirmingScope={null}
        busyScope={null}
        onAskRevoke={() => undefined}
        onCancelRevoke={() => undefined}
        onRevoke={() => undefined}
        onRegrant={() => undefined}
      />,
    );
    const ids = [...markup.matchAll(/<button[^>]* id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  afterEach((): void => {
    backend.queries = {};
    backend.refusals = {};
  });

  it('confirms a revoke with focus on the safe choice, says what it did, and gives focus back to the row', async (): Promise<void> => {
    backend.queries = {
      'agents:permissionScopes': [{ scope: 'linear:write', active: true, source: 'deploy' }],
    };
    const view = mount(<PermissionsCard agentId={'agent-1' as Id<'agents'>} />);
    await press(view.container, 'Revoke linear:write');
    expect(focusedName()).toBe('Keep grant');
    await press(view.container, 'Keep grant');
    expect(focusedName()).toBe('Revoke linear:write');

    await press(view.container, 'Revoke linear:write');
    await press(view.container, 'Confirm revoke');
    expect(said(view.container)).toEqual([
      'Revoked linear:write: work that still needs it stops at its final authority check.',
    ]);
    expect(focusedName()).toBe('Revoke linear:write');
    expect(view.container.querySelector('[role="group"]')).toBeNull();
    view.unmount();
  });

  it('says a refused re-grant, and gives every control a 44 px target', async (): Promise<void> => {
    backend.queries = {
      'agents:permissionScopes': [{ scope: 'slack:write', active: false, source: 'manager' }],
    };
    backend.refusals = {
      'agents:grantScopes': `[CONVEX M(agents:grantScopes)] [Request ID: 1] Server Error\nUncaught Error: slack:write is not a scope this employee can hold.\n    at handler (../convex/agents.ts:1:1)`,
    };
    const view = mount(<PermissionsCard agentId={'agent-1' as Id<'agents'>} />);
    expect(button(view.container, 'Re-grant slack:write').className).toMatch(/\bmin-h-11\b/);
    await press(view.container, 'Re-grant slack:write');
    expect(said(view.container)).toEqual(['slack:write is not a scope this employee can hold.']);
    expect(focusedName()).toBe('Re-grant slack:write');
    view.unmount();
  });
});

describe('loading is not the same as empty (P3-13)', (): void => {
  it('says the feed is loading, then that it has no events, then lists them', (): void => {
    expect(renderToStaticMarkup(<EventTicker events={undefined} titles={new Map()} />)).toContain(
      'loading the feed…',
    );
    expect(renderToStaticMarkup(<EventTicker events={[]} titles={new Map()} />)).toContain(
      'no events yet',
    );
  });

  it('says the queue and the skills are loading rather than empty', (): void => {
    const queue = renderToStaticMarkup(
      <WorkQueue
        agentId={'a1' as Id<'agents'>}
        workItems={[]}
        openQuestions={[]}
        surfaces={[]}
        registeredSkillCount={0}
        charterApproved={true}
        autonomousActions={false}
        surfaceMode="real"
        loading={true}
      />,
    );
    expect(queue).toContain('loading the work queue…');
    expect(queue).not.toContain('no work seeded yet');
    const skills = renderToStaticMarkup(
      <RegisteredSkillsPanel
        skills={[]}
        unregistered={[]}
        authoringFailure={null}
        onAuthoringAttempt={() => undefined}
        loading={true}
      />,
    );
    expect(skills).toContain('loading skills…');
    expect(skills).not.toContain('none yet');
  });

  it('puts every pilot figure definition in the page, not only in a hover', (): void => {
    const markup = renderToStaticMarkup(<MetricsCard metrics={dashboardMetrics()} />);
    for (const figure of PILOT_FIGURES) expect(markup).toContain(figure.definition);
    expect(markup).toContain('What each pilot figure counts');
  });
});

describe('answering the question a run stopped on (U2 decision 5, N7)', (): void => {
  const question = 'Which template should the notice use?';
  const stopped = {
    _id: 'w-q',
    _creationTime: 1,
    agentId: 'a1',
    state: 'failed',
    title: 'Customs hold notice',
    contentSummary: 'Send the notice.',
    sourceSystem: 'linear',
    sourceCategory: 'ticket-queue',
    externalId: 'LOG-1',
    observedAt: 1,
    contentRefs: [],
    skipReason: `stopped: ${openQuestionStopReason({ question, steps: [2] })}`,
    output: {
      draft: '',
      notes: '',
      actions: [],
      applied: [],
      openQuestion: { question, steps: [2] },
    },
  } as unknown as Doc<'workItems'>;

  it('asks for the answer by name, waits for one, and sends it as the retry note', async (): Promise<void> => {
    const sent: unknown[] = [];
    const view = mount(
      <WorkItemCard
        item={stopped}
        surfaces={[]}
        autonomousActions={false}
        onApprovePlan={async () => undefined}
        onCancelPlan={async () => undefined}
        onRetryFailed={async (note) => {
          sent.push(note);
        }}
        onReconcileFailed={async () => undefined}
        onApproveActions={async () => undefined}
        onRejectActions={async () => undefined}
        onResendDecision={async () => undefined}
      />,
    );
    const field = [...view.container.querySelectorAll('label')].find(
      (label) => label.textContent === `Your answer to: “${question}”`,
    )?.control as HTMLInputElement | null;
    if (!field) throw new Error('the answer field is not labelled with the question');
    expect(() => button(view.container, ANSWER_AND_RETRY)).toThrow();
    typeInto(field, 'Delay notice B.');
    await press(view.container, ANSWER_AND_RETRY);

    expect(sent).toEqual(['Delay notice B.']);
    expect(said(view.container)).toEqual(['Answer sent: Customs hold notice runs again with it.']);
    view.unmount();
  });
});

describe('the manager DM setting waits for a manager channel (N7)', (): void => {
  afterEach((): void => {
    backend.queries = {};
  });

  const agent = {
    _id: 'a1',
    _creationTime: 1,
    bossEmail: 'boss@day0.local',
    name: 'Priya',
    userId: 'owner',
    state: 'active',
    createdAt: 1,
  } as unknown as Doc<'agents'>;
  const approved = { approved: true } as unknown as Doc<'charters'>;

  it('is hidden until a chat surface has found the manager, then offered', (): void => {
    backend.queries = { 'config:surfaceMode': { mode: 'real', label: 'real' } };
    const without = renderToStaticMarkup(<DashboardHeader agent={agent} charter={approved} />);
    expect(without).not.toContain('Manager DMs');
    const withChannel = renderToStaticMarkup(
      <DashboardHeader agent={agent} charter={approved} managerChannel={true} />,
    );
    expect(withChannel).toContain('Manager DMs');
  });
});

describe("the zone line's confirmation (wave 3.5 review m10)", (): void => {
  it('says the zone the server stored, in its spelling, not the one typed, and gives focus back to Change zone', async (): Promise<void> => {
    const view = mount(<ZoneLine zone="UTC" onChange={async () => ({ zone: 'Asia/Singapore' })} />);
    await press(view.container, 'Change zone');
    const field = view.container.querySelector<HTMLInputElement>('#agent-zone');
    if (!field) throw new Error('no zone field');
    typeInto(field, 'asia/singapore');
    const save = [...view.container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Save',
    );
    save?.focus();
    await act(async (): Promise<void> => {
      save?.click();
    });
    await settle();
    expect(said(view.container)).toEqual([
      "The employee's day is now Asia/Singapore; every time on this page is in it.",
    ]);
    expect(focusedName()).toBe('Change zone');
    view.unmount();
  });
});

describe('the page after a draft charter is sent back (step 45)', (): void => {
  const agent = (state: string) => ({
    _id: 'agent-1',
    _creationTime: 1,
    bossEmail: 'boss@day0.local',
    name: 'Priya',
    userId: 'owner',
    state,
    createdAt: 1,
  });
  const draft = {
    _id: 'charter-2',
    _creationTime: 2,
    agentId: 'agent-1',
    version: '0.2',
    approved: false,
    createdAt: 2,
    body: {
      whyThisHire: 'Close week.',
      proposedFunction: 'Own routine revenue operations work.',
      shortTermGoals: { day30: 'a', day60: 'b', day90: 'c' },
      proposedBoundaries: { willDo: [], willNotDo: [], escalationTriggers: [] },
      namedCollaborators: [],
      priorityReading: [],
      openQuestions: [],
    },
  };

  afterEach((): void => {
    backend.queries = {};
    document.body.replaceChildren();
  });

  it('says the 1:1 is open again and gives it focus when the send-back reopened it', async (): Promise<void> => {
    backend.queries = { 'agents:get': agent('charter-pending'), 'charters:latest': draft };
    const view = mount(<AgentDashboard agentId={'agent-1' as Id<'agents'>} />);
    await press(view.container, 'Request changes');
    backend.queries = { 'agents:get': agent('deployed'), 'charters:latest': null };
    act((): void => view.root.render(<AgentDashboard agentId={'agent-1' as Id<'agents'>} />));
    await settle();

    expect(said(view.container)).toContain(
      'The 1:1 is open again, so the employee can redraft the charter from what you tell it.',
    );
    expect(focusedName()).toBe('The 1:1 that drafts the charter');
    view.unmount();
  });

  it('says nothing reopened and moves no focus when an approved charter stands beneath the draft', async (): Promise<void> => {
    backend.queries = { 'agents:get': agent('active'), 'charters:latest': draft };
    const view = mount(<AgentDashboard agentId={'agent-1' as Id<'agents'>} />);
    await press(view.container, 'Request changes');
    backend.queries = {
      'agents:get': agent('active'),
      'charters:latest': { ...draft, _id: 'charter-1', version: '0.1', approved: true },
    };
    act((): void => view.root.render(<AgentDashboard agentId={'agent-1' as Id<'agents'>} />));
    await settle();

    expect(said(view.container).join(' ')).not.toContain('The 1:1 is open again');
    expect(focusedName()).not.toBe('The 1:1 that drafts the charter');
    view.unmount();
  });
});

describe('the page in the layout (N29, UX 11)', (): void => {
  afterEach((): void => {
    backend.queries = {};
    document.body.replaceChildren();
  });

  it('leaves the one main landmark to the layout, loading and loaded', async (): Promise<void> => {
    const view = mount(<AgentDashboard agentId={'agent-1' as Id<'agents'>} />);
    expect(view.container.textContent).toContain('loading employee…');
    expect(view.container.querySelector('main')).toBeNull();
    backend.queries = {
      'agents:get': {
        _id: 'agent-1',
        _creationTime: 1,
        bossEmail: 'boss@day0.local',
        name: 'Priya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      },
    };
    act((): void => view.root.render(<AgentDashboard agentId={'agent-1' as Id<'agents'>} />));
    await settle();
    expect(view.container.textContent).toContain('Work queue');
    expect(view.container.querySelector('main')).toBeNull();
    view.unmount();
  });
});
