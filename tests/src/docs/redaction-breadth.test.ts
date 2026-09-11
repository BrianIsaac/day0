import { describe, expect, it } from 'vitest';
import { notionPageTemplate, type NotionPageName } from '../../fixtures/notion-pages';
import {
  credentialMarker,
  LABELLED_ENTROPY_FLOOR_BITS,
  looksLikeSecret,
  redactCredentials,
  shannonBits,
} from '../../../src/docs/redaction';

/**
 * Every value is assembled at runtime from parts, so no file in the
 * repository carries a string a secret scanner would report.
 */
function join(...parts: string[]): string {
  return parts.join('');
}

const MIXED = 'aB3dE5fG7hI9jK1lM2nO4pQ6rS8tU0vW';
const MIXED_LONG = `${MIXED}xY1zA2bC3dE4fG5hI6jK7lM8nO9pQ0rS`;
const HEX_40 = '3f2a9c1e7b5d4a6f8e0c2b1d9a7f6e5c4b3a2d1e';
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const NOTION_ID = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d';

const AWS = join('AK', 'IA', 'IOSFODNN7EXAMPLE');
const GITHUB_CLASSIC = join('gh', 'p_', MIXED, 'wxyz');
const GITHUB_FINE = join('github', '_pat_', MIXED.slice(0, 22), '_', MIXED_LONG.slice(0, 59));
const STRIPE_SECRET = join('sk', '_live_', MIXED.slice(0, 24));
const STRIPE_WEBHOOK = join('wh', 'sec_', MIXED);
const GOOGLE = join('AI', 'za', 'Sy', MIXED, 'x');
const OPENAI = join('sk', '-proj-', MIXED, MIXED.slice(0, 16));
const OPENAI_PLAIN = join('sk', '-', MIXED, MIXED.slice(0, 16));
const ANTHROPIC = join('sk', '-ant-', 'api03-', MIXED, MIXED.slice(0, 16));
const JWT = join(
  'eyJ',
  'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  '.',
  'eyJ',
  'zdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0',
  '.',
  'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
);
const DB_PASSWORD = join('w4reh0use', 'R3ad0nly', 'P4ss');
const BEARER_VALUE = join('opaque', MIXED.slice(0, 24));

interface Fixture {
  name: string;
  title: string;
  body: string;
  redacted: number;
  labels?: string[];
  plaintexts?: string[];
  kept?: string[];
}

const SHAPES: Fixture[] = [
  {
    name: 'an AWS access key id',
    title: 'Warehouse automation',
    body: `- Access key: ${AWS}\n- Region: ap-southeast-1`,
    redacted: 1,
    labels: ['aws access key'],
    plaintexts: [AWS],
    kept: ['Region: ap-southeast-1'],
  },
  {
    name: 'a classic GitHub personal access token',
    title: 'Release automation',
    body: `Push with ${GITHUB_CLASSIC} as the password.`,
    redacted: 1,
    labels: ['github personal access token'],
    plaintexts: [GITHUB_CLASSIC],
  },
  {
    name: 'a fine-grained GitHub personal access token',
    title: 'Release automation',
    body: `export GH_TOKEN=${GITHUB_FINE}`,
    redacted: 1,
    labels: ['github personal access token'],
    plaintexts: [GITHUB_FINE],
  },
  {
    name: 'a Stripe live secret key',
    title: 'Billing automation',
    body: `| Stripe | ${STRIPE_SECRET} |`,
    redacted: 1,
    labels: ['stripe api key'],
    plaintexts: [STRIPE_SECRET],
  },
  {
    name: 'a webhook signing secret',
    title: 'Billing automation',
    body: `Verify with ${STRIPE_WEBHOOK}.`,
    redacted: 1,
    labels: ['webhook signing secret'],
    plaintexts: [STRIPE_WEBHOOK],
  },
  {
    name: 'a Google API key',
    title: 'Maps automation',
    body: `?key=${GOOGLE}&region=sg`,
    redacted: 1,
    labels: ['google api key'],
    plaintexts: [GOOGLE],
    kept: ['&region=sg'],
  },
  {
    name: 'an OpenAI project key',
    title: 'Model access',
    body: `OPENAI_API_KEY=${OPENAI}`,
    redacted: 1,
    labels: ['openai api key'],
    plaintexts: [OPENAI],
  },
  {
    name: 'an OpenAI key without a project segment',
    title: 'Model access',
    body: `Use ${OPENAI_PLAIN} in the header.`,
    redacted: 1,
    labels: ['openai api key'],
    plaintexts: [OPENAI_PLAIN],
  },
  {
    name: 'an Anthropic key',
    title: 'Model access',
    body: `Fallback: ${ANTHROPIC}`,
    redacted: 1,
    labels: ['anthropic api key'],
    plaintexts: [ANTHROPIC],
  },
  {
    name: 'a JSON web token',
    title: 'Warehouse automation',
    body: `Session: ${JWT}, valid for one hour.`,
    redacted: 1,
    labels: ['warehouse json web token'],
    plaintexts: [JWT],
    kept: [', valid for one hour.'],
  },
  {
    name: 'the password inside a connection string',
    title: 'Warehouse automation',
    body: `DSN: postgres://app_reader:${DB_PASSWORD}@warehouse.internal:5432/revops?sslmode=require`,
    redacted: 1,
    labels: ['postgres connection secret'],
    plaintexts: [DB_PASSWORD],
    kept: ['postgres://app_reader:', '@warehouse.internal:5432/revops?sslmode=require'],
  },
  {
    name: 'the value after Bearer',
    title: 'Warehouse automation',
    body: `curl -H "Authorization: Bearer ${BEARER_VALUE}" https://api.example.com/v1`,
    redacted: 1,
    labels: ['warehouse bearer token'],
    plaintexts: [BEARER_VALUE],
    kept: ['Authorization: Bearer ', 'https://api.example.com/v1'],
  },
  {
    name: 'a labelled client secret',
    title: 'SSO automation',
    body: `Client secret: ${MIXED}`,
    redacted: 1,
    labels: ['sso client secret'],
    plaintexts: [MIXED],
  },
  {
    name: 'a labelled key with enough entropy',
    title: 'Billing automation',
    body: `API key: ${MIXED}`,
    redacted: 1,
    labels: ['billing api key'],
    plaintexts: [MIXED],
  },
  {
    name: 'a page carrying one of each shape',
    title: 'Systems',
    body: [
      `AWS: ${AWS}`,
      `GitHub: ${GITHUB_CLASSIC}`,
      `Stripe: ${STRIPE_SECRET} and ${STRIPE_WEBHOOK}`,
      `Google: ${GOOGLE}`,
      `OpenAI: ${OPENAI}`,
      `Session: ${JWT}`,
      `DSN: postgres://app:${DB_PASSWORD}@db/x`,
      `Header: Bearer ${BEARER_VALUE}`,
    ].join('\n'),
    redacted: 9,
  },
];

const NON_SHAPES: Fixture[] = [
  {
    name: 'the rotation and lifetime prose the module names',
    title: 'Linear automation',
    body: [
      '- Key rotation: quarterly',
      '- Token lifetime: 12 hours',
      '- Password rotation: quarterly, by the operations lead.',
      '- Secret rotation: annually',
    ].join('\n'),
    redacted: 0,
  },
  {
    name: 'a commit hash in prose',
    title: 'Release notes',
    body: `Fixed in ${HEX_40} on main; cherry-picked as ${HEX_40.slice(0, 12)}.`,
    redacted: 0,
  },
  {
    name: 'a UUID in prose',
    title: 'Warehouse automation',
    body: `The dataset id is ${UUID} and the run id was ${UUID}.`,
    redacted: 0,
  },
  {
    name: 'Linear issue keys, including on a key line',
    title: 'Linear automation',
    body: ['Issue key: REVOPS-7', 'Close REVOPS-12 after REVOPS-7.', 'Team key: REVOPS'].join('\n'),
    redacted: 0,
  },
  {
    name: 'Notion page ids in a URL and on an id line',
    title: 'Onboarding',
    body: [
      `https://www.notion.so/day0/Onboarding-${NOTION_ID}`,
      `Page id: ${NOTION_ID}`,
    ].join('\n'),
    redacted: 0,
  },
  {
    name: 'the words Bearer, key and token in the handbook prose',
    title: 'Slack automation policy',
    body: [
      'Authentication is a bearer token in the `Authorization` header.',
      'bot token in the `Authorization: Bearer` header.',
      'using a bot token Bearer header. It names the usable methods.',
      'Send `Authorization: Bearer <token>` with every call.',
      'Authorization: Bearer YOUR_TOKEN',
    ].join('\n'),
    redacted: 0,
  },
  {
    name: 'connection strings with no password, a reference or a placeholder',
    title: 'Warehouse automation',
    body: [
      'API: https://slack.com/api/ over HTTPS.',
      'Tile: http://looker-tile:8080/ on the compose network.',
      'Mirror: https://reader@warehouse.internal/revops',
      'DSN: postgres://app:${DB_PASSWORD}@warehouse.internal/revops',
      'DSN: postgres://app:<password>@warehouse.internal/revops',
      'DSN: postgres://app:{{ secret }}@warehouse.internal/revops',
    ].join('\n'),
    redacted: 0,
  },
  {
    name: 'labelled values below the entropy floor',
    title: 'Linear automation',
    body: [
      `Token: ${'x'.repeat(32)}`,
      `Key: ${'*'.repeat(24)}`,
      'Key: 2026-Q3-close',
      'Channel key: C0123456789',
      'Token version: v2-2026',
      'Key: abcd1234',
    ].join('\n'),
    redacted: 0,
  },
  {
    name: 'the prefixes named as words',
    title: 'Security handbook',
    body: [
      'An AKIA prefix marks an AWS access key id; ghp_ marks a classic GitHub token.',
      'Stripe keys start with sk_live_ and webhook secrets with whsec_.',
      'Google keys start with AIza, OpenAI keys with sk-, and a JWT with eyJ.',
      'eyJhbGci.eyJzdWI.sig is not a token, only the shape of one.',
    ].join('\n'),
    redacted: 0,
  },
  {
    name: 'an upper-case environment variable name carrying a legacy prefix as a word',
    title: 'Deployment',
    body: 'Set NOTION_SECRET_TOKEN_ROTATION_POLICY and LINEAR_API_KEY_OWNER in the vault.',
    redacted: 0,
  },
  {
    name: 'an already redacted page',
    title: 'Systems',
    body: [
      `DSN: postgres://app:${credentialMarker('postgres connection secret')}@db/x`,
      `Header: Bearer ${credentialMarker('warehouse bearer token')}`,
      `Access key: ${credentialMarker('aws access key')}`,
    ].join('\n'),
    redacted: 0,
  },
];

/** Count the markers a redacted body carries. */
function markerCount(markdown: string): number {
  return (markdown.match(/<credential: [^>]*, stored>/g) ?? []).length;
}

describe('documentation redaction breadth', (): void => {
  it.each(SHAPES.map((fixture): [string, Fixture] => [fixture.name, fixture]))(
    'redacts %s',
    (_name, fixture): void => {
      const result = redactCredentials(fixture.body, fixture.title);
      expect(result.credentials).toHaveLength(fixture.redacted);
      expect(markerCount(result.markdown)).toBe(fixture.redacted);
      if (fixture.labels) {
        expect(result.credentials.map((row) => row.label)).toEqual(fixture.labels);
      }
      for (const plaintext of fixture.plaintexts ?? result.credentials.map((row) => row.plaintext)) {
        expect(result.markdown).not.toContain(plaintext);
      }
      for (const kept of fixture.kept ?? []) {
        expect(result.markdown).toContain(kept);
      }
      expect(result.title).toBe(fixture.title);
    },
  );

  it.each(NON_SHAPES.map((fixture): [string, Fixture] => [fixture.name, fixture]))(
    'leaves %s alone',
    (_name, fixture): void => {
      const result = redactCredentials(fixture.body, fixture.title);
      expect(result.credentials).toEqual([]);
      expect(result.markdown).toBe(fixture.body);
    },
  );

  it('stores exactly two values across the five committed handbook pages', (): void => {
    const names: NotionPageName[] = [
      'onboarding',
      'linear-automation',
      'slack-day0-app',
      'northstar-crm',
      'looker-pipeline-tile',
    ];
    const counts = names.map((name): number => {
      return redactCredentials(notionPageTemplate(name), name).credentials.length;
    });
    expect(counts).toEqual([0, 1, 0, 0, 1]);
  });

  it('applies the entropy floor to labelled values and to nothing else', (): void => {
    expect(shannonBits('REVOPS-7')).toBeLessThan(LABELLED_ENTROPY_FLOOR_BITS);
    expect(shannonBits('x'.repeat(32))).toBe(0);
    expect(shannonBits(MIXED)).toBeGreaterThan(LABELLED_ENTROPY_FLOOR_BITS);
    expect(looksLikeSecret('REVOPS-7')).toBe(false);
    expect(looksLikeSecret('x'.repeat(32))).toBe(false);
    expect(looksLikeSecret('2026-Q3-close')).toBe(false);
    expect(looksLikeSecret(MIXED)).toBe(true);
    expect(looksLikeSecret('0123456789abcdef')).toBe(true);
    expect(looksLikeSecret('PASTE_LINEAR_API_KEY_HERE')).toBe(true);
    // The floor never reaches an unlabelled identifier: a UUID in prose is kept.
    const prose = `Run ${UUID} finished; see commit ${HEX_40}.`;
    expect(redactCredentials(prose, 'Release notes').markdown).toBe(prose);
  });

  it('redacts unlabelled high-entropy identifiers only when the generic floor is switched on', (): void => {
    const prose = `Run ${UUID} finished at commit ${HEX_40}; the page is ${NOTION_ID}.`;
    expect(redactCredentials(prose, 'Release notes').credentials).toEqual([]);
    const generic = redactCredentials(prose, 'Release notes', { genericEntropyFloor: true });
    expect(generic.credentials.map((row) => row.plaintext)).toEqual([UUID, HEX_40, NOTION_ID]);
    expect(generic.credentials.map((row) => row.label)).toEqual([
      'release notes secret',
      'release notes secret',
      'release notes secret',
    ]);
    expect(markerCount(generic.markdown)).toBe(3);
  });
});
