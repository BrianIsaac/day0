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
  it('says no card is open and that the employee does not yet notice changes, pointing at Amend', () => {
    const html = renderToStaticMarkup(asEmployee(<ReorientationView />));
    expect(html).toContain('No reorientation card is open');
    expect(html).toContain('does not yet notice on its own');
    expect(html).toContain('href="/agent/agent-1/charter"');
    expect(html).not.toMatch(/<button/);
  });
});
