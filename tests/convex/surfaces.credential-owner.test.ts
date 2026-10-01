import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { CREDENTIAL_NOT_THE_OWNERS } from '../../convex/handoverFence';
import { allConvexModules } from './all-modules';
import { fixtureAddressOf } from './fakes/manager-identity';

/*
 * The wave 9 review's M5: an action that resolved or stored a credential under the owner it
 * started with, and writes after a handover moved the employee, must not bind the old owner's
 * credential to the new owner's employee. Each of the four writers refuses a credential whose
 * row is not the employee's current owner's. The handover is represented by its outcome: the
 * employee is the colleague's, the credential the owner's.
 */

type Harness = TestConvex<typeof schema>;

/** The employee after the move, its old owner's credential, its own owner's, and two cards. */
interface Moved {
  readonly harness: Harness;
  readonly agentId: Id<'agents'>;
  readonly oldOwners: Id<'credentials'>;
  readonly newOwners: Id<'credentials'>;
  readonly oldOwnersSource: Id<'docSources'>;
  readonly declared: Id<'surfaces'>;
  readonly slack: Id<'surfaces'>;
}

/** A credential row of one owner. */
function credentialOf(
  userId: string,
  label: string,
): Omit<Doc<'credentials'>, '_id' | '_creationTime'> {
  return {
    userId,
    kind: 'oauth',
    label,
    ciphertext: 'sealed',
    iv: 'iv',
    source: 'oauth',
    createdAt: 1,
  };
}

/**
 * Seed Maya, handed over to the colleague, with a declared Linear card an orientation started
 * under the owner is still working on, and an approved Slack card awaiting its app's install.
 */
async function seedMoved(): Promise<Moved> {
  const harness = convexTest(schema, allConvexModules());
  const seeded = await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: fixtureAddressOf('colleague'),
      name: 'Maya',
      userId: 'colleague',
      state: 'active',
      createdAt: 1,
    });
    const oldOwners = await ctx.db.insert('credentials', credentialOf('owner', 'Linear token'));
    const newOwners = await ctx.db.insert('credentials', credentialOf('colleague', 'Linear token'));
    const oldOwnersSource = await ctx.db.insert('docSources', {
      userId: 'owner',
      label: 'Owner handbook',
      kind: 'folder',
      locator: '.',
      status: 'synced',
      createdAt: 1,
      updatedAt: 1,
    });
    const declared = await ctx.db.insert('surfaces', {
      agentId,
      slug: 'linear',
      displayName: 'Linear',
      class: 'kanban',
      verdict: 'declared',
      whereFound: [],
      credentialLanded: false,
      createdAt: 1,
    });
    const slack = await ctx.db.insert('surfaces', {
      agentId,
      slug: 'slack',
      displayName: 'Slack',
      class: 'chat',
      verdict: 'approved',
      whereFound: [],
      path: 'documented-api',
      endpoint: 'https://slack.com/api/',
      managerApprovedAt: 2,
      credentialLanded: false,
      createdAt: 1,
    });
    return { agentId, oldOwners, newOwners, oldOwnersSource, declared, slack };
  });
  return { harness, ...seeded };
}

/** Read one surface back. */
async function readSurface(harness: Harness, surfaceId: Id<'surfaces'>): Promise<Doc<'surfaces'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
  if (row === null) throw new Error('surface missing');
  return row;
}

/** The proposal an orientation drafts, with a credential and quotes of its choosing. */
function proposal(
  surfaceId: Id<'surfaces'>,
  fields: { credentialId?: Id<'credentials'>; sourceId?: Id<'docSources'> } = {},
) {
  const quote = {
    ...(fields.sourceId === undefined ? {} : { sourceId: String(fields.sourceId) }),
    ref: 'linear.md',
    quote: 'Journals over $50k need Tom Reyes (CFO).',
  };
  return {
    surfaceId,
    request: { target: { system: 'Linear', reasoning: 'Documented.' }, evidence: [quote] },
    whereFound: [quote],
    path: 'mcp',
    fallbackPath: 'escalate',
    endpoint: 'https://mcp.linear.app/mcp',
    ...(fields.credentialId === undefined
      ? {}
      : { credentialId: fields.credentialId, credentialKind: 'value' as const }),
  };
}

describe("surfaces.propose: an orientation in flight at a handover (the wave 9 review's M5)", (): void => {
  it("refuses a proposal that binds the old owner's credential, and leaves the card as it was", async (): Promise<void> => {
    const { harness, declared, oldOwners } = await seedMoved();
    const before = await readSurface(harness, declared);

    await expect(
      harness.mutation(internal.surfaces.propose, proposal(declared, { credentialId: oldOwners })),
    ).resolves.toBe(false);

    expect(await readSurface(harness, declared)).toEqual(before);
  });

  it("refuses a proposal drawn from documentation the employee's owner does not hold", async (): Promise<void> => {
    const { harness, declared, oldOwnersSource } = await seedMoved();
    const before = await readSurface(harness, declared);

    await expect(
      harness.mutation(
        internal.surfaces.propose,
        proposal(declared, { sourceId: oldOwnersSource }),
      ),
    ).resolves.toBe(false);

    expect(await readSurface(harness, declared)).toEqual(before);
  });

  it("files a proposal on the current owner's credential", async (): Promise<void> => {
    const { harness, declared, newOwners } = await seedMoved();

    await expect(
      harness.mutation(internal.surfaces.propose, proposal(declared, { credentialId: newOwners })),
    ).resolves.toBe(true);

    expect(await readSurface(harness, declared)).toMatchObject({
      verdict: 'proposed',
      credentialId: newOwners,
    });
  });
});

describe('the three credential writers after a handover (M5)', (): void => {
  it("attachCredential refuses the old owner's credential and attaches nothing", async (): Promise<void> => {
    const { harness, slack, oldOwners } = await seedMoved();

    await expect(
      harness.mutation(internal.surfaces.attachCredential, {
        surfaceId: slack,
        credentialId: oldOwners,
        credentialKind: 'value',
      }),
    ).rejects.toMatchObject({ data: CREDENTIAL_NOT_THE_OWNERS });

    expect((await readSurface(harness, slack)).credentialId).toBeUndefined();
  });

  it('attachCredential attaches a credential of the current owner', async (): Promise<void> => {
    const { harness, slack, newOwners } = await seedMoved();

    await harness.mutation(internal.surfaces.attachCredential, {
      surfaceId: slack,
      credentialId: newOwners,
      credentialKind: 'value',
    });

    expect((await readSurface(harness, slack)).credentialId).toBe(newOwners);
  });

  it('recordProvisionedApp refuses a client secret stored for the old owner and records no app', async (): Promise<void> => {
    const { harness, slack, oldOwners } = await seedMoved();

    await expect(
      harness.mutation(internal.surfaces.recordProvisionedApp, {
        surfaceId: slack,
        appId: 'A123',
        appName: 'Maya (Day0)',
        clientId: '111.222',
        clientSecretCredentialId: oldOwners,
        installUrl: 'https://slack.com/oauth/v2/authorize',
        redirectUrl: 'https://day0.example.test/api/oauth/slack',
        scopes: ['chat:write'],
        stateNonce: 'nonce',
        stateExpiresAt: 1_000,
        now: 5,
      }),
    ).rejects.toMatchObject({ data: CREDENTIAL_NOT_THE_OWNERS });

    expect((await readSurface(harness, slack)).provisioning).toBeUndefined();
  });

  it('recordInstalledApp refuses a bot token stored for the old owner and binds nothing', async (): Promise<void> => {
    const { harness, slack, oldOwners } = await seedMoved();

    await expect(
      harness.mutation(internal.surfaces.recordInstalledApp, {
        surfaceId: slack,
        credentialId: oldOwners,
        now: 5,
      }),
    ).rejects.toMatchObject({ data: CREDENTIAL_NOT_THE_OWNERS });

    const row = await readSurface(harness, slack);
    expect(row.credentialId).toBeUndefined();
    expect(row.credentialKind).toBeUndefined();
  });
});
