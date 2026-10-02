import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BROWSER_PROFILE_VAR,
  CUSTOMER_OIDC_ALLOWED_DOMAINS_VAR,
  CUSTOMER_OIDC_AUDIENCE_VAR,
  CUSTOMER_OIDC_CLIENT_SECRET_VAR,
  CUSTOMER_OIDC_EMAIL_TRUSTED_VAR,
  CUSTOMER_OIDC_ISSUER_VAR,
  CUSTOMER_SESSION_SECRET_VAR,
  PUBLIC_URL_VAR,
} from '../src/lib/customer-oidc';
import { ADMINISTRATORS_VAR } from '../src/lib/administrators';
import { PRIVATE_HOSTS_VAR } from '../src/lib/private-hosts';

const EXAMPLE = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
const COMPOSE = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');

/** Every name the example declares, commented-out or not. */
const DECLARED = new Set(
  EXAMPLE.split('\n')
    .map((line) => /^#?\s?([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined),
);

describe('.env.example', (): void => {
  it('declares every name the customer-local profile reads', (): void => {
    for (const name of [
      'DAY0_PROFILE',
      CUSTOMER_OIDC_ISSUER_VAR,
      CUSTOMER_OIDC_AUDIENCE_VAR,
      CUSTOMER_OIDC_EMAIL_TRUSTED_VAR,
      BROWSER_PROFILE_VAR,
      CUSTOMER_OIDC_CLIENT_SECRET_VAR,
      CUSTOMER_OIDC_ALLOWED_DOMAINS_VAR,
      CUSTOMER_SESSION_SECRET_VAR,
      PUBLIC_URL_VAR,
      PRIVATE_HOSTS_VAR,
      'CONVEX_URL',
      'DAY0_APP_HOST',
    ]) {
      expect(DECLARED, name).toContain(name);
    }
  });

  it('declares the administrators after the customer-local sign-in block, empty by default (B8)', (): void => {
    expect(DECLARED).toContain(ADMINISTRATORS_VAR);
    expect(EXAMPLE).toMatch(/^DAY0_ADMINISTRATORS=$/m);
    expect(EXAMPLE.indexOf('DAY0_ADMINISTRATORS=')).toBeGreaterThan(
      EXAMPLE.indexOf('DAY0_OIDC_EMAIL_TRUSTED='),
    );
    expect(EXAMPLE.indexOf('DAY0_ADMINISTRATORS=')).toBeLessThan(EXAMPLE.indexOf('# --- Clerk'));
  });

  it("declares the token store's Nango lines after the administrators, the address empty by default (11-AT)", (): void => {
    for (const name of [
      'DAY0_NANGO_URL',
      'DAY0_NANGO_SECRET_KEY',
      'DAY0_NANGO_ENCRYPTION_KEY',
      'DAY0_NANGO_DB_PASSWORD',
    ]) {
      expect(EXAMPLE, name).toMatch(new RegExp(`^${name}=$`, 'm'));
      expect(EXAMPLE.indexOf(`\n${name}=`)).toBeGreaterThan(
        EXAMPLE.indexOf('\nDAY0_ADMINISTRATORS='),
      );
      expect(EXAMPLE.indexOf(`\n${name}=`)).toBeLessThan(EXAMPLE.indexOf('# --- Clerk'));
      expect(COMPOSE.includes(name) || name === 'DAY0_NANGO_URL', name).toBe(true);
    }
    expect(EXAMPLE).toContain('DAY0_NANGO_URL=http://nango-server:3003');
  });

  it('declares the shared-skills switch, on by default (K4)', (): void => {
    expect(DECLARED).toContain('DAY0_SHARED_SKILLS');
    expect(EXAMPLE).toMatch(/^DAY0_SHARED_SKILLS=$/m);
  });

  it('declares every bind address and mirror the compose file reads', (): void => {
    const read = [...COMPOSE.matchAll(/\$\{([A-Z_]+(?:BIND_ADDR|_ENDPOINT|_INDEX_URL)):-/g)].map(
      (match) => match[1],
    );
    expect(new Set(read)).toEqual(
      new Set([
        'CONVEX_BIND_ADDR',
        'CONVEX_DASHBOARD_BIND_ADDR',
        'MODEL_BIND_ADDR',
        'FAKE_SLACK_BIND_ADDR',
        'HF_ENDPOINT',
        'PIP_INDEX_URL',
      ]),
    );
    for (const name of read) expect(DECLARED, name).toContain(name);
  });

  it('names only pnpm scripts package.json defines', (): void => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };
    const named = [...EXAMPLE.matchAll(/`pnpm ([a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+)/g)].map(
      (match) => match[1],
    );
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(Object.keys(manifest.scripts), name).toContain(name);
  });
});
