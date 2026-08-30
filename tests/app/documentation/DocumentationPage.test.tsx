import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  sources: [] as Array<Record<string, unknown>>,
}));

vi.mock('convex/react', () => ({
  useAction: (): (() => void) => (): void => undefined,
  useMutation: (): (() => void) => (): void => undefined,
  useQuery: (reference: unknown): unknown => {
    const name = getFunctionName(reference as never);
    if (name === 'config:surfaceMode') return { mode: 'real', label: 'real (local)' };
    if (name === 'docSources:listMine') return state.sources;
    return [];
  },
}));

import {
  DocumentationPage,
  SourceKindHelp,
} from '../../../app/documentation/DocumentationPage';

beforeEach((): void => {
  state.sources = [];
});

describe('a source whose system discovery failed', (): void => {
  const source = {
    _id: 'source-1',
    label: 'RevOps handbook',
    kind: 'folder',
    locator: '.',
    status: 'synced',
    pageCount: 2,
  };

  it('names the failure the sync status alone would hide', (): void => {
    state.sources = [
      { ...source, lastDiscoveryError: 'Documentation discovery exceeds 500 pages.' },
    ];
    const markup = renderToStaticMarkup(<DocumentationPage />);
    // The sync itself succeeded, so nothing else on the row would say the
    // newest pages were never read for systems.
    expect(markup).toContain('synced');
    expect(markup).toContain('System discovery: Documentation discovery exceeds 500 pages.');
  });

  it('says nothing about discovery on a healthy source', (): void => {
    state.sources = [source];
    expect(renderToStaticMarkup(<DocumentationPage />)).not.toContain('System discovery:');
  });
});

describe('the link form and the components a source needs', (): void => {
  it('says a folder source needs no component running', (): void => {
    const markup = renderToStaticMarkup(<DocumentationPage />);
    expect(markup).toContain('The backend reads this location itself.');
    expect(markup).toContain('No day0 component has to be running.');
  });

  it('offers the four source kinds', (): void => {
    const markup = renderToStaticMarkup(<DocumentationPage />);
    for (const kind of ['folder', 'git', 'urls', 'mcp']) {
      expect(markup).toContain(`value="${kind}"`);
    }
  });

  it('says folder, git and URL sources need nothing running', (): void => {
    for (const kind of ['folder', 'git', 'urls'] as const) {
      const markup = renderToStaticMarkup(<SourceKindHelp kind={kind} serverKind="notion" />);
      expect(markup).toContain('No day0 component has to be running.');
    }
  });

  it('names the component and the profile for a Notion source', (): void => {
    const markup = renderToStaticMarkup(<SourceKindHelp kind="mcp" serverKind="notion" />);
    expect(markup).toContain('--profile docs-notion');
    expect(markup).toContain('http://docs-notion-mcp:3000/mcp');
    expect(markup).toContain('never displayed again');
  });

  it('says the other MCP server kinds reach a server you already run', (): void => {
    for (const serverKind of ['drive', 'generic', 'confluence'] as const) {
      const markup = renderToStaticMarkup(<SourceKindHelp kind="mcp" serverKind={serverKind} />);
      expect(markup).toContain('an MCP server you already run');
      expect(markup).toContain('no component');
      expect(markup).not.toContain('--profile');
    }
  });
});
