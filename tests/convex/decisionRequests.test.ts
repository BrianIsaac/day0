/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  HANDED_OVER_REQUEST_REASON,
  MANAGER_CHANGED_RESEND_REASON,
  nameReplacement,
  openRequestsOn,
  recentThreadsOn,
  CLOSE_EDIT_IN_FLIGHT_MS,
  rememberDecidedUnmarked,
  rememberReplacedRequest,
  rememberRetriedRequest,
  requestThreadOf,
  resendDecisionsAfterManagerChange,
  returnApprovalsForHandover,
  scheduleDecisionRequest,
  scheduleRequestClose,
  settleBatchesHolding,
  settleClosedBatchesOn,
  settleDecisionBatchesPage,
  voidDecisionRequestsForHandover,
} from '../../convex/decisionRequests';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';

/**
 * A decision request's lifecycle (`convex/decisionRequests.ts`, moved out of `convex/work.ts` by
 * the wave 15 helpers split): a request goes out only through a channel the manager can be asked
 * on, a replaced or taken-back code stays answerable, a handover closes what the previous manager
 * was asked, and a batch is settled once none of its members is open.
 */

type Harness = TestConvex<typeof schema>;
type Decision = NonNullable<Doc<'workItems'>['decision']>;

const DM = 'D0MANAGER';

// Nothing a helper schedules runs: the scheduler's timer is faked and the
// tests read the scheduled jobs instead.
beforeEach((): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach((): void => {
  vi.useRealTimers();
});

function request(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'K7Q2',
    kind: 'plan',
    requestedAt: 1,
    channel: DM,
    surfaceSlug: 'team-chat',
    surfaceName: 'Team chat',
    ...overrides,
  };
}

async function seedAgent(harness: Harness): Promise<Id<'agents'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Aiko',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      }),
  );
}

async function seedChat(
  harness: Harness,
  agentId: Id<'agents'>,
  dm: string | undefined = DM,
): Promise<Doc<'surfaces'>> {
  return await harness.run(async (ctx) => {
    const credentialId = await ctx.db.insert('credentials', {
      userId: 'owner',
      kind: 'value',
      label: 'team chat token',
      ciphertext: 'ciphertext',
      iv: 'iv',
      source: 'entered',
      createdAt: 1,
    });
    const id = await ctx.db.insert('surfaces', {
      agentId,
      slug: 'team-chat',
      displayName: 'Team chat',
      class: 'chat',
      verdict: 'connected',
      whereFound: [],
      path: 'documented-api',
      endpoint: 'https://slack.com/api/',
      toolAllowlist: ['chat.postMessage'],
      ...(dm === undefined ? {} : { managerDmChannelId: dm, managerUserId: 'UMANAGER' }),
      credentialId,
      credentialKind: 'value',
      credentialLanded: true,
      lastVerifiedAt: Date.now(),
      createdAt: 1,
    });
    const surface = await ctx.db.get(id);
    if (!surface) throw new Error('surface missing');
    return surface;
  });
}

/** Each seeded item's ticket number, so rows never share an external id. */
let seeded = 0;

async function seedItem(
  harness: Harness,
  agentId: Id<'agents'>,
  state: Doc<'workItems'>['state'],
  fields: Partial<Doc<'workItems'>> = {},
): Promise<Doc<'workItems'>> {
  return await harness.run(async (ctx) => {
    const id = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: `REVOPS-${(seeded += 1)}`,
      title: 'Add the close-summary audit note',
      contentSummary: 'Synthetic.',
      contentRefs: [],
      state,
      observedAt: 1,
      createdAt: 1,
      ...fields,
    });
    const row = await ctx.db.get(id);
    if (!row) throw new Error('work item missing');
    return row;
  });
}

async function scheduled(harness: Harness): Promise<Array<{ name: string; args: unknown }>> {
  return (
    await harness.run(async (ctx) => await ctx.db.system.query('_scheduled_functions').collect())
  ).map((job) => ({ name: job.name, args: job.args[0] }));
}

async function replaced(harness: Harness): Promise<Doc<'replacedDecisionRequests'>[]> {
  return await harness.run(async (ctx) => await ctx.db.query('replacedDecisionRequests').collect());
}

async function reread(harness: Harness, id: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(id));
  if (!row) throw new Error('work item missing');
  return row;
}

describe('scheduleDecisionRequest', (): void => {
  it('asks only through a manager channel the employee can reach', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const row = await seedItem(harness, agentId, 'plan-pending');

    await harness.run(async (ctx) => {
      await scheduleDecisionRequest(ctx, row, 'plan');
    });
    const before = await scheduled(harness);
    await seedChat(harness, agentId);
    await harness.run(async (ctx) => {
      await scheduleDecisionRequest(ctx, row, 'plan');
    });

    expect(before).toEqual([]);
    expect(await scheduled(harness)).toEqual([
      {
        name: expect.stringContaining('requestDecision'),
        args: { workItemId: row._id, kind: 'plan' },
      },
    ]);
  });
});

describe('rememberReplacedRequest and rememberRetriedRequest', (): void => {
  it('keeps an undecided delivered request once and schedules the one edit of its message', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const row = await seedItem(harness, agentId, 'plan-pending', {
      decision: request({ ts: '1787770800.000100', requestText: 'Approve the plan?' }),
    });

    await harness.run(async (ctx) => {
      await rememberReplacedRequest(ctx, row, 10);
      await rememberReplacedRequest(ctx, row, 11);
    });

    expect(await replaced(harness)).toMatchObject([
      { decisionId: 'K7Q2', ts: '1787770800.000100', replacedAt: 10 },
    ]);
    expect((await scheduled(harness)).map((job) => job.name)).toEqual([
      expect.stringContaining('markRequestReplaced'),
    ]);
  });

  it('keeps a decided request only on Retry, with how it was decided and nothing to edit', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const row = await seedItem(harness, agentId, 'cancelled', {
      decision: request({ decidedAt: 5, outcome: 'rejected', decidedVia: 'channel', ts: '1.2' }),
    });

    await harness.run(async (ctx) => {
      await rememberReplacedRequest(ctx, row, 10);
    });
    const afterReplace = await replaced(harness);
    await harness.run(async (ctx) => {
      await rememberRetriedRequest(ctx, row, 12);
    });

    expect(afterReplace).toEqual([]);
    const [kept] = await replaced(harness);
    expect(kept).toMatchObject({ outcome: 'rejected', decidedAt: 5, decidedVia: 'channel' });
    expect(kept?.ts).toBeUndefined();
    expect(await scheduled(harness)).toEqual([]);
  });
});

describe('rememberDecidedUnmarked', (): void => {
  it('keeps a decided request whose message its close never marked, and leaves one it did', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const unmarked = await seedItem(harness, agentId, 'actions-pending', {
      decision: request({
        id: 'A1',
        kind: 'actions',
        ts: '1.1',
        requestText: 'Approve?',
        decidedAt: 5,
        outcome: 'approved',
      }),
    });
    const marked = await seedItem(harness, agentId, 'actions-pending', {
      decision: request({
        id: 'A2',
        kind: 'actions',
        ts: '1.2',
        requestText: 'Approve?',
        decidedAt: 5,
        closedAt: 6,
      }),
    });

    await harness.run(async (ctx) => {
      await rememberDecidedUnmarked(ctx, unmarked, 10);
      await rememberDecidedUnmarked(ctx, marked, 10);
    });

    expect(await replaced(harness)).toMatchObject([
      { decisionId: 'A1', outcome: 'approved', decidedAt: 5 },
    ]);
  });

  it("edits the message after the decision's own edit, never beside it, when that edit is in flight at the park (W14-R51)", async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const decided = {
      ts: '1.1',
      requestText: 'Approve?',
      decidedAt: 5,
      outcome: 'approved',
    } as const;
    const inFlight = await seedItem(harness, agentId, 'actions-pending', {
      decision: request({ id: 'A1', kind: 'actions', ...decided, closeClaimedAt: Date.now() }),
    });
    const unclaimed = await seedItem(harness, agentId, 'actions-pending', {
      decision: request({ id: 'A2', kind: 'actions', ...decided, ts: '1.2' }),
    });
    const now = Date.now();
    await harness.run(async (ctx) => {
      await rememberDecidedUnmarked(ctx, inFlight, now);
      await rememberDecidedUnmarked(ctx, unclaimed, now);
    });

    const edits = (
      await harness.run(async (ctx) => await ctx.db.system.query('_scheduled_functions').collect())
    ).filter((job) => job.name === 'managerChannelActions:markRequestReplaced');
    const rows = await replaced(harness);
    const waitOf = (decisionId: string): number => {
      const row = rows.find((kept) => kept.decisionId === decisionId);
      const job = edits.find(
        (edit) => (edit.args[0] as { replacedId: string }).replacedId === row?._id,
      );
      return (job?.scheduledTime ?? Number.NaN) - now;
    };
    // The edit in flight sends its own chat.update: a second one beside it would race it on one
    // message, so this one waits out the first's transport.
    expect(waitOf('A1')).toBe(CLOSE_EDIT_IN_FLIGHT_MS);
    // No edit was claimed for the other: its message is marked at once, as before.
    expect(waitOf('A2')).toBe(0);
    vi.useRealTimers();
  });
});

describe('nameReplacement', (): void => {
  it('names the new request on every earlier request of its kind for the item', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const row = await seedItem(harness, agentId, 'plan-pending');
    await harness.run(async (ctx) => {
      for (const [decisionId, kind] of [
        ['P1', 'plan'],
        ['P2', 'plan'],
        ['X1', 'actions'],
      ] as const) {
        await ctx.db.insert('replacedDecisionRequests', {
          agentId,
          workItemId: row._id,
          decisionId,
          kind,
          surfaceSlug: 'team-chat',
          channel: DM,
          replacedAt: 1,
        });
      }
      await nameReplacement(ctx, row._id, { id: 'P3', kind: 'plan' });
    });

    expect(
      Object.fromEntries(
        (await replaced(harness)).map((kept) => [kept.decisionId, kept.replacedBy]),
      ),
    ).toEqual({ P1: 'P3', P2: 'P3', X1: undefined });
  });
});

describe('voidDecisionRequestsForHandover and returnApprovalsForHandover', (): void => {
  it('closes what the previous manager was asked and returns what they approved', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const delivered = await seedItem(harness, agentId, 'plan-pending', {
      decision: request({ id: 'D1', ts: '1.1' }),
    });
    const onItsWay = await seedItem(harness, agentId, 'plan-pending', {
      decision: request({ id: 'D2' }),
    });
    const approvedPlan = await seedItem(harness, agentId, 'plan-approved', {
      decision: request({ id: 'D3', decidedAt: 4, outcome: 'approved' }),
    });
    const approvedSet = await seedItem(harness, agentId, 'actions-pending', {
      approvedIndexes: [0],
      applyPhase: 'approved',
    });

    const counts = await harness.run(async (ctx) => ({
      voided: await voidDecisionRequestsForHandover(ctx, agentId, 20),
      returned: await returnApprovalsForHandover(ctx, agentId, 20),
    }));

    expect(counts).toEqual({ voided: 2, returned: 2 });
    expect((await reread(harness, delivered._id)).decision).toMatchObject({
      id: 'D1',
      requestFailedAt: 20,
      requestFailure: HANDED_OVER_REQUEST_REASON,
    });
    expect((await reread(harness, onItsWay._id)).decision).toBeUndefined();
    expect((await replaced(harness)).map((kept) => kept.decisionId)).toEqual(['D2']);
    expect(await reread(harness, approvedPlan._id)).toMatchObject({
      state: 'plan-pending',
      planPendingAt: 20,
    });
    const set = await reread(harness, approvedSet._id);
    expect(set.approvedIndexes).toBeUndefined();
    expect(set.waitingSince).toBe(20);
  });
});

describe('resendDecisionsAfterManagerChange and openRequestsOn', (): void => {
  it("sends again what went to the previous DM and reads only the current DM's requests as open", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surface = await seedChat(harness, agentId, 'D0NEWDM');
    const stale = await seedItem(harness, agentId, 'plan-pending', {
      decision: request({ id: 'OLD', ts: '1.1', channel: DM }),
    });
    const current = await seedItem(harness, agentId, 'plan-pending', {
      decision: request({ id: 'NEW', ts: '1.2', channel: 'D0NEWDM' }),
    });

    const open = await harness.run(async (ctx) =>
      (await openRequestsOn(ctx, surface)).map((entry) => entry.decision.id),
    );
    const resent = await harness.run(
      async (ctx) => await resendDecisionsAfterManagerChange(ctx, surface, 'D0NEWDM'),
    );

    expect(open).toEqual(['NEW']);
    expect(resent).toBe(1);
    expect((await reread(harness, stale._id)).decision).toMatchObject({
      requestFailure: MANAGER_CHANGED_RESEND_REASON,
    });
    expect((await reread(harness, current._id)).decision?.requestFailedAt).toBeUndefined();
    expect(await scheduled(harness)).toEqual([
      {
        name: expect.stringContaining('requestDecision'),
        args: { workItemId: stale._id, kind: 'plan', supersedes: 'OLD' },
      },
    ]);
  });
});

describe('the batch settlers', (): void => {
  it('mark decided a batch none of whose members is open, and leave one still waiting', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const runId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('events', {
          agentId,
          type: 'work.skill-run',
          payload: {},
          createdAt: 1,
        }),
    );
    const decided = await seedItem(harness, agentId, 'actions-pending', {
      pendingRunId: runId,
      decision: request({ id: 'M1', kind: 'actions', decidedAt: 3, outcome: 'approved' }),
    });
    const waiting = await seedItem(harness, agentId, 'actions-pending', {
      pendingRunId: runId,
      decision: request({ id: 'M2', kind: 'actions' }),
    });
    const batch = async (id: string, members: Doc<'workItems'>[]): Promise<void> => {
      await harness.run(async (ctx) => {
        await ctx.db.insert('decisionBatches', {
          agentId,
          id,
          surfaceSlug: 'team-chat',
          channel: DM,
          members: members.map((member) => ({
            workItemId: member._id,
            decisionId: member.decision?.id ?? '',
            pendingRunId: runId,
          })),
          requestedAt: 1,
        });
      });
    };
    await batch('B1', [decided]);
    await batch('B2', [decided, waiting]);
    await batch('B3', [decided]);

    await harness.run(async (ctx) => {
      await settleBatchesHolding(ctx, decided);
    });
    const afterHolding = await harness.run(async (ctx) =>
      (await ctx.db.query('decisionBatches').collect()).map((row) => row.decidedAt !== undefined),
    );
    await harness.run(async (ctx) => {
      await ctx.db.patch(waiting._id, { state: 'cancelled' });
      await settleClosedBatchesOn(ctx, { agentId, surfaceSlug: 'team-chat', id: DM });
    });
    const page = await harness.run(async (ctx) => await settleDecisionBatchesPage(ctx, null));

    expect(afterHolding).toEqual([true, false, true]);
    expect(page).toMatchObject({ read: 3, changed: 0, isDone: true });
    expect(
      await harness.run(async (ctx) =>
        (await ctx.db.query('decisionBatches').collect()).every(
          (row) => row.decidedAt !== undefined,
        ),
      ),
    ).toBe(true);
  });
});

describe('requestThreadOf, scheduleRequestClose and recentThreadsOn', (): void => {
  it('answers in the thread of the request a code names and closes a delivered decided request', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surface = await seedChat(harness, agentId);
    const row = await seedItem(harness, agentId, 'plan-approved', {
      decision: request({
        id: 'NOW',
        ts: '1787770800.000300',
        requestText: 'Approve the plan?',
        decidedAt: 5,
        outcome: 'approved',
      }),
    });
    await harness.run(async (ctx) => {
      await ctx.db.insert('replacedDecisionRequests', {
        agentId,
        workItemId: row._id,
        decisionId: 'BEFORE',
        kind: 'plan',
        surfaceSlug: 'team-chat',
        channel: DM,
        ts: '1787770800.000100',
        replacedAt: 2,
        editedAt: 3,
      });
    });

    const threads = await harness.run(async (ctx) => ({
      own: await requestThreadOf(ctx, row, 'NOW'),
      replaced: await requestThreadOf(ctx, row, 'BEFORE'),
      unknown: (await requestThreadOf(ctx, row, 'NOBODY')) ?? null,
      recent: await recentThreadsOn(ctx, surface, DM, 0, {
        decided: ['1787770800.000300'],
        open: [],
      }),
    }));
    await harness.run(async (ctx) => {
      await scheduleRequestClose(ctx, row._id);
    });

    expect(threads).toEqual({
      own: '1787770800.000300',
      replaced: '1787770800.000100',
      unknown: null,
      recent: ['1787770800.000300', '1787770800.000100'],
    });
    expect(await scheduled(harness)).toEqual([
      {
        name: expect.stringContaining('closeDecisionRequest'),
        args: { workItemId: row._id, decisionId: 'NOW' },
      },
    ]);
  });
});
