import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ queries: {} as Record<string, unknown> }));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown =>
    args === 'skip' ? undefined : backend.queries[getFunctionName(reference as never)],
  useMutation: () => async (): Promise<void> => undefined,
  useAction: () => async (): Promise<void> => undefined,
}));

import type { Doc } from '../../../../../convex/_generated/dataModel';
import { WorkView } from '../../../../../app/agent/[agentId]/work/WorkView';
import { asEmployee, EMPLOYEE_ROW } from '../../../../fixtures/dom/employee';

/** A row of the employee's queue with the fields the card reads for its run. */
function workItem(id: string, fields: Record<string, unknown>): Doc<'workItems'> {
  return {
    _id: id,
    _creationTime: 10,
    agentId: EMPLOYEE_ROW._id,
    sourceCategory: 'ticket-queue',
    sourceSystem: 'linear',
    externalId: id,
    title: `Post the September close summary ${id}`,
    contentSummary: 'Post the September close summary.',
    contentRefs: [`ticket://${id}`],
    priority: 'High',
    observedAt: 10,
    createdAt: 10,
    plan: { summary: 'Post the summary.', steps: ['Post it.'] },
    ...fields,
  } as unknown as Doc<'workItems'>;
}

/** A plan approved and not started, and a run whose automatic write waits for its apply. */
const HELD_RUNS = [
  workItem('REVOPS-101', { state: 'plan-approved' }),
  workItem('REVOPS-102', {
    state: 'executing',
    applyPhase: 'auto',
    approvedIndexes: [0],
    pendingRunId: 'run-1',
    executionRunId: 'run-1',
  }),
];

afterEach((): void => {
  backend.queries = {};
});

describe('WorkView', () => {
  it('lists the queue beside the rail, the kept corrections only in real mode', () => {
    backend.queries = { 'work:listForAgent': [], 'corrections:listForAgent': [] };
    const mock = renderToStaticMarkup(asEmployee(<WorkView />));
    expect(mock).toContain('Work queue');
    expect(mock).toContain('>So far</h2>');
    expect(mock).not.toMatch(/correction/i);
    const real = renderToStaticMarkup(asEmployee(<WorkView />, { surfaceMode: 'real' }));
    expect(real).toMatch(/correction/i);
  });

  it('says each held step is held while the employee is paused, never that it is under way', () => {
    backend.queries = { 'work:listForAgent': HELD_RUNS, 'corrections:listForAgent': [] };
    const paused = renderToStaticMarkup(
      asEmployee(<WorkView />, {
        surfaceMode: 'real',
        agent: { ...EMPLOYEE_ROW, pausedAt: 5, pausedBy: 'owner' },
      }),
    );
    expect(paused).not.toContain('Starting the approved plan');
    expect(paused).not.toContain('Applying 1 action automatically');
    expect(paused.match(/Held while Mira is paused/g)).toHaveLength(2);

    const running = renderToStaticMarkup(asEmployee(<WorkView />, { surfaceMode: 'real' }));
    expect(running).toContain('Starting the approved plan');
    expect(running).toContain('Applying 1 action automatically');
    expect(running).not.toContain('Held while');
  });

  it("says a held step is held while the deployment's scheduled work is paused, and an approved write waits too", () => {
    const approvedWrite = workItem('REVOPS-103', {
      state: 'actions-pending',
      approvedIndexes: [1],
      pendingRunId: 'run-3',
      executionRunId: 'run-3',
      output: { draft: 'Posted.', actions: [] },
    });
    backend.queries = {
      'work:listForAgent': [...HELD_RUNS, approvedWrite],
      'corrections:listForAgent': [],
    };
    const html = renderToStaticMarkup(
      asEmployee(<WorkView />, { surfaceMode: 'real', scheduledWorkPaused: true }),
    );
    expect(html.match(/Held while this deployment&#x27;s scheduled work is paused/g)).toHaveLength(
      3,
    );
    expect(html).not.toContain('Applying the approved actions');

    const mock = renderToStaticMarkup(
      asEmployee(<WorkView />, {
        scheduledWorkPaused: true,
        agent: { ...EMPLOYEE_ROW, pausedAt: 5 },
      }),
    );
    expect(mock).not.toContain('Held while');
  });
});
