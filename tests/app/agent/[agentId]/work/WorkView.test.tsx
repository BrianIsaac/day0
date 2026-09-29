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

import { WorkView } from '../../../../../app/agent/[agentId]/work/WorkView';
import { asEmployee } from '../../../../fixtures/dom/employee';

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
});
