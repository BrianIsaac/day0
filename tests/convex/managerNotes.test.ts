/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  digestNoteFilter,
  managerDelivery,
  owedDecisions,
  queueManagerNote,
} from '../../convex/managerNotes';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';

/**
 * The notes the gate keeps for the manager (`convex/managerNotes.ts`, moved out of
 * `convex/work.ts` by the wave 15 helpers split): a finished run's note is kept only where there
 * is a channel to send it, sent at once per run or kept for the digest, and the digest says what
 * the manager still has to decide.
 */

type Harness = TestConvex<typeof schema>;
type Decision = NonNullable<Doc<'workItems'>['decision']>;

// A per-run note schedules its send; the scheduler's timer is faked and the
// tests read the scheduled jobs instead.
beforeEach((): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach((): void => {
  vi.useRealTimers();
});

async function seedAgent(
  harness: Harness,
  managerNotifications?: Doc<'agents'>['managerNotifications'],
): Promise<Doc<'agents'>> {
  return await harness.run(async (ctx) => {
    const id = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Aiko',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
      ...(managerNotifications ? { managerNotifications } : {}),
    });
    const agent = await ctx.db.get(id);
    if (!agent) throw new Error('agent missing');
    return agent;
  });
}

async function seedChat(harness: Harness, agentId: Id<'agents'>): Promise<void> {
  await harness.run(async (ctx) => {
    const credentialId = await ctx.db.insert('credentials', {
      userId: 'owner',
      kind: 'value',
      label: 'team chat token',
      ciphertext: 'ciphertext',
      iv: 'iv',
      source: 'entered',
      createdAt: 1,
    });
    await ctx.db.insert('surfaces', {
      agentId,
      slug: 'team-chat',
      displayName: 'Team chat',
      class: 'chat',
      verdict: 'connected',
      whereFound: [],
      path: 'documented-api',
      endpoint: 'https://slack.com/api/',
      toolAllowlist: ['chat.postMessage'],
      managerDmChannelId: 'D0MANAGER',
      managerUserId: 'UMANAGER',
      credentialId,
      credentialKind: 'value',
      credentialLanded: true,
      lastVerifiedAt: Date.now(),
      createdAt: 1,
    });
  });
}

async function seedItem(
  harness: Harness,
  agentId: Id<'agents'>,
  fields: Partial<Doc<'workItems'>> & Pick<Doc<'workItems'>, 'state' | 'title'>,
): Promise<Doc<'workItems'>> {
  return await harness.run(async (ctx) => {
    const id = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: fields.title,
      contentSummary: 'Synthetic.',
      contentRefs: [],
      observedAt: 1,
      createdAt: 1,
      ...fields,
    });
    const row = await ctx.db.get(id);
    if (!row) throw new Error('work item missing');
    return row;
  });
}

async function notes(harness: Harness): Promise<Doc<'managerNotes'>[]> {
  return await harness.run(async (ctx) => await ctx.db.query('managerNotes').collect());
}

async function scheduledNames(harness: Harness): Promise<string[]> {
  return (
    await harness.run(async (ctx) => await ctx.db.system.query('_scheduled_functions').collect())
  ).map((job) => job.name);
}

describe('queueManagerNote', (): void => {
  it('keeps nothing where there is no channel to send it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agent = await seedAgent(harness);
    const row = await seedItem(harness, agent._id, { state: 'completed', title: 'Close REVOPS-1' });

    await harness.run(async (ctx) => {
      await queueManagerNote(ctx, row, 'landed', (name) => `${name} closed REVOPS-1`);
    });

    expect(await notes(harness)).toEqual([]);
  });

  it('sends a landed note at once per run and keeps no stop', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agent = await seedAgent(harness);
    await seedChat(harness, agent._id);
    const row = await seedItem(harness, agent._id, { state: 'completed', title: 'Close REVOPS-1' });

    await harness.run(async (ctx) => {
      await queueManagerNote(ctx, row, 'landed', (name) => `${name} closed REVOPS-1`);
      await queueManagerNote(ctx, row, 'stopped', (name) => `${name} stopped`);
    });

    expect((await notes(harness)).map((note) => [note.kind, note.text, note.keptFor])).toEqual([
      ['landed', 'Aiko closed REVOPS-1', 'per-run'],
    ]);
    expect(await scheduledNames(harness)).toEqual([expect.stringContaining('sendManagerNote')]);
  });

  it('keeps both kinds for the digest and sends neither now', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agent = await seedAgent(harness, 'digest');
    await seedChat(harness, agent._id);
    const row = await seedItem(harness, agent._id, { state: 'failed', title: 'Close REVOPS-1' });

    await harness.run(async (ctx) => {
      await queueManagerNote(ctx, row, 'stopped', (name) => `${name} stopped`);
    });

    expect((await notes(harness)).map((note) => note.keptFor)).toEqual(['digest']);
    expect(await scheduledNames(harness)).toEqual([]);
  });
});

describe('managerDelivery', (): void => {
  it('names the agent and its manager channel, and nothing for an agent without one', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agent = await seedAgent(harness);

    const before = await harness.run(
      async (ctx) => (await managerDelivery(ctx, agent._id)) ?? null,
    );
    await seedChat(harness, agent._id);
    const after = await harness.run(async (ctx) => await managerDelivery(ctx, agent._id));

    expect(before).toBeNull();
    expect(after).toMatchObject({
      agentId: agent._id,
      agentName: 'Aiko',
      surface: { slug: 'team-chat' },
      grants: [],
    });
  });
});

describe('digestNoteFilter', (): void => {
  it("gives a per-run agent's digest only the notes kept for it", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const perRun = await seedAgent(harness);
    const digest = await seedAgent(harness, 'digest');
    const note = (keptFor: 'digest' | 'per-run' | undefined, createdAt: number) =>
      ({ keptFor, createdAt }) as Doc<'managerNotes'>;
    await harness.run(async (ctx) => {
      await ctx.db.insert('events', {
        agentId: perRun._id,
        type: 'agent.notifications-changed',
        payload: {},
        createdAt: 50,
      });
    });

    const kept = await harness.run(async (ctx) => {
      const ofPerRun = await digestNoteFilter(ctx, perRun);
      const ofDigest = await digestNoteFilter(ctx, digest);
      return [
        ofPerRun(note('digest', 99)),
        ofPerRun(note('per-run', 10)),
        ofPerRun(note(undefined, 40)),
        ofPerRun(note(undefined, 60)),
        ofDigest(note('per-run', 10)),
      ];
    });

    expect(kept).toEqual([true, false, true, false, true]);
  });
});

describe('owedDecisions', (): void => {
  it('lists what the manager still decides, oldest first, with the code of a delivered request', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agent = await seedAgent(harness);
    const request = (overrides: Partial<Decision>): Decision => ({
      id: 'K7Q2',
      kind: 'plan',
      requestedAt: 1,
      channel: 'D0MANAGER',
      surfaceSlug: 'team-chat',
      surfaceName: 'Team chat',
      ...overrides,
    });
    await seedItem(harness, agent._id, {
      state: 'plan-pending',
      title: 'Delivered plan',
      decision: request({ ts: '1.1' }),
    });
    await seedItem(harness, agent._id, {
      state: 'plan-pending',
      title: 'Undelivered plan',
      decision: request({ id: 'Z9Z9' }),
    });
    await seedItem(harness, agent._id, {
      state: 'actions-pending',
      title: 'Approved set',
      approvedIndexes: [0],
    });

    const owed = await harness.run(async (ctx) => await owedDecisions(ctx, agent._id));

    expect(owed).toEqual([
      { title: 'Delivered plan', decisionId: 'K7Q2' },
      { title: 'Undelivered plan' },
    ]);
  });
});
