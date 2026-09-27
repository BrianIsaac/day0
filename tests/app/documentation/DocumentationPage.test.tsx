import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  sources: [] as Array<Record<string, unknown>>,
  mode: 'real' as 'real' | 'mock',
}));

vi.mock('convex/react', () => ({
  useAction: (): (() => void) => (): void => undefined,
  useMutation: (): (() => void) => (): void => undefined,
  useQuery: (reference: unknown): unknown => {
    const name = getFunctionName(reference as never);
    if (name === 'config:surfaceMode')
      return { mode: state.mode, label: state.mode === 'real' ? 'real (local)' : 'mock' };
    if (name === 'docSources:listMine') return state.sources;
    return [];
  },
}));

import {
  AUTHOR_GUIDE_URL,
  DocumentationPage,
  ReaderSecretField,
  SourceKindHelp,
  credentialForLink,
  linkFormAfterLink,
  locatorForSourceKind,
} from '../../../app/documentation/DocumentationPage';

beforeEach((): void => {
  state.sources = [];
  state.mode = 'real';
});

it('keeps the hosted mock documentation page unchanged', (): void => {
  state.mode = 'mock';
  expect(renderToStaticMarkup(<DocumentationPage />)).toMatchSnapshot();
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
  it('clears the folder locator when another source kind is selected', (): void => {
    expect(locatorForSourceKind('mcp')).toBe('');
    expect(locatorForSourceKind('git')).toBe('');
    expect(locatorForSourceKind('urls')).toBe('');
    expect(locatorForSourceKind('folder')).toBe('.');
  });

  it('empties the label and the locator after a link, so the next source is typed, not replaced (rehearsal 2: the Notion label was a replace of "Team folder")', (): void => {
    expect(linkFormAfterLink()).toEqual({ label: '', locator: '' });
  });

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

describe('a reader secret for a private repository or wiki (E-74)', (): void => {
  it('offers the field for a git or URL source only, as a password that is never shown', (): void => {
    for (const kind of ['git', 'urls'] as const) {
      const markup = renderToStaticMarkup(<ReaderSecretField kind={kind} />);
      expect(markup).toContain('Reader secret (optional)');
      expect(markup).toContain('type="password"');
      expect(markup).toContain('name="credential"');
    }
    expect(renderToStaticMarkup(<ReaderSecretField kind="folder" />)).toBe('');
    expect(renderToStaticMarkup(<ReaderSecretField kind="mcp" />)).toBe('');
  });

  it('sends the typed secret for the kinds that take one, and nothing for a blank field or a folder', (): void => {
    expect(credentialForLink('mcp', 'value')).toBe('value');
    expect(credentialForLink('git', 'value')).toBe('value');
    expect(credentialForLink('urls', 'value')).toBe('value');
    expect(credentialForLink('git', '')).toBeUndefined();
    expect(credentialForLink('folder', 'value')).toBeUndefined();
  });

  it('lets the owner rotate or revoke a git source’s secret as an MCP source’s', (): void => {
    state.sources = [
      {
        _id: 'source-git',
        label: 'Runbooks',
        kind: 'git',
        locator: 'https://github.com/team/private-docs#main',
        status: 'synced',
        pageCount: 3,
        credentialId: 'credential-1',
      },
    ];
    const markup = renderToStaticMarkup(<DocumentationPage />);
    expect(markup).toContain('>Rotate<');
    expect(markup).toContain('>Revoke<');
  });
});

describe('the author guide', (): void => {
  it('links the guide to the page shapes day0 reads from the link form', (): void => {
    const markup = renderToStaticMarkup(<DocumentationPage />);
    expect(AUTHOR_GUIDE_URL).toBe(
      'https://github.com/BrianIsaac/day0/blob/main/docs/running/documentation.md',
    );
    expect(markup).toContain(`href="${AUTHOR_GUIDE_URL}"`);
    expect(markup).toContain('the documentation author guide');
  });
});
