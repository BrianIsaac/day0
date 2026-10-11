/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  queueManagerReplyNotice,
  REPLACED_DECISION_REASON,
  resolveManagerReply,
  type ManagerReply,
} from '../../convex/managerReplies';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';

/**
 * A manager's reply or button press read into a decision (`convex/managerReplies.ts`, moved out of
 * `convex/work.ts` by the wave 15 helpers split): only the card's manager decides, a code is
 * matched against the requests on this DM, a replaced code is answered with the request that
 * replaced it once, and every reply that decides is acknowledged in the request's thread.
 */

type Harness = TestConvex<typeof schema>;
type Decision = NonNullable<Doc<'workItems'>['decision']>;

const DM = 'D0MANAGER';
const MANAGER = 'UMANAGER';

// The acknowledgement and the plan's run are scheduled; the scheduler's timer is
// faked so nothing runs after the test.
beforeEach((): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach((): void => {
  vi.useRealTimers();
});

function request(id: string, overrides: Partial<Decision> = {}): Decision {
  return {
    id,
    kind: 'plan',
    requestedAt: 1,
    channel: DM,
    surfaceSlug: 'team-chat',
    surfaceName: 'Team chat',
    ts: '1787770800.000100',
    ...overrides,
  };
}

interface Seeded {
  readonly agentId: Id<'agents'>;
  readonly surfaceId: Id<'surfaces'>;
}

async function seedChat(harness: Harness): Promise<Seeded> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Aiko',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const credentialId = await ctx.db.insert('credentials', {
      userId: 'owner',
      kind: 'value',
      label: 'team chat token',
      ciphertext: 'ciphertext',
      iv: 'iv',
      source: 'entered',
      createdAt: 1,
    });
    const surfaceId = await ctx.db.insert('surfaces', {
      agentId,
      slug: 'team-chat',
      displayName: 'Team chat',
      class: 'chat',
      verdict: 'connected',
      whereFound: [],
      path: 'documented-api',
      endpoint: 'https://slack.com/api/',
      toolAllowlist: ['chat.postMessage'],
      managerDmChannelId: DM,
      managerUserId: MANAGER,
      providerIdentityId: 'U0DAY0BOT',
      credentialId,
      credentialKind: 'value',
      credentialLanded: true,
      lastVerifiedAt: Date.now(),
      createdAt: 1,
    });
    return { agentId, surfaceId };
  });
}

async function seedItem(
  harness: Harness,
  agentId: Id<'agents'>,
  fields: Partial<Doc<'workItems'>>,
): Promise<Id<'workItems'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-1',
        title: 'Add the close-summary audit note',
        contentSummary: 'Synthetic.',
        contentRefs: [],
        state: 'plan-pending',
        observedAt: 1,
        createdAt: 1,
        ...fields,
      }),
  );
}

function reply(
  seeded: Seeded,
  id: string,
  overrides: Partial<Pick<ManagerReply, 'userId' | 'messageTs'>> = {},
): ManagerReply {
  return {
    surfaceId: seeded.surfaceId,
    userId: overrides.userId ?? MANAGER,
    messageTs: overrides.messageTs ?? '1787770900.000100',
    reply: { verb: 'approve', id },
  };
}

async function notices(harness: Harness): Promise<Doc<'managerDecisionNotices'>[]> {
  return await harness.run(async (ctx) => await ctx.db.query('managerDecisionNotices').collect());
}

describe('resolveManagerReply', (): void => {
  it("approves the plan its code names and acknowledges in the request's thread", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const seeded = await seedChat(harness);
    const workItemId = await seedItem(harness, seeded.agentId, { decision: request('K7Q2') });

    const result = await harness.run(
      async (ctx) => await resolveManagerReply(ctx, reply(seeded, 'K7Q2')),
    );

    expect(result).toEqual({ status: 'decided', outcome: 'approve' });
    expect(await harness.run(async (ctx) => await ctx.db.get(workItemId))).toMatchObject({
      state: 'plan-approved',
      decision: { decidedVia: 'channel', decidedTs: '1787770900.000100' },
    });
    expect((await notices(harness)).map((notice) => notice.kind)).toEqual(['received']);
  });

  it("decides nothing for anyone but the card's manager", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const seeded = await seedChat(harness);
    const workItemId = await seedItem(harness, seeded.agentId, { decision: request('K7Q2') });

    const fromColleague = await harness.run(
      async (ctx) => await resolveManagerReply(ctx, reply(seeded, 'K7Q2', { userId: 'UOTHER' })),
    );
    const fromBot = await harness.run(
      async (ctx) => await resolveManagerReply(ctx, reply(seeded, 'K7Q2', { userId: 'U0DAY0BOT' })),
    );

    expect(fromColleague).toEqual({ status: 'ignored', reason: 'manager identity mismatch' });
    expect(fromBot).toEqual({ status: 'ignored', reason: 'bot message' });
    expect((await harness.run(async (ctx) => await ctx.db.get(workItemId)))?.state).toBe(
      'plan-pending',
    );
  });

  it('answers a replaced code once with the request that replaced it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const seeded = await seedChat(harness);
    const workItemId = await seedItem(harness, seeded.agentId, { decision: request('NEW1') });
    await harness.run(async (ctx) => {
      await ctx.db.insert('replacedDecisionRequests', {
        agentId: seeded.agentId,
        workItemId,
        decisionId: 'OLD1',
        replacedBy: 'NEW1',
        kind: 'plan',
        surfaceSlug: 'team-chat',
        channel: DM,
        replacedAt: 2,
      });
    });

    const first = await harness.run(
      async (ctx) => await resolveManagerReply(ctx, reply(seeded, 'OLD1')),
    );
    const second = await harness.run(
      async (ctx) =>
        await resolveManagerReply(ctx, reply(seeded, 'OLD1', { messageTs: '1787770950.000100' })),
    );

    expect(first).toEqual({ status: 'replaced', replacedBy: 'NEW1', notified: true });
    expect(second).toEqual({ status: 'replaced', replacedBy: 'NEW1', notified: false });
    expect((await notices(harness)).map((notice) => notice.text)).toEqual([
      'That request (OLD1) was replaced by NEW1. Decide on NEW1 instead.',
    ]);
    const ignored = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect()).filter(
        (event) => event.type === 'work.decision-ignored',
      ),
    );
    expect(ignored.map((event) => (event.payload as { reason: string }).reason)).toEqual([
      REPLACED_DECISION_REASON,
      REPLACED_DECISION_REASON,
    ]);
  });

  it('tells the manager once that a code was already decided, and not for the reply that decided', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const seeded = await seedChat(harness);
    await seedItem(harness, seeded.agentId, {
      state: 'plan-approved',
      decision: request('K7Q2', { decidedAt: 5, outcome: 'approved', decidedTs: '1787770900.1' }),
    });

    const deciding = await harness.run(
      async (ctx) =>
        await resolveManagerReply(ctx, reply(seeded, 'K7Q2', { messageTs: '1787770900.1' })),
    );
    const again = await harness.run(
      async (ctx) =>
        await resolveManagerReply(ctx, reply(seeded, 'K7Q2', { messageTs: '1787770999.1' })),
    );
    const thrice = await harness.run(
      async (ctx) =>
        await resolveManagerReply(ctx, reply(seeded, 'K7Q2', { messageTs: '1787771000.1' })),
    );

    expect([deciding, again, thrice]).toEqual([
      { status: 'already-decided', notified: false },
      { status: 'already-decided', notified: true },
      { status: 'already-decided', notified: false },
    ]);
  });
});

describe('queueManagerReplyNotice', (): void => {
  it('queues one notice per reply message', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const seeded = await seedChat(harness);
    const workItemId = await seedItem(harness, seeded.agentId, { decision: request('K7Q2') });
    const notice = {
      surfaceId: seeded.surfaceId,
      workItemId,
      decisionId: 'K7Q2',
      messageTs: '1787770900.000100',
      kind: 'received' as const,
      text: 'Got it.',
    };

    const queued = await harness.run(async (ctx) => [
      await queueManagerReplyNotice(ctx, notice),
      await queueManagerReplyNotice(ctx, notice),
    ]);

    expect(queued).toEqual([true, false]);
    expect(await notices(harness)).toHaveLength(1);
  });
});
