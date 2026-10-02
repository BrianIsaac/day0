import type { UserIdentity } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownerKeyOf } from '../../../convex/ownership';
import { CUSTOMER_OIDC_ISSUER_VAR } from '../../../src/lib/customer-oidc';
import { DEV_NO_AUTH_ISSUER, DEV_NO_AUTH_SUBJECT } from '../../../src/lib/dev-auth-issuer';
import {
  ORGANISATION_HOLDER,
  ORGANISATION_OWNER_KEY,
  isOrganisationOwnerKey,
} from '../../../src/lib/organisation-key';

const CUSTOMER_ISSUER = 'https://sso.example.com/realms/ops';
const CLERK_ISSUER = 'https://demo.clerk.accounts.dev';

/** A token's identity as the deployment sees it: Convex joins issuer and subject with a bar. */
function identity(issuer: string, subject: string): UserIdentity {
  return { issuer, subject, tokenIdentifier: `${issuer}|${subject}` };
}

afterEach((): void => {
  vi.unstubAllEnvs();
});

describe('the reserved organisation key', (): void => {
  it('is one fixed key, recognised exactly and nothing near it', (): void => {
    expect(ORGANISATION_OWNER_KEY).toBe('day0:organisation');
    expect(ORGANISATION_HOLDER).toBe('organisation');
    expect(isOrganisationOwnerKey(ORGANISATION_OWNER_KEY)).toBe(true);
    for (const near of ['', 'organisation', 'day0:organisation ', 'DAY0:ORGANISATION', 'owner']) {
      expect(isOrganisationOwnerKey(near), near).toBe(false);
    }
  });

  it('holds no bar, so the customer issuer, whose keys are issuer and subject joined by one, cannot yield it', (): void => {
    expect(ORGANISATION_OWNER_KEY).not.toContain('|');
    vi.stubEnv(CUSTOMER_OIDC_ISSUER_VAR, CUSTOMER_ISSUER);
    const key = ownerKeyOf(identity(CUSTOMER_ISSUER, ORGANISATION_OWNER_KEY));
    expect(key).toBe(`${CUSTOMER_ISSUER}|${ORGANISATION_OWNER_KEY}`);
    expect(isOrganisationOwnerKey(key)).toBe(false);
  });

  it('is not the local issuer’s one subject, nor shaped as a Clerk subject', (): void => {
    vi.stubEnv(CUSTOMER_OIDC_ISSUER_VAR, CUSTOMER_ISSUER);
    expect(
      isOrganisationOwnerKey(ownerKeyOf(identity(DEV_NO_AUTH_ISSUER, DEV_NO_AUTH_SUBJECT))),
    ).toBe(false);
    expect(ORGANISATION_OWNER_KEY.startsWith('user_')).toBe(false);
    expect(isOrganisationOwnerKey(ownerKeyOf(identity(CLERK_ISSUER, 'user_2abc')))).toBe(false);
  });

  // A bare subject is the issuer's to choose, so only a refusal inside ownerKeyOf proves this.
  it.fails(
    // .fails: red until 11-AO's refusal of the reserved key in ownerKeyOf (wave 11).
    'refuses a token whose bare subject is the reserved key (11-AO turns this green)',
    (): void => {
      expect(() => ownerKeyOf(identity(CLERK_ISSUER, ORGANISATION_OWNER_KEY))).toThrow();
    },
  );
});
