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

import { DocumentationView } from '../../../../../app/agent/[agentId]/documentation/DocumentationView';
import { asEmployee } from '../../../../fixtures/dom/employee';

describe('DocumentationView', () => {
  it('sends real mode to the Documentation page and the Docs on the Surfaces tab', () => {
    const html = renderToStaticMarkup(asEmployee(<DocumentationView />, { surfaceMode: 'real' }));
    expect(html).toContain('href="/documentation"');
    expect(html).toContain('href="/agent/agent-1/surfaces"');
  });

  it('says the hosted office reads its own wiki, and links no page mock mode does not have', () => {
    const html = renderToStaticMarkup(asEmployee(<DocumentationView />));
    expect(html).toContain('reads the office&#x27;s wiki and how-to guides');
    expect(html).not.toContain('href="/documentation"');
  });
});
