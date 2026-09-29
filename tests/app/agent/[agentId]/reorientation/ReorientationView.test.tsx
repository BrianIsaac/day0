import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ queries: {} as Record<string, unknown> }));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown =>
    args === 'skip' ? undefined : backend.queries[getFunctionName(reference as never)],
  useMutation: () => async (): Promise<void> => undefined,
  useAction: () => async (): Promise<void> => undefined,
}));

import { ReorientationView } from '../../../../../app/agent/[agentId]/reorientation/ReorientationView';
import { asEmployee } from '../../../../fixtures/dom/employee';

describe('ReorientationView', () => {
  it('says what real mode re-checks after a documentation sync, and points at Surfaces and Amend', () => {
    const html = renderToStaticMarkup(asEmployee(<ReorientationView />, { surfaceMode: 'real' }));
    expect(html).toContain('No reorientation card is open');
    expect(html).toContain('After each documentation sync');
    expect(html).toContain('href="/agent/agent-1/surfaces"');
    expect(html).toContain('href="/agent/agent-1/charter"');
    expect(html).not.toMatch(/<button/);
  });

  it('says the hosted office does not change, and points at Amend', () => {
    const html = renderToStaticMarkup(asEmployee(<ReorientationView />));
    expect(html).toContain('pages do not change');
    expect(html).toContain('href="/agent/agent-1/charter"');
  });
});
