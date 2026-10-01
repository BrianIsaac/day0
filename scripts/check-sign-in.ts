/// <reference types="node" />
/**
 * The company sign-in's checks (the customer-local profile, A7), in two parts.
 *
 * `signInSetupChecks` is the customer-local block of `pnpm check:setup`: the
 * values the sign-in needs, the issuer's discovery document fetched from this
 * machine and from inside the backend container (Convex fetches the issuer's
 * keys from there, so a firewall that admits the host and not the container
 * fails every sign-in), its `issuer` equal to `DAY0_OIDC_ISSUER` byte for
 * byte, `DAY0_PUBLIC_URL` https, and the values pushed to the deployment equal
 * to the file's. It never sends a secret anywhere and never prints one.
 *
 * `pnpm check:sign-in` is the live check run with the customer's IT:
 *
 *   pnpm check:sign-in [env file] [--timeout <seconds>] [--report]
 *
 * It prints a one-time link (ten minutes, sealed with the session secret, so
 * only this install's server opens it), waits on a listener on this machine,
 * and the operator signs in through the link as a test person in a private
 * window. The callback, in this mode only, judges each claim that matters
 * (`iss`, `aud`, `sub`, `email`, `email_verified` or `xms_edov`, `hd` or `tid`,
 * the lifetime, the refresh token), asks the deployment `config.whoAmI` with
 * the token, shows the verdicts on the page and posts them back here. Nobody
 * is signed in. `--report` prints the verdicts (claim names and verdicts, no
 * values) as one JSON document for the support bundle. It exits 0 when every
 * line passes or is a note, 1 otherwise.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import {
  BROWSER_PROFILE_VAR,
  CUSTOMER_OIDC_ALLOWED_DOMAINS_VAR,
  CUSTOMER_OIDC_AUDIENCE_VAR,
  CUSTOMER_OIDC_CLIENT_SECRET_VAR,
  CUSTOMER_OIDC_EMAIL_TRUSTED_VAR,
  CUSTOMER_OIDC_ISSUER_VAR,
  CUSTOMER_SESSION_SECRET_VAR,
  PUBLIC_URL_VAR,
  parseAllowedDomains,
} from '../src/lib/customer-oidc';
import { sessionSecretGap } from '../src/lib/customer-session';
import {
  customerSignInGaps,
  publicOrigin,
  redirectUriOf,
  signedOutUriOf,
} from '../src/lib/customer-sign-in-settings';
import { errorMessage } from '../src/lib/errors';
import {
  CHECK_TICKET_SECONDS,
  sealCheckTicket,
  type CheckTicket,
  type SignInCheckReport,
} from '../src/lib/sign-in-check';
import { readEnvValues } from './lib/env-file';
import { firstLine } from './model-reach';
import { isLoopback } from './setup-route';

type Values = Readonly<Record<string, string>>;

/** How one check reads: passed, worth saying, or a gap. */
export type CheckStatus = 'ok' | 'warn' | 'gap';

/** The checks the setup block makes, by name, as the support report lists them. */
export const SIGN_IN_CHECKS = [
  'browser-profile',
  'client-secret',
  'allowed-domains',
  'session-secret',
  'public-url',
  'discovery-from-host',
  'discovery-from-container',
  'deployment-values',
] as const;

/** One of {@link SIGN_IN_CHECKS}. */
export type SignInCheckName = (typeof SIGN_IN_CHECKS)[number];

/** One check's verdict and the line that says it. */
export interface SignInCheck {
  readonly name: SignInCheckName;
  readonly status: CheckStatus;
  readonly line: string;
}

/** What fetching the discovery document came to: an HTTP answer, or the reason there was none. */
export type IssuerFetch =
  | { readonly status: number; readonly body: string }
  | { readonly error: string };

/** The deployment's env as `npx convex env list` printed it, or why it could not be read. */
export type DeploymentRead =
  | { readonly values: Readonly<Record<string, string>> }
  | { readonly error: string };

/** What the setup check asked outside this process; an absent one was not asked. */
export interface SignInProbes {
  readonly host?: IssuerFetch;
  readonly container?: IssuerFetch;
  readonly deployment?: DeploymentRead;
}

/** The names the deployment must hold as the file does. */
export const PUSHED_SIGN_IN_NAMES = [
  'DAY0_PROFILE',
  CUSTOMER_OIDC_ISSUER_VAR,
  CUSTOMER_OIDC_AUDIENCE_VAR,
  CUSTOMER_OIDC_ALLOWED_DOMAINS_VAR,
  // A stale trust flag on the deployment keeps believing addresses the file stopped believing.
  CUSTOMER_OIDC_EMAIL_TRUSTED_VAR,
  PUBLIC_URL_VAR,
] as const;

/**
 * The discovery document's address for an issuer, as OpenID Connect Discovery
 * forms it: the issuer with `/.well-known/openid-configuration` appended.
 *
 * @param issuer - The issuer URL.
 */
export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}

/**
 * The `issuer` a fetched discovery document names, or what is wrong with it.
 *
 * @param fetched - The fetch's answer.
 */
export function discoveredIssuer(fetched: IssuerFetch): { issuer: string } | { problem: string } {
  if ('error' in fetched) return { problem: fetched.error || 'nothing answered' };
  if (fetched.status !== 200) return { problem: `it answered HTTP ${fetched.status}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fetched.body);
  } catch {
    return { problem: 'it answered with something that is not JSON' };
  }
  const issuer = (parsed as { issuer?: unknown } | null)?.issuer;
  if (typeof issuer !== 'string' || issuer === '') {
    return { problem: 'its discovery document names no issuer' };
  }
  return { issuer };
}

function check(name: SignInCheckName, status: CheckStatus, line: string): SignInCheck {
  return { name, status, line };
}

/** The values the sign-in needs in the file, each a gap when missing; never a value printed. */
function valueChecks(v: Values): SignInCheck[] {
  const checks: SignInCheck[] = [];
  checks.push(
    v[BROWSER_PROFILE_VAR]?.trim() === 'customer-local'
      ? check(
          'browser-profile',
          'ok',
          `${BROWSER_PROFILE_VAR}=customer-local: the build signs people in through the issuer.`,
        )
      : check(
          'browser-profile',
          'gap',
          `${BROWSER_PROFILE_VAR} is not customer-local, so the browser would not use the company ` +
            'sign-in: set it as DAY0_PROFILE is, then run pnpm build again.',
        ),
  );
  checks.push(
    v[CUSTOMER_OIDC_CLIENT_SECRET_VAR]?.trim()
      ? check(
          'client-secret',
          'ok',
          `${CUSTOMER_OIDC_CLIENT_SECRET_VAR} is set (it stays on this machine).`,
        )
      : check(
          'client-secret',
          'gap',
          `${CUSTOMER_OIDC_CLIENT_SECRET_VAR} is not set: the app registration's client secret.`,
        ),
  );
  try {
    const domains = parseAllowedDomains(v[CUSTOMER_OIDC_ALLOWED_DOMAINS_VAR]);
    checks.push(
      domains.length > 0
        ? check(
            'allowed-domains',
            'ok',
            `${CUSTOMER_OIDC_ALLOWED_DOMAINS_VAR}: people at ${domains.join(', ')} may sign in.`,
          )
        : check(
            'allowed-domains',
            'gap',
            `${CUSTOMER_OIDC_ALLOWED_DOMAINS_VAR} is not set, so nobody may sign in.`,
          ),
    );
  } catch (err) {
    checks.push(check('allowed-domains', 'gap', errorMessage(err)));
  }
  const secretGap = sessionSecretGap(v[CUSTOMER_SESSION_SECRET_VAR]);
  checks.push(
    secretGap
      ? check('session-secret', 'gap', `${secretGap} It seals the browser's session.`)
      : check('session-secret', 'ok', `${CUSTOMER_SESSION_SECRET_VAR} is set.`),
  );
  const origin = publicOrigin(v[PUBLIC_URL_VAR]);
  if ('gap' in origin) {
    checks.push(check('public-url', 'gap', origin.gap));
  } else if (origin.origin.startsWith('https:')) {
    checks.push(
      check(
        'public-url',
        'ok',
        `${PUBLIC_URL_VAR} ${origin.origin}: register ${redirectUriOf(origin.origin)} as the redirect URI and ${signedOutUriOf(origin.origin)} as the sign-out URI.`,
      ),
    );
  } else if (isLoopback(origin.origin)) {
    checks.push(
      check(
        'public-url',
        'warn',
        `${PUBLIC_URL_VAR} ${origin.origin} is plain http on this machine: only this machine can sign ` +
          `in. A customer install serves https through its proxy. Redirect URI ${redirectUriOf(origin.origin)}.`,
      ),
    );
  } else {
    checks.push(
      check(
        'public-url',
        'gap',
        `${PUBLIC_URL_VAR} must be https: the session cookie and the issuer's redirect cross the ` +
          "network, and the customer's proxy terminates TLS for Day0.",
      ),
    );
  }
  return checks;
}

/** The discovery checks: from this machine, from the container, and the issuer byte for byte. */
function discoveryChecks(issuer: string, probes: SignInProbes): SignInCheck[] {
  const checks: SignInCheck[] = [];
  const address = discoveryUrl(issuer);
  const fromHost = probes.host ? discoveredIssuer(probes.host) : undefined;
  if (fromHost === undefined) {
    checks.push(
      check(
        'discovery-from-host',
        'warn',
        `The discovery document was not asked for from this machine.`,
      ),
    );
  } else if ('problem' in fromHost) {
    checks.push(
      check(
        'discovery-from-host',
        'gap',
        `This machine cannot read ${address}: ${fromHost.problem}.`,
      ),
    );
  } else if (fromHost.issuer !== issuer) {
    checks.push(
      check(
        'discovery-from-host',
        'gap',
        `The discovery document names the issuer "${fromHost.issuer}", and ${CUSTOMER_OIDC_ISSUER_VAR} is ` +
          `"${issuer}". They must match byte for byte (a trailing slash included), or every token is ` +
          `refused: set ${CUSTOMER_OIDC_ISSUER_VAR} to the document's value, then pnpm sync:env.`,
      ),
    );
  } else {
    checks.push(
      check(
        'discovery-from-host',
        'ok',
        `This machine reads the discovery document, and its issuer matches byte for byte.`,
      ),
    );
  }
  const fromContainer = probes.container ? discoveredIssuer(probes.container) : undefined;
  if (fromContainer === undefined) {
    checks.push(
      check(
        'discovery-from-container',
        'warn',
        'The backend container was not asked (it is not running here, or the backend is not ' +
          'self-hosted): run this again with it up.',
      ),
    );
  } else if ('problem' in fromContainer) {
    checks.push(
      check(
        'discovery-from-container',
        'gap',
        `The issuer cannot be reached from inside the backend container: ${fromContainer.problem}. ` +
          "Convex fetches the issuer's keys from there, so every sign-in would be refused. Containers " +
          "do not inherit the host's proxy settings: allow the container through the firewall or proxy.",
      ),
    );
  } else {
    checks.push(
      check('discovery-from-container', 'ok', 'The backend container reaches the issuer too.'),
    );
  }
  return checks;
}

/** The pushed values against the file's. */
function deploymentChecks(v: Values, read: DeploymentRead | undefined): SignInCheck[] {
  if (read === undefined) {
    return [
      check(
        'deployment-values',
        'warn',
        "The deployment's values were not asked (the backend is not running here).",
      ),
    ];
  }
  if ('error' in read) {
    return [
      check(
        'deployment-values',
        'warn',
        `The deployment's values could not be read: ${read.error}.`,
      ),
    ];
  }
  const differing = PUSHED_SIGN_IN_NAMES.filter(
    (name) => (read.values[name] ?? '').trim() !== (v[name] ?? '').trim(),
  );
  if (differing.length > 0) {
    return [
      check(
        'deployment-values',
        'gap',
        `The deployment holds other values than this file for ${differing.join(', ')}: run ` +
          'pnpm sync:env, then restart the backend so it reads them.',
      ),
    ];
  }
  return [
    check(
      'deployment-values',
      'ok',
      `The deployment holds this file's ${PUSHED_SIGN_IN_NAMES.join(', ')}.`,
    ),
  ];
}

/**
 * The customer-local block of `pnpm check:setup`: every check the company
 * sign-in needs, each pass, note or gap.
 *
 * @param v - The env file with the process environment layered on.
 * @param issuer - The issuer as the file names it, already validated.
 * @param probes - What was asked outside this process; absent probes are noted, not failed.
 */
export function signInSetupChecks(
  v: Values,
  issuer: string,
  probes: SignInProbes = {},
): SignInCheck[] {
  return [
    ...valueChecks(v),
    ...discoveryChecks(issuer, probes),
    ...deploymentChecks(v, probes.deployment),
  ];
}

/** The worst of a set of verdicts. */
export function worstStatus(checks: readonly SignInCheck[]): CheckStatus {
  if (checks.some((one) => one.status === 'gap')) return 'gap';
  if (checks.some((one) => one.status === 'warn')) return 'warn';
  return 'ok';
}

/** How long each probe may take, in seconds. */
const PROBE_SECONDS = 10;

/**
 * Fetch the discovery document from this machine with Node's own `fetch`, as
 * the app's server does (so `NODE_EXTRA_CA_CERTS` counts here as it does there).
 *
 * @param issuer - The issuer URL.
 */
export function fetchFromHost(issuer: string): IssuerFetch {
  const script =
    'fetch(process.argv[1],{signal:AbortSignal.timeout(' +
    `${PROBE_SECONDS * 1000}` +
    ')}).then(async r=>process.stdout.write(JSON.stringify({status:r.status,body:(await r.text()).slice(0,65536)})))' +
    '.catch(e=>process.stdout.write(JSON.stringify({error:String(e&&e.cause&&e.cause.code||e&&e.message||e)})))';
  const run = spawnSync(process.execPath, ['-e', script, discoveryUrl(issuer)], {
    encoding: 'utf8',
    timeout: (PROBE_SECONDS + 5) * 1000,
  });
  try {
    return JSON.parse(run.stdout ?? '') as IssuerFetch;
  } catch {
    return { error: firstLine(run.stderr ?? '') || 'the fetch did not run' };
  }
}

/**
 * The `docker compose` arguments, after the project and env file, that fetch
 * the discovery document from inside the backend container with the curl its
 * own healthcheck uses, printing the body and then the status on a last line.
 *
 * @param issuer - The issuer URL.
 */
export function containerDiscoveryArguments(issuer: string): string[] {
  return [
    'exec',
    '-T',
    'backend',
    'curl',
    '-sS',
    '--max-time',
    String(PROBE_SECONDS),
    '-w',
    '\\n%{http_code}',
    discoveryUrl(issuer),
  ];
}

/**
 * Read what the container's curl printed: the body, then the status on its own
 * line (`000` when nothing answered, with curl's reason on stderr).
 *
 * @param result - The exit status and both streams.
 */
export function readContainerDiscovery(result: {
  status: number | null;
  stdout: string;
  stderr: string;
}): IssuerFetch {
  const lines = result.stdout.replace(/\n$/, '').split('\n');
  const code = lines.pop()?.trim() ?? '';
  if (!/^\d{3}$/.test(code) || code === '000') {
    return { error: firstLine(result.stderr) || 'nothing answered' };
  }
  return { status: Number(code), body: lines.join('\n') };
}

/**
 * Fetch the discovery document from inside the backend container.
 *
 * @param issuer - The issuer URL.
 * @param project - The Compose project.
 * @param envFile - The env file Compose reads.
 */
export function fetchFromContainer(issuer: string, project: string, envFile: string): IssuerFetch {
  const run = spawnSync(
    'docker',
    ['compose', '-p', project, '--env-file', envFile, ...containerDiscoveryArguments(issuer)],
    { encoding: 'utf8', timeout: (PROBE_SECONDS + 20) * 1000 },
  );
  return readContainerDiscovery({
    status: run.status,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
  });
}

/**
 * Parse `npx convex env list`: one `NAME=value` per line.
 *
 * @param stdout - What the CLI printed.
 */
export function parseDeploymentEnv(stdout: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

/**
 * Read the deployment's env through the Convex CLI, pointed at the deployment
 * the file names.
 *
 * @param v - The env file's values.
 */
export function readDeploymentEnv(v: Values): DeploymentRead {
  const names = ['CONVEX_SELF_HOSTED_URL', 'CONVEX_SELF_HOSTED_ADMIN_KEY', 'CONVEX_DEPLOYMENT'];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...Object.fromEntries(names.filter((name) => v[name]).map((name) => [name, v[name]])),
  };
  const run = spawnSync('npx', ['convex', 'env', 'list'], {
    encoding: 'utf8',
    timeout: 60_000,
    env,
  });
  if (run.status !== 0) return { error: firstLine(run.stderr ?? '') || 'the Convex CLI failed' };
  return { values: parseDeploymentEnv(run.stdout ?? '') };
}

/** How a verdict opens its line in the terminal, as `check:setup` marks a section. */
const VERDICT_MARK: Readonly<Record<CheckStatus, string>> = {
  ok: 'pass',
  warn: 'note',
  gap: 'GAP',
};

/** The width of the claim column: the longest claim name the check judges, and a gap. */
const CLAIM_COLUMN = 16;

/**
 * The live check's report as terminal lines: each claim's verdict, value and
 * reason in columns, then what the deployment made of the token.
 *
 * @param report - The callback's report.
 */
export function formatSignInReport(report: SignInCheckReport): string[] {
  const valueColumn = Math.max(0, ...report.verdicts.map((one) => one.value.length)) + 2;
  const lines = report.verdicts.map(
    (one) =>
      `${VERDICT_MARK[one.status].padEnd(6)}${one.claim.padEnd(CLAIM_COLUMN)}` +
      `${one.value.padEnd(valueColumn)}${one.note}`,
  );
  const who = report.whoAmI;
  lines.push(
    who.status === 'ok'
      ? `${'pass'.padEnd(6)}${'whoAmI'.padEnd(CLAIM_COLUMN)}${who.ownerKey}  The deployment accepted the token` +
          (who.verifiedAddress
            ? ` (verified address ${who.verifiedAddress}).`
            : ' (no verified address).')
      : `${'GAP'.padEnd(6)}${'whoAmI'.padEnd(CLAIM_COLUMN)}${who.detail}`,
  );
  return lines;
}

/**
 * The exit status a report earns: 1 when any claim is a gap or the deployment
 * did not accept the person, else 0.
 *
 * @param report - The callback's report.
 */
export function reportExitCode(report: SignInCheckReport): number {
  const gap = report.whoAmI.status === 'gap' || report.verdicts.some((one) => one.status === 'gap');
  return gap ? 1 : 0;
}

/**
 * The one-time link the operator signs in through.
 *
 * @param settings - The public origin and the session secret the ticket is sealed with.
 * @param ticket - The ticket.
 */
export async function signInCheckLink(
  settings: { readonly publicUrl: string; readonly sessionSecret: string },
  ticket: CheckTicket,
): Promise<string> {
  const sealed = await sealCheckTicket(settings.sessionSecret, ticket);
  return `${settings.publicUrl}/api/auth/oidc/login?check=${encodeURIComponent(sealed)}`;
}

function isReport(value: unknown): value is SignInCheckReport {
  if (typeof value !== 'object' || value === null) return false;
  const report = value as Partial<SignInCheckReport>;
  return (
    report.version === 1 &&
    typeof report.checkId === 'string' &&
    Array.isArray(report.verdicts) &&
    typeof report.whoAmI === 'object' &&
    report.whoAmI !== null
  );
}

/** A listener waiting for one check's report. */
export interface WaitingCheck {
  /** Where the callback posts the report: a port on this machine's loopback. */
  readonly reportTo: string;
  /** The report, or a rejection once the time is up. */
  readonly report: Promise<SignInCheckReport>;
}

/**
 * Listen on this machine's loopback for the callback's report on one check.
 * A post for another check is answered 404 and the wait goes on; the listener
 * closes once the report arrives or the time is up.
 *
 * @param checkId - The check's id.
 * @param timeoutMs - How long to wait.
 */
export async function waitForReport(checkId: string, timeoutMs: number): Promise<WaitingCheck> {
  let settle:
    | { resolve: (report: SignInCheckReport) => void; reject: (err: Error) => void }
    | undefined;
  const report = new Promise<SignInCheckReport>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/report') {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        // Not a report: answered as one for no check this listener waits on.
        body = undefined;
      }
      if (!isReport(body) || body.checkId !== checkId) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(204).end();
      settle?.resolve(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const timer = setTimeout(
    () =>
      settle?.reject(
        new Error(`No sign-in reached the check within ${Math.round(timeoutMs / 1000)} s.`),
      ),
    timeoutMs,
  );
  const close = (): void => {
    clearTimeout(timer);
    server.close();
  };
  report.then(close, close);
  const { port } = server.address() as AddressInfo;
  return { reportTo: `http://127.0.0.1:${port}/report`, report };
}

/** The sign-in names the process environment may override, as `check:setup` lets it. */
const SIGN_IN_NAMES = [
  'DAY0_PROFILE',
  BROWSER_PROFILE_VAR,
  CUSTOMER_OIDC_ISSUER_VAR,
  CUSTOMER_OIDC_AUDIENCE_VAR,
  CUSTOMER_OIDC_CLIENT_SECRET_VAR,
  CUSTOMER_OIDC_ALLOWED_DOMAINS_VAR,
  CUSTOMER_SESSION_SECRET_VAR,
  PUBLIC_URL_VAR,
] as const;

/** The parsed command line. */
interface CheckArguments {
  readonly envFile: string;
  readonly timeoutMs: number;
  readonly report: boolean;
}

function parseArguments(argv: readonly string[]): CheckArguments {
  const timeoutAt = argv.indexOf('--timeout');
  const seconds = timeoutAt >= 0 ? Number(argv[timeoutAt + 1]) : CHECK_TICKET_SECONDS;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > CHECK_TICKET_SECONDS) {
    throw new Error(`--timeout takes whole seconds from 1 to ${CHECK_TICKET_SECONDS}.`);
  }
  const positional = argv.filter(
    (argument, index) => !argument.startsWith('--') && argv[index - 1] !== '--timeout',
  );
  return {
    envFile: positional[0] ?? '.env.local',
    timeoutMs: seconds * 1000,
    report: argv.includes('--report'),
  };
}

/** Run the live check from the command line; the exit status is handed back. */
async function main(argv: readonly string[]): Promise<number> {
  let args: CheckArguments;
  try {
    args = parseArguments(argv);
  } catch (err) {
    console.error(`error: ${errorMessage(err)}`);
    return 2;
  }
  const values: Record<string, string> = readEnvValues(args.envFile);
  for (const name of SIGN_IN_NAMES) {
    const fromProcess = process.env[name];
    if (fromProcess !== undefined) values[name] = fromProcess;
  }
  const read = (name: string): string | undefined => values[name];
  const gaps = customerSignInGaps(read);
  const origin = publicOrigin(read(PUBLIC_URL_VAR));
  if (gaps.length > 0 || 'gap' in origin) {
    console.error(`The company sign-in is not set up in ${args.envFile}:`);
    for (const gap of gaps) console.error(`  ${gap}`);
    console.error('`./setup.sh sign-in --provider entra|okta|google` sets it up.');
    return 1;
  }
  const checkId = randomBytes(12).toString('base64url');
  const waiting = await waitForReport(checkId, args.timeoutMs);
  const link = await signInCheckLink(
    { publicUrl: origin.origin, sessionSecret: (read(CUSTOMER_SESSION_SECRET_VAR) ?? '').trim() },
    { checkId, reportTo: waiting.reportTo, expiresAt: Date.now() + args.timeoutMs },
  );
  console.log('Open this link in a private window and sign in as the test person:');
  console.log(`\n  ${link}\n`);
  console.log(
    `It works once, for ${Math.round(args.timeoutMs / 60_000)} minutes, and signs nobody in. Waiting...`,
  );
  let report: SignInCheckReport;
  try {
    report = await waiting.report;
  } catch (err) {
    console.error(errorMessage(err));
    return 1;
  }
  console.log('');
  for (const line of formatSignInReport(report)) console.log(line);
  if (args.report) {
    console.log(
      JSON.stringify(
        {
          kind: 'day0-sign-in-check',
          version: 1,
          checkedAt: new Date(report.checkedAt).toISOString(),
          claims: report.verdicts.map(({ claim, status }) => ({ claim, status })),
          deployment: report.whoAmI.status,
        },
        null,
        2,
      ),
    );
  }
  return reportExitCode(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Handed back rather than passed to process.exit so a piped stdout drains.
  process.exitCode = await main(process.argv.slice(2));
}
