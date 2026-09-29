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

import { RecordView } from '../../../../../app/agent/[agentId]/record/RecordView';
import { asEmployee } from '../../../../fixtures/dom/employee';

afterEach((): void => {
  backend.queries = {};
});

describe('RecordView', () => {
  it('lists the events beside the supervision figures and the files', () => {
    backend.queries = { 'events:recent': [], 'workspace:read': { 'AGENTS.md': '' } };
    const html = renderToStaticMarkup(asEmployee(<RecordView />));
    expect(html).toContain('Live event feed');
    expect(html).toContain('Supervision metrics');
    expect(html).toContain('AGENTS.md');
  });
});
