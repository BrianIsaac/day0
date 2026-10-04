/** @vitest-environment jsdom */

import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Doc } from '../../../../../convex/_generated/dataModel';
import type { MockAction } from '../../../../../src/work/types';
import type { SurfaceRecord } from '../../../../../src/surfaces/types';
import {
  SessionRestoreNote,
  CHIP_SWAP_MS,
} from '../../../../../app/agent/[agentId]/work/RunDetails';
import {
  failedItemReason,
  ANSWER_AND_RETRY,
  SKIP_RETRY_NOTE,
  TAKE_IT_ANYWAY,
  waitingLine,
} from '../../../../../app/agent/[agentId]/work/work-item';
import {
  WorkItemCard,
  LANDING_MS,
  retryModeOf,
} from '../../../../../app/agent/[agentId]/work/WorkItemCard';
import {
  button,
  focusedName,
  mount,
  press,
  said,
  settle,
  typeInto,
} from '../../../../fixtures/dom/press';
import { AgentZoneContext } from '../../../../../app/components/time';
import { DECISION_REQUEST_RECOVERY_MS } from '../../../../../src/work/manager-channel';
import { slackPhaseOne } from '../../../../fixtures/browser-phase-split-2026-09-16';
import { REFUSED_CREATE_RUN } from '../../../../fixtures/refused-ticket-create-2026-09-19';
import { gateRefusalStop } from '../../../../../src/work/stop';
import { openQuestionStopReason } from '../../../../../src/work/obligations';

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

/** A backend refusal as it reaches the browser: the transport's envelope around the sentence. */
function refusal(call: string, sentence: string): Error {
  return new Error(
    `[CONVEX M(${call})] [Request ID: 1] Server Error\nUncaught Error: ${sentence}\n    at handler (../convex/x.ts:1:1)`,
  );
}

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
    expect(markup).toContain('Sending it back with a note returns this finished work');
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
    expect(markup).toContain('>Stopped<');
    expect(markup).not.toContain('>Failed<');
    expect(markup).not.toContain('>Rejected by you<');
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
    expect(markup).toContain('>Stopped<');
    expect(markup).not.toContain('>Failed<');
    expect(markup).not.toContain('>Rejected by you<');
    expect(markup).toContain('1 action refused by Day0&#x27;s gate · never sent');
    expect(markup).not.toContain('did not reach');
    expect(markup).toContain('stopped at a step Day0&#x27;s gate refused');
    expect(markup).not.toContain('nothing landed and nothing to decide');
  });

  it("offers Retry on an out-of-scope skip as the manager's scope decision", (): void => {
    const markup = render(skipped('out-of-scope: no charter or current documented-system overlap'));
    expect(markup).toContain('>Take it anyway<');
    expect(markup).toContain(
      'Take it anyway is your decision that this work is the employee&#x27;s to do: it is evaluated again as in scope',
    );
    expect(markup).not.toContain('without the quality-fit filter');
    // The skip in words, and the sentence that scope and skill are judged apart (R6).
    expect(markup).toContain('Skipped.</span> No charter or current documented-system overlap.');
    expect(markup).not.toContain('out-of-scope:');
    expect(markup).toContain('is judged separately from whether the employee has a skill for it');
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
      expect(markup).toMatch(/<button[^>]*class="[^"]*\bmin-h-11\b[^"]*"[^>]*>Retry<\/button>/);
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
      /Another employee holds this: <a [^>]*href="\/agent\/a2"[^>]*>Priya<\/a>/,
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
    expect(markup).toContain('needs linear:write, slack:write, a grant you give');
    expect(markup).toContain('>Parked<');
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
    await press(view.container, 'Cancel this item');
    // Cancel opens the reason first: the field takes focus, the cancel waits for a second press.
    expect(document.activeElement?.tagName).toBe('INPUT');
    expect(view.calls).toEqual([]);
    await press(view.container, 'Cancel without a reason');
    expect(view.calls).toEqual([['cancelPlan', '']]);
    expect(said(view.container)).toEqual(['The plan already ran.']);
    expect(focusedName()).toBe('Cancel without a reason');
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
    expect(said(approving.container)).toEqual(['Approved 1 action: it applies now.']);
    approving.unmount();

    const rejecting = card(held);
    await press(rejecting.container, 'Reject the run');
    const reason = [...rejecting.container.querySelectorAll('label')].find(
      (label) => label.textContent === 'Reason for rejecting',
    )?.control as HTMLInputElement | null;
    if (!reason) throw new Error('the reason field has no visible label');
    expect(document.activeElement).toBe(reason);
    typeInto(reason, 'wrong ticket');
    await press(rejecting.container, 'Reject with this reason');
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
    // Answered per entry since wave 12 (U17 D1): re-pinned from one tick and `true`.
    const landed = [
      ...view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    ].find((radio) => radio.closest('label')?.textContent === 'It landed');
    act((): void => landed?.click());
    await press(view.container, 'Confirm reconciliation');
    expect(view.calls).toEqual([
      ['reconcile', [{ phase: 'single', actionIndex: 0, answer: 'landed' }]],
    ]);
    expect(said(view.container)).toEqual(['Reconciliation recorded: Retry is enabled.']);
    view.unmount();
  });

  it('gives every decision control on the card a 44 px target', (): void => {
    const view = card({ state: 'plan-pending', plan });
    for (const name of ['Approve plan', 'Cancel this item']) {
      expect(button(view.container, name).className).toMatch(/\bmin-h-11\b/);
    }
    act((): void => button(view.container, 'Cancel this item').click());
    for (const name of ['Cancel without a reason', 'Keep the plan']) {
      expect(button(view.container, name).className).toMatch(/\bmin-h-11\b/);
    }
    for (const field of view.container.querySelectorAll('input')) {
      expect(field.className).toMatch(/\bmin-h-11\b/);
    }
    view.unmount();
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

describe('a work item that lands while the page is open (v3 section 5.2)', (): void => {
  const executing = {
    _id: 'w1',
    _creationTime: 1,
    agentId: 'a1',
    state: 'executing',
    title: 'Close REVOPS-5',
    contentSummary: 'Add the audit note and close the ticket.',
    sourceSystem: 'linear',
    sourceCategory: 'ticket-queue',
    externalId: 'REVOPS-5',
    observedAt: 1,
    contentRefs: [],
  } as unknown as Doc<'workItems'>;
  const landed = {
    ...executing,
    state: 'completed',
    output: {
      draft: 'Closed with the audit note.',
      applied: [
        { tool: 'linear.save_comment', ok: true, effect: 'Commented on REVOPS-5' },
        { tool: 'linear.save_issue', ok: true, effect: 'Moved REVOPS-5 to Done' },
      ],
    },
  } as unknown as Doc<'workItems'>;

  afterEach((): void => {
    document.body.replaceChildren();
  });

  /** The card for one row, as the queue renders it. */
  const card = (item: Doc<'workItems'>) => (
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
    />
  );

  it('swaps the state chip in one cell, settles the ledger and lifts its lines 70 ms apart', (): void => {
    const view = mount(card(executing));
    expect(view.container.querySelector('.chip-swap')).toBeNull();

    act((): void => view.root.render(card(landed)));
    const swap = view.container.querySelector('.chip-swap');
    expect(swap?.querySelector('.from')?.textContent).toBe('Working');
    expect(swap?.querySelector('.from')?.getAttribute('aria-hidden')).toBe('true');
    expect(swap?.querySelector('.to')?.textContent).toBe('Landed');
    const ledger = view.container.querySelector('[data-land]');
    expect(ledger?.textContent).toContain('Moved REVOPS-5 to Done');
    expect(
      [...(ledger?.querySelectorAll('li') ?? [])].map((line) =>
        (line as HTMLElement).style.getPropertyValue('--i'),
      ),
    ).toEqual(['0', '1']);
    view.unmount();
  });

  it('drops the swap and the landing mark once they have played, so a card moved later replays nothing', (): void => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const view = mount(card(executing));
      act((): void => view.root.render(card(landed)));
      expect(view.container.querySelector('.chip-swap')).not.toBeNull();
      expect(view.container.querySelector('[data-land]')).not.toBeNull();
      act((): void => {
        vi.advanceTimersByTime(Math.max(CHIP_SWAP_MS, LANDING_MS));
      });
      expect(view.container.querySelector('.chip-swap')).toBeNull();
      expect(view.container.textContent).not.toContain('Working');
      expect(view.container.querySelector('[data-land]')).toBeNull();
      expect(
        [...view.container.querySelectorAll('li')].filter(
          (line) => (line as HTMLElement).style.getPropertyValue('--i') !== '',
        ),
      ).toEqual([]);
      expect(view.container.textContent).toContain('Moved REVOPS-5 to Done');
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the stagger of the ledger lines at the fourth line', (): void => {
    const long = {
      ...landed,
      output: {
        draft: 'Closed.',
        applied: Array.from({ length: 6 }, (_, index) => ({
          tool: 'linear.save_comment',
          ok: true,
          effect: `Comment ${index}`,
        })),
      },
    } as unknown as Doc<'workItems'>;
    const view = mount(card(executing));
    act((): void => view.root.render(card(long)));
    expect(
      [...view.container.querySelectorAll('[data-land] li')].map((line) =>
        (line as HTMLElement).style.getPropertyValue('--i'),
      ),
    ).toEqual(['0', '1', '2', '3', '3', '3']);
    view.unmount();
  });

  it('plays the landing for the writes that land after Approve on a run that landed a row before it (M7)', (): void => {
    const prerequisite = { tool: 'linear.get_issue', ok: true, effect: 'Read REVOPS-5' };
    const held = {
      ...executing,
      state: 'actions-pending',
      pendingRunId: 'run-1',
      output: {
        draft: 'Closing from the ledger.',
        notes: '',
        initial: { applied: [prerequisite] },
        actions: [{ tool: 'linear.save_comment', args: { issueId: 'REVOPS-5', body: 'Audit' } }],
        applied: [],
      },
      actionVerdicts: [{ disposition: 'held', reason: 'system-of-record mutation held' }],
    } as unknown as Doc<'workItems'>;
    // Completion flattens the two phases into one ledger (`flattenedDependentOutput`):
    // the prerequisite first, at the place it held while the closing set waited.
    const closed = {
      ...held,
      state: 'completed',
      pendingRunId: undefined,
      actionVerdicts: undefined,
      output: {
        draft: 'Closing from the ledger.',
        notes: '',
        actions: [],
        applied: [
          prerequisite,
          { tool: 'linear.save_comment', ok: true, effect: 'Commented on REVOPS-5' },
          { tool: 'linear.save_issue', ok: true, effect: 'Moved REVOPS-5 to Done' },
        ],
      },
    } as unknown as Doc<'workItems'>;
    const view = mount(card(held));
    expect(view.container.querySelector('[data-land]')).toBeNull();

    act((): void => view.root.render(card(closed)));
    const landing = view.container.querySelector('[data-land]');
    expect(landing?.textContent).toContain('Moved REVOPS-5 to Done');
    expect(landing?.textContent).not.toContain('Read REVOPS-5');
    expect(
      [...(landing?.querySelectorAll('li') ?? [])].map((line) =>
        (line as HTMLElement).style.getPropertyValue('--i'),
      ),
    ).toEqual(['0', '1']);
    expect(view.container.textContent).toContain('Read REVOPS-5');
    view.unmount();
  });

  it('shows a landing that was already there as it stands, with nothing to play', (): void => {
    const view = mount(card(landed));
    expect(view.container.textContent).toContain('Moved REVOPS-5 to Done');
    expect(view.container.querySelector('.chip-swap')).toBeNull();
    expect(view.container.querySelector('[data-land]')).toBeNull();
    expect(view.container.querySelector('li[style]')).toBeNull();
    view.unmount();
  });
});

describe('retryModeOf', (): void => {
  it('fails loudly on a state the union does not hold, never drawing a card with no controls (m13)', (): void => {
    const stray = { state: 'archived' } as unknown as Doc<'workItems'>;
    expect(() => retryModeOf(stray, undefined, undefined)).toThrow(
      'no settling controls for a work item in state archived',
    );
    expect(retryModeOf({ state: 'executing' } as Doc<'workItems'>, undefined, undefined)).toBe(
      undefined,
    );
  });
});
