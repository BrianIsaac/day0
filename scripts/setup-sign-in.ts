/// <reference types="node" />
/**
 * `./setup.sh sign-in --provider entra|okta|google`: the company sign-in's
 * setup verb (A7, the install kit), run with the customer's IT on an
 * installation `./setup.sh --route ...` already made.
 *
 * It asks for what no flag names (the tenant, Okta domain and server, or
 * issuer; the client id; the client secret, hidden and never a flag; the
 * allowed domains; the public origin), derives the issuer from the provider's
 * preset, writes the customer-local block of the env file with a generated
 * session secret (kept when one is already set, so a second run signs nobody
 * out), turns the local key off (a customer build signs in through the
 * issuer alone), prints the two addresses to register at the issuer, pushes the
 * deployment's values (`pnpm run sync:env`, the audience before the issuer),
 * pushes the functions so the auth config takes the issuer, restarts a
 * self-hosted backend so it reads them, and runs `pnpm run check:setup`.
 *
 * It exits with the check's status, so a later verb composes with it: wave
 * 11's `./setup.sh install` runs this, then `./setup.sh access`, then the
 * checks, and stops at the first that fails.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  BROWSER_PROFILE_VAR,
  CUSTOMER_OIDC_ALLOWED_DOMAINS_VAR,
  CUSTOMER_OIDC_AUDIENCE_VAR,
  CUSTOMER_OIDC_CLIENT_SECRET_VAR,
  CUSTOMER_OIDC_ISSUER_VAR,
  CUSTOMER_SESSION_SECRET_VAR,
  PUBLIC_URL_VAR,
  parseAllowedDomains,
} from '../src/lib/customer-oidc';
import {
  CUSTOMER_OIDC_PRESETS,
  CUSTOMER_OIDC_PROVIDERS,
  entraIssuer,
  googleIssuer,
  oktaIssuer,
  type CustomerOidcProvider,
} from '../src/lib/customer-oidc-presets';
import { sessionSecretGap } from '../src/lib/customer-session';
import { publicOrigin, redirectUriOf, signedOutUriOf } from '../src/lib/customer-sign-in-settings';
import { errorMessage } from '../src/lib/errors';
import { readEnvValues, writeEnvValues } from './lib/env-file';
import { isLoopback } from './setup-route';

/** The env file the verb reads and writes, beside the setup's own. */
const ENV_FILE = '.env.local';

/** The verb's flags; anything absent is asked for. */
export interface SignInFlags {
  readonly provider?: CustomerOidcProvider;
  /** Entra's directory (tenant) id. */
  readonly tenant?: string;
  /** Okta's domain, such as `acme.okta.com`. */
  readonly oktaDomain?: string;
  /** Okta's authorisation server: `org`, `default` or a custom server's id. */
  readonly authServer?: string;
  /** Any other issuer's URL (`--provider oidc`). */
  readonly issuer?: string;
  readonly clientId?: string;
  readonly allowedDomains?: string;
  readonly publicUrl?: string;
}

/** What the verb is told: its flags, and whether to print the plan only. */
export interface SignInOptions {
  readonly signIn: SignInFlags;
  readonly dryRun: boolean;
}

/** A child process's status and output, as the setup's runner returns it. */
interface StepResult {
  readonly status: number | null;
  readonly stderr: string;
}

/** What the verb needs of the machine: the setup's own `SetupIo` provides it. */
export interface SignInIo {
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly interactive?: boolean;
  run(command: string, args: readonly string[], options?: { inherit?: boolean }): StepResult;
  ask(question: string, options?: { hidden?: boolean }): Promise<string>;
  log(line: string): void;
}

/** The verb could not go on; the message says why and what to do. */
export class SignInRefused extends Error {}

/** One step the verb runs: the command, and what it is for. */
interface SignInStep {
  readonly label: string;
  readonly args: readonly string[];
}

/** The steps that put the written values into effect, in order; a failed one stops the verb. */
const PUSH_STEPS: readonly SignInStep[] = [
  { label: 'push the sign-in values to the deployment', args: ['pnpm', 'run', 'sync:env'] },
  {
    label: 'push the functions, so the auth config takes the issuer',
    args: ['npx', 'convex', 'dev', '--once'],
  },
  { label: 'restart the backend, so it reads them', args: ['pnpm', 'run', 'convex:restart'] },
];

/** The last step, whose status the verb exits with. */
const CHECK_STEP: SignInStep = { label: 'check the setup', args: ['pnpm', 'run', 'check:setup'] };

/** Every step, in order, as the dry run prints them. */
export const SIGN_IN_STEPS: readonly SignInStep[] = [...PUSH_STEPS, CHECK_STEP];

/** The addresses `npx convex dev --once` rewrites in the env file, which the verb puts back. */
const PUSH_REWRITES = ['NEXT_PUBLIC_CONVEX_URL', 'NEXT_PUBLIC_CONVEX_SITE_URL'] as const;

/** One value the verb needs: what a flag gave, how to ask for it, and what stands if nothing does. */
interface Question {
  /** The value a flag or the environment gave, if any. */
  readonly given?: string;
  readonly text: string;
  /** The flag (or variable) that answers it without a terminal. */
  readonly flag: string;
  readonly hidden?: boolean;
  /** The value already set, kept when the answer is empty. */
  readonly fallback?: string;
}

/** Ask a question the flags did not answer, or refuse where nobody can answer it. */
async function answer(io: SignInIo, question: Question): Promise<string> {
  const { given, text, flag, hidden, fallback } = question;
  if (given !== undefined && given.trim() !== '') return given.trim();
  if (io.interactive === false) {
    if (fallback) return fallback;
    throw new SignInRefused(`${flag} is needed: nothing can be asked without a terminal.`);
  }
  const shown = fallback && !hidden ? ` [${fallback}]` : '';
  const said = (await io.ask(`${text}${shown}: `, { hidden })).trim();
  if (said !== '') return said;
  if (fallback) return fallback;
  throw new SignInRefused(`${flag} is needed.`);
}

/** The provider, from the flag or a numbered question. */
async function chooseProvider(io: SignInIo, flags: SignInFlags): Promise<CustomerOidcProvider> {
  if (flags.provider) return flags.provider;
  const offered = ['entra', 'okta', 'google'] as const;
  const menu = offered
    .map((provider, index) => `  ${index + 1}  ${CUSTOMER_OIDC_PRESETS[provider].label}`)
    .join('\n');
  const said = await answer(io, {
    text: `Which identity provider does the customer sign in with?\n${menu}\nNumber`,
    flag: '--provider entra|okta|google',
  });
  const chosen = offered[Number(said) - 1] ?? offered.find((provider) => provider === said);
  if (!chosen) throw new SignInRefused(`"${said}" is not 1, 2 or 3.`);
  return chosen;
}

/** The issuer for the provider, from its preset and the answers it needs. */
async function issuerFor(
  io: SignInIo,
  provider: CustomerOidcProvider,
  flags: SignInFlags,
): Promise<string> {
  switch (provider) {
    case 'entra':
      return entraIssuer(
        await answer(io, {
          given: flags.tenant,
          text: 'Directory (tenant) id, from the app registration',
          flag: '--tenant',
        }),
      );
    case 'okta':
      return oktaIssuer(
        await answer(io, {
          given: flags.oktaDomain,
          text: 'Okta domain, such as acme.okta.com',
          flag: '--okta-domain',
        }),
        await answer(io, {
          given: flags.authServer,
          text: "Authorisation server: 'org', 'default' or a custom server's id",
          flag: '--auth-server',
          fallback: 'org',
        }),
      );
    case 'google':
      return googleIssuer();
    case 'oidc':
      return answer(io, {
        given: flags.issuer,
        text: "The issuer's URL, exactly as its tokens carry it in iss",
        flag: '--issuer',
      });
    default: {
      const unknown: never = provider;
      throw new Error(`unhandled provider ${String(unknown)}`);
    }
  }
}

/** Everything the verb writes, resolved and checked before anything is written. */
interface ResolvedSignIn {
  readonly provider: CustomerOidcProvider;
  readonly updates: Readonly<Record<string, string>>;
  readonly publicUrl: string;
  readonly generatedSessionSecret: boolean;
}

/** A value already set in the env file, as a question's fallback, or nothing when it is empty. */
function kept(existing: Readonly<Record<string, string>>, name: string): string | undefined {
  return existing[name] ? existing[name] : undefined;
}

async function resolveSignIn(
  io: SignInIo,
  flags: SignInFlags,
  existing: Readonly<Record<string, string>>,
): Promise<ResolvedSignIn> {
  const provider = await chooseProvider(io, flags);
  const issuer = await issuerFor(io, provider, flags);
  const clientId = await answer(io, {
    given: flags.clientId,
    text: 'Application (client) id',
    flag: '--client-id',
    fallback: kept(existing, CUSTOMER_OIDC_AUDIENCE_VAR),
  });
  const clientSecret = await answer(io, {
    given: io.environment[CUSTOMER_OIDC_CLIENT_SECRET_VAR],
    text: 'Client secret (hidden; Enter keeps the one already set)',
    flag: `${CUSTOMER_OIDC_CLIENT_SECRET_VAR} in the environment`,
    hidden: true,
    fallback: kept(existing, CUSTOMER_OIDC_CLIENT_SECRET_VAR),
  });
  const domains = parseAllowedDomains(
    await answer(io, {
      given: flags.allowedDomains,
      text: 'Email domains whose people may sign in, comma-separated',
      flag: '--allowed-domains',
      fallback: kept(existing, CUSTOMER_OIDC_ALLOWED_DOMAINS_VAR),
    }),
  );
  if (domains.length === 0) throw new SignInRefused('At least one allowed domain is needed.');
  const origin = publicOrigin(
    await answer(io, {
      given: flags.publicUrl,
      text: 'The https address people reach Day0 on, through the customer’s proxy',
      flag: '--public-url',
      fallback: kept(existing, PUBLIC_URL_VAR),
    }),
  );
  if ('gap' in origin) throw new SignInRefused(origin.gap);
  if (!origin.origin.startsWith('https:') && !isLoopback(origin.origin)) {
    throw new SignInRefused(
      `${PUBLIC_URL_VAR} must be https: the session cookie and the issuer's redirect cross the network.`,
    );
  }
  const keptSecret = sessionSecretGap(existing[CUSTOMER_SESSION_SECRET_VAR]) === undefined;
  return {
    provider,
    publicUrl: origin.origin,
    generatedSessionSecret: !keptSecret,
    updates: {
      // The local key is the operator's way in under `next dev`. A customer
      // build signs people in through the issuer, `next build` refuses the key,
      // and the deployment must not accept it beside the customer's people.
      NEXT_PUBLIC_DEV_NO_AUTH: '',
      DAY0_PROFILE: 'customer-local',
      [BROWSER_PROFILE_VAR]: 'customer-local',
      [CUSTOMER_OIDC_ISSUER_VAR]: issuer,
      [CUSTOMER_OIDC_AUDIENCE_VAR]: clientId,
      [CUSTOMER_OIDC_CLIENT_SECRET_VAR]: clientSecret,
      [CUSTOMER_OIDC_ALLOWED_DOMAINS_VAR]: domains.join(','),
      [CUSTOMER_SESSION_SECRET_VAR]: keptSecret
        ? existing[CUSTOMER_SESSION_SECRET_VAR]
        : randomBytes(32).toString('base64url'),
      [PUBLIC_URL_VAR]: origin.origin,
    },
  };
}

/** The names whose values are never printed. */
const HIDDEN = new Set<string>([CUSTOMER_OIDC_CLIENT_SECRET_VAR, CUSTOMER_SESSION_SECRET_VAR]);

/** The lines that say what is written, secrets as `(hidden)`. */
function writtenLines(resolved: ResolvedSignIn): string[] {
  return Object.entries(resolved.updates).map(
    ([name, value]) => `  ${name}=${shownValue(name, value, resolved.generatedSessionSecret)}`,
  );
}

/** A value as the terminal may show it: a secret never, a generated one said to be so. */
function shownValue(name: string, value: string, generated: boolean): string {
  if (!HIDDEN.has(name)) return value;
  return name === CUSTOMER_SESSION_SECRET_VAR && generated ? '(generated, hidden)' : '(hidden)';
}

/** What to register at the issuer, and what comes after the verb. */
function registrationLines(resolved: ResolvedSignIn): string[] {
  return [
    `Register these with ${CUSTOMER_OIDC_PRESETS[resolved.provider].label} (its guide says where):`,
    `  redirect URI         ${redirectUriOf(resolved.publicUrl)}`,
    `  sign-out return URI  ${signedOutUriOf(resolved.publicUrl)}`,
  ];
}

/**
 * Run the sign-in verb.
 *
 * @param options - The flags and whether to print the plan only.
 * @param io - The machine, as the setup reaches it.
 * @returns The check's exit status; 1 when the verb itself refused or a step failed.
 */
export async function runSignIn(options: SignInOptions, io: SignInIo): Promise<number> {
  const envPath = join(io.cwd, ENV_FILE);
  if (!existsSync(envPath)) {
    io.log(
      `There is no ${ENV_FILE} here, so there is no installation to add the company sign-in to. ` +
        'Set Day0 up first: `./setup.sh --route <featherless|key|endpoint|local>`.',
    );
    return 1;
  }
  const existing = readEnvValues(envPath);
  let resolved: ResolvedSignIn;
  try {
    resolved = await resolveSignIn(io, options.signIn, existing);
  } catch (err) {
    io.log(`Nothing was written: ${errorMessage(err)}`);
    return 1;
  }
  if (options.dryRun) {
    io.log(`Dry run. ${ENV_FILE} would get:`);
    for (const line of writtenLines(resolved)) io.log(line);
    for (const line of registrationLines(resolved)) io.log(line);
    io.log('Then, in order:');
    for (const step of SIGN_IN_STEPS) io.log(`  ${step.args.join(' ')}    (${step.label})`);
    io.log('Nothing was written and nothing was run.');
    return 0;
  }
  writeEnvValues(envPath, resolved.updates);
  io.log(`Wrote the company sign-in to ${ENV_FILE}:`);
  for (const line of writtenLines(resolved)) io.log(line);
  for (const line of registrationLines(resolved)) io.log(line);

  const selfHosted = !!existing.CONVEX_SELF_HOSTED_URL;
  for (const step of PUSH_STEPS) {
    if (step.args.includes('convex:restart') && !selfHosted) continue;
    const before = readEnvValues(envPath);
    const result = runStep(io, step);
    if (step.args.includes('--once')) restoreRewrites(envPath, before);
    if (result.status !== 0) {
      io.log(`That step failed, so the verb stops here: ${result.stderr.trim() || 'no message'}`);
      return result.status ?? 1;
    }
  }
  const checked = runStep(io, CHECK_STEP);
  io.log(
    '\nThen build and start the app again (the browser reads the profile at build): ' +
      '`pnpm build`, then start it behind the proxy. With the customer’s IT, ' +
      '`pnpm check:sign-in` signs a test person in and shows each claim’s verdict.',
  );
  return checked.status ?? 1;
}

/** Run one step with its output on the terminal, saying first what it is for. */
function runStep(io: SignInIo, step: SignInStep): StepResult {
  io.log(`\n${step.args.join(' ')}    (${step.label})`);
  const [command, ...args] = step.args;
  return io.run(command, args, { inherit: true });
}

/** Put back the public addresses the push rewrote, as they were before it ran. */
function restoreRewrites(envPath: string, before: Readonly<Record<string, string>>): void {
  const after = readEnvValues(envPath);
  const restored = Object.fromEntries(
    PUSH_REWRITES.filter((name) => before[name] !== undefined && after[name] !== before[name]).map(
      (name) => [name, before[name]],
    ),
  );
  if (Object.keys(restored).length > 0) writeEnvValues(envPath, restored);
}

/** The providers the `--provider` flag takes. */
export const SIGN_IN_PROVIDERS: readonly CustomerOidcProvider[] = CUSTOMER_OIDC_PROVIDERS;
