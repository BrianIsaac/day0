import { describe, expect, it } from 'vitest';
import { mergeSpans, replaceSpans, structuralSpans } from '../../../src/redaction/structural';
import { CORPUS_SLOTS } from '../../fixtures/redaction-corpus';

function found(text: string): Array<[string, string]> {
  return structuralSpans(text).map((span): [string, string] => [span.label, text.slice(span.start, span.end)]);
}

describe('the structural grammar', (): void => {
  it('takes the password segment of a connection string and nothing else of it', (): void => {
    expect(found(`DSN: postgres://app_reader:${CORPUS_SLOTS.db_password}@warehouse.internal:5432/revops`)).toEqual([
      ['connection password', CORPUS_SLOTS.db_password],
    ]);
    for (const kept of [
      'Mirror: https://reader@warehouse.internal/revops',
      'DSN: postgres://app:${DB_PASSWORD}@warehouse.internal/revops',
      'DSN: postgres://app:<password>@warehouse.internal/revops',
      'DSN: postgres://app:{{ secret }}@warehouse.internal/revops',
      'Tile: http://looker-tile:8080/ on the compose network.',
    ]) {
      expect(found(kept)).toEqual([]);
    }
  });

  it('takes a PEM body, a JSON web token and an Authorization header value', (): void => {
    expect(found(`-----BEGIN OPENSSH PRIVATE KEY-----\n${CORPUS_SLOTS.pem_body}\n-----END OPENSSH PRIVATE KEY-----`)).toEqual([
      ['private key', CORPUS_SLOTS.pem_body],
    ]);
    expect(found(`Session: ${CORPUS_SLOTS.jwt}, valid for one hour.`)).toEqual([['json web token', CORPUS_SLOTS.jwt]]);
    expect(found(`curl -H "Authorization: Bearer ${CORPUS_SLOTS.bearer_value}" https://api.example.com/v1`)).toEqual([
      ['header value', CORPUS_SLOTS.bearer_value],
    ]);
    expect(found(`Authorization: Basic ${CORPUS_SLOTS.basic_auth}`)).toEqual([['header value', CORPUS_SLOTS.basic_auth]]);
  });

  it('leaves the words Bearer and a placeholder header alone', (): void => {
    for (const kept of [
      'using a bot token Bearer header. It names the usable methods.',
      'Send `Authorization: Bearer <token>` with every call.',
      'Authorization: Bearer YOUR_TOKEN',
      'headersJson: "{\\"Authorization\\":\\"Bearer {{secret}}\\"}"',
      'Header: Bearer <credential: warehouse bearer token, stored>',
    ]) {
      expect(found(kept)).toEqual([]);
    }
  });

  it('names a provider token by its prefix grammar wherever it occurs', (): void => {
    const cases: Array<[string, string]> = [
      [CORPUS_SLOTS.linear_token, 'linear service token'],
      [CORPUS_SLOTS.slack_bot_token, 'slack bot token'],
      [CORPUS_SLOTS.slack_user_token, 'slack user token'],
      [CORPUS_SLOTS.slack_app_token, 'slack app token'],
      [CORPUS_SLOTS.slack_config_token, 'slack configuration token'],
      [CORPUS_SLOTS.notion_token, 'notion connection token'],
      [CORPUS_SLOTS.aws_key, 'aws access key'],
      [CORPUS_SLOTS.github_classic, 'github personal access token'],
      [CORPUS_SLOTS.github_fine, 'github personal access token'],
      [CORPUS_SLOTS.stripe_key, 'stripe api key'],
      [CORPUS_SLOTS.stripe_webhook, 'webhook signing secret'],
      [CORPUS_SLOTS.google_key, 'google api key'],
      [CORPUS_SLOTS.openai_key, 'openai api key'],
      [CORPUS_SLOTS.openai_plain, 'openai api key'],
      [CORPUS_SLOTS.anthropic_key, 'anthropic api key'],
    ];
    for (const [value, label] of cases) {
      expect(found(`| Service token | ${value} |`), label).toEqual([[label, value]]);
      expect(found(`Use ${value}, then rotate ${value}.`)).toEqual([
        [label, value],
        [label, value],
      ]);
    }
  });

  it('does not read a prefix named as a word, a variable name or a page id as a token', (): void => {
    for (const kept of [
      'Notion tokens start with ntn_ and the ntn_prefix convention is documented.',
      'An AKIA prefix marks an AWS access key id; ghp_ marks a classic GitHub token.',
      'Stripe keys start with sk_live_ and webhook secrets with whsec_.',
      'Set NOTION_SECRET_TOKEN_ROTATION_POLICY and LINEAR_API_KEY_OWNER in the vault.',
      'eyJhbGci.eyJzdWI.sig is not a token, only the shape of one.',
      'Page id: 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d',
      'Token: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      'Key: 2026-Q3-close',
    ]) {
      expect(found(kept)).toEqual([]);
    }
  });

  it('merges overlapping spans and replaces from the end', (): void => {
    expect(
      mergeSpans([
        { start: 5, end: 10 },
        { start: 0, end: 4 },
        { start: 6, end: 8 },
        { start: 10, end: 12 },
      ]),
    ).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 10 },
      { start: 10, end: 12 },
    ]);
    expect(replaceSpans('abcdefghij', [{ start: 1, end: 3 }, { start: 5, end: 6 }], (): string => '_')).toBe('a_de_ghij');
  });
});

describe('the labelled password grammar', (): void => {
  it('takes the value after a password-class label, quoted or bare, and the password half of a login pair', (): void => {
    const cases: Array<[string, string[]]> = [
      ['Dashboard login (Looker tile): `pipeline-tile-local` (username `revops`)', ['pipeline-tile-local']],
      ['pwd: Winter2026!', ['Winter2026!']],
      ['Passcode = 482913', ['482913']],
      ['login: revops / Sunny-Day-42', ['Sunny-Day-42']],
      ['Credentials: revops/hunter2 (rotated quarterly)', ['hunter2']],
      ['密码：revops2026', ['revops2026']],
    ];
    for (const [text, values] of cases) {
      const spans = structuralSpans(text);
      expect(spans.map((span) => text.slice(span.start, span.end)), text).toEqual(values);
      expect(spans.every((span) => span.label === 'password'), text).toBe(true);
    }
  });

  it('leaves placeholders, references, label words, prose and a bare lowercase word to the model', (): void => {
    for (const text of [
      'Password: {{secret}}',
      'password: <redacted>',
      'Password: ${LOOKER_PASSWORD}',
      'Password: YOUR_PASSWORD',
      'password: password',
      'Password: see the vault item',
      'password: sunshine',
      'password policy: rotate quarterly',
      'The tile login is revops and the password is hunter2',
      'PIN for the shared phone: 0419',
    ]) {
      expect(structuralSpans(text), text).toEqual([]);
    }
  });
});

describe('the national identifier grammar', (): void => {
  it('takes a Singapore NRIC or FIN whose check letter verifies, as an id number', (): void => {
    const text = 'Escalation note from HR: Ines Ferreira, NRIC S1234567D, FIN G1234567X, staff no. T0123456789.';
    const spans = structuralSpans(text);
    expect(spans.map((span) => [text.slice(span.start, span.end), span.kind, span.label])).toEqual([
      ['S1234567D', 'id-number', 'national id'],
      ['G1234567X', 'id-number', 'national id'],
    ]);
  });

  it('leaves a value with the shape but the wrong check letter, or inside a longer token, alone', (): void => {
    for (const text of ['S1234567A', 'ref S1234567D9', 'M1234567K is not valid', 'T1234567D']) {
      expect(structuralSpans(text), text).toEqual([]);
    }
  });
});
