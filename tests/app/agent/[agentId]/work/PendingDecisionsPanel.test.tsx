/** @vitest-environment jsdom */

import { act } from 'react';
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../../../convex/_generated/dataModel';
import type { MockAction } from '../../../../../src/work/types';
import { PendingDecisionsPanel } from '../../../../../app/agent/[agentId]/work/PendingDecisionsPanel';
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
