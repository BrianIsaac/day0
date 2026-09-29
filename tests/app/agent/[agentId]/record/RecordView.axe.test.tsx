/** @vitest-environment jsdom */

import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The Record tab in its fuller states, checked with axe and for 44 px targets with every
 * disclosure open: the payloads, the projection, the files. The shell's own suite checks the
 * tab inside the page; this one holds the states that suite's fixture does not draw.
 */
const backend = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  record: [] as unknown[],
  status: 'CanLoadMore' as string,
}));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown): unknown => backend.queries[getFunctionName(reference as never)],
  usePaginatedQuery: () => ({
    results: backend.record,
    status: backend.status,
    isLoading: false,
    loadMore: (): void => undefined,
  }),
  useMutation: () => async (): Promise<void> => undefined,
  useAction: () => async (): Promise<void> => undefined,
}));

import { RecordView } from '../../../../../app/agent/[agentId]/record/RecordView';
import { dashboardMetrics } from '../../../../fixtures/dashboard/metrics';
import { axeViolations } from '../../../../fixtures/dom/axe';
import { asEmployee } from '../../../../fixtures/dom/employee';
import { mount, settle } from '../../../../fixtures/dom/press';
import { underTarget } from '../../../../fixtures/dom/targets';

const agentId = 'agent-1';

afterEach((): void => {
  backend.queries = {};
  backend.record = [];
  document.body.replaceChildren();
});

describe('the Record tab against the accessibility floor (N14)', (): void => {
  it.each(['CanLoadMore', 'Exhausted', 'LoadingFirstPage'])(
    'has no axe violation and a 44 px target on every control, every disclosure open, while %s',
    async (status): Promise<void> => {
      backend.status = status;
      backend.queries = {
        'memoryProjection:forAgent': { text: 'Charter 0.1: Own triage.', cut: true },
        'metrics:forAgent': dashboardMetrics(),
        'workspace:read': { 'AGENTS.md': '# Mira', 'MEMORY.md': '' },
      };
      backend.record = [
        {
          event: {
            _id: 'e2',
            _creationTime: 2,
            agentId,
            type: 'work.actions-rejected',
            payload: { workItemId: 'w1', reason: 'wrong owner', decidedVia: 'dashboard' },
            createdAt: 2,
          },
          itemTitle: 'Refresh the pipeline view',
        },
        {
          event: {
            _id: 'e1',
            _creationTime: 1,
            agentId,
            type: 'charter.approved',
            payload: { version: '0.1' },
            createdAt: 1,
          },
        },
      ];
      const view = mount(asEmployee(<RecordView />));
      await settle();
      for (const disclosure of view.container.querySelectorAll('details')) disclosure.open = true;
      await settle();
      expect(await axeViolations(view.container, ['region'])).toEqual([]);
      expect(underTarget(view.container)).toEqual([]);
      view.unmount();
    },
    30_000,
  );
});
