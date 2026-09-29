/** @vitest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { axeViolations } from '../../../../fixtures/dom/axe';
import { mount } from '../../../../fixtures/dom/press';
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';
import {
  ActionPayload,
  DraftDetails,
  PlanExecutionLedger,
  RefusedBlockedSteps,
  RefusedClosingDetails,
  WithheldActionsDetails,
} from '../../../../../app/agent/[agentId]/work/RunDetails';
import { failedItemReason, phasedLedger } from '../../../../../app/agent/[agentId]/work/work-item';
import {
  log1FirstStopRefusedClosing,
  log1RefusedClosing,
} from '../../../../fixtures/work/full-run-3-2026-09-19-log-1';
import { log1PhaseOne as sitting4Log1PhaseOne } from '../../../../fixtures/work/full-run-4-2026-09-19-log-1';
import {
  openQuestionStopReason,
  withheldForAnswerReason,
} from '../../../../../src/work/obligations';

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
    // Named as the control that answers it is (U17 D5).
    expect(markup).toContain('Answer and retry answers it');
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

  it('reads a stop with the question open as one the manager answers with Answer and retry (U17 D5)', (): void => {
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
      `stopped with a question open for you, and the writes that wait on it were never sent; answer it below with Answer and retry: ${reason}`,
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

  it('names each scrolling draft without making it a landmark, so two items of one title do not clash', async (): Promise<void> => {
    const output = { draft: 'Closed with the audit note.', notes: '', applied: twoPhase.applied };
    const view = mount(
      <main>
        <DraftDetails output={output} title="Slack mention in #ops-requests" />
        <DraftDetails output={output} title="Slack mention in #ops-requests" />
      </main>,
    );
    for (const disclosure of view.container.querySelectorAll('details')) disclosure.open = true;
    const drafts = [...view.container.querySelectorAll('pre')];
    expect(drafts.map((draft) => draft.getAttribute('tabindex'))).toEqual(['0', '0']);
    expect(drafts[0]?.getAttribute('aria-label')).toBe(
      'Draft the employee wrote: Slack mention in #ops-requests',
    );
    expect(await axeViolations(view.container)).toEqual([]);
    view.unmount();
  });

  it('calls the draft the employee’s, never the agent’s (N29)', (): void => {
    const single = renderToStaticMarkup(
      <DraftDetails
        output={{ draft: 'd', notes: '', applied: twoPhase.applied }}
        title="Close REVOPS-5"
      />,
    );
    expect(single).toContain('Draft the employee wrote (1 character)');
    expect(single).toContain('aria-label="Draft the employee wrote: Close REVOPS-5"');
    expect(single).toContain('The employee&#x27;s own words');
    expect(single).not.toMatch(/\bagent\b/i);
  });
});
