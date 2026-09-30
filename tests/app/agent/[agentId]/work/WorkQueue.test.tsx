/** @vitest-environment jsdom */

import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../../../../convex/_generated/dataModel';
import {
  CheckForNewWork,
  sortedForQueue,
  WorkQueue,
} from '../../../../../app/agent/[agentId]/work/WorkQueue';
import { button, focusedName, mount, press, said, settle } from '../../../../fixtures/dom/press';

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
    expect(queue).toContain('Loading the work queue…');
    expect(queue).not.toContain('Nothing has come in yet');
  });
});

describe('the order the queue lists its items in', (): void => {
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

  it('keeps a run in its place from its plan to its held write, runs oldest first (walk m21, second pass M5)', (): void => {
    const others = [
      { _id: 'skill', state: 'needs-skill', _creationTime: 3 },
      { _id: 'waiting', state: 'discovered', _creationTime: 4 },
      { _id: 'older-run', state: 'executing', _creationTime: 1 },
      { _id: 'landed', state: 'completed', _creationTime: 5 },
    ];
    const orderAt = (state: string): string[] =>
      sortedForQueue([...others, { _id: 'run', state, _creationTime: 2 }]).map((item) => item._id);
    const places = ['claimed', 'plan-pending', 'plan-approved', 'executing', 'actions-pending'].map(
      orderAt,
    );
    for (const place of places) expect(place).toEqual(places[0]);
    expect(places[0]).toEqual(['older-run', 'run', 'skill', 'waiting', 'landed']);
    // Landing is a move the list must make: to the finished rows.
    expect(orderAt('completed').indexOf('run')).toBeGreaterThan(
      orderAt('completed').indexOf('waiting'),
    );
  });

  it('files a failed item the manager dismissed at the foot, after every open state (N7)', (): void => {
    const order = sortedForQueue([
      { state: 'failed', title: 'dismissed', dismissedAt: 5 },
      { state: 'cancelled', title: 'cancelled' },
      { state: 'failed', title: 'stopped' },
      { state: 'skipped', title: 'skipped' },
    ]).map((item) => item.title);
    expect(order).toEqual(['stopped', 'skipped', 'cancelled', 'dismissed']);
  });
});

describe('landing an inbox link on its card (U17 D13, A D8)', (): void => {
  it('brings the named card into view and focus when the hash changes, clearing a filter that hides it', async (): Promise<void> => {
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element): void {
      scrolled.push(this.id);
    };
    const items = [
      { _id: 'w-plan', state: 'plan-pending', title: 'Plan' },
      { _id: 'w-done', state: 'completed', title: 'Done' },
    ].map(
      (row) =>
        ({
          ...row,
          _creationTime: 1,
          agentId: 'a1',
          sourceSystem: 'linear',
          sourceCategory: 'ticket-queue',
          externalId: row._id,
          contentSummary: 's',
          contentRefs: [],
          observedAt: 1,
        }) as unknown as Doc<'workItems'>,
    );
    const view = mount(
      <WorkQueue
        agentId={'a1' as Id<'agents'>}
        workItems={items}
        openQuestions={[]}
        surfaces={[]}
        registeredSkillCount={0}
        charterApproved
        autonomousActions={false}
        surfaceMode="real"
      />,
    );
    await press(view.container, 'Needs you 1');
    expect(document.getElementById('item-w-done')).toBeNull();
    await act(async (): Promise<void> => {
      window.location.hash = '#item-w-done';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await settle();
    await vi.waitFor((): void => {
      expect(document.activeElement?.id).toBe('item-w-done');
    });
    expect(scrolled).toContain('item-w-done');
    view.unmount();
    window.location.hash = '';
  });
});
