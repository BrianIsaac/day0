import { describe, expect, it } from 'vitest';
import {
  DEV_NO_AUTH_ALGORITHM,
  DEV_NO_AUTH_AUDIENCE,
  DEV_NO_AUTH_ISSUER,
  DEV_NO_AUTH_KEY_ID,
  DEV_NO_AUTH_SESSION_CLAIM,
  DEV_NO_AUTH_SUBJECT,
} from '../../../src/lib/dev-auth-issuer';

describe('the local no-auth issuer', (): void => {
  it('names an https issuer under a reserved local domain that no resolver answers', (): void => {
    expect(DEV_NO_AUTH_ISSUER).toMatch(/^https:\/\/[a-z0-9.-]+\.local$/);
  });

  it('signs with the curve the generated keypair uses, so the deployment can verify what the server mints', (): void => {
    expect(DEV_NO_AUTH_ALGORITHM).toBe('ES256');
  });

  it('carries the browser session in the claim OIDC session management uses', (): void => {
    expect(DEV_NO_AUTH_SESSION_CLAIM).toBe('sid');
  });

  it('keeps the subject, audience and key id as non-empty plain identifiers', (): void => {
    for (const value of [DEV_NO_AUTH_SUBJECT, DEV_NO_AUTH_AUDIENCE, DEV_NO_AUTH_KEY_ID]) {
      expect(value).toMatch(/^[a-z0-9|-]+$/);
    }
  });
});
