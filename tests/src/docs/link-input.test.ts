import { describe, expect, it } from 'vitest';
import {
  readsWithOwnSecret,
  secretLabel,
  validateLinkInput,
  validateReaderSecret,
} from '../../../src/docs/link-input';

describe('documentation source validation', (): void => {
  it('validates kind-specific source fields', (): void => {
    expect(
      validateLinkInput({ label: ' Team docs ', kind: 'folder', locator: ' runbooks ' }),
    ).toEqual({ label: 'Team docs', kind: 'folder', locator: 'runbooks' });
    expect(() =>
      validateLinkInput({ label: 'Private', kind: 'folder', locator: '../private' }),
    ).toThrow('stay inside');
    expect(() =>
      validateLinkInput({
        label: 'Notion',
        kind: 'mcp',
        locator: 'http://notion-mcp:3000/mcp',
        serverKind: 'notion',
      }),
    ).not.toThrow();
  });

  it('refuses a user name or token in every remote locator, and never repeats it', (): void => {
    for (const [kind, locator] of [
      ['git', 'https://oauth2:glpat-abc@git.corp.internal/team/docs#main'],
      ['git', 'https://ghp_secret123@github.com/example/docs'],
      ['urls', 'https://docs.example.com/a\nhttps://deploy:hunter2@docs.example.com/b'],
      ['mcp', 'https://svc:hunter2@docs.example.com/mcp'],
      ['git', 'https://ghp_secret123#en@github.com/org/docs#main'],
      ['urls', 'https://hunter2#x@docs.example.com/page'],
    ] as const) {
      let message = '';
      try {
        validateLinkInput({
          label: 'Docs',
          kind,
          locator,
          ...(kind === 'mcp' ? { serverKind: 'confluence' as const } : {}),
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, locator).toContain('must not carry a user name or password');
      for (const secret of ['glpat-abc', 'ghp_secret123', 'hunter2', 'oauth2', 'deploy', 'svc']) {
        expect(message).not.toContain(secret);
      }
    }
  });

  it("refuses a plain HTTP MCP locator except Day0's own component, before a secret is stored (M16)", (): void => {
    const mcp = (locator: string) => (): unknown =>
      validateLinkInput({ label: 'Docs', kind: 'mcp', locator, serverKind: 'confluence' });
    expect(mcp('http://docs.example.com/mcp')).toThrow('must use HTTPS');
    // The component's host under another server kind is not the component.
    expect(mcp('http://docs-notion-mcp:3000/mcp')).toThrow('must use HTTPS');
    expect(mcp('https://docs.example.com/mcp')).not.toThrow();
    expect(() =>
      validateLinkInput({
        label: 'Notion',
        kind: 'mcp',
        locator: 'http://docs-notion-mcp:3000/mcp',
        serverKind: 'notion',
      }),
    ).not.toThrow();
  });
});

describe('the secret a source reads with', (): void => {
  it('refuses a reader secret a source cannot keep to one https site, and a folder’s (E-74)', (): void => {
    const folder = validateLinkInput({ label: 'Folder', kind: 'folder', locator: '.' });
    expect(() => validateReaderSecret(folder, 'value')).toThrow('takes no secret');
    const twoSites = validateLinkInput({
      label: 'Wiki',
      kind: 'urls',
      locator: 'https://wiki.example/a\nhttps://other.example/b',
    });
    expect(() => validateReaderSecret(twoSites, 'value')).toThrow('one https site');
    const plaintext = validateLinkInput({
      label: 'Wiki',
      kind: 'urls',
      locator: 'http://wiki.example/a',
    });
    expect(() => validateReaderSecret(plaintext, 'value')).toThrow('one https site');
    const oneSite = validateLinkInput({
      label: 'Wiki',
      kind: 'urls',
      locator: 'https://wiki.example/a\nhttps://wiki.example/b',
    });
    expect(() => validateReaderSecret(oneSite, 'value')).not.toThrow();
    expect(() => validateReaderSecret(oneSite, undefined)).not.toThrow();
    expect(() => validateReaderSecret(oneSite, '')).toThrow('cannot be empty');
    expect(() => validateReaderSecret(oneSite, 'first\nsecond')).toThrow('line break');
    const mcp = validateLinkInput({
      label: 'Notion',
      kind: 'mcp',
      serverKind: 'generic',
      locator: 'https://mcp.example/mcp',
    });
    expect(() => validateReaderSecret(mcp, undefined)).toThrow('Connection secret is required');
  });

  it('refuses a Feishu source without its app, with a malformed one, or at another host (14-F)', (): void => {
    const wiki = validateLinkInput({
      label: 'Wiki',
      kind: 'feishu',
      locator: ' https://open.larksuite.com/drive/folders/fldcnArchive000000000000000 ',
    });
    expect(wiki.locator).toBe(
      'https://open.larksuite.com/drive/folders/fldcnArchive000000000000000',
    );
    expect(() => validateReaderSecret(wiki, undefined)).toThrow(
      'A Feishu source needs its app ID and secret.',
    );
    expect(() => validateReaderSecret(wiki, 'cli_fixture_app')).toThrow(
      'A Feishu secret is the app ID and the app secret joined by a colon',
    );
    expect(() => validateReaderSecret(wiki, 'cli_fixture_app:fixture-app-secret')).not.toThrow();
    for (const locator of [
      'https://acme.feishu.cn/wiki/spaces/7300000000000000001',
      'https://open.feishu.cn/docx/doxcnRevOpsHandbook00000000',
      '7300000000000000001',
    ]) {
      expect(() => validateLinkInput({ label: 'Wiki', kind: 'feishu', locator }), locator).toThrow(
        'A Feishu location is',
      );
    }
    expect(() =>
      validateLinkInput({
        label: 'Wiki',
        kind: 'feishu',
        locator: 'https://open.feishu.cn/wiki/spaces/7300000000000000001',
        serverKind: 'notion',
      }),
    ).toThrow('Only MCP sources may name a server kind.');
  });

  it('takes a Confluence Cloud space at the gateway with its API token, and nothing else (15-X)', (): void => {
    const locator =
      'https://api.atlassian.com/ex/confluence/1a11d016-8984-4c3e-b9ab-142dd06acb1b/wiki/spaces/OPS';
    const space = validateLinkInput({ label: ' Ops wiki ', kind: 'confluence-v2', locator });
    expect(space).toEqual({ label: 'Ops wiki', kind: 'confluence-v2', locator });
    expect(() => validateReaderSecret(space, undefined)).toThrow(
      "A Confluence Cloud source needs its service account's API token.",
    );
    expect(() => validateReaderSecret(space, 'two words')).toThrow(
      'A Confluence token is one line with no spaces',
    );
    expect(() => validateReaderSecret(space, 'fixture-confluence-token')).not.toThrow();
    for (const refused of [
      'https://acme.atlassian.net/wiki/spaces/OPS',
      'https://api.atlassian.com/ex/jira/1a11d016-8984-4c3e-b9ab-142dd06acb1b/wiki/spaces/OPS',
      'OPS',
    ]) {
      expect(
        () => validateLinkInput({ label: 'Ops wiki', kind: 'confluence-v2', locator: refused }),
        refused,
      ).toThrow("A Confluence Cloud location is the site's cloud ID and a space");
    }
    expect(secretLabel({ label: 'Ops wiki', kind: 'confluence-v2' })).toBe('Ops wiki API token');
    expect(readsWithOwnSecret('confluence-v2')).toBe(true);
  });

  it("takes a Confluence Data Center space at the customer's server over https, with its token (15-X)", (): void => {
    const locator = 'https://wiki.acme.corp/confluence/display/OPS';
    const space = validateLinkInput({ label: 'Ops wiki', kind: 'confluence-dc', locator });
    expect(space.locator).toBe(locator);
    expect(() => validateReaderSecret(space, undefined)).toThrow(
      'A Confluence Data Center source needs a personal access token.',
    );
    expect(() => validateReaderSecret(space, 'fixture-confluence-pat')).not.toThrow();
    for (const refused of [
      'http://wiki.acme.corp/display/OPS',
      'https://wiki.acme.corp/pages/viewpage.action?pageId=4587521',
      'https://mira:secret@wiki.acme.corp/display/OPS',
    ]) {
      expect(
        () => validateLinkInput({ label: 'Ops wiki', kind: 'confluence-dc', locator: refused }),
        refused,
      ).toThrow("A Confluence Data Center location is a space's address");
    }
    expect(secretLabel({ label: 'Ops wiki', kind: 'confluence-dc' })).toBe(
      'Ops wiki personal access token',
    );
    expect(readsWithOwnSecret('confluence-dc')).toBe(true);
  });

  it('names the secret by what it is for, and lets every kind but a folder rotate one (14-F)', (): void => {
    expect(secretLabel({ label: 'Runbooks', kind: 'git' })).toBe('Runbooks reader secret');
    expect(secretLabel({ label: 'Notion', kind: 'mcp' })).toBe('Notion connection secret');
    expect(secretLabel({ label: 'RevOps wiki', kind: 'feishu' })).toBe(
      'RevOps wiki app ID and secret',
    );
    expect(
      (['mcp', 'folder', 'git', 'urls', 'feishu'] as const).filter(readsWithOwnSecret),
    ).toEqual(['mcp', 'git', 'urls', 'feishu']);
  });

  it('refuses to link a kind whose reader has not landed, before anything is stored (15-K)', (): void => {
    expect(() =>
      validateLinkInput({
        label: 'Operations site',
        kind: 'sharepoint',
        locator: 'https://contoso.sharepoint.com/sites/ops',
      }),
    ).toThrow('Day0 does not read SharePoint sources yet.');
    expect(() =>
      validateLinkInput({ label: 'Team space', kind: 'yuque', locator: 'https://www.yuque.com/t' }),
    ).toThrow('Day0 does not read Yuque sources yet.');
  });
});
