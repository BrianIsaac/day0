import { getFunctionName } from 'convex/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

vi.mock('convex/react', () => ({
  useAction: () => () => undefined,
  useMutation: () => () => undefined,
  useQuery: (reference: unknown) => {
    const name = getFunctionName(reference as never);
    if (name === 'surfaces:listForAgent') return [{
      _id: 'mock-surface', agentId: 'mock-agent', slug: 'linear', displayName: 'Linear',
      class: 'kanban', verdict: 'proposed', path: 'mcp', whereFound: [],
      credentialLanded: false, createdAt: 1,
    }];
    if (name === 'charters:latest') return null;
    if (name === 'config:components') return { browser: false };
    if (name === 'surfaces:installRedirectConfigured') return false;
    return [];
  },
}));

import type { Id } from '../../../../../convex/_generated/dataModel';
import { SurfacesTab } from '../../../../../app/agent/[agentId]/mock/SurfacesTab';

it('keeps the hosted mock surfaces tab output', () => {
  expect(renderToStaticMarkup(<SurfacesTab agentId={'mock-agent' as Id<'agents'>} />))
    .toMatchSnapshot();
});
