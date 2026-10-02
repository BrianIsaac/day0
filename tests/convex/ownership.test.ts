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
  OWN_TRANSFER,
  TRANSFER_NOT_FOUND,
  UNVERIFIED_FOR_TRANSFER,
} from '../../src/agent/manager-transfer';
import {
  EMPLOYEE_GONE,
  EMPLOYEE_NOT_YOURS,
  isEmployeeNotYours,
} from '../../src/agent/employee-access';
import { ORGANISATION_OWNER_KEY } from '../../src/lib/organisation-key';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS, localIssuerIdentity, managerIdentity } from './fakes/manager-identity';

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
    vi.stubEnv('DAY0_OIDC_ALLOWED_DOMAINS', 'example.com');
    const harness = convexTest(schema, allConvexModules());
    const alice = harness.withIdentity(
      managerIdentity('alice', { issuer: CUSTOMER_ISSUER, email: 'alice@example.com' }),
    );
    const agentId = await alice.mutation(api.agents.deploy, {});
    expect((await alice.query(api.agents.get, { agentId }))?.userId).toBe(
      `${CUSTOMER_ISSUER}|alice`,
    );
  });

  it('never lets a customer token that names the local subject act as the local owner', async (): Promise<void> => {
    vi.stubEnv('DAY0_OIDC_ISSUER', CUSTOMER_ISSUER);
    vi.stubEnv('DAY0_OIDC_ALLOWED_DOMAINS', 'example.com');
    const harness = convexTest(schema, allConvexModules());
    const local = harness.withIdentity(
      managerIdentity(DEV_NO_AUTH_SUBJECT, { issuer: DEV_NO_AUTH_ISSUER, email: MANAGER_ADDRESS }),
    );
    const agentId = await local.mutation(api.agents.deploy, {});
    expect((await local.query(api.agents.get, { agentId }))?.userId).toBe(DEV_NO_AUTH_SUBJECT);

    const impostor = harness.withIdentity(
      // An allowed address: the domain rule admits it, and the owner key still keeps it apart.
      managerIdentity(DEV_NO_AUTH_SUBJECT, { issuer: CUSTOMER_ISSUER, email: 'boss@example.com' }),
    );
    await expect(impostor.query(api.agents.get, { agentId })).rejects.toThrow(EMPLOYEE_NOT_YOURS);
  });
});

describe('agents.get, the employee page read (ownedAgentOrNull)', (): void => {
  it('answers null for an employee that is gone, so the page can say so rather than crash', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity(managerIdentity());
    const agentId = await owner.mutation(api.agents.deploy, {});
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.delete(agentId);
    });
    await expect(owner.query(api.agents.get, { agentId })).resolves.toBeNull();
  });

  it("refuses another owner's employee with a ConvexError the page can read after production strips the rest", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity(managerIdentity());
    const agentId = await owner.mutation(api.agents.deploy, {});
    const stranger = harness.withIdentity(managerIdentity('stranger'));
    const refusal = await stranger.query(api.agents.get, { agentId }).then(
      (): unknown => undefined,
      (error: unknown): unknown => error,
    );
    expect(isEmployeeNotYours(refusal)).toBe(true);
  });

  it('answers null for an address that names no employee at all, a truncated link included', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity(managerIdentity());
    const agentId = await owner.mutation(api.agents.deploy, {});
    await expect(owner.query(api.agents.get, { agentId: 'foo' })).resolves.toBeNull();
    await expect(
      owner.query(api.agents.get, { agentId: agentId.slice(0, -3) }),
    ).resolves.toBeNull();
    await expect(harness.query(api.agents.get, { agentId: 'foo' })).rejects.toThrow();
  });

  it('refuses an anonymous caller before it reads the row', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity(managerIdentity());
    const agentId = await owner.mutation(api.agents.deploy, {});
    await expect(harness.query(api.agents.get, { agentId })).rejects.toThrow();
  });
});

describe('the per-agent guards (the cockpit’s item, FW-m5)', (): void => {
  it("refuse another owner's employee with a ConvexError in the manager's words, through every guard that reads it", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity(managerIdentity());
    const agentId = await owner.mutation(api.agents.deploy, {});
    const stranger = harness.withIdentity(managerIdentity('stranger'));
    const refusals = await Promise.all([
      stranger.query(api.skills.proposed, { agentId }).then(
        (): unknown => undefined,
        (error: unknown): unknown => error,
      ),
      stranger.query(api.skills.registered, { agentId }).then(
        (): unknown => undefined,
        (error: unknown): unknown => error,
      ),
    ]);
    for (const refusal of refusals) {
      expect(refusal).toBeInstanceOf(ConvexError);
      expect(isEmployeeNotYours(refusal)).toBe(true);
    }
  });

  it('refuse an employee that no longer exists with a ConvexError in the manager’s words', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity(managerIdentity());
    const agentId = await owner.mutation(api.agents.deploy, {});
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.delete(agentId);
    });
    await expect(owner.query(api.skills.proposed, { agentId })).rejects.toMatchObject({
      data: EMPLOYEE_GONE,
    });
  });

  it('refuse an anonymous caller with a ConvexError too, in the mode’s words', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity(managerIdentity());
    const agentId = await owner.mutation(api.agents.deploy, {});
    const refusal = await harness.query(api.skills.proposed, { agentId }).then(
      (): unknown => undefined,
      (error: unknown): unknown => error,
    );
    expect(refusal).toBeInstanceOf(ConvexError);
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
    vi.stubEnv('DAY0_OIDC_ALLOWED_DOMAINS', 'example.com');
    const harness = convexTest(schema, allConvexModules());
    const alice = harness.withIdentity({
      ...managerIdentity('alice', { issuer: CUSTOMER_ISSUER, email: 'alice@example.com' }),
      sid: 'tab-2',
    });
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

  it("reads the raw email_verified claim, as the backend hands over a custom JWT issuer's claims unmapped", (): void => {
    // Seen on a self-hosted backend for the local issuer (a customJwt provider): ctx.auth
    // carried `email` and `email_verified: true`, and no `emailVerified` (the 9-U1 bed, 1 Oct).
    const env = deploymentEnv({ DAY0_OIDC_ISSUER: CUSTOMER_ISSUER });
    for (const issuer of [DEV_NO_AUTH_ISSUER, CUSTOMER_ISSUER, CLERK_ISSUER]) {
      // Outside `day0.local`, which only the local issuer vouches for (U1-m4, its own test below).
      const raw = identity(issuer, 'u', { email: 'Boss@Kestrel.Example', email_verified: true });
      expect(verifiedAddressOf(raw, env), issuer).toBe('boss@kestrel.example');
      const rawFalse = identity(issuer, 'u', {
        email: 'boss@kestrel.example',
        email_verified: false,
      });
      expect(verifiedAddressOf(rawFalse, env), issuer).toBeUndefined();
      // Only a boolean asserts it: a string is not the claim the issuer is specified to send.
      const rawString = identity(issuer, 'u', {
        email: 'boss@kestrel.example',
        email_verified: 'true',
      });
      expect(verifiedAddressOf(rawString, env), issuer).toBeUndefined();
    }
  });

  it("treats a raw email_verified of false as the issuer's word, the trust flag notwithstanding", (): void => {
    const trusted = deploymentEnv({
      DAY0_OIDC_ISSUER: CUSTOMER_ISSUER,
      DAY0_OIDC_EMAIL_TRUSTED: 'true',
    });
    const said = identity(CUSTOMER_ISSUER, 'alice', {
      email: 'alice@example.com',
      email_verified: false,
    });
    expect(verifiedAddressOf(said, trusted)).toBeUndefined();
  });

  it('believes neither spelling of the claim when the two disagree, whichever comes first (U1-m1)', (): void => {
    const env = deploymentEnv({
      DAY0_OIDC_ISSUER: CUSTOMER_ISSUER,
      DAY0_OIDC_EMAIL_TRUSTED: 'true',
    });
    for (const issuer of [DEV_NO_AUTH_ISSUER, CUSTOMER_ISSUER, CLERK_ISSUER]) {
      for (const claims of [
        { emailVerified: true, email_verified: false },
        { emailVerified: false, email_verified: true },
        { emailVerified: true, email_verified: 'false' },
        // A JSON null is no claim of verification, alone or beside a true (second pass).
        { emailVerified: null },
        { email_verified: null },
        { emailVerified: true, email_verified: null },
        { email_verified: 0 },
      ]) {
        const both = identity(issuer, 'u', { email: 'boss@kestrel.example', ...claims });
        expect(verifiedAddressOf(both, env), `${issuer} ${JSON.stringify(claims)}`).toBeUndefined();
      }
      // Outside `day0.local`, which only the local issuer vouches for (U1-m4).
      const agreeing = identity(issuer, 'u', {
        email: 'boss@kestrel.example',
        emailVerified: true,
        email_verified: true,
      });
      expect(verifiedAddressOf(agreeing, env), issuer).toBe('boss@kestrel.example');
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
        bossEmail: MANAGER_ADDRESS,
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
        const { transfer, caller } = await assertNamedInTransfer(ctx, transferId);
        return `${transfer._id} for ${caller.ownerKey}`;
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
    ).resolves.toBe(`${transferId} for lead`);
  });

  it('refuses the account that asked even when it signs in with the named address (plan 5.1)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const transferId = await seedRequest(harness);
    // One person, one account, two addresses: the second is now the account's verified one.
    await expect(
      guardFor(
        harness,
        { subject: 'owner', email: 'lead@day0.local', emailVerified: true },
        transferId,
      ),
    ).resolves.toBe(`refused: ${OWN_TRANSFER}`);
  });

  it('answers every other account as it answers a request that does not exist, the owner who asked included, so no id is confirmed to anyone it does not name (U1-m2)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const transferId = await seedRequest(harness);
    for (const who of [
      { subject: 'owner', email: 'boss@day0.local', emailVerified: true },
      { subject: 'someone', email: 'someone@day0.local', emailVerified: true },
    ]) {
      await expect(guardFor(harness, who, transferId), who.subject).resolves.toBe(
        `refused: ${TRANSFER_NOT_FOUND}`,
      );
    }
  });

  it('refuses an unverified caller before it reads the request, so a missing id and a live one answer alike (U1-m2)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const transferId = await seedRequest(harness);
    const gone = await seedRequest(harness);
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.delete(gone);
    });
    const unverified = { subject: 'lead', email: 'lead@day0.local', emailVerified: false };
    await expect(guardFor(harness, unverified, transferId)).resolves.toBe(
      `refused: ${UNVERIFIED_FOR_TRANSFER}`,
    );
    await expect(guardFor(harness, unverified, gone)).resolves.toBe(
      `refused: ${UNVERIFIED_FOR_TRANSFER}`,
    );
  });

  it("reads an id that is not a handover request's, or not an id at all, as one that does not exist (U4-m1)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const transferId = await seedRequest(harness);
    const agentId = await harness.run(
      async (ctx) => (await ctx.db.get(transferId))!.agentId as string,
    );
    const lead = { subject: 'lead', email: 'lead@day0.local', emailVerified: true };
    for (const id of ['garbage', agentId, '']) {
      await expect(
        harness.withIdentity(lead).run(async (ctx) => {
          try {
            await assertNamedInTransfer(ctx, id);
            return 'answered';
          } catch (error: unknown) {
            return error instanceof ConvexError ? `refused: ${String(error.data)}` : 'crashed';
          }
        }),
        id,
      ).resolves.toBe(`refused: ${TRANSFER_NOT_FOUND}`);
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

  it('refuses a request that no longer exists', async (): Promise<void> => {
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
  });

  it('refuses an anonymous caller as not authenticated, before it reads a live request', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const transferId = await seedRequest(harness);
    await expect(
      harness.run(async (ctx) => await assertNamedInTransfer(ctx, transferId)),
    ).rejects.toThrow(/^not authenticated/);
  });
});

describe('the domain rule in getCaller (S2)', (): void => {
  /** The owner key getCaller answers a caller with, or null when it refuses them. */
  async function callerKeyOf(who: Partial<UserIdentity>): Promise<string | null> {
    const harness = convexTest(schema, allConvexModules());
    return await harness.withIdentity(who).run(async (ctx) => {
      const { getCaller } = await import('../../convex/ownership');
      return (await getCaller(ctx))?.ownerKey ?? null;
    });
  }

  it('getCaller refuses a customer-issuer caller outside the allowed domains', async (): Promise<void> => {
    vi.stubEnv('DAY0_OIDC_ISSUER', CUSTOMER_ISSUER);
    vi.stubEnv('DAY0_OIDC_ALLOWED_DOMAINS', 'acme.test');
    const forced = managerIdentity('eve', { issuer: CUSTOMER_ISSUER, email: 'eve@rival.test' });
    await expect(callerKeyOf(forced)).resolves.toBeNull();
    const allowed = managerIdentity('priya', { issuer: CUSTOMER_ISSUER, email: 'Priya@ACME.test' });
    await expect(callerKeyOf(allowed)).resolves.toBe(`${CUSTOMER_ISSUER}|priya`);
  });

  it('refuses every customer-issuer caller while the deployment names no allowed domain', async (): Promise<void> => {
    vi.stubEnv('DAY0_OIDC_ISSUER', CUSTOMER_ISSUER);
    const priya = managerIdentity('priya', { issuer: CUSTOMER_ISSUER, email: 'priya@acme.test' });
    await expect(callerKeyOf(priya)).resolves.toBeNull();
  });

  it('refuses a Google caller whose hd is not an allowed Workspace, whatever its address', async (): Promise<void> => {
    vi.stubEnv('DAY0_OIDC_ISSUER', 'https://accounts.google.com');
    vi.stubEnv('DAY0_OIDC_ALLOWED_DOMAINS', 'acme.test');
    const personal = {
      ...managerIdentity('g1', { issuer: 'https://accounts.google.com', email: 'priya@acme.test' }),
    };
    await expect(callerKeyOf(personal)).resolves.toBeNull();
    await expect(callerKeyOf({ ...personal, hd: 'acme.test' })).resolves.toBe(
      'https://accounts.google.com|g1',
    );
  });

  it('leaves the local issuer and Clerk to their own rules', async (): Promise<void> => {
    vi.stubEnv('DAY0_OIDC_ISSUER', CUSTOMER_ISSUER);
    vi.stubEnv('DAY0_OIDC_ALLOWED_DOMAINS', 'acme.test');
    await expect(callerKeyOf(localIssuerIdentity())).resolves.toBe(DEV_NO_AUTH_SUBJECT);
    await expect(
      callerKeyOf(managerIdentity('user_1', { issuer: CLERK_ISSUER, email: 'a@elsewhere.test' })),
    ).resolves.toBe('user_1');
  });
});

describe('the reserved organisation key in getCaller (11-AO)', (): void => {
  it('answers a token whose bare subject is the reserved key as no caller at all', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const caller = await harness
      .withIdentity(managerIdentity(ORGANISATION_OWNER_KEY, { issuer: CLERK_ISSUER }))
      .run(async (ctx) => {
        const { getCaller } = await import('../../convex/ownership');
        return await getCaller(ctx);
      });
    expect(caller).toBeNull();
    await expect(
      harness
        .withIdentity(managerIdentity(ORGANISATION_OWNER_KEY, { issuer: CLERK_ISSUER }))
        .mutation(api.agents.deploy, {}),
    ).rejects.toThrow();
  });
});

describe('a verified address under the generic sign-in preset (the wave 10 review, decision 7 (b))', (): void => {
  /** The owner key getCaller answers a caller with, or null when it refuses them. */
  async function callerKeyOf(who: Partial<UserIdentity>): Promise<string | null> {
    const harness = convexTest(schema, allConvexModules());
    return await harness.withIdentity(who).run(async (ctx) => {
      const { getCaller } = await import('../../convex/ownership');
      return (await getCaller(ctx))?.ownerKey ?? null;
    });
  }

  it('refuses an allowed-domain address a generic issuer says is unverified', async (): Promise<void> => {
    vi.stubEnv('DAY0_OIDC_ISSUER', CUSTOMER_ISSUER);
    vi.stubEnv('DAY0_OIDC_ALLOWED_DOMAINS', 'acme.test');
    const unverified = managerIdentity('mallory', {
      issuer: CUSTOMER_ISSUER,
      email: 'mallory@acme.test',
      emailVerified: false,
    });
    await expect(callerKeyOf(unverified)).resolves.toBeNull();
    await expect(callerKeyOf({ ...unverified, emailVerified: undefined })).resolves.toBeNull();
    await expect(
      callerKeyOf({ ...unverified, emailVerified: undefined, email_verified: 'true' }),
    ).resolves.toBeNull();
  });

  it('admits a generic issuer’s verified address, and an unclaimed one only where the deployment trusts its addresses (D3)', async (): Promise<void> => {
    vi.stubEnv('DAY0_OIDC_ISSUER', CUSTOMER_ISSUER);
    vi.stubEnv('DAY0_OIDC_ALLOWED_DOMAINS', 'acme.test');
    const priya = managerIdentity('priya', { issuer: CUSTOMER_ISSUER, email: 'priya@acme.test' });
    await expect(callerKeyOf(priya)).resolves.toBe(`${CUSTOMER_ISSUER}|priya`);
    const unclaimed = { ...priya, emailVerified: undefined };
    await expect(callerKeyOf(unclaimed)).resolves.toBeNull();
    vi.stubEnv('DAY0_OIDC_EMAIL_TRUSTED', 'true');
    await expect(callerKeyOf(unclaimed)).resolves.toBe(`${CUSTOMER_ISSUER}|priya`);
  });

  it('leaves Entra, Okta and Google, which control their addresses, to the domain rule alone', async (): Promise<void> => {
    vi.stubEnv('DAY0_OIDC_ALLOWED_DOMAINS', 'acme.test');
    const entra = 'https://login.microsoftonline.com/3f2504e0-4f89-11d3-9a0c-0305e82c3301/v2.0';
    for (const issuer of [entra, 'https://acme.okta.com']) {
      vi.stubEnv('DAY0_OIDC_ISSUER', issuer);
      await expect(
        callerKeyOf(
          managerIdentity('ana', { issuer, email: 'ana@acme.test', emailVerified: false }),
        ),
      ).resolves.toBe(`${issuer}|ana`);
    }
    vi.stubEnv('DAY0_OIDC_ISSUER', 'https://accounts.google.com');
    await expect(
      callerKeyOf({
        ...managerIdentity('g2', {
          issuer: 'https://accounts.google.com',
          email: 'ana@acme.test',
          emailVerified: false,
        }),
        hd: 'acme.test',
      }),
    ).resolves.toBe('https://accounts.google.com|g2');
  });
});

describe("verifiedAddressOf and Entra's xms_edov (S4)", (): void => {
  const ENTRA = 'https://login.microsoftonline.com/3f2504e0-4f89-11d3-9a0c-0305e82c3301/v2.0';

  it('verifiedAddressOf reads xms_edov', (): void => {
    const env = deploymentEnv({ DAY0_OIDC_ISSUER: ENTRA });
    const edov = identity(ENTRA, 'oid-1', { email: 'Priya@Acme.test', xms_edov: true });
    expect(verifiedAddressOf(edov, env)).toBe('priya@acme.test');
    expect(verifiedAddressOf(identity(ENTRA, 'oid-1', { email: 'priya@acme.test' }), env)).toBe(
      undefined,
    );
  });

  it('takes an xms_edov of false at its word, the trust flag notwithstanding, and only a boolean true asserts it', (): void => {
    const trusted = deploymentEnv({ DAY0_OIDC_ISSUER: ENTRA, DAY0_OIDC_EMAIL_TRUSTED: 'true' });
    for (const said of [false, 'true', 1, null]) {
      const caller = identity(ENTRA, 'oid-1', { email: 'priya@acme.test', xms_edov: said });
      expect(verifiedAddressOf(caller, trusted), String(said)).toBeUndefined();
    }
  });

  it('lets email_verified speak first when the issuer sends both', (): void => {
    const env = deploymentEnv({ DAY0_OIDC_ISSUER: ENTRA });
    const both = identity(ENTRA, 'oid-1', {
      email: 'priya@acme.test',
      emailVerified: false,
      xms_edov: true,
    });
    expect(verifiedAddressOf(both, env)).toBeUndefined();
  });
});

describe('the reserved local domain (the wave 9 review, U1-m4)', (): void => {
  it("never believes a customer issuer's day0.local address, verified or trusted", (): void => {
    const trusted = deploymentEnv({
      DAY0_OIDC_ISSUER: CUSTOMER_ISSUER,
      DAY0_OIDC_EMAIL_TRUSTED: 'true',
    });
    for (const address of ['boss@day0.local', 'Eval-run1@Day0.local', 'lead@day0.local']) {
      const verified = identity(CUSTOMER_ISSUER, 'mallory', {
        email: address,
        emailVerified: true,
      });
      expect(verifiedAddressOf(verified, trusted), address).toBeUndefined();
      const flagged = identity(CUSTOMER_ISSUER, 'mallory', { email: address });
      expect(verifiedAddressOf(flagged, trusted), address).toBeUndefined();
    }
  });

  it('believes the local issuer, whose own domain it is', (): void => {
    const env = deploymentEnv({ DAY0_OIDC_ISSUER: CUSTOMER_ISSUER });
    expect(verifiedAddressOf(localIssuerIdentity() as UserIdentity, env)).toBe(MANAGER_ADDRESS);
  });
});

describe('the one local manager on the named side of a handover (the wave 9 review, U1-m3)', (): void => {
  /** A request a customer-issuer account asked, naming the local operator's configured address. */
  async function askedOfTheLocalAddress(
    harness: ReturnType<typeof convexTest>,
  ): Promise<Id<'managerTransfers'>> {
    return await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'alice@acme.test',
        name: 'Maya',
        userId: `${CUSTOMER_ISSUER}|alice`,
        state: 'deployed',
        createdAt: 1,
      });
      return await ctx.db.insert('managerTransfers', {
        agentId,
        agentName: 'Maya',
        fromOwnerKey: `${CUSTOMER_ISSUER}|alice`,
        fromAddress: 'alice@acme.test',
        toAddress: MANAGER_ADDRESS,
        state: 'asked',
        requestedAt: Date.now(),
        expiresAt: Date.now() + 86_400_000,
      });
    });
  }

  it('refuses the local account the preview, the accept and the decline under local-dev, as it refuses the ask', async (): Promise<void> => {
    vi.stubEnv('DAY0_OIDC_ISSUER', CUSTOMER_ISSUER);
    vi.stubEnv('DAY0_PROFILE', '');
    const harness = convexTest(schema, allConvexModules());
    const transferId = await askedOfTheLocalAddress(harness);
    const local = harness.withIdentity(localIssuerIdentity());
    const refusal = (error: unknown): string =>
      error instanceof ConvexError ? String(error.data) : String(error);
    const { LOCAL_DEV_TRANSFER_REFUSAL } = await import('../../src/agent/manager-transfer');
    await expect(
      local.query(api.transferAcceptance.transferPreview, { transferId }).catch(refusal),
    ).resolves.toBe(LOCAL_DEV_TRANSFER_REFUSAL);
    await expect(
      local.mutation(api.transferAcceptance.accept, { transferId }).catch(refusal),
    ).resolves.toBe(LOCAL_DEV_TRANSFER_REFUSAL);
    await expect(
      local.mutation(api.managerTransfers.decline, { transferId }).catch(refusal),
    ).resolves.toBe(LOCAL_DEV_TRANSFER_REFUSAL);
  });

  it('lets the local account answer under customer-local, where it is one manager among several', async (): Promise<void> => {
    vi.stubEnv('DAY0_OIDC_ISSUER', CUSTOMER_ISSUER);
    vi.stubEnv('DAY0_PROFILE', 'customer-local');
    const harness = convexTest(schema, allConvexModules());
    const transferId = await askedOfTheLocalAddress(harness);
    const seen = await harness.withIdentity(localIssuerIdentity()).run(async (ctx) => {
      const { transfer, caller } = await assertNamedInTransfer(ctx, transferId);
      return `${transfer._id} for ${caller.ownerKey}`;
    });
    expect(seen).toBe(`${transferId} for ${DEV_NO_AUTH_SUBJECT}`);
  });
});
