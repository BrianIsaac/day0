import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CUSTOMER_OIDC_AUDIENCE_VAR, CUSTOMER_OIDC_ISSUER_VAR } from '../src/lib/customer-oidc';
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
      PRIVATE_HOSTS_VAR,
      'CONVEX_URL',
      'DAY0_APP_HOST',
    ]) {
      expect(DECLARED, name).toContain(name);
    }
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
});
