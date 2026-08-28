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
    if (name === 'mock:listDocs') {
      return [
        {
          _id: 'doc-1',
          slug: 'doc',
          title: 'Operating handbook',
          body: 'How the team works.',
          category: 'team-doc',
        },
        {
          _id: 'doc-2',
          slug: 'doc-2',
          title: 'Linear automation',
          body: 'How work enters the queue.',
          category: 'how-to-guide',
        },
      ];
    }
    return [];
  },
}));

import type { Id } from '../../../../convex/_generated/dataModel';
import {
  activeTabForEnvironment,
  MockEnvironment,
  tabFromHash,
} from '../../../../app/agent/[agentId]/MockEnvironment';

const agentId = 'agent-1' as Id<'agents'>;

describe('MockEnvironment caption and tabs', (): void => {
  it('says the surfaces are mock and shows no Surfaces tab in mock mode', (): void => {
    queries.mode = 'mock';
    const markup = renderToStaticMarkup(<MockEnvironment agentId={agentId} />);
    expect(markup).toContain('Mock work environment');
    expect(markup).toContain('Mock surfaces - when the agent runs a skill');
    expect(markup).not.toContain('Surfaces');
    expect(markup).not.toContain('real mode');
    expect(markup).toContain('Q4 Revenue Tracker');
    expect(markup).toContain('Linear-style queue');
  });

  it('shows only readable documentation and discovered surfaces in real mode', (): void => {
    queries.mode = 'real';
    const markup = renderToStaticMarkup(<MockEnvironment agentId={agentId} />);
    expect(markup).toContain('>Enterprise context<');
    expect(markup).toContain(
      'Documentation day0 can read, and the connection status of every system it has discovered',
    );
    expect(markup).toContain('>Docs<');
    expect(markup).toContain('>Surfaces<');
    expect(markup).toContain('linked documentation');
    expect(markup).toContain('connections + evidence');
    expect(markup).toContain('Operating handbook');
    expect(markup).not.toContain('>Slack<');
    expect(markup).not.toContain('>Spreadsheet<');
    expect(markup).not.toContain('>Twitter<');
    expect(markup).not.toContain('>Tickets<');
    expect(markup).not.toContain('mock-only');
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
    expect(tabFromHash('#%E0%A4%A', true)).toBeUndefined();
    expect(tabFromHash('#surfaces', false)).toBeUndefined();
    expect(tabFromHash('#slack', true)).toBeUndefined();
    expect(tabFromHash('#spreadsheet', true)).toBeUndefined();
    expect(tabFromHash('#tweet', true)).toBeUndefined();
    expect(tabFromHash('#tickets', true)).toBeUndefined();
  });

  it('keeps the active tab valid when the resolved mode changes', (): void => {
    expect(activeTabForEnvironment('surfaces', '#surfaces', false)).toBe('slack');
    expect(activeTabForEnvironment('docs', '#unknown', false)).toBe('docs');
    expect(activeTabForEnvironment('slack', '#surfaces', true)).toBe('surfaces');
    expect(activeTabForEnvironment('slack', '#unknown', true)).toBe('docs');
    expect(activeTabForEnvironment('tickets', '', true)).toBe('docs');
  });
});
