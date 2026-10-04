/** @vitest-environment jsdom */

import { act } from 'react';
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../../../../convex/_generated/dataModel';
import type { MockAction } from '../../../../../src/work/types';
import {
  PendingDecisionsPanel,
  pendingDecisionMembers,
} from '../../../../../app/agent/[agentId]/work/PendingDecisionsPanel';
import { HELD_CLOSE_AGAINST_WORDS, HELD_MUTATION } from '../../../../../src/surfaces/policy';
import { button, mount, press, said } from '../../../../fixtures/dom/press';

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
    leftForCard: [],
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

describe('the Needs you batch and a close Day0 held (12-H, R-12D-1)', (): void => {
  const comment: MockAction = {
    tool: 'mcp.call',
    args: {
      surface: 'linear',
      tool: 'save_comment',
      toolArgsJson: '{"issueId":"REVOPS-12","body":"Audit note posted."}',
    },
  };
  const close: MockAction = {
    tool: 'mcp.call',
    args: {
      surface: 'linear',
      tool: 'save_issue',
      toolArgsJson: '{"id":"REVOPS-12","state":"Done"}',
    },
  };
  const row = (id: string, actions: MockAction[], reasons: string[], applied: unknown[] = []) =>
    ({
      _id: id,
      state: 'actions-pending',
      pendingRunId: `run-${id}`,
      title: `Close ${id}`,
      output: { draft: '', notes: '', actions, applied },
      actionVerdicts: reasons.map((reason) => ({ disposition: 'held', reason })),
    }) as unknown as Doc<'workItems'>;

  it('leaves a tripped close out of what the batch approves, and lists a set that holds only one', (): void => {
    const members = pendingDecisionMembers([
      row('w1', [comment, close], [HELD_MUTATION, HELD_CLOSE_AGAINST_WORDS]),
      row('w2', [comment], [HELD_MUTATION]),
      row(
        'w3',
        [comment, close],
        [HELD_MUTATION, HELD_CLOSE_AGAINST_WORDS],
        [{ tool: 'mcp.call', ok: true, authority: 'manager' }],
      ),
    ]);
    expect(
      members.map((member) => [member.workItemId, member.heldIndexes, member.leftForCard]),
    ).toEqual([
      ['w1', [0], [1]],
      ['w2', [0], []],
      ['w3', [], [1]],
    ]);
  });

  it('counts only what it sends, and says the close is left for its card', async (): Promise<void> => {
    const sent: unknown[] = [];
    const members = pendingDecisionMembers([
      row('w1', [comment, close], [HELD_MUTATION, HELD_CLOSE_AGAINST_WORDS]),
      row('w2', [comment], [HELD_MUTATION]),
    ]);
    const view = mount(
      <PendingDecisionsPanel
        members={members}
        surfaces={[]}
        onApproveBatch={async (batch) => {
          sent.push(batch);
        }}
      />,
    );
    const text = view.container.textContent ?? '';
    expect(text).toContain(
      'Its ticket close is left for its card: Day0 held it because the run’s own words say the work was not done.',
    );
    expect(text).toContain(
      '1 ticket close Day0 held is left for its card; approve it there only if the work was done.',
    );
    await press(view.container, 'Approve 2 held actions across 2 items');
    expect(sent).toEqual([
      [
        { workItemId: 'w1', pendingRunId: 'run-w1', approvedIndexes: [0] },
        { workItemId: 'w2', pendingRunId: 'run-w2', approvedIndexes: [0] },
      ],
    ]);
    expect(said(view.container)).toEqual([
      'Approved 2 held actions across 2 items: they apply now. The ticket close waits on its card.',
    ]);
    view.unmount();
  });
});
