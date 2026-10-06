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
  /** A call that waits, by function name, until the test lets it settle. */
  held: {} as Record<string, Promise<void>>,
}));

vi.mock('convex/react', () => {
  const call =
    (reference: unknown): ((args?: unknown) => Promise<unknown>) =>
    async (args?: unknown): Promise<unknown> => {
      const name = getFunctionName(reference as never);
      backend.calls.push({ name, args });
      await backend.held[name];
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

describe("a card waiting on a skill whose draft failed Day0's check (D3)", (): void => {
  it('tells only the card waiting on that skill, and links it to its Retry', (): void => {
    const waiting = (id: string, skillId: string): Doc<'workItems'> =>
      ({
        _id: id,
        _creationTime: 1,
        agentId: 'a1',
        title: `Close out ticket ${id}`,
        state: 'needs-skill',
        sourceCategory: 'ticket-queue',
        sourceSystem: 'ticket',
        externalId: id,
        contentSummary: 'Priya: "Please close it."',
        contentRefs: [],
        verdict: { decision: 'needs-skill', reason: 'smoke test failed' },
        proposedSkillId: skillId,
        createdAt: 1,
      }) as unknown as Doc<'workItems'>;
    const queue = renderToStaticMarkup(
      <WorkQueue
        agentId={'a1' as Id<'agents'>}
        workItems={[waiting('w1', 'skill-failed'), waiting('w2', 'skill-proposed')]}
        openQuestions={[]}
        surfaces={[]}
        registeredSkillCount={0}
        charterApproved={true}
        autonomousActions={false}
        surfaceMode="mock"
        refusedSkills={
          new Map([
            [
              'skill-failed',
              { skillId: 'skill-failed', name: 'kanban-comment-and-close', retryable: true },
            ],
          ])
        }
      />,
    );
    expect(queue.match(/Retry it on the Skills tab/g)).toHaveLength(1);
    expect(queue).toContain('href="/agent/a1/skills#skill-skill-failed"');
    expect(queue).toContain('holds the proposal');
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

  it('puts the run that began first on top, not the item found first and claimed later (second review x4)', (): void => {
    const order = sortedForQueue([
      // Found first, parked at the cap, claimed hours later and now executing.
      { _id: 'found-first', state: 'executing', _creationTime: 1_000, claimedAt: 9_000 },
      // Found later, claimed at once, and waiting on the manager since.
      { _id: 'waiting-on-you', state: 'actions-pending', _creationTime: 2_000, claimedAt: 2_500 },
      // Claimed before the claim was recorded: ordered by when it was found.
      { _id: 'older-row', state: 'plan-pending', _creationTime: 1_500 },
    ]).map((item) => item._id);
    expect(order).toEqual(['older-row', 'waiting-on-you', 'found-first']);
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

describe('the queue gliding its cards to their new places (second review x8)', (): void => {
  const ownOffsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
  const ownAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');

  afterEach((): void => {
    for (const [name, own] of [
      ['offsetTop', ownOffsetTop],
      ['animate', ownAnimate],
    ] as const) {
      if (own) Object.defineProperty(HTMLElement.prototype, name, own);
      else Reflect.deleteProperty(HTMLElement.prototype, name);
    }
    vi.unstubAllGlobals();
  });

  it('moves a card that changed its place from where it stood, keyed by the item', (): void => {
    // jsdom lays nothing out: each card stands 100 px below the one before it.
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement): number {
        return [...(this.parentElement?.children ?? [])].indexOf(this) * 100;
      },
    });
    const moved: Array<{ id: string; from: unknown }> = [];
    HTMLElement.prototype.animate = function (this: HTMLElement, keyframes: Keyframe[]): Animation {
      moved.push({ id: this.id, from: keyframes[0]?.transform });
      return {} as Animation;
    } as HTMLElement['animate'];
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const item = (id: string, state: string, created: number): Doc<'workItems'> =>
      ({
        _id: id,
        state,
        title: id,
        _creationTime: created,
        agentId: 'a1',
        sourceSystem: 'linear',
        sourceCategory: 'ticket-queue',
        externalId: id,
        contentSummary: 's',
        contentRefs: [],
        observedAt: 1,
      }) as unknown as Doc<'workItems'>;
    const queue = (items: Doc<'workItems'>[]) => (
      <WorkQueue
        agentId={'a1' as Id<'agents'>}
        workItems={items}
        openQuestions={[]}
        surfaces={[]}
        registeredSkillCount={0}
        charterApproved
        autonomousActions={false}
        surfaceMode="real"
      />
    );
    const view = mount(queue([item('w-a', 'completed', 1), item('w-b', 'completed', 2)]));
    moved.length = 0;
    // The second item starts a run, which the queue lists above what has finished.
    act((): void =>
      view.root.render(queue([item('w-a', 'completed', 1), item('w-b', 'claimed', 2)])),
    );
    expect(moved).toEqual([
      { id: 'item-w-b', from: 'translateY(100px)' },
      { id: 'item-w-a', from: 'translateY(-100px)' },
    ]);
    view.unmount();
  });
});

describe("the mock office's own loop (round 0141 R-D item 1, the bed walk)", (): void => {
  afterEach((): void => {
    backend.calls.length = 0;
    backend.held = {};
    backend.results = {};
  });

  /** A work item row with the given id, state and verdict. */
  function item(id: string, state: string, verdict?: unknown): Doc<'workItems'> {
    return {
      _id: id,
      _creationTime: 1,
      agentId: 'a1',
      state,
      title: id,
      sourceSystem: 'ticket',
      sourceCategory: 'ticket-queue',
      externalId: id,
      contentSummary: 's',
      contentRefs: [],
      observedAt: 1,
      createdAt: 1,
      ...(verdict !== undefined ? { verdict } : {}),
    } as unknown as Doc<'workItems'>;
  }

  function queue(items: Doc<'workItems'>[]) {
    return (
      <WorkQueue
        agentId={'a1' as Id<'agents'>}
        workItems={items}
        openQuestions={[]}
        surfaces={[]}
        registeredSkillCount={1}
        charterApproved
        autonomousActions={false}
        surfaceMode="mock"
      />
    );
  }

  const evaluations = (): number =>
    backend.calls.filter((call) => call.name === 'workActions:evaluateWorkItem').length;

  it('asks again for a queued item when its slot freed while that item was being judged', async (): Promise<void> => {
    let release = (): void => undefined;
    backend.held = {
      'workActions:evaluateWorkItem': new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    backend.results = { 'workActions:evaluateWorkItem': { decision: 'queue' } };
    const queued = item('w-ticket', 'discovered', { decision: 'queue' });
    const view = mount(queue([queued, item('w-docs', 'actions-pending')]));
    await settle();
    expect(evaluations()).toBe(1);

    // The docs item finishes while the ticket item's judgement is still under way.
    act((): void => view.root.render(queue([queued, item('w-docs', 'completed')])));
    await settle();
    expect(evaluations()).toBe(1);

    backend.held = {};
    await act(async (): Promise<void> => {
      release();
    });
    await settle();
    expect(evaluations()).toBe(2);
    view.unmount();
  });
});

describe('an empty queue whose seeding did not finish (12-J item 6, option C; 12-FX)', (): void => {
  afterEach((): void => {
    backend.queries = {};
    backend.results = {};
    backend.refusals = {};
    backend.calls = [];
  });

  const queue = () => (
    <WorkQueue
      agentId={'a1' as Id<'agents'>}
      workItems={[]}
      openQuestions={[]}
      surfaces={[]}
      registeredSkillCount={0}
      charterApproved={true}
      autonomousActions={false}
      surfaceMode="mock"
      employeeName="Nola"
    />
  );

  it('says the seeding stopped and why, and finds work again on the manager’s press', async (): Promise<void> => {
    backend.queries = {
      'charterSeeding:standing': {
        state: 'stopped',
        reason: 'it ran past the 10 minutes it is given',
        line: 'Day0 could not find work for Nola: it ran past the 10 minutes it is given.',
      },
    };
    const view = mount(queue());
    expect(view.container.textContent).toContain(
      'Day0 could not find work for Nola: it ran past the 10 minutes it is given.',
    );
    expect(view.container.textContent).not.toContain('Nothing has come in yet');
    expect(button(view.container, 'Find work again').className).toMatch(/\bmin-h-11\b/);
    await press(view.container, 'Find work again');
    expect(backend.calls).toContainEqual({
      name: 'charterSeeding:findWorkAgain',
      args: { agentId: 'a1' },
    });
    expect(said(view.container)).toEqual(['Finding work again. It appears here as it is found.']);
    view.unmount();
  });

  it('says a seeding that is being tried again, with no control', (): void => {
    backend.queries = {
      'charterSeeding:standing': {
        state: 'retrying',
        reason: 'the model call reached its 300000ms budget',
        line: 'Finding work for Nola did not finish: the model call reached its 300000ms budget. Day0 tries again shortly.',
      },
    };
    const markup = renderToStaticMarkup(queue());
    expect(markup).toContain('Day0 tries again shortly.');
    expect(markup).not.toContain('Find work again');
  });

  it('keeps the usual words while nothing is wrong', (): void => {
    backend.queries = { 'charterSeeding:standing': null };
    expect(renderToStaticMarkup(queue())).toContain(
      'Nothing has come in yet. New work appears here as it is found.',
    );
  });
});
