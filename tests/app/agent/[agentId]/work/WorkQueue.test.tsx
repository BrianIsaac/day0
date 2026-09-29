/** @vitest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../../../convex/_generated/dataModel';
import { CheckForNewWork, WorkQueue } from '../../../../../app/agent/[agentId]/work/WorkQueue';
import { button, focusedName, mount, press, said } from '../../../../fixtures/dom/press';

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

describe('loading is not the same as empty (P3-13)', (): void => {
  it('says the queue is loading rather than empty', (): void => {
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
  });
});
