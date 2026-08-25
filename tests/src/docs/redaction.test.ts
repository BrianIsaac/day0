import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  credentialMarker,
  credentialSourceRef,
  redactCredentials,
} from '../../../src/docs/redaction';

/** Build a token-shaped value at runtime so fixtures never carry one. */
function token(prefixParts: string[], suffix: string): string {
  return `${prefixParts.join('_')}_${suffix}`;
}

describe('documentation credential redaction', (): void => {
  it('redacts every recognised token shape with a system-specific marker', (): void => {
    const fixtures = [
      {
        title: 'Notion handbook',
        value: token(['ntn'], 'contract-value'),
        label: 'notion connection token',
      },
      {
        title: 'Linear automation',
        value: token(['lin', 'api'], 'contract-value'),
        label: 'linear service token',
      },
      { title: 'Slack automation', value: `xox${'b'}-contract-value`, label: 'slack bot token' },
      { title: 'Slack automation', value: `xox${'p'}-contract-value`, label: 'slack user token' },
      { title: 'Slack automation', value: `xox${'a'}-contract-value`, label: 'slack app token' },
      {
        title: 'Notion handbook',
        value: token(['secret'], 'contract-value'),
        label: 'notion secret',
      },
    ];
    for (const fixture of fixtures) {
      const result = redactCredentials(
        `# ${fixture.title}\n\nValue: ${fixture.value}`,
        fixture.title,
      );
      expect(result.markdown).toContain(credentialMarker(fixture.label));
      expect(result.markdown).not.toContain(fixture.value);
      expect(result.credentials).toEqual([{ label: fixture.label, plaintext: fixture.value }]);
    }
  });

  it('redacts a generic labelled key line', (): void => {
    const value = 'runtime-contract-value';
    const result = redactCredentials(
      `# Billing automation\n\nAPI key: ${value}`,
      'Billing automation',
    );
    expect(result.markdown).toContain(credentialMarker('billing api key'));
    expect(result.markdown).not.toContain(value);
  });

  it('redacts the Linear automation template before it can be mirrored', (): void => {
    const template = readFileSync('docs/submission/notion-pages/linear-automation.md', 'utf8');
    const value = token(['lin', 'api'], 'runtime-contract-value');
    const page = template.replace('PASTE_LINEAR_API_KEY_HERE', value);
    const result = redactCredentials(page, 'Linear automation');
    expect(result.markdown).toContain(credentialMarker('linear service token'));
    expect(result.markdown).not.toContain(value);
    expect(result.credentials).toHaveLength(1);
    expect(credentialSourceRef('linear-page', result.credentials[0], 1)).toBe('linear-page');
  });
});
