import { convexTest } from 'convex-test';
import type { UserIdentity } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import { DEV_NO_AUTH_ISSUER, DEV_NO_AUTH_SUBJECT } from '../../src/lib/dev-auth-issuer';
import { callerSessionId, ownerKeyOf } from '../../convex/ownership';
import { allConvexModules } from './all-modules';

const CUSTOMER_ISSUER = 'https://sso.example.com/realms/ops';

afterEach((): void => {
  vi.unstubAllEnvs();
});

/** A token's identity as the deployment sees it. */
function identity(
  issuer: string,
  subject: string,
  extra: Record<string, string> = {},
): UserIdentity {
  return { issuer, subject, tokenIdentifier: `${issuer}|${subject}`, ...extra };
}

describe('the owner key', (): void => {
  it('is the bare subject for the local issuer and Clerk, whose rows were keyed on it', (): void => {
    vi.stubEnv('DAY0_OIDC_ISSUER', CUSTOMER_ISSUER);
    expect(ownerKeyOf(identity(DEV_NO_AUTH_ISSUER, DEV_NO_AUTH_SUBJECT))).toBe(DEV_NO_AUTH_SUBJECT);
    expect(ownerKeyOf(identity('https://demo.clerk.accounts.dev', 'user_1'))).toBe('user_1');
  });

  it('is qualified by the issuer for the customer issuer, trailing slash or not', (): void => {
    vi.stubEnv('DAY0_OIDC_ISSUER', `${CUSTOMER_ISSUER}/`);
    expect(ownerKeyOf(identity(CUSTOMER_ISSUER, 'alice'))).toBe(`${CUSTOMER_ISSUER}|alice`);
  });

  it('keys an agent a customer user deploys on the issuer and the subject together', async (): Promise<void> => {
    vi.stubEnv('DAY0_OIDC_ISSUER', CUSTOMER_ISSUER);
    const harness = convexTest(schema, allConvexModules());
    const alice = harness.withIdentity({ issuer: CUSTOMER_ISSUER, subject: 'alice' });
    const agentId = await alice.mutation(api.agents.deploy, { bossEmail: 'alice@example.com' });
    expect((await alice.query(api.agents.get, { agentId })).userId).toBe(
      `${CUSTOMER_ISSUER}|alice`,
    );
  });

  it('never lets a customer token that names the local subject act as the local owner', async (): Promise<void> => {
    vi.stubEnv('DAY0_OIDC_ISSUER', CUSTOMER_ISSUER);
    const harness = convexTest(schema, allConvexModules());
    const local = harness.withIdentity({
      issuer: DEV_NO_AUTH_ISSUER,
      subject: DEV_NO_AUTH_SUBJECT,
    });
    const agentId = await local.mutation(api.agents.deploy, { bossEmail: 'boss@day0.local' });
    expect((await local.query(api.agents.get, { agentId })).userId).toBe(DEV_NO_AUTH_SUBJECT);

    const impostor = harness.withIdentity({
      issuer: CUSTOMER_ISSUER,
      subject: DEV_NO_AUTH_SUBJECT,
    });
    await expect(impostor.query(api.agents.get, { agentId })).rejects.toThrow('forbidden');
  });
});

describe('the caller session', (): void => {
  it('reads the session id a token carries in sid', (): void => {
    expect(callerSessionId(identity(DEV_NO_AUTH_ISSUER, DEV_NO_AUTH_SUBJECT, { sid: 'b1' }))).toBe(
      'b1',
    );
  });

  it('is absent when the issuer names no session', (): void => {
    expect(callerSessionId(identity(CUSTOMER_ISSUER, 'alice'))).toBeUndefined();
    expect(callerSessionId(identity(CUSTOMER_ISSUER, 'alice', { sid: '' }))).toBeUndefined();
  });

  it('survives the owner key: getCaller keeps every claim but the subject', async (): Promise<void> => {
    vi.stubEnv('DAY0_OIDC_ISSUER', CUSTOMER_ISSUER);
    const harness = convexTest(schema, allConvexModules());
    const alice = harness.withIdentity({ issuer: CUSTOMER_ISSUER, subject: 'alice', sid: 'tab-2' });
    const seen = await alice.run(async (ctx) => {
      const { getCaller } = await import('../../convex/ownership');
      const caller = await getCaller(ctx);
      return caller && { subject: caller.subject, session: callerSessionId(caller) };
    });
    expect(seen).toEqual({ subject: `${CUSTOMER_ISSUER}|alice`, session: 'tab-2' });
  });
});
