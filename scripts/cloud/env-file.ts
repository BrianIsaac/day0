/**
 * The Convex deployment's settings for a first cloud setup: read from a
 * private dotenv file outside the checkout, or asked for in prompts, judged
 * against what a cloud deployment may hold, and handed to
 * `npx convex env set` as a dotenv stream on stdin.
 *
 * Nothing here prints a value. A refusal names the variable and the line,
 * never what the line says, because the file holds provider keys.
 */

/** The identity settings `convex/auth.config.ts` reads off the deployment at every push. */
export const IDENTITY_NAMES: readonly string[] = [
  'CLERK_JWT_ISSUER_DOMAIN',
  'DAY0_OIDC_ISSUER',
  'DAY0_OIDC_AUDIENCE',
  'DAY0_PROFILE',
];

/**
 * Names a cloud deployment never holds, each with the reason: the local
 * no-auth key would let any holder of the local key in, an evaluation bed
 * spends the owner's model calls for the harness, the test double's
 * addresses point Slack at a fake, and the pause belongs to the verbs.
 */
export const REFUSED_ON_CLOUD: Readonly<Record<string, string>> = {
  NEXT_PUBLIC_DEV_NO_AUTH: 'no-auth mode is local-only, and a cloud deployment signs people in',
  DEV_NO_AUTH_JWKS: 'the local no-auth key has no place on a cloud deployment',
  DAY0_EVALUATION_BED: 'a public deployment is never an evaluation bed',
  DAY0_TEST_SLACK_API_URL: 'the Slack test double is for the demo bed only',
  DAY0_TEST_SLACK_AUTHORIZE_URL: 'the Slack test double is for the demo bed only',
  DAY0_CRONS_PAUSED: '`./setup.sh cloud pause` and `unpause` own it',
};

/** The mode a public deployment is pinned to when the file does not name one. */
export const PINNED_SURFACE_MODE = 'mock';

/**
 * Every name a cloud deployment may be given: the ones `scripts/sync-convex-env.sh`
 * manages for a local deployment, plus the identity settings, less the ones
 * refused on cloud.
 *
 * @param syncKeys - The sync script's `KEYS`, read off the script.
 */
export function cloudEnvNames(syncKeys: readonly string[]): ReadonlySet<string> {
  return new Set([...syncKeys, ...IDENTITY_NAMES].filter((name) => !(name in REFUSED_ON_CLOUD)));
}

/**
 * The settings a private dotenv file declares: `NAME=value` lines, a value
 * optionally in single or double quotes, `#` comments and blank lines. An
 * empty value declares nothing.
 *
 * @param text - The file.
 *
 * @throws Error naming the line, never its content, when a line is not a setting.
 */
export function parsePrivateEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '' || line.trim().startsWith('#')) return;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) throw new Error(`line ${index + 1} is not a NAME=value setting`);
    const [, name, raw] = match as unknown as [string, string, string];
    if (values.has(name)) throw new Error(`${name} is set twice (line ${index + 1})`);
    const trimmed = raw.trim();
    const quoted = /^(['"])(.*)\1$/.exec(trimmed);
    const value = quoted ? quoted[2]! : trimmed.replace(/\s+#.*$/, '');
    if (!quoted && /["']/.test(value)) {
      throw new Error(`${name} (line ${index + 1}) has an unbalanced quote`);
    }
    if (value !== '') values.set(name, value);
  });
  return values;
}

/**
 * Why these settings may not go onto a cloud deployment, or undefined when
 * they may. Every reason names variables only.
 *
 * @param values - The settings, as the file or the prompts gave them.
 * @param allowed - The names a cloud deployment may be given.
 */
export function cloudEnvRefusal(
  values: ReadonlyMap<string, string>,
  allowed: ReadonlySet<string>,
): string | undefined {
  const refused = [...values.keys()].filter((name) => name in REFUSED_ON_CLOUD);
  if (refused.length > 0) {
    return refused.map((name) => `${name} is refused: ${REFUSED_ON_CLOUD[name]}`).join('; ');
  }
  const unknown = [...values.keys()].filter((name) => !allowed.has(name));
  if (unknown.length > 0) {
    return (
      `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a deployment setting. ` +
      'The Convex deployment takes only what its functions read (the list in ' +
      'scripts/sync-convex-env.sh, and the identity settings); the app’s own keys, Clerk’s ' +
      'among them, are set on the app host.'
    );
  }
  const clerk = values.get('CLERK_JWT_ISSUER_DOMAIN');
  const oidc = values.has('DAY0_OIDC_ISSUER') && values.has('DAY0_OIDC_AUDIENCE');
  if (clerk === undefined && !oidc) {
    return (
      'there is no identity setting: a cloud deployment needs CLERK_JWT_ISSUER_DOMAIN (the Issuer ' +
      'URL of the Clerk JWT template named `convex`), or DAY0_OIDC_ISSUER with DAY0_OIDC_AUDIENCE, ' +
      'before its first push, because the auth config is read from the deployment then.'
    );
  }
  if (values.has('DAY0_OIDC_ISSUER') !== values.has('DAY0_OIDC_AUDIENCE')) {
    return 'DAY0_OIDC_ISSUER and DAY0_OIDC_AUDIENCE go together; the file sets only one.';
  }
  if (clerk !== undefined && (!/^https:\/\/[^\s/]+$/.test(clerk) || clerk.endsWith('/'))) {
    return 'CLERK_JWT_ISSUER_DOMAIN is not an https origin with no path and no trailing slash.';
  }
  const mode = values.get('DAY0_SURFACE_MODE');
  if (mode !== undefined && mode !== 'mock' && mode !== 'real') {
    return 'DAY0_SURFACE_MODE is neither mock nor real.';
  }
  if (mode === 'real') {
    const missing = ['DAY0_CREDENTIAL_KEY', 'DAY0_OIDC_ISSUER'].filter((name) => !values.has(name));
    if (values.get('DAY0_PROFILE') !== 'customer-local')
      missing.push('DAY0_PROFILE=customer-local');
    if (missing.length > 0) {
      return (
        `DAY0_SURFACE_MODE=real on a cloud deployment needs ${missing.join(', ')}: real mode ` +
        'there runs only for people a customer issuer signs in, with credentials sealed under a key.'
      );
    }
  }
  return undefined;
}

/**
 * The settings with the surface mode pinned: a public deployment says what
 * it is rather than leaning on the code's default.
 *
 * @param values - The settings.
 */
export function withPinnedMode(values: ReadonlyMap<string, string>): Map<string, string> {
  const pinned = new Map(values);
  if (!pinned.has('DAY0_SURFACE_MODE')) pinned.set('DAY0_SURFACE_MODE', PINNED_SURFACE_MODE);
  return pinned;
}

/**
 * One line of the dotenv stream `npx convex env set` reads on stdin, quoted
 * so that the CLI's parser gives back exactly the value.
 *
 * @param name - The variable.
 * @param value - Its value.
 *
 * @throws Error naming the variable when no dotenv quoting carries the value.
 */
export function dotenvLine(name: string, value: string): string {
  if (/^[A-Za-z0-9_./:@+=,-]+$/.test(value)) return `${name}=${value}`;
  if (!/['\n\r]/.test(value)) return `${name}='${value}'`;
  if (!/["\n\r\\]/.test(value)) return `${name}="${value}"`;
  throw new Error(`${name}'s value carries characters a dotenv line cannot hold as they are`);
}

/** A setting the first cloud setup asks for when no file is named. */
export interface PromptedSetting {
  readonly name: string;
  /** Asked in a hidden prompt, and never shown in a plan. */
  readonly secret: boolean;
  /** Refused when left empty. */
  readonly required: boolean;
  /** What to type, said in the question. */
  readonly hint: string;
}

/**
 * What the first cloud setup asks for without a file: the Clerk issuer, the
 * model and the optional Daytona key. Anything else goes in a file.
 */
export const PROMPTED_SETTINGS: readonly PromptedSetting[] = [
  {
    name: 'CLERK_JWT_ISSUER_DOMAIN',
    secret: false,
    required: true,
    hint: 'the Issuer URL of the Clerk JWT template named convex, no trailing slash',
  },
  {
    name: 'OPENAI_API_KEY',
    secret: true,
    required: true,
    hint: 'the model provider key, hidden',
  },
  {
    name: 'OPENAI_BASE_URL',
    secret: false,
    required: false,
    hint: 'an OpenAI-compatible endpoint; empty for api.openai.com',
  },
  {
    name: 'OPENAI_MODEL',
    secret: false,
    required: false,
    hint: 'the model id; empty for the code default',
  },
  {
    name: 'DAYTONA_API_KEY',
    secret: true,
    required: false,
    hint: 'the key that verifies authored skills on Daytona, hidden; empty for none',
  },
];
