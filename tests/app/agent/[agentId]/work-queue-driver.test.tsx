import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../../../convex/_generated/dataModel';

/**
 * Who drives the work loop: the page in mock mode, where the hosted demo and
 * the frozen harness rely on it, and the server in real mode. The effects of
 * `WorkQueue` are run synchronously here (the node project has no DOM), and
 * every action the queue asks for is recorded by its function name.
 */

const calls = vi.hoisted(() => [] as Array<{ name: string; args: unknown }>);

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useEffect: (effect: () => void): void => {
      effect();
    },
  };
});

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  const record =
    (ref: Parameters<typeof getFunctionName>[0]) =>
    async (args: unknown): Promise<void> => {
      calls.push({ name: getFunctionName(ref), args });
    };
  return { useQuery: (): undefined => undefined, useMutation: record, useAction: record };
});

import { WorkQueue, checkForWorkMessage } from '../../../../app/agent/[agentId]/AgentDashboard';

function item(id: string, state: Doc<'workItems'>['state'], plan?: unknown): Doc<'workItems'> {
  return {
    _id: id as Id<'workItems'>,
    _creationTime: 1,
    agentId: 'agent-1' as Id<'agents'>,
    sourceCategory: 'ticket-queue',
    sourceSystem: 'linear',
    externalId: id,
    title: `Item ${id}`,
    contentSummary: 'Triage this Linear close summary.',
    contentRefs: [],
    state,
    ...(plan ? { plan } : {}),
    observedAt: 1,
    createdAt: 1,
  } as Doc<'workItems'>;
}

const PLAN = {
  summary: 'Tell the manager.',
  steps: ['DM the manager.'],
  expectedOutputType: 'message',
  riskNotes: '',
  reversibility: 'reversible',
  estimatedMinutes: 2,
};

const ITEMS = [
  item('w-discovered', 'discovered'),
  item('w-claimed', 'claimed'),
  item('w-approved', 'plan-approved', PLAN),
];

function render(surfaceMode: 'mock' | 'real' | undefined): string {
  return renderToStaticMarkup(
    <WorkQueue
      agentId={'agent-1' as Id<'agents'>}
      workItems={ITEMS}
      openQuestions={[]}
      surfaces={[]}
      registeredSkillCount={1}
      charterApproved
      autonomousActions={false}
      surfaceMode={surfaceMode}
    />,
  );
}

const LOOP_ACTIONS = [
  'workActions:evaluateWorkItem',
  'workActions:draftPlan',
  'workActions:executeApprovedPlan',
];

describe('the work queue as the loop driver', (): void => {
  beforeEach((): void => {
    // The cards' clocks start intervals in their effects; they never fire here.
    vi.useFakeTimers();
  });

  afterEach((): void => {
    calls.length = 0;
    vi.useRealTimers();
  });

  it('calls none of evaluate, draft or execute in real mode', (): void => {
    render('real');
    expect(calls.filter((call) => LOOP_ACTIONS.includes(call.name))).toEqual([]);
  });

  it('calls none of them before the deployment says which mode it runs', (): void => {
    render(undefined);
    expect(calls.filter((call) => LOOP_ACTIONS.includes(call.name))).toEqual([]);
  });

  it('drives evaluation, drafting and execution in mock mode as it always has', (): void => {
    render('mock');
    expect(calls.filter((call) => LOOP_ACTIONS.includes(call.name))).toEqual([
      { name: 'workActions:evaluateWorkItem', args: { workItemId: 'w-discovered' } },
      { name: 'workActions:draftPlan', args: { workItemId: 'w-claimed' } },
      { name: 'workActions:executeApprovedPlan', args: { workItemId: 'w-approved' } },
    ]);
  });

  it('keeps the mock queue markup fixed to the base render', (): void => {
    expect(render('mock')).toMatchSnapshot();
  });
});

describe('checking for new work from the queue', (): void => {
  beforeEach((): void => {
    vi.useFakeTimers();
  });

  afterEach((): void => {
    calls.length = 0;
    vi.useRealTimers();
  });

  it('offers the check in real mode, where the server polls the surfaces, and nowhere else', (): void => {
    expect(render('real')).toContain('Check for new work');
    expect(render('mock')).not.toContain('Check for new work');
    expect(render(undefined)).not.toContain('Check for new work');
    expect(calls.filter((call) => call.name === 'workLoop:checkForNewWork')).toEqual([]);
  });

  it('says what the check did', (): void => {
    expect(checkForWorkMessage({ scheduled: 2 })).toBe(
      'Checking 2 connected surfaces now; anything new appears here within a minute.',
    );
    expect(checkForWorkMessage({ scheduled: 1 })).toBe(
      'Checking 1 connected surface now; anything new appears here within a minute.',
    );
    expect(checkForWorkMessage({ scheduled: 0, retryInMs: 29_100 })).toBe(
      'Checked under a minute ago; try again in 30 s.',
    );
    expect(checkForWorkMessage({ scheduled: 0 })).toBe('No connected work surface to check.');
  });
});
