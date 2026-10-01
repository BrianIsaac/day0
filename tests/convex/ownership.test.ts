import { convexTest } from 'convex-test';
import type { UserIdentity } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import { DEV_NO_AUTH_ISSUER, DEV_NO_AUTH_SUBJECT } from '../../src/lib/dev-auth-issuer';
import { callerSessionId, ownerKeyOf } from '../../convex/ownership';
import { EMPLOYEE_NOT_YOURS, isEmployeeNotYours } from '../../src/agent/employee-access';
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
    expect((await alice.query(api.agents.get, { agentId }))?.userId).toBe(
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
    expect((await local.query(api.agents.get, { agentId }))?.userId).toBe(DEV_NO_AUTH_SUBJECT);

    const impostor = harness.withIdentity({
      issuer: CUSTOMER_ISSUER,
      subject: DEV_NO_AUTH_SUBJECT,
    });
    await expect(impostor.query(api.agents.get, { agentId })).rejects.toThrow(EMPLOYEE_NOT_YOURS);
  });
});

describe('agents.get, the employee page read (ownedAgentOrNull)', (): void => {
  it('answers null for an employee that is gone, so the page can say so rather than crash', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity({ subject: 'owner' });
    const agentId = await owner.mutation(api.agents.deploy, { bossEmail: 'boss@example.com' });
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.delete(agentId);
    });
    await expect(owner.query(api.agents.get, { agentId })).resolves.toBeNull();
  });

  it("refuses another owner's employee with a ConvexError the page can read after production strips the rest", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity({ subject: 'owner' });
    const agentId = await owner.mutation(api.agents.deploy, { bossEmail: 'boss@example.com' });
    const stranger = harness.withIdentity({ subject: 'stranger' });
    const refusal = await stranger.query(api.agents.get, { agentId }).then(
      (): unknown => undefined,
      (error: unknown): unknown => error,
    );
    expect(isEmployeeNotYours(refusal)).toBe(true);
  });

  it('answers null for an address that names no employee at all, a truncated link included', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity({ subject: 'owner' });
    const agentId = await owner.mutation(api.agents.deploy, { bossEmail: 'boss@example.com' });
    await expect(owner.query(api.agents.get, { agentId: 'foo' })).resolves.toBeNull();
    await expect(
      owner.query(api.agents.get, { agentId: agentId.slice(0, -3) }),
    ).resolves.toBeNull();
    await expect(harness.query(api.agents.get, { agentId: 'foo' })).rejects.toThrow();
  });

  it('refuses an anonymous caller before it reads the row', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity({ subject: 'owner' });
    const agentId = await owner.mutation(api.agents.deploy, { bossEmail: 'boss@example.com' });
    await expect(harness.query(api.agents.get, { agentId })).rejects.toThrow();
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

  it('survives the owner key: getCaller keeps every claim, the subject as the token gave it, and adds the owner key', async (): Promise<void> => {
    vi.stubEnv('DAY0_OIDC_ISSUER', CUSTOMER_ISSUER);
    const harness = convexTest(schema, allConvexModules());
    const alice = harness.withIdentity({ issuer: CUSTOMER_ISSUER, subject: 'alice', sid: 'tab-2' });
    const seen = await alice.run(async (ctx) => {
      const { getCaller } = await import('../../convex/ownership');
      const caller = await getCaller(ctx);
      return (
        caller && {
          subject: caller.subject,
          ownerKey: caller.ownerKey,
          session: callerSessionId(caller),
        }
      );
    });
    expect(seen).toEqual({
      subject: 'alice',
      ownerKey: `${CUSTOMER_ISSUER}|alice`,
      session: 'tab-2',
    });
  });
});

describe("convex-test's identity (U-5)", (): void => {
  it('reaches ctx.auth with the email and emailVerified withIdentity was given, as UserIdentity carries the email claims', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const manager = harness.withIdentity({
      subject: 'owner',
      email: 'Boss@Day0.local',
      emailVerified: true,
    });
    const seen = await manager.run(async (ctx) => {
      const identity = await ctx.auth.getUserIdentity();
      return identity && { email: identity.email, emailVerified: identity.emailVerified };
    });
    expect(seen).toEqual({ email: 'Boss@Day0.local', emailVerified: true });

    const unverified = harness.withIdentity({
      subject: 'other',
      email: 'other@day0.local',
      emailVerified: false,
    });
    expect(
      await unverified.run(async (ctx) => (await ctx.auth.getUserIdentity())?.emailVerified),
    ).toBe(false);
    // A function's undefined comes back from run as null, so the claim's absence is read inside.
    expect(
      await harness.withIdentity({ subject: 'bare' }).run(async (ctx) => {
        const identity = await ctx.auth.getUserIdentity();
        return identity !== null && !('email' in identity) && !('emailVerified' in identity);
      }),
    ).toBe(true);
  });
});
