import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSetupArguments } from '../../../scripts/setup';
import { ACCESS_KIT, type AccessKitSystem } from '../../../src/surfaces/access-kit';
import { linearKitManifest } from '../../../src/surfaces/access-kit/linear';
import { slackKitManifestTemplate } from '../../../src/surfaces/access-kit/slack';
import { decisionButtonsWords } from '../../../app/agent/[agentId]/surfaces/card-words';

/**
 * The access recipes are what we run with a customer's IT, so each is pinned to the kit
 * (`src/surfaces/access-kit/`): the same seven steps in the same order, every scope list exactly
 * the kit's for its mode, the manifest exactly the one the kit prints, every secret's lifetime in
 * the kit's words, the stdin names the verb reads, and only flags the verb takes. A page cannot
 * drift from the code.
 */

const STEPS = [
  '## 1. What IT creates',
  '## 2. The manifest or the form',
  '## 3. The scopes',
  '## 4. The allow-list',
  '## 5. The secret and its lifetime',
  '## 6. What to hand to the setup verb',
  '## 7. What check:access must show',
];

const SYSTEMS = Object.keys(ACCESS_KIT) as AccessKitSystem[];

function page(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
}

/** The fenced block after an `<!-- access-kit: <name> -->` marker. */
function pinned(text: string, name: string): string | undefined {
  const at = text.indexOf(`<!-- access-kit: ${name} -->`);
  if (at < 0) return undefined;
  return /```[a-z]*\n([\s\S]*?)```/.exec(text.slice(at))?.[1];
}

describe('the access recipes', (): void => {
  it.each(SYSTEMS)('%s has the same seven steps in the same order', (system): void => {
    const headings = page(ACCESS_KIT[system].guide)
      .split('\n')
      .filter((line) => line.startsWith('## '));
    expect(headings).toEqual(STEPS);
  });

  it.each(SYSTEMS)('%s lists exactly the kit’s scopes for each mode it offers', (system): void => {
    const text = page(ACCESS_KIT[system].guide);
    for (const mode of ACCESS_KIT[system].modes) {
      const block = pinned(text, `scopes ${mode.mode}`);
      expect(block, `${system} ${mode.mode}`).toBeDefined();
      expect(block?.split('\n').filter(Boolean)).toEqual([...mode.scopes]);
      if (mode.clientCredentialsScopes !== undefined) {
        expect(
          pinned(text, `client-credentials ${mode.mode}`)?.split('\n').filter(Boolean),
        ).toEqual([...mode.clientCredentialsScopes]);
      }
    }
  });

  it.each(SYSTEMS)('%s names every secret’s lifetime in the kit’s words', (system): void => {
    const text = page(ACCESS_KIT[system].guide).replace(/\s+/g, ' ');
    for (const mode of ACCESS_KIT[system].modes) {
      expect(text).toContain(mode.secretLifetime.words);
    }
  });

  it.each(SYSTEMS)('%s names the stdin line for every answer the verb asks', (system): void => {
    const text = page(ACCESS_KIT[system].guide);
    for (const ask of ACCESS_KIT[system].modes.flatMap((mode) => mode.asks)) {
      expect(text).toContain(`${ask.stdinName}=`);
    }
  });

  it('never tells IT that a Delete on api.slack.com ends the configuration pair, which only its lapse ends (R41X-8, R41X-R2 to R4)', (): void => {
    const text = page(ACCESS_KIT.slack.guide).replace(/\s+/g, ' ');
    expect(text).not.toMatch(/ends the pair/);
    expect(text).not.toMatch(/deleting it ends/);
    expect(text).not.toContain('Slack shows two values');
    expect(text).not.toContain('the one you generated is spent');
    expect(text).toContain('ends the access token only');
    expect(text).toContain('ends only when it lapses');
    expect(text).toContain("keep the service account's sign-in closed");
  });

  it('shows Slack’s manifest exactly as the kit prints it', (): void => {
    expect(pinned(page(ACCESS_KIT.slack.guide), 'manifest')?.trim()).toBe(
      slackKitManifestTemplate(),
    );
  });

  it('shows Linear’s shared app manifest exactly as the kit builds it for the example origin', (): void => {
    const shown = pinned(page(ACCESS_KIT.linear.guide), 'manifest shared');
    expect(JSON.parse(shown ?? '')).toEqual(
      linearKitManifest({
        appName: 'Day0',
        publicUrl: 'https://day0.acme.example',
        mode: 'shared',
      }),
    );
  });

  it.each(SYSTEMS)(
    '%s hands the setup verb only flags it takes, and never a secret as one',
    (system): void => {
      const text = page(ACCESS_KIT[system].guide);
      for (const block of text.matchAll(/```bash\n([\s\S]*?)```/g)) {
        for (const command of block[1]
          .split('\n')
          .filter((line) => line.startsWith('./setup.sh '))) {
          const words = command
            .replace(/\s+<\s*\S+$/, '')
            .replace(/<[^>]*>/g, 'value')
            .split(/\s+/)
            .slice(1);
          expect(() => parseSetupArguments(['--mode', 'real', ...words]), command).not.toThrow();
          expect(command).not.toMatch(/xox|secret=|token=/i);
        }
      }
    },
  );

  it('has the runbook walk both halves, and the README point at it in both languages', (): void => {
    const runbook = page('docs/running/install.md');
    for (const guide of [
      'sign-in-entra.md',
      'sign-in-okta.md',
      'sign-in-google.md',
      'access-slack.md',
      'access-linear.md',
      'access-mcp.md',
    ]) {
      expect(runbook).toContain(guide);
    }
    expect(runbook).toContain('./setup.sh install');
    expect(runbook).toContain('pnpm check:access');
    const readme = page('README.md');
    expect(readme.match(/docs\/running\/install\.md/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('says at the sign-in step, where the install first meets it, that an issuer certified by a private CA needs NODE_EXTRA_CA_CERTS (R41X-R5)', (): void => {
    const install = page('docs/running/install.md').replace(/\s+/g, ' ');
    const step3 =
      install.split('3. **The company sign-in**')[1]?.split('4. **The organisation')[0] ?? '';
    // The re-walk's run 1 stopped here, before step 6's proxy ever came up.
    expect(step3).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(step3).toContain('NODE_EXTRA_CA_CERTS=<the CA bundle> ./setup.sh install');
  });

  it("has the runbook's failure table cure each gap by its cause, as pnpm check:access words it (the round review's m6)", (): void => {
    const table = page('docs/running/install.md').split('## When a check fails')[1] ?? '';
    const rows = table
      .split('\n## ')[0]
      ?.split('\n')
      .filter((line) => line.startsWith('| `'));
    const row = (start: string): string | undefined =>
      rows?.find((line) => line.startsWith(`| ${start}`));
    expect(row('`scopes` GAP, missing a scope')).toContain('--correct');
    expect(row('`scopes` GAP, landed without')).toContain('land it again');
    expect(row('`scopes` GAP, landed without')).not.toContain('--correct');
    expect(row('`identity` GAP, no issuer')).toContain('land it again');
    // The round review's m13: a public client's issuer is recorded in place, ending no card.
    expect(row('`identity` GAP, no issuer')).toContain(
      '`./setup.sh access --correct <system>` records the issuer',
    );
    expect(row('`reach` GAP')).toContain('SSL_CERT_FILE');
    expect(row('`reach` WARN')).toContain('./setup.sh resume');
  });

  it('carries no em dash', (): void => {
    for (const path of [
      'docs/running/install.md',
      ...SYSTEMS.map((system) => ACCESS_KIT[system].guide),
    ]) {
      expect(page(path), path).not.toContain('\u2014');
    }
  });
});

describe('the Slack recipe and the card it describes', (): void => {
  it('quotes the title the card shows once the buttons are on (W12-R17)', (): void => {
    const text = page(ACCESS_KIT.slack.guide).replace(/\s+/g, ' ');
    const { title } = decisionButtonsWords({ available: true }, 'Mateo (Day0)');
    expect(text).toContain(`The card then says "${title}"`);
  });

  it('quotes the title the card shows while the socket service reports no live connection (D-6 (b))', (): void => {
    const text = page(ACCESS_KIT.slack.guide).replace(/\s+/g, ' ');
    const { title } = decisionButtonsWords(
      { available: false, why: 'bridge-down' },
      'Mateo (Day0)',
    );
    expect(text).toContain(`the card says "${title}"`);
  });

  it('gives the App Home toggle only for the cases a live card is in (W12X-4)', (): void => {
    const text = page(ACCESS_KIT.slack.guide).replace(/\s+/g, ' ');
    // A revoke ends every card on the connection and Day0 never installs such an app again, so
    // no live card has an app whose creating connection was revoked.
    expect(text).not.toContain('the connection that created it was revoked');
    expect(text).toContain(
      'Where Day0 cannot (the app was created with a configuration token pasted on its card, the connection that created it is marked **Needs IT** on the organisation page, or Slack refused the update), a collaborator on the app opens it',
    );
  });

  it('says a tab turned off refuses the bot too, and what turns it off (the re-walk on real Slack)', (): void => {
    const text = page(ACCESS_KIT.slack.guide).replace(/\s+/g, ' ');
    expect(text).toContain('`messages_tab_disabled`');
    expect(text).toContain('`apps.manifest.update`');
    expect(text).toContain('`app_home`');
  });
});
