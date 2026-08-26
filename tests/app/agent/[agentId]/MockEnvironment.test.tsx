import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';

const queries = vi.hoisted(() => ({ mode: 'mock' as 'mock' | 'real' }));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown => {
    const name = getFunctionName(reference as never);
    if (name === 'config:surfaceMode') {
      return { mode: queries.mode, label: queries.mode === 'real' ? 'real (local)' : 'mock' };
    }
    if (args === 'skip') return undefined;
    if (name === 'surfaces:listForAgent') return [{ slug: 'linear' }];
    if (name === 'mock:listDocs') return [{ slug: 'doc' }, { slug: 'doc-2' }];
    return [];
  },
}));

import type { Id } from '../../../../convex/_generated/dataModel';
import { MockEnvironment, tabFromHash } from '../../../../app/agent/[agentId]/MockEnvironment';

const agentId = 'agent-1' as Id<'agents'>;

describe('MockEnvironment caption and tabs', (): void => {
  it('says the surfaces are mock and shows no Surfaces tab in mock mode', (): void => {
    queries.mode = 'mock';
    const markup = renderToStaticMarkup(<MockEnvironment agentId={agentId} />);
    expect(markup).toContain('Mock work environment');
    expect(markup).toContain('Mock surfaces - when the agent runs a skill');
    expect(markup).not.toContain('Surfaces');
    expect(markup).not.toContain('real mode');
  });

  it('says which tabs mirror real content and adds the Surfaces tab in real mode', (): void => {
    queries.mode = 'real';
    const markup = renderToStaticMarkup(<MockEnvironment agentId={agentId} />);
    expect(markup).toContain('>Work environment<');
    expect(markup).toContain('Real surfaces - the Docs tab mirrors the linked documentation');
    expect(markup).toContain('mock-only and stay empty');
    expect(markup).toContain('Surfaces');
    expect(markup).toContain('no Slack channels are mirrored here in real mode');
  });
});

describe('tab selection from the location hash', (): void => {
  it('names a tab from the hash the card link carries', (): void => {
    expect(tabFromHash('#surfaces', true)).toBe('surfaces');
    expect(tabFromHash('surfaces', true)).toBe('surfaces');
    expect(tabFromHash('#Docs', true)).toBe('docs');
    expect(tabFromHash('#tickets', false)).toBe('tickets');
  });

  it('ignores hashes that name no tab, and the Surfaces tab outside real mode', (): void => {
    expect(tabFromHash('', true)).toBeUndefined();
    expect(tabFromHash('#work-item-1', true)).toBeUndefined();
    expect(tabFromHash('#surfaces', false)).toBeUndefined();
  });
});
