import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { fixtureAddressOf, managerIdentity } from './fakes/manager-identity';

/*
 * The wave 11 review's B1, by decision 1 (a): a key the orientation finds in the documentation is
 * never bound where IT's active organisation connection covers the card's system (IT's connection
 * wins, the card offers Connect), and where none does it is bound and stamped a shared key, so
 * the card says whom the employee acts as before its approval.
 */

type Harness = TestConvex<typeof schema>;

const LINEAR_ENDPOINT = 'https://mcp.linear.app/mcp';

/** Maya, a declared Linear card and the wiki's Linear key, stored from a documentation page. */
interface Seeded {
  readonly harness: Harness;
  readonly surfaceId: Id<'surfaces'>;
  readonly wikiKey: Id<'credentials'>;
}

/** Seed the owner's employee with a declared Linear card and a key synced from the wiki. */
async function seed(connection: 'active' | 'needs-attention' | 'none'): Promise<Seeded> {
  const harness = convexTest(schema, allConvexModules());
  const seeded = await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: fixtureAddressOf('owner'),
      name: 'Maya',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const sourceId = await ctx.db.insert('docSources', {
      userId: 'owner',
      label: 'Wiki',
      kind: 'folder',
      locator: '.',
      status: 'synced',
      createdAt: 1,
      updatedAt: 1,
    });
    const wikiKey = await ctx.db.insert('credentials', {
      userId: 'owner',
      kind: 'value',
      label: 'Linear API key',
      ciphertext: 'sealed',
      iv: 'iv',
      explicitlyAssigned: true,
      source: { sourceId, ref: 'linear.md' },
      createdAt: 1,
    });
    const surfaceId = await ctx.db.insert('surfaces', {
      agentId,
      slug: 'linear',
      displayName: 'Linear',
      class: 'kanban',
      verdict: 'declared',
      whereFound: [],
      credentialLanded: false,
      createdAt: 1,
    });
    if (connection !== 'none') {
      await ctx.db.insert('organisationConnections', {
        system: 'linear',
        displayName: 'Linear',
        kind: 'oauth-app',
        mode: 'shared',
        scopes: ['read', 'write'],
        registeredBy: { via: 'setup-cli', at: 1 },
        status: connection,
        createdAt: 1,
      });
    }
    return { surfaceId, wikiKey };
  });
  return { harness, ...seeded };
}

/** The proposal the orientation drafts for the Linear card, binding the wiki's key. */
function proposal(seeded: Seeded) {
  return {
    surfaceId: seeded.surfaceId,
    request: {
      target: { system: 'Linear', reasoning: 'Documented.' },
      credential: { found: 'value', label: 'Linear API key' },
    },
    whereFound: [],
    path: 'mcp',
    fallbackPath: 'browser-driven',
    endpoint: LINEAR_ENDPOINT,
    credentialId: seeded.wikiKey,
    credentialKind: 'value' as const,
  };
}

/** Read the card back. */
async function readCard(seeded: Seeded): Promise<Doc<'surfaces'>> {
  const row = await seeded.harness.run(async (ctx) => await ctx.db.get(seeded.surfaceId));
  if (row === null) throw new Error('surface missing');
  return row;
}

describe('surfaces.propose: a key found in the documentation (B1, decision 1 (a))', (): void => {
  it('binds no documented key where IT has connected the system, so the card connects through IT', async (): Promise<void> => {
    const seeded = await seed('active');

    expect(await seeded.harness.mutation(internal.surfaces.propose, proposal(seeded))).toBe(true);

    const card = await readCard(seeded);
    expect(card.verdict).toBe('proposed');
    expect(card.credentialId).toBeUndefined();
    expect(card.credentialKind).toBeUndefined();
    expect(card.actsAs).toBeUndefined();
  });

  it('binds the documented key where no connection covers the system, stamped a shared key', async (): Promise<void> => {
    const seeded = await seed('none');

    await seeded.harness.mutation(internal.surfaces.propose, proposal(seeded));

    const card = await readCard(seeded);
    expect(card.credentialId).toBe(seeded.wikiKey);
    expect(card.credentialKind).toBe('value');
    expect(card.actsAs).toEqual({ kind: 'shared-key', label: 'Linear API key' });
  });

  it("binds the documented key where IT's connection is one no issuer of Day0's acts through (11-AC's item 8)", async (): Promise<void> => {
    const seeded = await seed('none');
    await seeded.harness.run(async (ctx) => {
      await ctx.db.insert('organisationConnections', {
        system: 'notion',
        displayName: 'Notion',
        kind: 'static-key',
        mode: 'shared',
        scopes: ['read'],
        registeredBy: { via: 'setup-cli', at: 1 },
        status: 'active',
        createdAt: 1,
      });
      await ctx.db.patch(seeded.surfaceId, { slug: 'notion', displayName: 'Notion' });
    });

    await seeded.harness.mutation(internal.surfaces.propose, {
      ...proposal(seeded),
      path: 'documented-api',
      endpoint: 'https://api.notion.com/v1',
    });

    const card = await readCard(seeded);
    expect(card.credentialId).toBe(seeded.wikiKey);
    expect(card.actsAs).toEqual({ kind: 'shared-key', label: 'Linear API key' });
  });

  it("binds the documented key where IT landed a static key for Linear, which no issuer acts through (D6, the round review's m11)", async (): Promise<void> => {
    const seeded = await seed('none');
    await seeded.harness.run(async (ctx) => {
      await ctx.db.insert('organisationConnections', {
        system: 'linear',
        displayName: 'Linear',
        kind: 'static-key',
        mode: 'shared',
        scopes: ['read'],
        registeredBy: { via: 'setup-cli', at: 1 },
        status: 'active',
        createdAt: 1,
      });
    });

    await seeded.harness.mutation(internal.surfaces.propose, proposal(seeded));

    const card = await readCard(seeded);
    expect(card.credentialId).toBe(seeded.wikiKey);
    expect(card.actsAs).toEqual({ kind: 'shared-key', label: 'Linear API key' });
  });

  it('binds the documented key where the connection needs IT’s attention, which covers nothing', async (): Promise<void> => {
    const seeded = await seed('needs-attention');

    await seeded.harness.mutation(internal.surfaces.propose, proposal(seeded));

    const card = await readCard(seeded);
    expect(card.credentialId).toBe(seeded.wikiKey);
    expect(card.actsAs).toEqual({ kind: 'shared-key', label: 'Linear API key' });
  });
});

describe("whom a card acts as, answered by the listing (11-AC's cockpit item 1; the review's M8)", (): void => {
  it('says a documented key bound with no connection is the documented key, and IT’s identity where a connection covers it', async (): Promise<void> => {
    const seeded = await seed('none');
    await seeded.harness.mutation(internal.surfaces.propose, proposal(seeded));
    const owner = seeded.harness.withIdentity(managerIdentity());
    const agentId = (await readCard(seeded)).agentId;

    const [bound] = await owner.query(api.surfaces.listForAgent, { agentId });
    expect(bound?.identity).toEqual({
      kind: 'shared-key',
      label: 'Linear API key',
      planned: false,
      keyFrom: 'documentation',
    });
    expect(bound?.connectionIdentity).toBeUndefined();

    await seeded.harness.run(async (ctx) => {
      await ctx.db.insert('organisationConnections', {
        system: 'linear',
        displayName: 'Linear',
        kind: 'oauth-app',
        mode: 'shared',
        scopes: ['read', 'write'],
        registeredBy: { via: 'setup-cli', at: 1 },
        status: 'active',
        createdAt: 1,
      });
    });
    const [covered] = await owner.query(api.surfaces.listForAgent, { agentId });
    expect(covered?.connectionIdentity).toEqual({ kind: 'shared-app', planned: true });
  });

  it('names no landed identity on a card that no longer holds its credential', async (): Promise<void> => {
    const seeded = await seed('none');
    await seeded.harness.run(async (ctx) => {
      await ctx.db.patch(seeded.surfaceId, {
        verdict: 'approved',
        path: 'mcp',
        endpoint: LINEAR_ENDPOINT,
        managerApprovedAt: 1,
        actsAs: { kind: 'own-app', label: 'Day0 Leo' },
      });
    });
    const agentId = (await readCard(seeded)).agentId;

    const [card] = await seeded.harness
      .withIdentity(managerIdentity())
      .query(api.surfaces.listForAgent, { agentId });

    expect(card?.identity).toEqual({ kind: 'shared-key', planned: true });
  });
});
