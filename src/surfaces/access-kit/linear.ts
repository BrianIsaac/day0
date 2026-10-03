import type { OrganisationConnectionMode } from '../access-identity';
import { AccessKitError, httpsOrigin } from './origin';
import type { AccessRecipe } from './types';

/*
 * Linear in the access kit (the access plan, section 4.10; L1 to L3, read 1 October 2026): IT
 * creates an OAuth app in Linear's settings from the manifest below, through a link that pre-fills
 * the create form with the manifest's fields (no API creates an app). In `shared` mode one app serves every
 * employee through client-credentials tokens, app-actor tokens valid 30 days, with a fixed scope
 * set (L2: a request with other scopes revokes and replaces the app's tokens). In `per-employee`
 * mode each employee has its own app, since Linear documents one app user per app per workspace
 * (L1), installed with `actor=app` by a Linear administrator from the access request's link.
 */

/** The path Linear's authorisation returns to (11-AL's route, `app/api/oauth/linear`). */
export const LINEAR_REDIRECT_PATH = '/api/oauth/linear';

/**
 * The scope without which Linear refuses a ticket delegated or assigned to the app user ("One or
 * more app users lack the required capability.", the real-vendor walk, 3 October 2026), and which
 * Linear accepts only with `actor=app`. Linear checks it on a live app-actor token: the shared
 * app's set must hold it, or its employees take only unassigned tickets (decision 5).
 */
export const LINEAR_DELEGATE_SCOPE = 'app:assignable';

/**
 * The scopes a shared app's client-credentials tokens hold, fixed at install (L2): `read`;
 * `write`, the only scope that changes an issue's state (`comments:create` covers comments only);
 * and {@link LINEAR_DELEGATE_SCOPE}, so a manager hands a ticket to the shared app user (AL1).
 */
export const LINEAR_CLIENT_CREDENTIALS_SCOPES: readonly string[] = [
  'read',
  'write',
  LINEAR_DELEGATE_SCOPE,
];

/**
 * The scopes an employee's own app is authorised with: the shared set, `app:assignable` among
 * them, so a manager hands the employee a ticket by assigning it to the employee's app user (AC8).
 */
export const LINEAR_PER_EMPLOYEE_SCOPES: readonly string[] = LINEAR_CLIENT_CREDENTIALS_SCOPES;

/** What a Linear app's employees cannot be handed without {@link LINEAR_DELEGATE_SCOPE}. */
const LINEAR_MISSING_SCOPE_WORDS: Readonly<Record<string, string>> = {
  [LINEAR_DELEGATE_SCOPE]:
    'no ticket can be delegated or assigned to the app user, so its employees take only ' +
    'unassigned tickets',
};

/** Linear's create-application page, which its dotted query fields pre-fill. */
const CREATE_APPLICATION_URL = 'https://linear.app/settings/api/applications/new';

/** Linear's authorisation endpoint. */
const AUTHORISE_URL = 'https://linear.app/oauth/authorize';

/** Linear's manifest schema, which the manifest names. */
const MANIFEST_SCHEMA = 'https://linear.app/.well-known/oauth-app-manifest.schema.json';

/** A Linear app's name: 2 to 80 characters, never naming Linear itself. */
const CLIENT_NAME_MIN = 2;
const CLIENT_NAME_MAX = 80;

/**
 * The name of an employee's own Linear app, `<employee> (Day0)`: the manifest's `client_name`, and
 * the name Linear then gives the app on its consent and in `viewer` (the re-walk, R41X-3).
 *
 * @param employee - The employee's name, as its card shows it.
 */
export function linearEmployeeAppName(employee: string): string {
  return `${employee.trim()} (Day0)`;
}

/** An OAuth app manifest as Linear's schema 1.0.0 reads it: the fields Day0 sets. */
export interface LinearAppManifest {
  readonly $schema: string;
  readonly schemaVersion: '1.0.0';
  readonly distribution: 'private';
  readonly display: { readonly description: string };
  readonly developer: { readonly name: string };
  readonly oauth: {
    readonly client_name: string;
    readonly client_uri: string;
    readonly redirect_uris: readonly string[];
    readonly grant_types: readonly ('authorization_code' | 'client_credentials')[];
  };
  readonly webhook: { readonly enabled: false };
}

/**
 * The manifest IT creates Day0's Linear app from: the shared app, or one employee's own.
 *
 * @param input.appName - The app's name in Linear (`Day0`, or `Leo (Day0)` for an employee's own).
 * @param input.publicUrl - Day0's public https origin, which the redirect returns to.
 * @param input.mode - Shared (client credentials enabled) or one employee's own app.
 * @throws AccessKitError for a name Linear refuses or an origin that is not https.
 */
export function linearKitManifest(input: {
  readonly appName: string;
  readonly publicUrl: string;
  readonly mode: OrganisationConnectionMode;
}): LinearAppManifest {
  const name = input.appName.trim();
  if (name.length < CLIENT_NAME_MIN || name.length > CLIENT_NAME_MAX) {
    throw new AccessKitError(
      `A Linear app's name is ${CLIENT_NAME_MIN} to ${CLIENT_NAME_MAX} characters.`,
    );
  }
  if (/linear/i.test(name)) {
    throw new AccessKitError("A Linear app's name may not contain the word Linear.");
  }
  const origin = httpsOrigin(input.publicUrl, 'Linear');
  return {
    $schema: MANIFEST_SCHEMA,
    schemaVersion: '1.0.0',
    distribution: 'private',
    display: {
      description: 'Day0 digital employees: each takes its own Linear tickets and acts on them.',
    },
    developer: { name: 'Day0' },
    oauth: {
      client_name: name,
      client_uri: origin,
      redirect_uris: [`${origin}${LINEAR_REDIRECT_PATH}`],
      grant_types:
        input.mode === 'shared'
          ? ['authorization_code', 'client_credentials']
          : ['authorization_code'],
    },
    webhook: { enabled: false },
  };
}

/**
 * The link that opens Linear's create-application form pre-filled with a manifest's fields, in
 * Linear's dotted query form (`oauth.client_name=...`). Linear refuses a `?manifest=` link ("The
 * app manifest provided in the URL is not valid", the re-walk, R41X-2), and the dotted form
 * pre-filled an employee's app's form on real Linear. Each value is percent-encoded as that link
 * was, a space as `%20` and never `+`; a list repeats its field, as the shared app's second grant
 * type does. The description and the webhook setting are not in the link: the form is checked
 * against the printed manifest.
 *
 * @param manifest - The manifest, from {@link linearKitManifest}.
 */
export function linearCreateFormUrl(manifest: LinearAppManifest): string {
  const fields: ReadonlyArray<readonly [name: string, value: string]> = [
    ['distribution', manifest.distribution],
    ['developer.name', manifest.developer.name],
    ['oauth.client_name', manifest.oauth.client_name],
    ['oauth.client_uri', manifest.oauth.client_uri],
    ...manifest.oauth.redirect_uris.map((uri) => ['oauth.redirect_uris', uri] as const),
    ...manifest.oauth.grant_types.map((grant) => ['oauth.grant_types', grant] as const),
  ];
  const query = fields.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&');
  return `${CREATE_APPLICATION_URL}?${query}`;
}

/**
 * The link a Linear administrator follows to install an employee's own app as the app actor (L1):
 * the scopes and the redirect its manifest declares. 11-AL's issuer builds its link with this.
 *
 * @param input.clientId - The employee's app's client id.
 * @param input.publicUrl - Day0's public https origin.
 * @param input.state - The signed, single-use state the redirect is checked against.
 * @throws AccessKitError when the origin is not https.
 */
export function linearAuthoriseUrl(input: {
  readonly clientId: string;
  readonly publicUrl: string;
  readonly state: string;
}): string {
  const url = new URL(AUTHORISE_URL);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set(
    'redirect_uri',
    `${httpsOrigin(input.publicUrl, 'Linear')}${LINEAR_REDIRECT_PATH}`,
  );
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', LINEAR_PER_EMPLOYEE_SCOPES.join(','));
  url.searchParams.set('actor', 'app');
  url.searchParams.set('state', input.state);
  return url.toString();
}

/**
 * Linear's recipe: shared by default (AI5), or per employee, landed with nothing handed over since
 * each employee's own app brings its own client id and secret (join 2 of 11-AJ).
 */
export const LINEAR_RECIPE: AccessRecipe = {
  system: 'linear',
  displayName: 'Linear',
  guide: 'docs/running/access-linear.md',
  redirectPath: LINEAR_REDIRECT_PATH,
  vendorHosts: ['linear.app', 'api.linear.app', 'mcp.linear.app'],
  modes: [
    {
      mode: 'shared',
      kind: 'oauth-app',
      scopes: LINEAR_CLIENT_CREDENTIALS_SCOPES,
      clientCredentialsScopes: LINEAR_CLIENT_CREDENTIALS_SCOPES,
      missingScopeWords: LINEAR_MISSING_SCOPE_WORDS,
      summary:
        'Create one OAuth app from the manifest, with client credentials enabled, and hand over ' +
        'its client id and client secret: every employee acts as that app.',
      asks: [
        {
          field: 'clientId',
          label: "The Linear app's client id",
          secret: false,
          stdinName: 'LINEAR_CLIENT_ID',
          optional: false,
        },
        {
          field: 'secret',
          label: "The Linear app's client secret (hidden)",
          secret: true,
          stdinName: 'LINEAR_CLIENT_SECRET',
          optional: false,
        },
      ],
      secretLifetime: {
        words:
          'The client secret lasts until IT rotates it in Linear, which ends every token issued ' +
          'with it; each client-credentials token Day0 obtains lasts 30 days.',
      },
      landsAtInstall: true,
    },
    {
      mode: 'per-employee',
      kind: 'oauth-app',
      scopes: LINEAR_PER_EMPLOYEE_SCOPES,
      missingScopeWords: LINEAR_MISSING_SCOPE_WORDS,
      summary:
        'Nothing to hand over now: for each employee a Linear administrator creates its own app ' +
        'from the access request and installs it as the app actor.',
      asks: [],
      secretLifetime: {
        words:
          "Each employee's app's client secret lasts until IT rotates it; the access tokens it " +
          'issues last 24 hours and are refreshed by Day0.',
      },
      landsAtInstall: true,
    },
  ],
};
