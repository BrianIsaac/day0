import type { OrganisationConnectionMode } from '../access-identity';
import { AccessKitError, httpsOrigin } from './origin';
import type { AccessRecipe } from './types';

/*
 * Linear in the access kit (the access plan, section 4.10; L1 to L3, read 1 October 2026): IT
 * creates an OAuth app in Linear's settings from the manifest below (Linear's app manifests
 * pre-fill the create form; no API creates an app). In `shared` mode one app serves every
 * employee through client-credentials tokens, app-actor tokens valid 30 days, with a fixed scope
 * set (L2: a request with other scopes revokes and replaces the app's tokens). In `per-employee`
 * mode each employee has its own app, since Linear documents one app user per app per workspace
 * (L1), installed with `actor=app` by a Linear administrator from the access request's link.
 */

/** The path Linear's authorisation returns to (11-AL's route, `app/api/oauth/linear`). */
export const LINEAR_REDIRECT_PATH = '/api/oauth/linear';

/**
 * The scopes a shared app's client-credentials tokens hold, fixed at install (L2): `read`, and
 * `write`, the only scope that changes an issue's state (`comments:create` covers comments only).
 */
export const LINEAR_CLIENT_CREDENTIALS_SCOPES: readonly string[] = ['read', 'write'];

/**
 * The scopes an employee's own app is authorised with: the shared set, and `app:assignable`, so a
 * manager hands the employee a ticket by assigning it to the employee's app user (AC8).
 */
export const LINEAR_PER_EMPLOYEE_SCOPES: readonly string[] = ['read', 'write', 'app:assignable'];

/** Linear's create-application page, which a manifest pre-fills. */
const CREATE_APPLICATION_URL = 'https://linear.app/settings/api/applications/new';

/** Linear's authorisation endpoint. */
const AUTHORISE_URL = 'https://linear.app/oauth/authorize';

/** Linear's manifest schema, which the manifest names. */
const MANIFEST_SCHEMA = 'https://linear.app/.well-known/oauth-app-manifest.schema.json';

/** A Linear app's name: 2 to 80 characters, never naming Linear itself. */
const CLIENT_NAME_MIN = 2;
const CLIENT_NAME_MAX = 80;

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
 * The link that opens Linear's create-application form pre-filled with a manifest.
 *
 * @param manifest - The manifest, from {@link linearKitManifest}.
 */
export function linearManifestUrl(manifest: LinearAppManifest): string {
  const url = new URL(CREATE_APPLICATION_URL);
  url.searchParams.set('manifest', JSON.stringify(manifest));
  return url.toString();
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

/** Linear's recipe: shared by default (AI5), per employee recorded but landed by 11-AL's path. */
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
      summary:
        'Nothing to hand over now: for each employee a Linear administrator creates its own app ' +
        'from the access request and installs it as the app actor.',
      asks: [],
      secretLifetime: {
        words:
          "Each employee's app's client secret lasts until IT rotates it; the access tokens it " +
          'issues last 24 hours and are refreshed by Day0.',
      },
      landsAtInstall: false,
    },
  ],
};
