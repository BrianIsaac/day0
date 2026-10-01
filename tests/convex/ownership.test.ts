import { convexTest } from 'convex-test';
import type { UserIdentity } from 'convex/server';
import { ConvexError } from 'convex/values';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import { DEV_NO_AUTH_ISSUER, DEV_NO_AUTH_SUBJECT } from '../../src/lib/dev-auth-issuer';
import {
  assertNamedInTransfer,
  callerSessionId,
  ownerKeyOf,
  verifiedAddressOf,
} from '../../convex/ownership';
import type { Id } from '../../convex/_generated/dataModel';
import {
  NOT_NAMED_IN_TRANSFER,
  TRANSFER_NOT_FOUND,
  UNVERIFIED_FOR_TRANSFER,
} from '../../src/agent/manager-transfer';
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
  extra: Omit<Partial<UserIdentity>, 'issuer' | 'subject' | 'tokenIdentifier'> = {},
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

/** An env reader over a plain record, as the deployment's env would answer. */
function deploymentEnv(values: Record<string, string>): (name: string) => string | undefined {
  return (name: string): string | undefined => values[name];
}

const CLERK_ISSUER = 'https://demo.clerk.accounts.dev';

describe('verifiedAddressOf', (): void => {
  it('reads a verified address per issuer and answers undefined for an unverified or missing one', (): void => {
    const env = deploymentEnv({ DAY0_OIDC_ISSUER: CUSTOMER_ISSUER });
    for (const issuer of [CLERK_ISSUER, CUSTOMER_ISSUER, DEV_NO_AUTH_ISSUER]) {
      const verified = identity(issuer, 'u', {
        email: ' Ana@Kestrel.Example ',
        emailVerified: true,
      });
      expect(verifiedAddressOf(verified, env), issuer).toBe('ana@kestrel.example');
      const unverified = identity(issuer, 'u', {
        email: 'ana@kestrel.example',
        emailVerified: false,
      });
      expect(verifiedAddressOf(unverified, env), issuer).toBeUndefined();
      expect(verifiedAddressOf(identity(issuer, 'u', { emailVerified: true }), env), issuer).toBe(
        undefined,
      );
      expect(verifiedAddressOf(identity(issuer, 'u'), env), issuer).toBeUndefined();
    }
  });

  it('refuses an address that is not shaped like one, verified or not', (): void => {
    const env = deploymentEnv({});
    const odd = identity(CLERK_ISSUER, 'u', { email: 'not an address', emailVerified: true });
    expect(verifiedAddressOf(odd, env)).toBeUndefined();
  });

  it("never believes a Clerk or local address without email_verified, the customer issuer's flag notwithstanding", (): void => {
    const env = deploymentEnv({
      DAY0_OIDC_ISSUER: CUSTOMER_ISSUER,
      DAY0_OIDC_EMAIL_TRUSTED: 'true',
    });
    for (const issuer of [CLERK_ISSUER, DEV_NO_AUTH_ISSUER]) {
      expect(verifiedAddressOf(identity(issuer, 'u', { email: 'a@b.example' }), env), issuer).toBe(
        undefined,
      );
    }
  });

  it("refuses a customer issuer's address without email_verified unless DAY0_OIDC_EMAIL_TRUSTED is true (D3)", (): void => {
    const bare = identity(CUSTOMER_ISSUER, 'alice', { email: 'Alice@Example.com' });
    expect(verifiedAddressOf(bare, deploymentEnv({ DAY0_OIDC_ISSUER: CUSTOMER_ISSUER }))).toBe(
      undefined,
    );
    const trusted = deploymentEnv({
      DAY0_OIDC_ISSUER: `${CUSTOMER_ISSUER}/`,
      DAY0_OIDC_EMAIL_TRUSTED: 'true',
    });
    expect(verifiedAddressOf(bare, trusted)).toBe('alice@example.com');
  });

  it('keeps an issuer that says the address is unverified unverified, even when its addresses are trusted', (): void => {
    const trusted = deploymentEnv({
      DAY0_OIDC_ISSUER: CUSTOMER_ISSUER,
      DAY0_OIDC_EMAIL_TRUSTED: 'true',
    });
    const said = identity(CUSTOMER_ISSUER, 'alice', {
      email: 'alice@example.com',
      emailVerified: false,
    });
    expect(verifiedAddressOf(said, trusted)).toBeUndefined();
  });

  it("reads the deployment's own env when no reader is given", (): void => {
    vi.stubEnv('DAY0_OIDC_ISSUER', CUSTOMER_ISSUER);
    vi.stubEnv('DAY0_OIDC_EMAIL_TRUSTED', 'true');
    expect(
      verifiedAddressOf(identity(CUSTOMER_ISSUER, 'alice', { email: 'alice@example.com' })),
    ).toBe('alice@example.com');
  });
});

describe('assertNamedInTransfer', (): void => {
  async function seedRequest(
    harness: ReturnType<typeof convexTest>,
  ): Promise<Id<'managerTransfers'>> {
    return await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'Maya',
        userId: 'owner',
        state: 'deployed',
        createdAt: 1,
      });
      return await ctx.db.insert('managerTransfers', {
        agentId,
        agentName: 'Maya',
        fromOwnerKey: 'owner',
        fromAddress: 'boss@day0.local',
        toAddress: 'lead@day0.local',
        state: 'asked',
        requestedAt: 1,
        expiresAt: 2,
      });
    });
  }

  /** What the guard answers a caller: the row's id, or the refusal's words. */
  async function guardFor(
    harness: ReturnType<typeof convexTest>,
    who: Partial<UserIdentity>,
    transferId: Id<'managerTransfers'>,
  ): Promise<string> {
    return await harness.withIdentity(who).run(async (ctx) => {
      try {
        return (await assertNamedInTransfer(ctx, transferId))._id;
      } catch (error: unknown) {
        return error instanceof ConvexError ? `refused: ${String(error.data)}` : 'crashed';
      }
    });
  }

  it('answers the request to the account signed in with the address it names, however it is spelt', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const transferId = await seedRequest(harness);
    await expect(
      guardFor(
        harness,
        { subject: 'lead', email: 'Lead@Day0.local', emailVerified: true },
        transferId,
      ),
    ).resolves.toBe(transferId);
  });

  it('refuses every other account with words the dialog can show, the owner who asked included', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const transferId = await seedRequest(harness);
    for (const who of [
      { subject: 'owner', email: 'boss@day0.local', emailVerified: true },
      { subject: 'someone', email: 'someone@day0.local', emailVerified: true },
    ]) {
      await expect(guardFor(harness, who, transferId), who.subject).resolves.toBe(
        `refused: ${NOT_NAMED_IN_TRANSFER}`,
      );
    }
  });

  it('refuses the named address when the token does not assert it verified', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const transferId = await seedRequest(harness);
    await expect(
      guardFor(
        harness,
        { subject: 'lead', email: 'lead@day0.local', emailVerified: false },
        transferId,
      ),
    ).resolves.toBe(`refused: ${UNVERIFIED_FOR_TRANSFER}`);
  });

  it('refuses a request that no longer exists, and an anonymous caller before it reads', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const transferId = await seedRequest(harness);
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.delete(transferId);
    });
    await expect(
      guardFor(
        harness,
        { subject: 'lead', email: 'lead@day0.local', emailVerified: true },
        transferId,
      ),
    ).resolves.toBe(`refused: ${TRANSFER_NOT_FOUND}`);
    await expect(
      harness.run(async (ctx) => await assertNamedInTransfer(ctx, transferId)),
    ).rejects.toThrow();
  });
});
