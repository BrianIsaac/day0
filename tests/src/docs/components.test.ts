import { describe, expect, it, vi } from 'vitest';
import {
  assertDocsComponentReachable,
  componentFor,
  DOCS_NOTION_ABSENT,
  DOCS_NOTION_LOCATOR,
  DOCS_NOTION_SERVICE,
  isBundledNotionLocator,
  serverKindHelp,
} from '../../../src/docs/components';

/** A transport that answers, the way any running HTTP server does. */
const answers = vi.fn(async (): Promise<Response> => new Response('', { status: 406 }));

/** A transport that cannot connect, the way a stopped component does. */
const silent = vi.fn(async (): Promise<Response> => {
  throw new Error('fetch failed');
});

describe('which documentation sources need a day0 component', (): void => {
  it('needs none for the three kinds the backend reads itself', (): void => {
    expect(componentFor({ kind: 'folder', locator: '.' })).toBeUndefined();
    expect(componentFor({ kind: 'git', locator: 'https://github.com/day0/handbook.git' })).toBeUndefined();
    expect(componentFor({ kind: 'urls', locator: 'https://handbook.day0.local/onboarding' })).toBeUndefined();
  });

  it('needs the Notion component for a Notion source pointed at day0', (): void => {
    expect(componentFor({ kind: 'mcp', serverKind: 'notion', locator: DOCS_NOTION_LOCATOR })).toBe(
      DOCS_NOTION_SERVICE,
    );
  });

  it('still recognises the name the service had before the rename', (): void => {
    expect(
      componentFor({ kind: 'mcp', serverKind: 'notion', locator: 'http://notion-mcp:3000/mcp' }),
    ).toBe(DOCS_NOTION_SERVICE);
    expect(isBundledNotionLocator('http://notion-mcp:3000/mcp')).toBe(true);
    expect(isBundledNotionLocator(DOCS_NOTION_LOCATOR)).toBe(true);
  });

  it('needs no component for an MCP server the enterprise already runs', (): void => {
    for (const serverKind of ['drive', 'generic', 'confluence']) {
      expect(
        componentFor({ kind: 'mcp', serverKind, locator: 'https://mcp.internal.example/mcp' }),
      ).toBeUndefined();
    }
    // Not even for Notion, when the address is somebody else's copy of it.
    expect(
      componentFor({ kind: 'mcp', serverKind: 'notion', locator: 'https://notion.internal.example/mcp' }),
    ).toBeUndefined();
    expect(isBundledNotionLocator('not a url')).toBe(false);
  });
});

describe('linking a source that needs a component', (): void => {
  it('says which component and which profile when nothing is listening', async (): Promise<void> => {
    await expect(
      assertDocsComponentReachable(
        { kind: 'mcp', serverKind: 'notion', locator: DOCS_NOTION_LOCATOR },
        silent,
      ),
    ).rejects.toThrow(DOCS_NOTION_ABSENT);
    expect(DOCS_NOTION_ABSENT).toContain('--profile docs-notion');
  });

  it('accepts any HTTP answer as the component being there', async (): Promise<void> => {
    await expect(
      assertDocsComponentReachable(
        { kind: 'mcp', serverKind: 'notion', locator: DOCS_NOTION_LOCATOR },
        answers,
      ),
    ).resolves.toBeUndefined();
  });

  it('never reaches for anything on a folder, git or URL source', async (): Promise<void> => {
    const reach = vi.fn(async (): Promise<Response> => {
      throw new Error('fetch failed');
    });
    for (const source of [
      { kind: 'folder', locator: '.' },
      { kind: 'git', locator: 'https://github.com/day0/handbook.git' },
      { kind: 'urls', locator: 'https://handbook.day0.local/onboarding' },
      { kind: 'mcp', serverKind: 'generic', locator: 'https://mcp.internal.example/mcp' },
    ]) {
      await expect(assertDocsComponentReachable(source, reach)).resolves.toBeUndefined();
    }
    expect(reach).not.toHaveBeenCalled();
  });
});

describe('what the link form says about each server kind', (): void => {
  it('names the component and the profile for Notion', (): void => {
    const help = serverKindHelp('notion');
    expect(help).toContain('--profile docs-notion');
    expect(help).toContain(DOCS_NOTION_LOCATOR);
  });

  it('says the other kinds reach a server you already run', (): void => {
    for (const serverKind of ['drive', 'generic', 'confluence']) {
      expect(serverKindHelp(serverKind)).toContain('an MCP server you already run');
      expect(serverKindHelp(serverKind)).toContain('no component');
    }
  });
});
