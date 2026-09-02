import { describe, expect, it } from 'vitest';
import {
  LINEAR_TOKEN_PLACEHOLDER,
  notionPageTemplate,
  type NotionPageName,
} from '../../fixtures/notion-pages';
import {
  credentialMarker,
  credentialSourceRef,
  looksLikeSecret,
  redactCredentials,
} from '../../../src/docs/redaction';

/** Build a token-shaped value at runtime so fixtures never carry one. */
function token(prefixParts: string[], suffix: string): string {
  return `${prefixParts.join('_')}_${suffix}`;
}

const SUFFIX = 'contract0123456789abcdefghijkl';

describe('documentation credential redaction', (): void => {
  it('redacts every recognised token shape with a system-specific marker', (): void => {
    const fixtures = [
      { title: 'Notion handbook', value: token(['ntn'], SUFFIX), label: 'notion connection token' },
      {
        title: 'Linear automation',
        value: token(['lin', 'api'], SUFFIX),
        label: 'linear service token',
      },
      { title: 'Slack automation', value: `xox${'b'}-${SUFFIX}`, label: 'slack bot token' },
      { title: 'Slack automation', value: `xox${'p'}-${SUFFIX}`, label: 'slack user token' },
      { title: 'Slack automation', value: `xox${'a'}-${SUFFIX}`, label: 'slack app token' },
      { title: 'Notion handbook', value: token(['secret'], SUFFIX), label: 'notion secret' },
    ];
    for (const fixture of fixtures) {
      const result = redactCredentials(
        `# ${fixture.title}\n\nValue: ${fixture.value}`,
        fixture.title,
      );
      expect(result.markdown).toContain(credentialMarker(fixture.label));
      expect(result.markdown).not.toContain(fixture.value);
      expect(result.title).toBe(fixture.title);
      expect(result.credentials).toEqual([{ label: fixture.label, plaintext: fixture.value }]);
    }
  });

  it('finds a token inside a fence, a table cell, a URL query and a JSON body', (): void => {
    const value = token(['lin', 'api'], SUFFIX);
    const bodies = [
      `Run:\n\`\`\`\nexport KEY=${value}\n\`\`\``,
      `| Service token | ${value} |`,
      `See https://example.com/x?token=${value}&y=1 for details`,
      `{"token":"${value}","key":"value"}`,
      `Use \`${value}\` in the header.`,
    ];
    for (const body of bodies) {
      const result = redactCredentials(body, 'Linear automation');
      expect(result.markdown).not.toContain(value);
      expect(result.markdown).toContain(credentialMarker('linear service token'));
      expect(result.credentials).toEqual([{ label: 'linear service token', plaintext: value }]);
    }
  });

  it('keeps sentence punctuation out of the stored value', (): void => {
    const value = token(['lin', 'api'], SUFFIX);
    const result = redactCredentials(`Use ${value}, then rotate ${value}.`, 'Linear automation');
    expect(result.credentials).toEqual([{ label: 'linear service token', plaintext: value }]);
    expect(result.markdown).toBe(
      `Use ${credentialMarker('linear service token')}, then rotate ${credentialMarker('linear service token')}.`,
    );
  });

  it('redacts a token in the title and never lets a value into a label', (): void => {
    const value = token(['ntn'], SUFFIX);
    const result = redactCredentials(`# Title ${value}\n\nbody`, `Title ${value}`);
    const marker = credentialMarker('notion connection token');
    expect(result.title).toBe(`Title ${marker}`);
    expect(result.markdown).toBe(`# Title ${marker}\n\nbody`);
    expect(result.credentials).toEqual([{ label: 'notion connection token', plaintext: value }]);
    const generic = redactCredentials(`Service token: ${SUFFIX}${SUFFIX}`, `Access ${value}`);
    expect(generic.credentials.map((credential) => credential.label)).toEqual([
      'notion connection token',
      'system service token',
    ]);
    expect(generic.title).toBe(`Access ${marker}`);
  });

  it('redacts a generic labelled key line', (): void => {
    const value = 'runtime-contract-value-0123456789';
    const result = redactCredentials(
      `# Billing automation\n\nAPI key: ${value}`,
      'Billing automation',
    );
    expect(result.markdown).toContain(credentialMarker('billing api key'));
    expect(result.markdown).not.toContain(value);
  });

  it('leaves prose, names, counts, dates, scheme words and locations alone', (): void => {
    const body = [
      'Notion tokens start with ntn_ and the ntn_prefix convention is documented.',
      'Channel id: C0123456789 in #revops-asks',
      'Key contacts: Alice Smith (RevOps lead)',
      'Token budget: 20000 per run',
      'Key dates: 2026-09-03',
      'Service token: see the vault item RevOps/Linear',
      'API key: https://vault.example.com/item/123',
      `Bot token: Bearer xox${'b'}-${SUFFIX}`,
    ].join('\n');
    const result = redactCredentials(body, 'Onboarding');
    expect(result.credentials).toEqual([
      { label: 'slack bot token', plaintext: `xox${'b'}-${SUFFIX}` },
    ]);
    expect(result.markdown).toContain('Key contacts: Alice Smith');
    expect(result.markdown).toContain('Token budget: 20000');
    expect(result.markdown).toContain('ntn_prefix convention');
    expect(result.markdown).toContain(`Bot token: Bearer ${credentialMarker('slack bot token')}`);
    expect(looksLikeSecret('ghp_0123456789abcdef')).toBe(true);
    expect(looksLikeSecret('PASTE_LINEAR_API_KEY_HERE')).toBe(true);
    expect(looksLikeSecret('Bearer')).toBe(false);
  });

  it('keeps two values on one page distinct, in document order, with stable refs', (): void => {
    const first = token(['lin', 'api'], `aaaa${SUFFIX}`);
    const second = token(['lin', 'api'], `bbbb${SUFFIX}`);
    const result = redactCredentials(
      `Old: ${first}\nNew: ${second}\nAgain: ${first}`,
      'Linear automation',
    );
    expect(result.credentials.map((credential) => credential.plaintext)).toEqual([first, second]);
    expect(result.markdown).not.toContain(first);
    expect(result.markdown).not.toContain(second);
    const refs = result.credentials.map((credential, index) =>
      credentialSourceRef('page', credential, result.credentials.length, index),
    );
    expect(refs).toEqual([
      'page#credential=1-linear%20service%20token',
      'page#credential=2-linear%20service%20token',
    ]);
  });

  it('is idempotent over an already redacted page', (): void => {
    const marker = credentialMarker('linear service token');
    const result = redactCredentials(`Service token: ${marker}`, 'Linear automation');
    expect(result.markdown).toBe(`Service token: ${marker}`);
    expect(result.credentials).toEqual([]);
  });

  it('redacts the Linear automation template before it can be mirrored', (): void => {
    const template = notionPageTemplate('linear-automation');
    expect(template).toContain(LINEAR_TOKEN_PLACEHOLDER);
    const value = token(['lin', 'api'], `runtime${SUFFIX}`);
    const page = template.replace(LINEAR_TOKEN_PLACEHOLDER, value);
    const result = redactCredentials(page, 'Linear automation');
    expect(result.markdown).toContain(credentialMarker('linear service token'));
    expect(result.markdown).not.toContain(value);
    expect(result.credentials).toHaveLength(1);
    expect(credentialSourceRef('linear-page', result.credentials[0], 1)).toBe('linear-page');
  });

  it('stores nothing from the three value-free templates', (): void => {
    const names: NotionPageName[] = ['onboarding', 'slack-day0-app', 'northstar-crm'];
    for (const name of names) {
      const template = notionPageTemplate(name);
      const result = redactCredentials(template, name);
      expect(result.credentials).toEqual([]);
      expect(result.markdown).toBe(template);
    }
  });
});

describe('a sign-in credential the team declared on a page', (): void => {
  it('stores a memorable dashboard password that does not look random', (): void => {
    const result = redactCredentials(
      [
        '# Looker pipeline tile',
        '',
        '- Dashboard login (Looker tile): `pipeline-tile-local` (username `revops`), held by the',
        '  RevOps operations lead and rotated each quarter.',
      ].join('\n'),
      'Looker pipeline tile',
    );
    expect(result.credentials).toEqual([
      { label: 'looker pipeline tile dashboard login', plaintext: 'pipeline-tile-local' },
    ]);
    expect(result.markdown).toContain(
      '<credential: looker pipeline tile dashboard login, stored>',
    );
    expect(result.markdown).not.toContain('pipeline-tile-local');
    // The username is not a secret and the runbook needs it in the clear.
    expect(result.markdown).toContain('username `revops`');
  });

  it('leaves a declaring line whose value is prose rather than a literal', (): void => {
    const result = redactCredentials(
      '- Password rotation: quarterly, by the operations lead.\n- Login: ask the lead.',
      'Looker pipeline tile',
    );
    expect(result.credentials).toEqual([]);
    expect(result.markdown).toContain('quarterly');
    expect(result.markdown).toContain('ask the lead');
  });

  it('still requires a token or key value to look like a secret', (): void => {
    const result = redactCredentials(
      '- Key rotation: `quarterly`\n- Token lifetime: `12h`',
      'Linear automation',
    );
    expect(result.credentials).toEqual([]);
  });

  it('does not store a URL written after a login label', (): void => {
    const result = redactCredentials(
      '- Login page: `https://looker.example/login`',
      'Looker pipeline tile',
    );
    expect(result.credentials).toEqual([]);
    expect(result.markdown).toContain('https://looker.example/login');
  });

  it('takes each declared credential once when a page carries two', (): void => {
    const result = redactCredentials(
      [
        '- Dashboard login (Looker tile): `pipeline-tile-local`',
        '- Warehouse password: `warehouse-read-only`',
      ].join('\n'),
      'Systems',
    );
    expect(result.credentials.map((row) => row.plaintext)).toEqual([
      'pipeline-tile-local',
      'warehouse-read-only',
    ]);
  });
});
