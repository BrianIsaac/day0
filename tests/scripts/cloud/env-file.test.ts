import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  cloudEnvNames,
  cloudEnvRefusal,
  dotenvLine,
  IDENTITY_NAMES,
  parsePrivateEnv,
  PROMPTED_SETTINGS,
  REFUSED_ON_CLOUD,
  withPinnedMode,
} from '../../../scripts/cloud/env-file';
import { syncScriptKeys } from '../../../scripts/demo-bed';

/** The names the sync script manages, read off the script as the verb reads them. */
const SYNC_KEYS = syncScriptKeys(
  readFileSync(new URL('../../../scripts/sync-convex-env.sh', import.meta.url), 'utf8'),
);
const ALLOWED = cloudEnvNames(SYNC_KEYS);

/**
 * The dotenv parser the Convex CLI reads `env set`'s stdin with: the CLI's
 * own dependency, resolved from the CLI's package so the test holds the lines
 * to the exact parser that will read them.
 */
const cliDotenv = createRequire(createRequire(import.meta.url).resolve('convex/package.json'))(
  'dotenv',
) as { parse(text: string): Record<string, string> };

const CLERK = 'https://example.clerk.accounts.dev';

describe('cloudEnvNames', (): void => {
  it('takes the sync list and the identity settings, never a name refused on cloud', (): void => {
    for (const name of ['OPENAI_API_KEY', 'DAY0_SURFACE_MODE', ...IDENTITY_NAMES]) {
      expect(ALLOWED.has(name), name).toBe(true);
    }
    for (const name of Object.keys(REFUSED_ON_CLOUD)) expect(ALLOWED.has(name), name).toBe(false);
    expect(ALLOWED.has('CLERK_SECRET_KEY')).toBe(false);
  });
});

describe('parsePrivateEnv', (): void => {
  it('reads settings, quoted or not, and skips comments, blank lines and empty values', (): void => {
    const values = parsePrivateEnv(
      [
        '# the hosted deployment',
        `CLERK_JWT_ISSUER_DOMAIN=${CLERK}`,
        "OPENAI_API_KEY='sk-synthetic'",
        'export OPENAI_MODEL="gpt-5.6-terra"  ',
        'DAYTONA_API_KEY=',
        'OPENAI_JSON_MODE=prompt # GLM wants prompt injection',
        '',
      ].join('\n'),
    );
    expect(Object.fromEntries(values)).toEqual({
      CLERK_JWT_ISSUER_DOMAIN: CLERK,
      OPENAI_API_KEY: 'sk-synthetic',
      OPENAI_MODEL: 'gpt-5.6-terra',
      OPENAI_JSON_MODE: 'prompt',
    });
  });

  it('names the line it cannot read and never repeats what the line says', (): void => {
    expect(() => parsePrivateEnv('OPENAI_API_KEY=ok\nsk-leaked-secret\n')).toThrow(
      'line 2 is not a NAME=value setting',
    );
    try {
      parsePrivateEnv("OPENAI_API_KEY='sk-leaked-secret\n");
    } catch (error) {
      expect(String(error)).not.toContain('sk-leaked');
    }
    expect(() => parsePrivateEnv('A=1\nA=2\n')).toThrow('A is set twice (line 2)');
  });
});

describe('cloudEnvRefusal', (): void => {
  const valid = new Map([
    ['CLERK_JWT_ISSUER_DOMAIN', CLERK],
    ['OPENAI_API_KEY', 'sk-synthetic'],
  ]);

  it('accepts a Clerk deployment with its model key', (): void => {
    expect(cloudEnvRefusal(valid, ALLOWED)).toBeUndefined();
  });

  it('refuses the local no-auth key and the other names a cloud deployment never holds', (): void => {
    for (const name of Object.keys(REFUSED_ON_CLOUD)) {
      const refusal = cloudEnvRefusal(new Map([...valid, [name, 'x']]), ALLOWED);
      expect(refusal, name).toContain(`${name} is refused`);
    }
  });

  it("refuses an app host's key by name, without its value", (): void => {
    const refusal = cloudEnvRefusal(
      new Map([...valid, ['CLERK_SECRET_KEY', 'sk_test_x']]),
      ALLOWED,
    );
    expect(refusal).toContain('CLERK_SECRET_KEY is not a deployment setting');
    expect(refusal).not.toContain('sk_test_x');
  });

  it('needs an identity before the first push, and an OIDC issuer with its audience', (): void => {
    expect(cloudEnvRefusal(new Map([['OPENAI_API_KEY', 'x']]), ALLOWED)).toContain(
      'there is no identity setting',
    );
    expect(
      cloudEnvRefusal(
        new Map([
          ['CLERK_JWT_ISSUER_DOMAIN', CLERK],
          ['DAY0_OIDC_ISSUER', 'https://id.example.com'],
        ]),
        ALLOWED,
      ),
    ).toContain('go together');
    expect(cloudEnvRefusal(new Map([['CLERK_JWT_ISSUER_DOMAIN', `${CLERK}/`]]), ALLOWED)).toContain(
      'no trailing slash',
    );
  });

  it('reads the identity and the mode from what the deployment holds as well', (): void => {
    const held = new Map([['CLERK_JWT_ISSUER_DOMAIN', CLERK]]);
    expect(cloudEnvRefusal(new Map([['OPENAI_API_KEY', 'x']]), ALLOWED, held)).toBeUndefined();
    expect(
      cloudEnvRefusal(
        new Map([['OPENAI_API_KEY', 'x']]),
        ALLOWED,
        new Map([...held, ['DAY0_SURFACE_MODE', 'real']]),
      ),
    ).toContain('DAY0_SURFACE_MODE=real on a cloud deployment needs');
    // A name the deployment holds is kept, not added, so the allowlist does not judge it.
    expect(
      cloudEnvRefusal(valid, ALLOWED, new Map([['SOMETHING_SET_BY_HAND', 'x']])),
    ).toBeUndefined();
  });

  it('lets real mode onto a cloud deployment only for a customer issuer with a credential key', (): void => {
    expect(cloudEnvRefusal(new Map([...valid, ['DAY0_SURFACE_MODE', 'real']]), ALLOWED)).toContain(
      'DAY0_CREDENTIAL_KEY, DAY0_OIDC_ISSUER, DAY0_PROFILE=customer-local',
    );
    expect(
      cloudEnvRefusal(
        new Map([
          ['DAY0_SURFACE_MODE', 'real'],
          ['DAY0_PROFILE', 'customer-local'],
          ['DAY0_OIDC_ISSUER', 'https://id.example.com'],
          ['DAY0_OIDC_AUDIENCE', 'day0'],
          ['DAY0_CREDENTIAL_KEY', 'synthetic-credential-key'],
        ]),
        ALLOWED,
      ),
    ).toBeUndefined();
    expect(cloudEnvRefusal(new Map([...valid, ['DAY0_SURFACE_MODE', 'live']]), ALLOWED)).toContain(
      'neither mock nor real',
    );
  });
});

describe('withPinnedMode', (): void => {
  it('pins mock mode unless the settings name a mode', (): void => {
    expect(withPinnedMode(new Map()).get('DAY0_SURFACE_MODE')).toBe('mock');
    expect(withPinnedMode(new Map([['DAY0_SURFACE_MODE', 'real']])).get('DAY0_SURFACE_MODE')).toBe(
      'real',
    );
  });
});

describe('dotenvLine', (): void => {
  it.each([
    ['plain', 'sk-proj-Abc_123.def'],
    ['a URL', 'https://api.featherless.ai/v1'],
    ['spaces and a hash', 'upgrade to 0.11.0 # held'],
    ['a double quote', 'say "hello"'],
    ['a single quote and a dollar', "it's $5"],
  ])('writes %s so the CLI reads back exactly the value', (_label, value): void => {
    expect(cliDotenv.parse(dotenvLine('NAME', value))).toEqual({ NAME: value });
  });

  it('refuses a value no dotenv line holds as it is, naming only the variable', (): void => {
    expect(() => dotenvLine('KEY', 'a\'b"c')).toThrow("KEY's value carries characters");
    expect(() => dotenvLine('KEY', 'line\nbreak')).toThrow(/^KEY/);
  });
});

describe('PROMPTED_SETTINGS', (): void => {
  it('asks for every secret hidden and only for names a cloud deployment takes', (): void => {
    for (const setting of PROMPTED_SETTINGS) {
      expect(ALLOWED.has(setting.name), setting.name).toBe(true);
      if (setting.name.endsWith('_API_KEY')) expect(setting.secret, setting.name).toBe(true);
    }
    expect(PROMPTED_SETTINGS.filter((setting) => setting.required).map((s) => s.name)).toEqual([
      'CLERK_JWT_ISSUER_DOMAIN',
      'OPENAI_API_KEY',
    ]);
  });
});
