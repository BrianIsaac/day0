/// <reference types="node" />
/**
 * `pnpm check:access`: the live check of the organisation's connections, run with the customer's
 * IT after `./setup.sh access` (the access plan, section 4.8; B13).
 *
 *   pnpm check:access [env file] [--system <key>] [--report] [--install]
 *
 * For the deployment, whether it names its administrators (B8). For each connection IT landed
 * (active, or needing IT's attention; a revoked one is history): its status; the redirect URI it
 * registered against `${DAY0_PUBLIC_URL}<the system's redirect path>`; its scopes against the kit's
 * (`src/surfaces/access-kit/`); whether its secret opens under this deployment's key; and whether
 * the vendor answers an identity call with it (Slack's `apps.manifest.validate` with the kit's
 * manifest, Linear's client-credentials grant and `viewer` as the app, an MCP server's
 * authorisation-server metadata); and, for Slack, whether the socket service carries the decision
 * buttons' presses. The secret is opened on this machine through the deployment's
 * admin key and sent only to its own vendor; nothing of it is printed. It exits 0 when every line
 * passes or is a note, 1 otherwise. `--report` prints the verdicts (names and statuses, no values)
 * as one JSON document for the support bundle.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ADMINISTRATORS_VAR, parseAdministrators } from '../src/lib/administrators';
import { errorMessage } from '../src/lib/errors';
import { PUBLIC_URL_VAR } from '../src/lib/customer-oidc';
import {
  ORGANISATION_CONNECTION_KINDS,
  ORGANISATION_CONNECTION_MODES,
  ORGANISATION_CONNECTION_STATUSES,
  type OrganisationConnectionKind,
  type OrganisationConnectionMode,
  type OrganisationConnectionStatus,
} from '../src/surfaces/access-identity';
import { recipeForSystem, type RecipeMode } from '../src/surfaces/access-kit';
import { slackKitManifest } from '../src/surfaces/access-kit/slack';
import {
  LINEAR_GRAPHQL_URL,
  LinearIssuerRefusal,
  readLinearViewer,
  requestAppActorToken,
  revokeLinearToken,
  sharedTokenScopes,
  type LinearFetch,
  type LinearIssuedTokens,
} from '../src/surfaces/identity-issuers/linear';
import { SLACK_API_ENDPOINT } from '../src/surfaces/slack-endpoint';
import type { CheckStatus } from './check-sign-in';
import { adminTarget, deploymentAdmin } from './lib/convex-admin';
import { readEnvValues } from './lib/env-file';
import {
  containerReachArguments,
  firstLine,
  readContainerDial,
  type ModelDial,
} from './model-reach';

type Values = Readonly<Record<string, string>>;

/** The checks, in the order each connection reports them. */
export const ACCESS_CHECK_NAMES = [
  'administrators',
  'status',
  'redirect',
  'scopes',
  'secret',
  'identity',
  'reach',
  'socket',
] as const;

/** One of {@link ACCESS_CHECK_NAMES}. */
export type AccessCheckName = (typeof ACCESS_CHECK_NAMES)[number];

/** One verdict: whose it is (`deployment` or a system key), which check, and why. */
export interface AccessCheck {
  readonly subject: string;
  readonly name: AccessCheckName;
  readonly status: CheckStatus;
  readonly detail: string;
}

/** An organisation connection as the Convex CLI lists it: the fields the check reads, no secret. */
export interface ConnectionRow {
  readonly _id: string;
  readonly system: string;
  readonly displayName: string;
  readonly kind: OrganisationConnectionKind;
  readonly mode: OrganisationConnectionMode;
  readonly status: OrganisationConnectionStatus;
  readonly statusReason?: string;
  readonly scopes: readonly string[];
  readonly clientCredentialsScopes?: readonly string[];
  readonly clientId?: string;
  readonly issuer?: string;
  readonly resource?: string;
  readonly redirectUrl?: string;
  readonly secretCredentialId?: string;
}

/** What the live checks need from outside this process: the network, Slack's base and the secrets. */
export interface VendorProbes {
  readonly fetch: typeof fetch;
  readonly slackApiBase: URL;
  /**
   * Open one organisation secret under the deployment's key.
   *
   * @throws Error saying why it does not open; never its value.
   */
  openSecret(credentialId: string): Promise<string>;
  /**
   * Ask one address from inside the backend container, with a GET and no secret: what the
   * deployment's own way out to the vendor finds, where every other probe asks from this machine.
   */
  fromBackend(address: URL): Promise<ModelDial>;
  /**
   * What the Slack socket service (`slack-socket`, 12-M) says of itself on its health check,
   * asked inside its container; absent where nothing can ask it.
   */
  socketBridge?(): Promise<SocketBridgeReading>;
}

/** The Slack socket service's own account of itself, or why it could not be asked. */
export type SocketBridgeReading =
  | {
      readonly state: 'running';
      /** Whether its last read of the backend's app list succeeded. */
      readonly synced: boolean;
      readonly apps: ReadonlyArray<{
        readonly appId: string;
        readonly connected: boolean;
        /** The app's connection answered for another app: its card holds another app's token. */
        readonly mismatch?: boolean;
      }>;
    }
  | { readonly state: 'absent'; readonly detail: string };

/** How long one vendor call may take. */
const VENDOR_TIMEOUT_MS = 20_000;

/** The subject of the deployment-wide checks. */
const DEPLOYMENT = 'deployment';

function check(
  subject: string,
  name: AccessCheckName,
  status: CheckStatus,
  detail: string,
): AccessCheck {
  return { subject, name, status, detail };
}

/**
 * Whether the deployment names who may manage the organisation's connections (B8).
 *
 * @param values - The env file's values.
 */
export function administratorsCheck(values: Values): AccessCheck {
  let administrators: readonly string[];
  try {
    administrators = parseAdministrators(values[ADMINISTRATORS_VAR]);
  } catch (err) {
    return check(DEPLOYMENT, 'administrators', 'gap', errorMessage(err));
  }
  if (administrators.length === 0) {
    return check(
      DEPLOYMENT,
      'administrators',
      'gap',
      `Nobody may manage the organisation's connections: ${ADMINISTRATORS_VAR} is empty. ` +
        '`./setup.sh access` names the administrators by the address they sign in with.',
    );
  }
  return check(
    DEPLOYMENT,
    'administrators',
    'ok',
    `${administrators.length === 1 ? 'One administrator' : `${administrators.length} administrators`} ` +
      `may manage the organisation's connections: ${administrators.join(', ')}.`,
  );
}

/** Day0's public origin, or the gap that stops the redirect checks. */
function publicOriginOf(values: Values): { origin: string } | { gap: string } {
  const raw = (values[PUBLIC_URL_VAR] ?? '').trim();
  if (raw === '') {
    return { gap: `${PUBLIC_URL_VAR} is unset, so no redirect can be checked.` };
  }
  try {
    return { origin: new URL(raw).origin };
  } catch {
    return { gap: `${PUBLIC_URL_VAR} is not a URL.` };
  }
}

/** The connection's status: in use, or needing IT. */
function statusCheck(row: ConnectionRow): AccessCheck {
  if (row.status === 'active') {
    return check(row.system, 'status', 'ok', `${row.displayName} is connected, ${row.mode}.`);
  }
  return check(
    row.system,
    'status',
    'gap',
    `${row.displayName} needs IT's attention: ${row.statusReason ?? 'no reason was recorded'}`,
  );
}

/** The redirect URI the registration holds against the one Day0 returns to. */
function redirectCheck(row: ConnectionRow, values: Values, redirectPath: string): AccessCheck {
  const origin = publicOriginOf(values);
  if ('gap' in origin) return check(row.system, 'redirect', 'gap', origin.gap);
  const expected = `${origin.origin}${redirectPath}`;
  if (row.redirectUrl === undefined) {
    return check(
      row.system,
      'redirect',
      'gap',
      `No redirect URI is recorded for ${row.displayName}: land it again with \`./setup.sh access\`, ` +
        `registering ${expected}.`,
    );
  }
  if (row.redirectUrl !== expected) {
    return check(
      row.system,
      'redirect',
      'gap',
      `${row.displayName} has ${row.redirectUrl} registered, and Day0 returns to ${expected}: ` +
        `register ${expected} at ${row.displayName}, byte for byte, then record it with ` +
        `\`./setup.sh access --correct ${row.system}\` (or set ${PUBLIC_URL_VAR} back).`,
    );
  }
  return check(row.system, 'redirect', 'ok', `Registered ${expected}, where Day0 returns.`);
}

/** The scopes a registration lacks of the kit's for its mode, or none. */
function missing(held: readonly string[], needed: readonly string[]): string[] {
  return needed.filter((scope: string): boolean => !held.includes(scope));
}

/** What the kit says Day0 cannot do without the scopes a connection lacks, or undefined. */
function costOf(mode: RecipeMode, lacking: readonly string[]): string | undefined {
  const costs = lacking
    .map((scope: string): string | undefined => mode.missingScopeWords?.[scope])
    .filter((words): words is string => words !== undefined);
  return costs.length === 0 ? undefined : costs.join('; ');
}

/**
 * A connection whose fixed client-credentials set lacks a scope of the kit's: the set cannot be
 * changed in place, since a token requested with another set revokes and replaces every token of
 * the app (L2), so the cure is to revoke the connection and land it again.
 */
function fixedSetCheck(
  row: ConnectionRow,
  mode: RecipeMode,
  lacking: readonly string[],
): AccessCheck {
  const cost = costOf(mode, lacking);
  return check(
    row.system,
    'scopes',
    'gap',
    `${row.displayName} was landed with ${row.clientCredentialsScopes?.join(', ') || 'no scope set'}, ` +
      `without ${lacking.join(', ')}${cost === undefined ? '' : `: ${cost}`}. The set cannot be changed in place, since ` +
      `${row.displayName} revokes every token of the app when one is requested with another set: ` +
      'revoke the connection on the organisation page, then land it again with `./setup.sh access`.',
  );
}

/** The registration's scopes against the kit's for its mode. */
function scopesCheck(row: ConnectionRow, mode: RecipeMode): AccessCheck {
  const lackingFixed = missing(
    row.clientCredentialsScopes ?? [],
    mode.clientCredentialsScopes ?? [],
  );
  if (lackingFixed.length > 0) return fixedSetCheck(row, mode, lackingFixed);
  const lacking = missing(row.scopes, mode.scopes);
  if (lacking.length > 0) {
    const cost = costOf(mode, lacking);
    return check(
      row.system,
      'scopes',
      'gap',
      `Missing scope ${[...new Set(lacking)].join(', ')}${cost === undefined ? '' : ` (${cost})`}: the ` +
        `registration holds ${row.scopes.join(', ') || 'none'}, and Day0 needs ` +
        `${mode.scopes.join(', ')}. Grant them at the vendor, then record them with ` +
        `\`./setup.sh access --correct ${row.system}\`.`,
    );
  }
  if (mode.scopes.length === 0 && row.scopes.length === 0) {
    return check(row.system, 'scopes', 'ok', 'No scopes listed: the server offers its own.');
  }
  // A kit that names its scopes is the whole of what Day0 uses: more is held for nothing (m20).
  const unused = mode.scopes.length === 0 ? [] : missing(mode.scopes, row.scopes);
  if (unused.length > 0) {
    return check(
      row.system,
      'scopes',
      'warn',
      `Holds ${row.scopes.join(', ')}, of which Day0 never uses ${unused.join(', ')}: IT may ` +
        `remove them at ${row.displayName}, then record the change with ` +
        `\`./setup.sh access --correct ${row.system}\`.`,
    );
  }
  return check(row.system, 'scopes', 'ok', `Holds ${row.scopes.join(', ')}.`);
}

/**
 * The checks that need nothing outside the env file and the row: the status, the redirect and
 * the scopes. `check:setup`'s access block reports these.
 *
 * @param row - The connection.
 * @param values - The env file's values.
 */
export function connectionChecks(row: ConnectionRow, values: Values): AccessCheck[] {
  const recipe = recipeForSystem(row.system);
  if (recipe === undefined) {
    return [
      statusCheck(row),
      check(
        row.system,
        'scopes',
        'warn',
        `The access kit has no recipe for ${row.displayName}: only its status and secret are checked.`,
      ),
    ];
  }
  const mode = recipe.modes.find((offered) => offered.mode === row.mode);
  if (mode === undefined || mode.kind !== row.kind) {
    return [
      statusCheck(row),
      check(
        row.system,
        'scopes',
        'gap',
        `${row.displayName} is connected ${row.mode} as ${row.kind}, which its recipe does not offer.`,
      ),
    ];
  }
  return [
    statusCheck(row),
    redirectCheck(row, values, recipe.redirectPath),
    scopesCheck(row, mode),
  ];
}

/** One vendor call's answer: its status and its JSON body, or why there is none. */
async function askVendor(
  probes: VendorProbes,
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown } | { error: string }> {
  try {
    const response = await probes.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(VENDOR_TIMEOUT_MS),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text === '' ? undefined : (JSON.parse(text) as unknown);
    } catch {
      // Not JSON: the status alone answers.
      body = undefined;
    }
    return { status: response.status, body };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

/** A string field of a JSON body, or undefined. */
function field(body: unknown, name: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

/** Slack: the configuration token validates the kit's manifest (S2), which proves both. */
async function slackIdentity(
  row: ConnectionRow,
  values: Values,
  token: string,
  probes: VendorProbes,
): Promise<AccessCheck> {
  let manifest: string;
  try {
    manifest = JSON.stringify(
      slackKitManifest({ employeeName: 'Access check', publicUrl: values[PUBLIC_URL_VAR] ?? '' })
        .manifest,
    );
  } catch (err) {
    return check(row.system, 'identity', 'gap', errorMessage(err));
  }
  const answer = await askVendor(
    probes,
    new URL('apps.manifest.validate', probes.slackApiBase).href,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ manifest }).toString(),
    },
  );
  if ('error' in answer) {
    return check(row.system, 'identity', 'gap', `Slack could not be reached: ${answer.error}`);
  }
  const ok =
    typeof answer.body === 'object' &&
    answer.body !== null &&
    (answer.body as { ok?: unknown }).ok === true;
  if (ok) {
    return check(
      row.system,
      'identity',
      'ok',
      "Slack accepts the configuration token and the kit's manifest (its scopes and redirect).",
    );
  }
  const error = field(answer.body, 'error') ?? `HTTP ${answer.status}`;
  if (error === 'token_expired') {
    return check(
      row.system,
      'identity',
      'warn',
      'The configuration token has expired (12 hours after it was generated). Its refresh token ' +
        "renews it at Day0's next use of it; the check does not rotate it, since a rotation " +
        'replaces the pair.',
    );
  }
  return check(row.system, 'identity', 'gap', `Slack refused the configuration token: ${error}.`);
}

/**
 * Linear, as the shared app's issuer reaches it: an app-actor token requested only through
 * `requestAppActorToken` with the connection's own client-credentials scope set (L2: a request
 * with another set revokes and replaces the app's tokens, so a connection holding none is asked
 * nothing), `viewer` read as the app, then the check's own token revoked again. Each check adds
 * one of the app's 1,000 parallel tokens for the moments before its revocation.
 */
async function linearIdentity(
  row: ConnectionRow,
  secret: string,
  probes: VendorProbes,
): Promise<AccessCheck[]> {
  const linearFetch: LinearFetch = async (url: URL, init: RequestInit): Promise<Response> =>
    await probes.fetch(url, init);
  const app = {
    clientId: row.clientId ?? '',
    ...(row.clientCredentialsScopes === undefined
      ? {}
      : { clientCredentialsScopes: row.clientCredentialsScopes }),
  };
  let issued: LinearIssuedTokens;
  try {
    issued = await requestAppActorToken(linearFetch, app, secret, Date.now());
  } catch (err) {
    return [check(row.system, 'identity', 'gap', linearRefusalWords(err))];
  }
  const fixed = sharedTokenScopes(app);
  const lacking = missing(issued.scopes, fixed);
  let identity: AccessCheck;
  try {
    const viewer = await readLinearViewer(linearFetch, issued.accessToken);
    identity = viewer.app
      ? check(row.system, 'identity', 'ok', `Linear answers as the app ${viewer.name}.`)
      : check(
          row.system,
          'identity',
          'gap',
          `The token acts as a person (${viewer.name}), not as the app: check that the app ` +
            'was created with client credentials and not authorised by a person.',
        );
  } catch (err) {
    identity = check(
      row.system,
      'identity',
      'gap',
      `Linear issued a token but did not answer viewer: ${linearRefusalWords(err)}`,
    );
  }
  let unrevoked: string | undefined;
  try {
    await revokeLinearToken(linearFetch, issued.accessToken, 'access_token');
  } catch (err) {
    unrevoked = linearRefusalWords(err);
  }
  const answered: AccessCheck =
    identity.status !== 'ok'
      ? identity
      : unrevoked === undefined
        ? {
            ...identity,
            detail: `${identity.detail.replace(/\.$/, '')}, with a token the check then revoked.`,
          }
        : {
            ...identity,
            status: 'warn',
            detail: `${identity.detail} The check could not revoke its own token again (${unrevoked}); it expires in 30 days.`,
          };
  if (lacking.length === 0) return [answered];
  return [
    answered,
    check(
      row.system,
      'scopes',
      'gap',
      `Missing scope ${lacking.join(', ')}: Linear granted ${issued.scopes.join(', ') || 'none'}.`,
    ),
  ];
}

/** Why Linear's issuer refused, in its own words, which never carry a secret. */
function linearRefusalWords(err: unknown): string {
  if (err instanceof LinearIssuerRefusal) {
    switch (err.reason) {
      case 'client-refused':
      case 'grant-not-enabled':
        return `${err.message} Check that client credentials are enabled on the app and that the secret is the current one.`;
      case 'no-scope-set':
        return `${err.message} Land the connection again with its scope set; no token is requested without one (L2).`;
      default:
        return err.message;
    }
  }
  return `Linear could not be reached: ${errorMessage(err)}`;
}

/** RFC 8414's metadata address for an issuer, then OpenID Connect's. */
function metadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, '');
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

/** An MCP server: its authorisation server's metadata names it and a token endpoint. */
async function mcpIdentity(row: ConnectionRow, probes: VendorProbes): Promise<AccessCheck[]> {
  if (row.issuer === undefined) {
    // A public client's issuer is the one its server names, which a correction records in place
    // (the round review's m13); a confidential client's is IT's to give (M12 f).
    const cure =
      row.secretCredentialId === undefined
        ? `./setup.sh access --correct ${row.system} records the issuer the server's own metadata ` +
          'names, and ends no card.'
        : 'a client with a secret takes the issuer IT registered it with, so revoke the ' +
          'connection and land it again with that issuer.';
    return [
      check(
        row.system,
        'identity',
        'gap',
        `No issuer is recorded, so every employee's authorisation is refused: ${cure}`,
      ),
    ];
  }
  for (const url of metadataUrls(row.issuer)) {
    const answer = await askVendor(probes, url, { method: 'GET' });
    if ('error' in answer || answer.status !== 200) continue;
    if (field(answer.body, 'issuer') !== row.issuer || !field(answer.body, 'token_endpoint')) {
      return [
        check(
          row.system,
          'identity',
          'gap',
          `The metadata at ${url} does not name ${row.issuer} as its issuer with a token endpoint.`,
        ),
      ];
    }
    const supported = (answer.body as { scopes_supported?: unknown }).scopes_supported;
    const offered = Array.isArray(supported)
      ? supported.filter((one) => typeof one === 'string')
      : [];
    const lacking = offered.length === 0 ? [] : missing(offered, row.scopes);
    const identity = check(
      row.system,
      'identity',
      'ok',
      `The authorisation server answers as ${row.issuer}.`,
    );
    return lacking.length === 0
      ? [identity]
      : [
          identity,
          check(
            row.system,
            'scopes',
            'gap',
            `Missing scope ${lacking.join(', ')}: the server offers ${offered.join(', ')}.`,
          ),
        ];
  }
  return [
    check(
      row.system,
      'identity',
      'gap',
      `The authorisation server ${row.issuer} published no metadata Day0 could read.`,
    ),
  ];
}

/**
 * A per-employee OAuth app's checks: the organisation holds no secret for it (each employee's own
 * app brings its own, AI5), so nothing opens and the vendor is asked nothing until a card connects.
 */
function perEmployeeAppChecks(row: ConnectionRow): AccessCheck[] {
  return [
    check(
      row.system,
      'secret',
      'ok',
      "None is held for the organisation: each employee's own app holds its own.",
    ),
    check(
      row.system,
      'identity',
      'warn',
      `Each employee's own ${row.displayName} app is checked when its card connects.`,
    ),
  ];
}

/** The live checks: the secret opens, then the vendor answers with it. */
async function liveChecks(
  row: ConnectionRow,
  values: Values,
  probes: VendorProbes,
): Promise<AccessCheck[]> {
  if (row.kind === 'oauth-app' && row.mode === 'per-employee') return perEmployeeAppChecks(row);
  if (row.secretCredentialId === undefined) {
    if (row.kind === 'mcp-client') {
      return [
        check(row.system, 'secret', 'ok', 'A public client: no secret is held.'),
        ...(await mcpIdentity(row, probes)),
      ];
    }
    return [check(row.system, 'secret', 'gap', `No secret is stored for ${row.displayName}.`)];
  }
  let secret: string;
  try {
    secret = await probes.openSecret(row.secretCredentialId);
  } catch (err) {
    return [
      check(
        row.system,
        'secret',
        'gap',
        "The secret does not open under this deployment's key (the key changed since it was " +
          `sealed, or the row was altered); rotate it with a fresh secret: ${errorMessage(err)}`,
      ),
      check(row.system, 'identity', 'gap', 'Not asked: the secret did not open.'),
    ];
  }
  const opened = check(row.system, 'secret', 'ok', "Opens under this deployment's key.");
  const recipe = recipeForSystem(row.system);
  const mode = recipe?.modes.find((offered) => offered.mode === row.mode);
  switch (row.kind) {
    case 'slack-configuration':
      return [opened, await slackIdentity(row, values, secret, probes)];
    case 'oauth-app':
      return mode === undefined || row.system !== 'linear'
        ? [opened]
        : [opened, ...(await linearIdentity(row, secret, probes))];
    case 'mcp-client':
      return [opened, ...(await mcpIdentity(row, probes))];
    case 'service-account':
    case 'static-key':
      return [opened];
    default: {
      const unknown: never = row.kind;
      throw new Error(`unhandled connection kind ${String(unknown)}`);
    }
  }
}

/**
 * The address the deployment calls a connection's vendor at, as the backend container reaches it:
 * Slack's Web API (the fake a bed names on the Compose network, as the deployment does), Linear's
 * API, or the MCP server IT connected. Undefined for a system the kit knows no address for.
 */
export function backendAddressOf(row: ConnectionRow, values: Values): URL | undefined {
  if (row.kind === 'slack-configuration') {
    const fake = (values.DAY0_TEST_SLACK_API_URL ?? '').trim();
    return new URL('api.test', fake === '' ? SLACK_API_ENDPOINT : fake);
  }
  if (row.system === 'linear') return new URL(LINEAR_GRAPHQL_URL);
  if (row.kind === 'mcp-client') {
    const server = row.resource ?? row.issuer;
    return server === undefined ? undefined : new URL(server);
  }
  return undefined;
}

/** curl's words for a certificate the container does not trust, whose cure is trust, not a route. */
const UNTRUSTED_CERTIFICATE = /SSL certificate|certificate verify|self[- ]signed|local issuer/i;

/** How a run of the check reads what it could not ask. */
export interface AccessCheckOptions {
  /**
   * Run by `./setup.sh install`: a backend dial that did not run is a gap, so an install never
   * passes with the backend container never asked (the round review's m10).
   */
  readonly install?: boolean;
}

/**
 * Whether the backend container itself reaches the connection's vendor (the wave 11 review's
 * section 11, item 4; AI9): every other check here asks from this machine, which says nothing of
 * the deployment's own way out. Nothing is sent but a GET: any HTTP answer means it is reached.
 */
async function reachCheck(
  row: ConnectionRow,
  values: Values,
  probes: VendorProbes,
  options: AccessCheckOptions,
): Promise<AccessCheck> {
  const address = backendAddressOf(row, values);
  if (address === undefined) {
    return check(
      row.system,
      'reach',
      'warn',
      `Not asked from the backend container: the kit knows no address for ${row.displayName}.`,
    );
  }
  const dial = await probes.fromBackend(address);
  switch (dial.reach) {
    case 'reached':
      return check(
        row.system,
        'reach',
        'ok',
        `The backend container reached ${address.href} (${dial.detail}).`,
      );
    case 'unreachable':
      return check(
        row.system,
        'reach',
        'gap',
        `The backend container could not reach ${address.href}: ${dial.detail}. ` +
          (UNTRUSTED_CERTIFICATE.test(dial.detail)
            ? 'The backend does not trust the certificate the address presents: give the backend ' +
              "container the customer's CA bundle (its SSL_CERT_FILE), then run the check again."
            : `Every call the deployment makes to ${row.displayName} starts there: open its way ` +
              'out (the proxy or firewall in front of the backend), then run the check again.'),
      );
    case 'unknown':
      // The install never passes with the backend unasked (the round review's m10).
      return check(
        row.system,
        'reach',
        options.install === true ? 'gap' : 'warn',
        `Not asked from the backend container: ${dial.detail}. Start it (\`./setup.sh resume\`) ` +
          'and run the check again.',
      );
    default: {
      const unhandled: never = dial.reach;
      throw new Error(`unhandled dial ${String(unhandled)}`);
    }
  }
}

/**
 * Whether the Slack socket service carries the Approve and Reject presses (12-M; RM7): running,
 * reading the backend's app list, and holding a connection for each employee app with an
 * app-level token. Not running is a note, since the typed code always decides; a list it cannot
 * read or an app with no connection is a gap.
 */
async function socketCheck(row: ConnectionRow, probes: VendorProbes): Promise<AccessCheck> {
  if (probes.socketBridge === undefined) {
    return check(row.system, 'socket', 'warn', 'Not asked: nothing here can ask the service.');
  }
  const reading = await probes.socketBridge();
  if (reading.state === 'absent') {
    return check(
      row.system,
      'socket',
      'warn',
      `The Slack socket service is not running (${reading.detail}), so decision requests carry ` +
        'the typed code only, which always decides. Start it with pnpm convex:up --profile ' +
        'slack-socket for Approve and Reject buttons.',
    );
  }
  if (!reading.synced) {
    return check(
      row.system,
      'socket',
      'gap',
      "The Slack socket service cannot read the backend's list of apps: DAY0_SOCKET_BRIDGE_SECRET " +
        'must be the same in the env file and on the deployment (pnpm sync:env), then restart ' +
        'the service.',
    );
  }
  const mismatched = reading.apps.filter((app) => app.mismatch === true).map((app) => app.appId);
  if (mismatched.length > 0) {
    return check(
      row.system,
      'socket',
      'gap',
      `${mismatched.map((appId) => `${appId}'s card`).join(' and ')} holds the app-level token of ` +
        "another app: generate the token in that employee's own app and land it on its card again.",
    );
  }
  const unconnected = reading.apps.filter((app) => !app.connected).map((app) => app.appId);
  if (unconnected.length > 0) {
    return check(
      row.system,
      'socket',
      'gap',
      `No Socket Mode connection for ${unconnected.join(', ')}: the service must reach ` +
        "Slack's Socket Mode hosts outbound over wss://, and each app needs Socket Mode on with a " +
        'live app-level token.',
    );
  }
  const count = reading.apps.length;
  return check(
    row.system,
    'socket',
    'ok',
    count === 0
      ? 'The Slack socket service is running; no employee app has an app-level token yet, so ' +
          'requests carry the typed code.'
      : `The Slack socket service holds a connection for ${count} employee app${count === 1 ? '' : 's'} with an app-level token.`,
  );
}

/** A later verdict on the same check replaces the earlier one (a granted scope after a registered one). */
function merged(checks: readonly AccessCheck[]): AccessCheck[] {
  const out: AccessCheck[] = [];
  for (const one of checks) {
    const at = out.findIndex((kept) => kept.subject === one.subject && kept.name === one.name);
    if (at < 0) out.push(one);
    else if (out[at].status === 'ok') out[at] = one;
  }
  return out;
}

/**
 * Every check of the deployment and its connections, in order.
 *
 * @param rows - The connections to check.
 * @param values - The env file's values.
 * @param probes - The network, Slack's base and the secrets.
 */
export async function accessChecks(
  rows: readonly ConnectionRow[],
  values: Values,
  probes: VendorProbes,
  options: AccessCheckOptions = {},
): Promise<AccessCheck[]> {
  const checks: AccessCheck[] = [administratorsCheck(values)];
  for (const row of rows) {
    checks.push(
      ...merged([
        ...connectionChecks(row, values),
        ...(await liveChecks(row, values, probes)),
        await reachCheck(row, values, probes, options),
        ...(row.kind === 'slack-configuration' ? [await socketCheck(row, probes)] : []),
      ]),
    );
  }
  return checks;
}

/** How a verdict opens its line, as `check:sign-in` marks one. */
const MARK: Readonly<Record<CheckStatus, string>> = { ok: 'pass', warn: 'note', gap: 'GAP' };

/**
 * The checks as terminal lines, one per verdict.
 *
 * @param checks - The verdicts.
 */
export function formatAccessChecks(checks: readonly AccessCheck[]): string[] {
  const subject = Math.max(...checks.map((one) => one.subject.length)) + 2;
  return checks.map(
    (one) =>
      `${MARK[one.status].padEnd(6)}${one.subject.padEnd(subject)}${one.name.padEnd(16)}${one.detail}`,
  );
}

/**
 * 1 when any verdict is a gap, else 0.
 *
 * @param checks - The verdicts.
 */
export function accessExitCode(checks: readonly AccessCheck[]): number {
  return checks.some((one) => one.status === 'gap') ? 1 : 0;
}

/** The statuses a listed connection is checked in; a revoked one is history. */
const CHECKED_STATUSES: ReadonlySet<string> = new Set(['active', 'needs-attention']);

/** A string array, or undefined. */
function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((one) => typeof one === 'string') ? value : undefined;
}

/** One listed row as a connection, or undefined when it is not one. */
function connectionOf(value: unknown): ConnectionRow | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const row = value as Record<string, unknown>;
  const text = (name: string): string | undefined =>
    typeof row[name] === 'string' ? (row[name] as string) : undefined;
  const scopes = stringArray(row.scopes);
  const kind = ORGANISATION_CONNECTION_KINDS.find((one) => one === row.kind);
  const mode = ORGANISATION_CONNECTION_MODES.find((one) => one === row.mode);
  const status = ORGANISATION_CONNECTION_STATUSES.find((one) => one === row.status);
  const id = text('_id');
  const system = text('system');
  const displayName = text('displayName');
  if (!id || !system || !displayName || !scopes || !kind || !mode || !status) return undefined;
  const optional = (name: keyof ConnectionRow): Partial<ConnectionRow> =>
    text(name) === undefined ? {} : { [name]: text(name) };
  const clientCredentialsScopes = stringArray(row.clientCredentialsScopes);
  return {
    _id: id,
    system,
    displayName,
    kind,
    mode,
    status,
    scopes,
    ...(clientCredentialsScopes === undefined ? {} : { clientCredentialsScopes }),
    ...optional('statusReason'),
    ...optional('clientId'),
    ...optional('issuer'),
    ...optional('resource'),
    ...optional('redirectUrl'),
    ...optional('secretCredentialId'),
  };
}

/**
 * The connections `npx convex data organisationConnections --format jsonl` lists, active or
 * needing IT's attention.
 *
 * @param stdout - The CLI's output, one JSON object per line.
 * @throws Error when a line is not an organisation connection.
 */
export function parseConnectionRows(stdout: string): ConnectionRow[] {
  const rows: ConnectionRow[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    const row = connectionOf(JSON.parse(line) as unknown);
    if (row === undefined) {
      throw new Error('The deployment listed a row that is not an organisation connection.');
    }
    if (CHECKED_STATUSES.has(row.status)) rows.push(row);
  }
  return rows;
}

/**
 * Where the check reaches Slack's Web API: Slack itself, or the fake Slack a bed publishes on
 * this machine (`DAY0_TEST_SLACK_API_URL` names it on the Compose network, which this machine
 * cannot resolve, and `DAY0_TEST_SLACK_AUTHORIZE_URL` names its host-published port).
 *
 * @param values - The env file's values.
 * @throws Error when the fake's published address is not on this machine.
 */
export function slackApiBaseForCheck(values: Values): URL {
  if (!(values.DAY0_TEST_SLACK_API_URL ?? '').trim()) return new URL(SLACK_API_ENDPOINT);
  const published = (values.DAY0_TEST_SLACK_AUTHORIZE_URL ?? '').trim();
  if (!onThisMachine(published)) {
    throw new Error(
      'DAY0_TEST_SLACK_API_URL names a fake Slack, and DAY0_TEST_SLACK_AUTHORIZE_URL does not ' +
        'publish it on this machine, so the check cannot reach it.',
    );
  }
  return new URL('/api/', published);
}

/** The loopback hosts a bed publishes a fake on. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Whether an address names this machine: parsed, plain http, a loopback host and no credentials. */
function onThisMachine(address: string): boolean {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  return (
    url.protocol === 'http:' &&
    url.username === '' &&
    url.password === '' &&
    LOOPBACK_HOSTS.has(url.hostname)
  );
}

/**
 * What the check says when no connection is active or needs IT's attention, for every system or
 * the one asked for. Never "yet": the deployment may have had connections that were all revoked
 * (the re-walk, row 10).
 *
 * @param system - The system the check was asked for, if one was.
 */
export function noConnectionLine(system: string | undefined): string {
  return system === undefined
    ? '  None is connected: `./setup.sh access` connects them with the customer’s IT.'
    : `  Nothing is connected for ${system}.`;
}

/** The connections the deployment holds, through the Convex CLI pointed at it. */
function listConnections(values: Values): ConnectionRow[] {
  const names = ['CONVEX_SELF_HOSTED_URL', 'CONVEX_SELF_HOSTED_ADMIN_KEY'];
  const run = spawnSync(
    'npx',
    ['convex', 'data', 'organisationConnections', '--limit', '200', '--format', 'jsonl'],
    {
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        ...Object.fromEntries(
          names.filter((name) => values[name]).map((name) => [name, values[name]]),
        ),
      },
    },
  );
  if (run.status !== 0) {
    throw new Error(
      `The organisation's connections could not be listed: ${firstLine(run.stderr ?? '') || 'the Convex CLI failed'}`,
    );
  }
  return parseConnectionRows(run.stdout ?? '');
}

/** Ask one address from the backend container of the project the env file names. */
function dialFromBackend(project: string, envFile: string, address: URL): ModelDial {
  const run = spawnSync(
    'docker',
    ['compose', '-p', project, '--env-file', envFile, ...containerReachArguments(address.href)],
    { encoding: 'utf8', timeout: 30_000 },
  );
  return readContainerDial({
    status: run.status,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? (run.error ? errorMessage(run.error) : ''),
  });
}

/** What the bridge's health check answers, as `slack-socket/server.js` writes it. */
function socketReadingOf(stdout: string): SocketBridgeReading {
  const parsed: unknown = JSON.parse(stdout);
  const body =
    parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const apps = Array.isArray(body.apps) ? body.apps : [];
  return {
    state: 'running',
    synced: body.synced === true,
    apps: apps.flatMap((app: unknown) => {
      const row = app !== null && typeof app === 'object' ? (app as Record<string, unknown>) : {};
      return typeof row.appId === 'string'
        ? [
            {
              appId: row.appId,
              connected: row.connected === true,
              ...(row.mismatch === true ? { mismatch: true } : {}),
            },
          ]
        : [];
    }),
  };
}

/** Ask the Slack socket service of the project the env file names for its health, inside it. */
function askSocketBridge(project: string, envFile: string): SocketBridgeReading {
  const run = spawnSync(
    'docker',
    [
      'compose',
      '-p',
      project,
      '--env-file',
      envFile,
      '--profile',
      'slack-socket',
      'exec',
      '-T',
      'slack-socket',
      'node',
      '-e',
      "fetch('http://127.0.0.1:8080/healthz').then(async (r) => process.stdout.write(await r.text()))",
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  if (run.status !== 0) {
    return {
      state: 'absent',
      detail: firstLine(run.stderr ?? '') || (run.error ? errorMessage(run.error) : 'no answer'),
    };
  }
  try {
    return socketReadingOf(run.stdout ?? '');
  } catch (err) {
    return {
      state: 'absent',
      detail: `its health check did not answer JSON: ${errorMessage(err)}`,
    };
  }
}

/** The parsed command line. */
interface CheckArguments {
  readonly envFile: string;
  readonly system?: string;
  readonly report: boolean;
  readonly install: boolean;
}

function parseArguments(argv: readonly string[]): CheckArguments {
  const at = argv.indexOf('--system');
  const system = at >= 0 ? argv[at + 1] : undefined;
  if (at >= 0 && (system === undefined || system.startsWith('--'))) {
    throw new Error('--system takes a system key, such as slack or linear.');
  }
  const positional = argv.filter(
    (argument, index) => !argument.startsWith('--') && argv[index - 1] !== '--system',
  );
  return {
    envFile: positional[0] ?? '.env.local',
    ...(system === undefined ? {} : { system }),
    report: argv.includes('--report'),
    install: argv.includes('--install'),
  };
}

/**
 * Run the check from the command line; the exit status is handed back.
 *
 * @param argv - The arguments after the script.
 */
export async function main(argv: readonly string[]): Promise<number> {
  let args: CheckArguments;
  try {
    args = parseArguments(argv);
  } catch (err) {
    console.error(`error: ${errorMessage(err)}`);
    return 2;
  }
  const values = readEnvValues(args.envFile);
  const target = adminTarget(values);
  if ('gap' in target) {
    console.error(target.gap);
    return 1;
  }
  const admin = deploymentAdmin(target);
  let rows: ConnectionRow[];
  let slackApiBase: URL;
  try {
    rows = listConnections(values).filter(
      (row) => args.system === undefined || row.system === args.system,
    );
    slackApiBase = slackApiBaseForCheck(values);
  } catch (err) {
    console.error(errorMessage(err));
    return 1;
  }
  const checks = await accessChecks(
    rows,
    values,
    {
      fetch,
      slackApiBase,
      openSecret: async (credentialId: string): Promise<string> =>
        await admin.run<string>('action', 'credentials:decrypt', { credentialId }),
      fromBackend: async (address: URL): Promise<ModelDial> =>
        dialFromBackend(values.COMPOSE_PROJECT_NAME || 'day0', args.envFile, address),
      socketBridge: async (): Promise<SocketBridgeReading> =>
        askSocketBridge(values.COMPOSE_PROJECT_NAME || 'day0', args.envFile),
    },
    { install: args.install },
  );
  console.log(`The organisation's connections, read from ${args.envFile}:`);
  if (rows.length === 0) console.log(noConnectionLine(args.system));
  for (const line of formatAccessChecks(checks)) console.log(line);
  if (args.report) {
    console.log(
      JSON.stringify(
        {
          kind: 'day0-access-check',
          version: 1,
          checkedAt: new Date().toISOString(),
          checks: checks.map(({ subject, name, status }) => ({ subject, check: name, status })),
        },
        null,
        2,
      ),
    );
  }
  const code = accessExitCode(checks);
  if (args.system !== undefined && rows.length === 0) return 1;
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Handed back rather than passed to process.exit so a piped stdout drains.
  process.exitCode = await main(process.argv.slice(2));
}
