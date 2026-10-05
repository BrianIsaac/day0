/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import type { Id } from '../../convex/_generated/dataModel';
import {
  proposePersonInTransaction,
  type ProposalOutcome,
  type ProposedPerson,
} from '../../convex/peopleProposals';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import {
  graphRows,
  seedEmployee,
  seedIdentity,
  seedPerson,
  type GraphHarness,
} from './fakes/people-graph';

/*
 * What a source proposes into the owner's graph (wave 13, 13-P; A1, A14, C5): a person written
 * `unverified` with its words and the edges it implies, merged as evidence into a person matching
 * by identity or address, offered as possibly the same when only a name matches, and never
 * proposed again once dismissed on the same grounds.
 */

/** A proposal from the one-to-one naming Priya Shah as a collaborator of an employee. */
function priya(agentId: Id<'agents'>, fields: Partial<ProposedPerson> = {}): ProposedPerson {
  return {
    name: 'Priya Shah',
    identities: [],
    evidence: [{ quote: 'Priya Shah for segment and pipeline.', where: 'the one-to-one', at: 5 }],
    edges: [{ type: 'collaborator', fromAgentId: agentId, scope: 'segment and pipeline' }],
    ...fields,
  };
}

/** Propose a person into the owner's graph at time 10. */
async function propose(
  harness: GraphHarness,
  proposal: ProposedPerson,
  scope = 'owner',
): Promise<ProposalOutcome> {
  return await harness.run(
    async (ctx) =>
      await proposePersonInTransaction(ctx, scope, proposal, { source: 'one-to-one' }, 10),
  );
}

describe('peopleProposals', (): void => {
  it('writes a new person unverified with its quote and its edge proposed, never as a confirmed fact', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const outcome = await propose(harness, priya(agentId));
    expect(outcome.kind).toBe('proposed');
    const { people, edges } = await graphRows(harness);
    expect(people).toMatchObject([
      {
        displayName: 'Priya Shah',
        nameKey: 'priya shah',
        status: 'unverified',
        source: 'one-to-one',
        evidence: [{ quote: 'Priya Shah for segment and pipeline.', where: 'the one-to-one' }],
      },
    ]);
    expect(people[0]?.confirmedAt).toBeUndefined();
    expect(edges).toMatchObject([
      {
        fromAgentId: agentId,
        type: 'collaborator',
        status: 'proposed',
        scope: 'segment and pipeline',
      },
    ]);
    expect(edges[0]?.confirmedAt).toBeUndefined();
  });

  it('proposes nobody twice when the same words come again', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const first = await propose(harness, priya(agentId));
    const second = await propose(harness, priya(agentId));
    expect(second).toEqual({ kind: 'repeat', personId: first.personId });
    const { people, edges } = await graphRows(harness);
    expect(people).toHaveLength(1);
    expect(edges).toHaveLength(1);
  });

  it('merges a proposal matching a confirmed person by address as evidence, its edge still waiting on Confirm', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const held = await seedPerson(harness, 'P. Shah', { primaryEmail: 'priya@kestrel.test' });
    const outcome = await propose(harness, priya(agentId, { email: 'Priya@Kestrel.test' }));
    expect(outcome).toEqual({ kind: 'merged', personId: held });
    const { people, edges } = await graphRows(harness);
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({
      displayName: 'P. Shah',
      status: 'active',
      evidence: [{ quote: 'Priya Shah for segment and pipeline.' }],
    });
    expect(edges).toMatchObject([{ toPersonId: held, status: 'proposed' }]);
  });

  it('merges a proposal holding the identity a confirmed person holds, in the same workspace', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const held = await seedPerson(harness, 'Someone Else');
    await seedIdentity(harness, held, {
      provider: 'slack',
      externalId: 'U0PRIYA',
      providerWorkspaceId: 'T1',
    });
    const outcome = await propose(
      harness,
      priya(agentId, {
        identities: [{ provider: 'slack', externalId: 'U0PRIYA', workspaceId: 'T1' }],
      }),
    );
    expect(outcome).toEqual({ kind: 'merged', personId: held });
    expect((await graphRows(harness)).people).toHaveLength(1);
  });

  it('offers a name-only match as possibly the same and leaves the known person untouched', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const held = await seedPerson(harness, 'Priya Shah', {
      evidence: [{ quote: 'Priya runs pipeline reviews.', where: 'Team overview', at: 2 }],
    });
    const outcome = await propose(harness, priya(agentId));
    expect(outcome.kind).toBe('possibly');
    const { people, edges } = await graphRows(harness);
    const known = people.find((person) => person._id === held);
    const offered = people.find((person) => person._id === outcome.personId);
    expect(known?.evidence).toEqual([
      { quote: 'Priya runs pipeline reviews.', where: 'Team overview', at: 2 },
    ]);
    expect(offered).toMatchObject({ status: 'unverified', possiblySameAs: held });
    expect(edges).toMatchObject([{ toPersonId: outcome.personId, status: 'proposed' }]);
  });

  it('proposes nobody for a person the manager dismissed on the same words or address', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const first = await propose(harness, priya(agentId, { email: 'priya@kestrel.test' }));
    await harness.run(async (ctx) => {
      await ctx.db.patch(first.personId, { status: 'dismissed', dismissedAt: 11 });
    });
    expect(await propose(harness, priya(agentId))).toEqual({
      kind: 'dismissed',
      personId: first.personId,
    });
    expect(
      await propose(
        harness,
        priya(agentId, {
          name: 'P Shah',
          email: 'priya@kestrel.test',
          evidence: [{ quote: 'P Shah, pipeline', where: 'Team overview', at: 6 }],
        }),
      ),
    ).toEqual({ kind: 'dismissed', personId: first.personId });
    expect((await graphRows(harness)).people).toHaveLength(1);
  });

  it("never reads or merges into another owner's people", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    await seedPerson(harness, 'Priya Shah', {
      userId: 'stranger',
      primaryEmail: 'priya@kestrel.test',
    });
    const outcome = await propose(harness, priya(agentId, { email: 'priya@kestrel.test' }));
    expect(outcome.kind).toBe('proposed');
    expect((await graphRows(harness)).people).toHaveLength(1);
    expect((await graphRows(harness, 'stranger')).people[0]?.evidence).toEqual([]);
  });
});

describe('peopleProposals, the second pass', (): void => {
  it('proposes no edge a manager dismissed on a confirmed person again, and no edge to the owner, who is the manager', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const known = await seedPerson(harness, 'Priya Shah', { primaryEmail: 'priya@kestrel.test' });
    await propose(harness, priya(agentId, { email: 'priya@kestrel.test' }));
    await harness.run(async (ctx) => {
      const edges = await ctx.db.query('relationships').collect();
      for (const edge of edges) await ctx.db.patch(edge._id, { status: 'retired' });
    });
    await propose(
      harness,
      priya(agentId, {
        email: 'priya@kestrel.test',
        evidence: [{ quote: 'Priya Shah, pipeline lead', where: 'Team overview', at: 7 }],
      }),
    );
    expect((await graphRows(harness)).edges.map((edge) => [edge.toPersonId, edge.status])).toEqual([
      [known, 'retired'],
    ]);

    const rowan = await seedPerson(harness, 'Rowan Hale', {
      isOwner: true,
      primaryEmail: 'rowan@kestrel.test',
    });
    const outcome = await propose(
      harness,
      priya(agentId, {
        name: 'Rowan Hale',
        email: 'rowan@kestrel.test',
        evidence: [{ quote: 'Rowan Hale approves the tile', where: 'Onboarding', at: 8 }],
      }),
    );
    expect(outcome).toEqual({ kind: 'merged', personId: rowan });
    expect((await graphRows(harness)).edges.filter((edge) => edge.toPersonId === rowan)).toEqual(
      [],
    );
  });
});
