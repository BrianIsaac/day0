/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import {
  seedEdge,
  seedEmployee,
  seedIdentity,
  seedPerson,
  type GraphHarness,
} from './fakes/people-graph';

/**
 * What the prompts read of the people graph (wave 13, 13-J; 13-P's "For the People block"): the
 * People block's people, grouped per person from 13-P's two readers, carrying names, roles and
 * edges and never an id, an identity or an evidence quote; and the confirmed people a work item's
 * requester and owner resolve to, for the From line and the person-scoped working agreements.
 */

async function seedItem(
  harness: GraphHarness,
  agentId: Id<'agents'>,
  fields: Record<string, unknown> = {},
): Promise<Id<'workItems'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'LOG-7',
        title: 'Grant Linear access to the new joiner',
        contentSummary: 'Please add Mo to the team.',
        contentRefs: ['ticket://LOG-7'],
        state: 'claimed',
        observedAt: 1,
        createdAt: 1,
        requesterLabel: 'lee.tan',
        ...fields,
      } as never),
  );
}

describe('peoplePrompt.forItem: the People block', (): void => {
  it('groups the edges in force by person, in name order, with the escalation contact and its scope', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const lee = await seedPerson(harness, 'Lee Tan', {
      title: 'Work management administrator',
      primaryEmail: 'lee.tan@kestrel.test',
      evidence: [{ quote: 'Lee runs Linear', where: 'one-to-one', at: 1 }],
    } as never);
    await seedIdentity(harness, lee, { provider: 'slack', externalId: 'U07LEE12345' });
    const dana = await seedPerson(harness, 'Dana Okafor', { team: 'Finance systems' });
    const sara = await seedPerson(harness, 'Sara Lindqvist', { title: 'Support lead' });
    await seedEdge(harness, lee, {
      type: 'collaborator',
      fromAgentId: agentId,
      scope: 'Linear access and workflow',
    });
    await seedEdge(harness, lee, {
      type: 'adjacent-role',
      fromAgentId: agentId,
      scope: 'Raising access requests through the manager',
    });
    await seedEdge(harness, dana, { type: 'dotted-line', fromAgentId: agentId });
    await seedEdge(harness, sara, {
      type: 'escalation-contact',
      fromAgentId: agentId,
      scope: 'missing Linear access',
    });

    const workItemId = await seedItem(harness, agentId);
    const { people } = await harness.query(internal.peoplePrompt.forItem, { workItemId });

    expect(people).toEqual({
      people: [
        { displayName: 'Dana Okafor', team: 'Finance systems', edges: [{ type: 'dotted-line' }] },
        {
          displayName: 'Lee Tan',
          title: 'Work management administrator',
          edges: [
            { type: 'collaborator', scope: 'Linear access and workflow' },
            { type: 'adjacent-role', scope: 'Raising access requests through the manager' },
          ],
        },
      ],
      escalation: {
        kind: 'person',
        displayName: 'Sara Lindqvist',
        title: 'Support lead',
        scope: 'missing Linear access',
      },
    });
    const text = JSON.stringify(people);
    for (const forbidden of [lee, dana, sara, 'kestrel.test', 'U07LEE12345', 'Lee runs Linear']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('takes a Slack id the owner’s graph holds out of the block’s words though it is letters alone, by the graph and not its shape (D-5)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const lee = await seedPerson(harness, 'Lee Tan', { title: 'Close lead (UABCDEFGH)' } as never);
    await seedIdentity(harness, lee, { provider: 'slack', externalId: 'UABCDEFGH' });
    await seedEdge(harness, lee, {
      type: 'collaborator',
      fromAgentId: agentId,
      scope: 'The close; ping UABCDEFGH first',
    });
    const workItemId = await seedItem(harness, agentId);
    const { people } = await harness.query(internal.peoplePrompt.forItem, { workItemId });
    // On the base the id stayed in the title and the scope: an all-letter token reads as a word.
    expect(JSON.stringify(people)).not.toContain('UABCDEFGH');
    expect(people.people).toEqual([
      {
        displayName: 'Lee Tan',
        title: 'Close lead',
        edges: [{ type: 'collaborator', scope: 'The close; ping first' }],
      },
    ]);
  });

  it('answers no one and the manager for an employee with no confirmed person, a proposal or an ended edge', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const proposed = await seedPerson(harness, 'Pat Proposed', { status: 'unverified' } as never);
    await seedEdge(harness, proposed, { type: 'collaborator', fromAgentId: agentId });
    const ended = await seedPerson(harness, 'Eve Ended');
    await seedEdge(harness, ended, {
      type: 'collaborator',
      fromAgentId: agentId,
      status: 'retired',
      effectiveUntil: 2,
    });
    const elsewhere = await seedPerson(harness, 'Olu Other', { userId: 'someone-else' });
    await seedEdge(harness, elsewhere, {
      type: 'collaborator',
      fromAgentId: agentId,
      userId: 'someone-else',
    });

    const workItemId = await seedItem(harness, agentId);
    expect(await harness.query(internal.peoplePrompt.forItem, { workItemId })).toEqual({
      people: { people: [], escalation: { kind: 'manager' } },
    });
  });

  it('answers no one for an employee no owner holds', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness, { userId: undefined });
    const workItemId = await seedItem(harness, agentId);
    expect(await harness.query(internal.peoplePrompt.forItem, { workItemId })).toEqual({
      people: { people: [], escalation: { kind: 'manager' } },
    });
  });
});

describe('peoplePrompt.forItem: the requester', (): void => {
  it('names the confirmed person the requester resolves to, beside the People block', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const lee = await seedPerson(harness, 'Lee Tan', { title: 'Work management administrator' });
    await seedEdge(harness, lee, { type: 'collaborator', fromAgentId: agentId });
    const workItemId = await seedItem(harness, agentId, {
      requesterPerson: { kind: 'person', personId: lee },
    });

    const answer = await harness.query(internal.peoplePrompt.forItem, { workItemId });
    expect(answer.requester).toEqual({
      displayName: 'Lee Tan',
      title: 'Work management administrator',
    });
    expect(answer.people.people.map((person) => person.displayName)).toEqual(['Lee Tan']);
    expect(JSON.stringify(answer)).not.toContain(lee);
  });

  it('names no requester for an ambiguous or unknown one, or one no longer confirmed or of another owner', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const dismissed = await seedPerson(harness, 'Dee Dismissed', { status: 'dismissed' } as never);
    const foreign = await seedPerson(harness, 'Olu Other', { userId: 'someone-else' });
    for (const requesterPerson of [
      { kind: 'ambiguous', candidates: 2 },
      { kind: 'unknown' },
      { kind: 'person', personId: dismissed },
      { kind: 'person', personId: foreign },
      undefined,
    ]) {
      const workItemId = await seedItem(harness, agentId, {
        ...(requesterPerson ? { requesterPerson } : {}),
      });
      const answer = await harness.query(internal.peoplePrompt.forItem, { workItemId });
      expect(answer.requester).toBeUndefined();
    }
  });
});
