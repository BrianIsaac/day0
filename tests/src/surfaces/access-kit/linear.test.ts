import { describe, expect, it } from 'vitest';
import {
  LINEAR_CLIENT_CREDENTIALS_SCOPES,
  LINEAR_PER_EMPLOYEE_SCOPES,
  LINEAR_RECIPE,
  LINEAR_REDIRECT_PATH,
  linearAuthoriseUrl,
  linearKitManifest,
  linearCreateFormUrl,
} from '../../../../src/surfaces/access-kit/linear';
import {
  LINEAR_MANIFEST_LINK_REFUSED,
  LINEAR_OWN_APP_NAME,
  LINEAR_PREFILLED_FORM_LINK,
  REWALK_PUBLIC_URL,
} from '../../../fixtures/real-vendor-rewalk-2026-10-03';

const PUBLIC_URL = 'https://day0.acme.test';

describe('the Linear recipe', (): void => {
  it('prints a shared app’s manifest with client credentials enabled and Day0’s redirect (L2)', (): void => {
    expect(
      linearKitManifest({ appName: 'Day0', publicUrl: `${PUBLIC_URL}/`, mode: 'shared' }),
    ).toEqual({
      $schema: 'https://linear.app/.well-known/oauth-app-manifest.schema.json',
      schemaVersion: '1.0.0',
      distribution: 'private',
      display: {
        description: 'Day0 digital employees: each takes its own Linear tickets and acts on them.',
      },
      developer: { name: 'Day0' },
      oauth: {
        client_name: 'Day0',
        client_uri: PUBLIC_URL,
        redirect_uris: [`${PUBLIC_URL}/api/oauth/linear`],
        grant_types: ['authorization_code', 'client_credentials'],
      },
      webhook: { enabled: false },
    });
  });

  it('prints one employee’s own app without client credentials, named for the employee (L1)', (): void => {
    const manifest = linearKitManifest({
      appName: 'Leo (Day0)',
      publicUrl: PUBLIC_URL,
      mode: 'per-employee',
    });
    expect(manifest.oauth.client_name).toBe('Leo (Day0)');
    expect(manifest.oauth.grant_types).toEqual(['authorization_code']);
  });

  it('refuses a name Linear refuses, and an origin that is not https', (): void => {
    expect(() =>
      linearKitManifest({ appName: 'Linear helper', publicUrl: PUBLIC_URL, mode: 'shared' }),
    ).toThrow(/Linear/);
    expect(() =>
      linearKitManifest({ appName: 'D', publicUrl: PUBLIC_URL, mode: 'shared' }),
    ).toThrow(/2 to 80/);
    expect(() =>
      linearKitManifest({ appName: 'Day0', publicUrl: 'http://day0.acme.test', mode: 'shared' }),
    ).toThrow(/https/);
  });

  it('refuses plain http as Day0’s own rule, never as a rule Linear keeps (Linear’s form accepted an http callback, R41V-2)', (): void => {
    expect(() =>
      linearKitManifest({ appName: 'Day0', publicUrl: 'http://day0.acme.test', mode: 'shared' }),
    ).toThrow(
      'DAY0_PUBLIC_URL must be https: Day0 has Linear send its codes and tokens back to an https address only.',
    );
  });

  it('pre-fills Linear’s create form with the manifest’s own fields', (): void => {
    const manifest = linearKitManifest({ appName: 'Day0', publicUrl: PUBLIC_URL, mode: 'shared' });
    const url = new URL(linearCreateFormUrl(manifest));
    expect(`${url.origin}${url.pathname}`).toBe('https://linear.app/settings/api/applications/new');
    expect(url.searchParams.get('oauth.client_name')).toBe(manifest.oauth.client_name);
    expect(url.searchParams.get('oauth.client_uri')).toBe(manifest.oauth.client_uri);
    expect(url.searchParams.getAll('oauth.redirect_uris')).toEqual(manifest.oauth.redirect_uris);
    expect(url.searchParams.getAll('oauth.grant_types')).toEqual(manifest.oauth.grant_types);
    expect(url.searchParams.get('developer.name')).toBe(manifest.developer.name);
    expect(url.searchParams.get('distribution')).toBe(manifest.distribution);
  });

  it(`pre-fills an employee’s app’s form field by field as the re-walk’s link did, never with a manifest Linear refuses ("${LINEAR_MANIFEST_LINK_REFUSED}", R41X-2)`, (): void => {
    const manifest = linearKitManifest({
      appName: LINEAR_OWN_APP_NAME,
      publicUrl: REWALK_PUBLIC_URL,
      mode: 'per-employee',
    });
    const link = linearCreateFormUrl(manifest);
    const built = new URL(link);
    const walked = new URL(LINEAR_PREFILLED_FORM_LINK);
    expect(`${built.origin}${built.pathname}`).toBe(`${walked.origin}${walked.pathname}`);
    expect([...built.searchParams]).toEqual([...walked.searchParams]);
    expect(built.searchParams.has('manifest')).toBe(false);
    // A space as the walk's link wrote it, never `+`.
    expect(link).toContain('oauth.client_name=Leo%20(Day0)');
  });

  it('pre-fills the shared app’s form in the same shape, with client credentials as a second grant type (R41X-2)', (): void => {
    const manifest = linearKitManifest({
      appName: 'Day0',
      publicUrl: REWALK_PUBLIC_URL,
      mode: 'shared',
    });
    const built = new URL(linearCreateFormUrl(manifest));
    const walked = new URL(LINEAR_PREFILLED_FORM_LINK);
    walked.searchParams.set('oauth.client_name', 'Day0');
    walked.searchParams.append('oauth.grant_types', 'client_credentials');
    expect([...built.searchParams]).toEqual([...walked.searchParams]);
    expect(built.searchParams.getAll('oauth.grant_types')).toEqual([
      'authorization_code',
      'client_credentials',
    ]);
  });

  it('authorises an employee’s app as the app actor with the scopes and redirect the manifest declares', (): void => {
    const url = new URL(
      linearAuthoriseUrl({ clientId: 'lin-client', publicUrl: PUBLIC_URL, state: 'state-1' }),
    );
    expect(`${url.origin}${url.pathname}`).toBe('https://linear.app/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'lin-client',
      redirect_uri: `${PUBLIC_URL}${LINEAR_REDIRECT_PATH}`,
      response_type: 'code',
      scope: LINEAR_PER_EMPLOYEE_SCOPES.join(','),
      actor: 'app',
      state: 'state-1',
    });
    const manifest = linearKitManifest({
      appName: 'Leo (Day0)',
      publicUrl: PUBLIC_URL,
      mode: 'per-employee',
    });
    expect(manifest.oauth.redirect_uris).toEqual([url.searchParams.get('redirect_uri')]);
  });

  it('offers shared first, with fixed client-credentials scopes, and per employee landed with nothing asked', (): void => {
    expect(LINEAR_RECIPE.modes.map((mode) => [mode.mode, mode.kind, mode.landsAtInstall])).toEqual([
      ['shared', 'oauth-app', true],
      ['per-employee', 'oauth-app', true],
    ]);
    const [shared, perEmployee] = LINEAR_RECIPE.modes;
    expect(shared.clientCredentialsScopes).toEqual(LINEAR_CLIENT_CREDENTIALS_SCOPES);
    expect(shared.scopes).toEqual(LINEAR_CLIENT_CREDENTIALS_SCOPES);
    expect(shared.asks.map((ask) => [ask.field, ask.secret])).toEqual([
      ['clientId', false],
      ['secret', true],
    ]);
    expect(shared.secretLifetime.words).toContain('30 days');
    expect(perEmployee.scopes).toEqual(LINEAR_PER_EMPLOYEE_SCOPES);
    expect(perEmployee.asks).toEqual([]);
    expect(LINEAR_PER_EMPLOYEE_SCOPES).toContain('app:assignable');
    expect(LINEAR_CLIENT_CREDENTIALS_SCOPES).not.toContain('admin');
  });

  it('lands the shared app with app:assignable, without which Linear refuses a ticket delegated to it (decision 5)', (): void => {
    // Linear, 3 October, a manager delegating a ticket to the shared app user under `read,write`:
    // "One or more app users lack the required capability." With `app:assignable` held: success.
    expect(LINEAR_CLIENT_CREDENTIALS_SCOPES).toEqual(['read', 'write', 'app:assignable']);
    const [shared] = LINEAR_RECIPE.modes;
    expect(shared.clientCredentialsScopes).toContain('app:assignable');
    expect(shared.missingScopeWords?.['app:assignable']).toContain('delegated');
  });
});
