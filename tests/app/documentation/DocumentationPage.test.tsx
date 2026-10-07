/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { focusedName, mount, press, said } from '../../fixtures/dom/press';

const state = vi.hoisted(() => ({
  sources: [] as Array<Record<string, unknown>>,
  mode: 'real' as 'real' | 'mock',
  /** Mutations that reject, by function name, with the text they reject with. */
  refusals: {} as Record<string, string>,
}));

vi.mock('convex/react', () => ({
  useAction: (): (() => void) => (): void => undefined,
  useMutation:
    (reference: unknown): (() => Promise<void>) =>
    async (): Promise<void> => {
      const refusal = state.refusals[getFunctionName(reference as never)];
      if (refusal !== undefined) throw new Error(refusal);
    },
  useQuery: (reference: unknown): unknown => {
    const name = getFunctionName(reference as never);
    if (name === 'config:surfaceMode')
      return { mode: state.mode, label: state.mode === 'real' ? 'real (local)' : 'mock' };
    if (name === 'docSources:listMine') return state.sources;
    return [];
  },
}));

import { DocumentationPage } from '../../../app/documentation/DocumentationPage';
import {
  AUTHOR_GUIDE_URL,
  FEISHU_GUIDE_URL,
  FeishuAppFields,
  ReaderSecretField,
  SourceKindHelp,
  credentialForLink,
  linkFormAfterLink,
  locatorForSourceKind,
} from '../../../app/documentation/LinkSourceForm';

beforeEach((): void => {
  state.sources = [];
  state.mode = 'real';
  state.refusals = {};
});

it('leaves the one main landmark to the layout', (): void => {
  expect(renderToStaticMarkup(<DocumentationPage />)).not.toMatch(/<main[\s>]/);
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
    expect(markup).toMatch(/<span[^>]*>Read<\/span>/);
    expect(markup).toContain('System discovery: Documentation discovery exceeds 500 pages.');
  });

  it('says nothing about discovery on a healthy source', (): void => {
    state.sources = [source];
    expect(renderToStaticMarkup(<DocumentationPage />)).not.toContain('System discovery:');
    expect(renderToStaticMarkup(<DocumentationPage />)).not.toContain('People from its pages:');
  });

  it('names a failed people extraction, which nothing else read (W13-R9)', (): void => {
    state.sources = [
      { ...source, lastPeopleExtractionError: 'The people extraction did not answer in time.' },
    ];
    expect(renderToStaticMarkup(<DocumentationPage />)).toContain(
      'People from its pages: The people extraction did not answer in time.',
    );
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

  it('offers the five source kinds', (): void => {
    const markup = renderToStaticMarkup(<DocumentationPage />);
    for (const kind of ['folder', 'git', 'urls', 'mcp', 'feishu']) {
      expect(markup).toContain(`value="${kind}"`);
    }
  });

  it('says folder, git and URL sources need nothing running', (): void => {
    for (const kind of ['folder', 'git', 'urls'] as const) {
      const markup = renderToStaticMarkup(<SourceKindHelp kind={kind} serverKind="notion" />);
      expect(markup).toContain('No day0 component has to be running.');
    }
  });

  it('says a Feishu source needs nothing running and links the guide for the app IT sets up (14-F)', (): void => {
    const markup = renderToStaticMarkup(<SourceKindHelp kind="feishu" serverKind="notion" />);
    expect(markup).toContain('No day0 component has to be running.');
    expect(markup).toContain(FEISHU_GUIDE_URL);
    expect(FEISHU_GUIDE_URL).toMatch(/\/docs\/running\/reader-feishu\.md$/);
  });

  it('asks a Feishu source for its region, its app ID and its secret, the secret as a password (14-F)', (): void => {
    const markup = renderToStaticMarkup(<FeishuAppFields />);
    expect(markup).toContain('value="feishu"');
    expect(markup).toContain('value="lark"');
    expect(markup).toMatch(
      /id="feishu-app-secret"[^>]*type="password"|type="password"[^>]*id="feishu-app-secret"/,
    );
    expect(credentialForLink('feishu', 'cli_fixture_app:fixture-app-secret')).toBe(
      'cli_fixture_app:fixture-app-secret',
    );
    expect(locatorForSourceKind('feishu')).toBe('');
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

  it('names a Feishu source and asks for its app ID and secret when it is rotated (14-F)', async (): Promise<void> => {
    state.sources = [
      {
        _id: 'source-feishu',
        label: 'RevOps wiki',
        kind: 'feishu',
        locator: 'https://open.feishu.cn/wiki/spaces/7300000000000000001',
        status: 'synced',
        pageCount: 4,
        credentialId: 'credential-1',
      },
    ];
    const view = mount(<DocumentationPage />);
    expect(view.container.textContent).toContain('Feishu · https://open.feishu.cn/wiki/spaces/');
    await press(view.container, 'Rotate the secret for RevOps wiki');
    const field = view.container.querySelector<HTMLInputElement>('#rotate-source-feishu');
    expect(field?.placeholder).toBe('New app ID and secret, as app ID:secret');
    expect(view.container.querySelector('label[for="rotate-source-feishu"]')?.textContent).toBe(
      'New app ID and secret, as app ID:secret',
    );
    view.unmount();
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

describe('a source action the backend refuses', (): void => {
  const source = {
    _id: 'source-1',
    label: 'RevOps handbook',
    kind: 'folder',
    locator: '.',
    status: 'synced',
    pageCount: 2,
  };

  // Unlink is destructive, so it asks once more before it sends (P6-7).
  it.each([
    ['Re-sync', 'docSources:resync', []],
    ['Unlink', 'docSources:unlink', ['Confirm unlink']],
  ])('shows why %s was refused on the page', async (label, name, confirm): Promise<void> => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    state.sources = [source];
    state.refusals = {
      [name]: `[CONVEX M(${name})] [Request ID: 1] Server Error\nUncaught Error: Documentation source not found.\n    at handler (../convex/docSources.ts:1:1)`,
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act((): void => root.render(<DocumentationPage />));

    for (const step of [label, ...confirm]) {
      const button = [...container.querySelectorAll('button')].find(
        (candidate) => candidate.textContent === step,
      );
      expect(button).toBeDefined();
      await act(async (): Promise<void> => {
        button?.click();
      });
    }

    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Documentation source not found.',
    );
    expect(container.textContent).not.toContain('Request ID');
    act((): void => root.unmount());
    container.remove();
  });
});

describe('the linked sources for a keyboard and a screen reader (step 45, P6-7)', (): void => {
  const source = {
    _id: 'source-1',
    label: 'RevOps handbook',
    kind: 'folder',
    locator: '.',
    status: 'synced',
    pageCount: 2,
  };

  it('asks before Unlink with focus on Keep, returns focus to Unlink on Keep, and says what an unlink did', async (): Promise<void> => {
    state.sources = [source];
    const view = mount(<DocumentationPage />);
    await press(view.container, `Unlink ${source.label}`);
    expect(focusedName()).toBe('Keep it linked');
    await press(view.container, 'Keep it linked');
    expect(focusedName()).toBe(`Unlink ${source.label}`);

    await press(view.container, `Unlink ${source.label}`);
    await press(view.container, 'Confirm unlink');
    expect(said(view.container)).toEqual([
      `Unlinked ${source.label}: its pages leave every employee's reading.`,
    ]);
    view.unmount();
  });

  it("keeps a refused revoke's confirmation open with focus on it, and returns to Revoke once one lands", async (): Promise<void> => {
    state.sources = [{ ...source, credentialId: 'credential-1' }];
    state.refusals = {
      'credentials:revoke': `[CONVEX M(credentials:revoke)] [Request ID: 1] Server Error\nUncaught Error: Credential is already revoked.\n    at handler (../convex/credentials.ts:1:1)`,
    };
    const view = mount(<DocumentationPage />);
    await press(view.container, `Revoke the secret for ${source.label}`);
    await press(view.container, 'Confirm revoke');
    expect(said(view.container)).toEqual(['Credential is already revoked.']);
    expect(focusedName()).toBe('Confirm revoke');

    state.refusals = {};
    await press(view.container, 'Confirm revoke');
    expect(view.container.querySelector('[role="group"]')).toBeNull();
    expect(focusedName()).toBe(`Revoke the secret for ${source.label}`);
    view.unmount();
  });

  it('labels every field of the link form in the page, and gives each control a 44 px target', (): void => {
    state.sources = [source];
    const view = mount(<DocumentationPage />);
    for (const id of ['source-kind', 'source-label', 'source-locator']) {
      expect(view.container.querySelector(`label[for="${id}"]`)?.textContent).not.toBe('');
    }
    for (const control of view.container.querySelectorAll('button, input, select')) {
      expect(control.className).toMatch(/\bmin-h-11\b/);
    }
    view.unmount();
  });
});
