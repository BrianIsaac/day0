import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LINEAR_TOKEN_PLACEHOLDER, notionPageTemplate, type NotionPageName } from '../../fixtures/notion-pages';
import { credentialMarker, credentialSourceRef, redactCredentials } from '../../../src/docs/redaction';
import { RedactorUnavailableError } from '../../../src/redaction/client';
import { CORPUS_SLOTS } from '../../fixtures/redaction-corpus';
import { RecordedSpanModel, ScriptedSpanModel, UnreachableSpanModel } from '../../fixtures/redaction-double';

const model = new RecordedSpanModel();
const options = { model };

describe('documentation credential redaction', (): void => {
  it('fails closed without a model rather than persist a page in the clear', async (): Promise<void> => {
    await expect(redactCredentials('# Page\n\nbody', 'Page', {})).rejects.toBeInstanceOf(RedactorUnavailableError);
    await expect(redactCredentials('# Page\n\nbody', 'Page', { model: new UnreachableSpanModel() })).rejects.toBeInstanceOf(
      RedactorUnavailableError,
    );
  });

  it('names a provider token by its grammar and stores it once', async (): Promise<void> => {
    const fixtures = [
      { title: 'Notion handbook', value: CORPUS_SLOTS.notion_token, label: 'notion connection token' },
      { title: 'Linear automation', value: CORPUS_SLOTS.linear_token, label: 'linear service token' },
      { title: 'Slack automation', value: CORPUS_SLOTS.slack_bot_token, label: 'slack bot token' },
      { title: 'Slack automation', value: CORPUS_SLOTS.slack_user_token, label: 'slack user token' },
      { title: 'Slack automation', value: CORPUS_SLOTS.slack_app_token, label: 'slack app token' },
      { title: 'Warehouse automation', value: CORPUS_SLOTS.aws_key, label: 'aws access key' },
      { title: 'Billing automation', value: CORPUS_SLOTS.stripe_key, label: 'stripe api key' },
    ];
    for (const fixture of fixtures) {
      const result = await redactCredentials(`# ${fixture.title}\n\nValue: ${fixture.value}`, fixture.title, options);
      expect(result.markdown).toContain(credentialMarker(fixture.label));
      expect(result.markdown).not.toContain(fixture.value);
      expect(result.title).toBe(fixture.title);
      expect(result.credentials).toEqual([{ label: fixture.label, plaintext: fixture.value }]);
    }
  });

  it('finds a token inside a fence, a table cell, a URL query and a JSON body', async (): Promise<void> => {
    const value = CORPUS_SLOTS.linear_token;
    for (const body of [
      `Run:\n\`\`\`\nexport KEY=${value}\n\`\`\``,
      `| Service token | ${value} |`,
      `See https://example.com/x?token=${value}&y=1 for details`,
      `{"token":"${value}","key":"value"}`,
      `Use \`${value}\` in the header.`,
    ]) {
      const result = await redactCredentials(body, 'Linear automation', options);
      expect(result.markdown).not.toContain(value);
      expect(result.credentials).toEqual([{ label: 'linear service token', plaintext: value }]);
    }
  });

  it('keeps sentence punctuation out of the stored value and redacts a token in the title', async (): Promise<void> => {
    const value = CORPUS_SLOTS.linear_token;
    const result = await redactCredentials(`Use ${value}, then rotate ${value}.`, 'Linear automation', options);
    expect(result.credentials).toEqual([{ label: 'linear service token', plaintext: value }]);
    expect(result.markdown).toBe(
      `Use ${credentialMarker('linear service token')}, then rotate ${credentialMarker('linear service token')}.`,
    );
    const title = await redactCredentials(`# Title ${CORPUS_SLOTS.notion_token}\n\nbody`, `Title ${CORPUS_SLOTS.notion_token}`, options);
    const marker = credentialMarker('notion connection token');
    expect(title.title).toBe(`Title ${marker}`);
    expect(title.markdown).toBe(`# Title ${marker}\n\nbody`);
  });

  it('stores a labelled password or key the model found, named by its line', async (): Promise<void> => {
    const looker = await redactCredentials(
      [
        '# Looker pipeline tile',
        '',
        '- Dashboard login (Looker tile): `pipeline-tile-local` (username `revops`), held by the',
        '  RevOps operations lead and rotated each quarter.',
      ].join('\n'),
      'Looker pipeline tile',
      options,
    );
    expect(looker.credentials).toEqual([{ label: 'looker pipeline tile dashboard login', plaintext: 'pipeline-tile-local' }]);
    expect(looker.markdown).toContain('<credential: looker pipeline tile dashboard login, stored>');
    expect(looker.markdown).toContain('username `revops`');
    const key = await redactCredentials('# Billing automation\n\nAPI key: runtime-contract-value-0123456789', 'Billing automation', options);
    expect(key.credentials).toEqual([{ label: 'billing api key', plaintext: 'runtime-contract-value-0123456789' }]);
    const two = await redactCredentials(
      '- Dashboard login (Looker tile): `pipeline-tile-local`\n- Warehouse password: `warehouse-read-only`',
      'Systems',
      options,
    );
    expect(two.credentials.map((row) => row.plaintext)).toEqual(['pipeline-tile-local', 'warehouse-read-only']);
    expect(two.credentials.map((row) => row.label)).toEqual(['systems dashboard login', 'systems password']);
  });

  it('leaves prose, names, counts, dates, placeholders and locations alone', async (): Promise<void> => {
    const body = [
      'Notion tokens start with ntn_ and the ntn_prefix convention is documented.',
      'Channel id: C0123456789 in #revops-asks',
      'Key contacts: Alice Smith (RevOps lead)',
      'Token budget: 20000 per run',
      'Key dates: 2026-09-03',
      'Service token: see the vault item RevOps/Linear',
      'API key: https://vault.example.com/item/123',
      '- Password rotation: quarterly, by the operations lead.',
      '- Login page: `https://looker.example/login`',
      `Bot token: Bearer ${CORPUS_SLOTS.slack_bot_token}`,
    ].join('\n');
    const result = await redactCredentials(body, 'Onboarding', options);
    expect(result.credentials).toEqual([{ label: 'slack bot token', plaintext: CORPUS_SLOTS.slack_bot_token }]);
    expect(result.markdown).toContain('Key contacts: Alice Smith');
    expect(result.markdown).toContain('Token budget: 20000');
    expect(result.markdown).toContain('ntn_prefix convention');
    expect(result.markdown).toContain(`Bot token: Bearer ${credentialMarker('slack bot token')}`);
  });

  it('is idempotent over an already redacted page and stores nothing from a placeholder', async (): Promise<void> => {
    const marker = credentialMarker('linear service token');
    const again = await redactCredentials(`Service token: ${marker}`, 'Linear automation', options);
    expect(again.markdown).toBe(`Service token: ${marker}`);
    expect(again.credentials).toEqual([]);
    // The committed template carries PASTE_LINEAR_API_KEY_HERE where the
    // operator pastes the key. It is a placeholder, and the guard reads an
    // upper-case name as one: nothing is stored until a value is pasted.
    const template = notionPageTemplate('linear-automation');
    expect(template).toContain(LINEAR_TOKEN_PLACEHOLDER);
    const placeholder = await redactCredentials(template, 'Linear automation', options);
    expect(placeholder.credentials).toEqual([]);
    const pasted = await redactCredentials(template.replace(LINEAR_TOKEN_PLACEHOLDER, CORPUS_SLOTS.linear_token), 'Linear automation', options);
    expect(pasted.credentials).toEqual([{ label: 'linear service token', plaintext: CORPUS_SLOTS.linear_token }]);
    expect(pasted.markdown).toContain(marker);
  });

  it('stores one value across the five committed handbook pages, the tile login', async (): Promise<void> => {
    const names: NotionPageName[] = ['onboarding', 'linear-automation', 'slack-day0-app', 'northstar-crm', 'looker-pipeline-tile'];
    const counts: number[] = [];
    for (const name of names) counts.push((await redactCredentials(notionPageTemplate(name), name, options)).credentials.length);
    expect(counts).toEqual([0, 0, 0, 0, 1]);
  });

  it('builds stable source refs for one and for several credentials on a page', (): void => {
    const first = { label: 'linear service token', plaintext: 'a' };
    const second = { label: 'linear service token', plaintext: 'b' };
    expect(credentialSourceRef('page', first, 1)).toBe('page');
    expect(credentialSourceRef('page', first, 2, 0)).toBe('page#credential=1-linear%20service%20token');
    expect(credentialSourceRef('page', second, 2, 1)).toBe('page#credential=2-linear%20service%20token');
  });
});

it('preserves runbook words while extracting an explicitly assigned word password', async () => {
  const words = ['linear', 'Linear', 'save_comment', 'surface', 'icon_emoji'];
  const detector = new ScriptedSpanModel((text) => words.flatMap((value) =>
    [...text.matchAll(new RegExp(`\\b${value}\\b`, 'g'))].map((match) => ({
      start: match.index, end: match.index + value.length, label: 'access token', score: 0.97,
    })),
  ));
  const body = readFileSync(new URL('../../fixtures/redaction/runbook.md', import.meta.url), 'utf8');
  const clean = await redactCredentials(body, 'Ticket runbook', { model: detector });
  expect(clean.credentials).toEqual([]);
  expect(clean.markdown).toBe(body);
  for (const value of words) {
    const secret = await redactCredentials(`Password: ${value}`, 'Test login', { model: detector });
    expect(secret.credentials.map((row) => row.plaintext)).toEqual([value]);
    expect(secret.markdown).not.toContain(`Password: ${value}`);
  }
});

it('keeps a word-shaped value in every credential assignment form a runbook uses', async () => {
  const detector = new ScriptedSpanModel((text) =>
    [...text.matchAll(/\bsunshine\b/g)].map((match) => ({
      start: match.index, end: match.index + match[0].length, label: 'password', score: 0.97,
    })),
  );
  const forms = [
    'login: sunshine',
    'Passphrase: sunshine',
    'Secret key: sunshine',
    '凭证：sunshine',
    '秘钥：sunshine',
    '{\\"password\\":\\"sunshine\\"}',
    '"body":"{\\"token\\":\\"sunshine\\"}"',
    '| Password | sunshine |',
    '| Service | Username | Password |\n|---|---|---|\n| Looker tile | revops | sunshine |',
    '```\nexport KEY=sunshine\n```',
    '```\nexport GH_PAT=sunshine\n```',
  ];
  for (const form of forms) {
    const result = await redactCredentials(form, 'Ticket runbook', { model: detector });
    expect(result.credentials.map((row) => row.plaintext), form).toEqual(['sunshine']);
    expect(result.markdown, form).not.toContain('sunshine');
  }
});

it('does not store manifest scopes even when every scope and a dotted prefix are flagged', async () => {
  const markdown = readFileSync('tests/fixtures/slack-manifest-scopes.md', 'utf8');
  const model = new ScriptedSpanModel((text) => [...text.matchAll(/[a-z]+:[a-z]+(?:\.[a-z]+)?/g)].flatMap((match) => {
    const span = { start: match.index!, end: match.index! + match[0].length, label: 'credential', score: 0.99 };
    return match[0].includes('.') ? [span, { ...span, end: span.end - 6 }] : [span];
  }));
  const result = await redactCredentials(markdown, 'Slack automation policy', { model });
  expect(result.credentials).toEqual([]);
  expect(result.markdown).toBe(markdown);
});

it('retains protection for assignments, bearer headers and userinfo', async () => {
  for (const [text, value] of [
    ['password: hunter2', 'hunter2'], ['token: abc123', 'abc123'],
    ['Authorization: Bearer x', 'x'], ['https://user:password@host/path', 'password'],
  ]) {
    const result = await redactCredentials(text, 'Access', { model: new ScriptedSpanModel(() => [{ start: text.indexOf(value), end: text.indexOf(value) + value.length, label: 'credential', score: 0.99 }]) });
    expect(result.credentials.map((credential) => credential.plaintext), text).toContain(value);
  }
});
