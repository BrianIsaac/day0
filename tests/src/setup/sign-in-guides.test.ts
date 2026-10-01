import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSetupArguments } from '../../../scripts/setup';
import { claimVerdicts, type ClaimCheckInput } from '../../../src/lib/sign-in-check';
import { entraIssuer, googleIssuer, oktaIssuer } from '../../../src/lib/customer-oidc-presets';

/**
 * The three sign-in guides are what we run with a customer's IT, so they are
 * pinned to what the kit does: the same seven steps in the same order, the
 * flags the setup verb takes, and the claims the live check judges.
 */

const GUIDES = {
  entra: entraIssuer('3f2504e0-4f89-11d3-9a0c-0305e82c3301'),
  okta: oktaIssuer('acme.okta.com'),
  google: googleIssuer(),
} as const;

const STEPS = [
  '## 1. Register the application',
  '## 2. The redirect URI',
  '## 3. Scopes and claims',
  '## 4. Who may sign in',
  '## 5. The secret and its expiry',
  '## 6. What to hand to the setup verb',
  '## 7. What the live check must show',
];

function guide(provider: keyof typeof GUIDES): string {
  return readFileSync(
    new URL(`../../../docs/running/sign-in-${provider}.md`, import.meta.url),
    'utf8',
  );
}

describe('the sign-in guides', (): void => {
  it.each(Object.keys(GUIDES) as Array<keyof typeof GUIDES>)(
    '%s has the same seven steps in the same order',
    (provider): void => {
      const headings = guide(provider)
        .split('\n')
        .filter((line) => line.startsWith('## '));
      expect(headings).toEqual(STEPS);
    },
  );

  it.each(Object.keys(GUIDES) as Array<keyof typeof GUIDES>)(
    '%s hands the setup verb only flags it takes',
    (provider): void => {
      // The secret is asked for in a hidden prompt: on the command line it stays in shell history.
      expect(guide(provider)).not.toMatch(/DAY0_OIDC_CLIENT_SECRET=/);
      const block = /```bash\n(\.\/setup\.sh sign-in[\s\S]*?)```/.exec(guide(provider))?.[1] ?? '';
      const words = block
        .replace(/\\\n/g, ' ')
        .replace(/<[^>]*>/g, 'value')
        .split(/\s+/)
        .filter((word) => word !== '');
      expect(words.slice(0, 2)).toEqual(['./setup.sh', 'sign-in']);
      const options = parseSetupArguments(['--mode', 'real', ...words.slice(1)]);
      expect(options.command).toBe('sign-in');
      expect(options.signIn?.provider).toBe(provider);
    },
  );

  it.each(Object.keys(GUIDES) as Array<keyof typeof GUIDES>)(
    "%s's table names every claim the live check judges for it",
    (provider): void => {
      const input: ClaimCheckInput = {
        issuer: GUIDES[provider],
        clientId: 'day0-app',
        allowedDomains: ['acme.com'],
        emailTrusted: false,
        refreshTokenGranted: true,
      };
      const text = guide(provider);
      for (const verdict of claimVerdicts({}, input)) {
        expect(text, verdict.claim).toContain(`| \`${verdict.claim}\` |`);
      }
      expect(text).toContain('| `whoAmI` |');
    },
  );
});
