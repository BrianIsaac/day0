/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { contractSchema } from './contract-schema';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/**
 * One claim per external item across the company (plan phase 5).
 *
 * Several employees of one owner reach the same ticket or the same ask: the
 * shared request channel reaches every employee by design, and two cards may
 * name one system under different slugs. Whichever employee's charter
 * judgement admits it, exactly one work item may hold it; the others are
 * skipped with the colleague named and a `work.claim-refused` on their own
 * events. The shared Slack message is the #ops-requests ask of the company
 * bed; the Linear issue id is the provider UUID intake keys a ticket by.
 */

const recorded = vi.hoisted(() => ({
  scopeCalls: [] as string[],
  /** Holds every charter judgement open until the test releases it. */
  scopeGate: undefined as Promise<void> | undefined,
  /** Roles whose charter judgement finds the ask out of scope. */
  outOfScope: new Set<string>(),
  planCalls: [] as string[],
  http: [] as string[],
}));

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (args: { agent: { name: string }; user: string }): Promise<unknown> => {
    if (args.agent.name === 'day0-scope-judgement') {
      recorded.scopeCalls.push(args.user);
      await recorded.scopeGate;
      if ([...recorded.outOfScope].some((role) => args.user.includes(`Role: ${role}`))) {
        return { inScope: false, fit: true, reason: 'the ask belongs to another desk' };
      }
      return { inScope: true, fit: true, reason: 'close summaries are the charter work' };
    }
    throw new Error(`unscripted agent ${args.agent.name}`);
  },
  agentText: async (): Promise<string> => '',
}));

vi.mock('../../src/work/plan', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/work/plan')>();
  return {
    ...original,
    draftExecutionPlan: async (args: { candidate: { title: string } }) => {
      recorded.planCalls.push(args.candidate.title);
      return {
        summary: 'Send the close summary to the requester.',
        steps: ['Reply in the thread with the close summary.'],
        expectedOutputType: 'message',
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 2,
      };
    },
  };
});

vi.mock('../../src/surfaces/credentials', () => ({
  decryptCredentialRef: { name: 'credentials:decrypt' },
  decryptCredential: async (_ctx: unknown, credentialId: string): Promise<string> =>
    `plain-${credentialId}`,
}));

vi.stubGlobal('fetch', async (input: URL | string): Promise<Response> => {
  recorded.http.push(String(input));
  return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
});

type Harness = TestConvex<typeof schema>;

afterEach((): void => {
  recorded.scopeCalls.length = 0;
  recorded.scopeGate = undefined;
  recorded.outOfScope.clear();
  recorded.planCalls.length = 0;
  recorded.http.length = 0;
  vi.useRealTimers();
  restoreSurfaceMode();
});

const WORKSPACE = 'T0COMPANY';
/** `${channel}:${ts}` of the one #ops-requests ask every employee's bot mention reaches. */
const OPS_ASK = 'C0OPSREQ:1789000000.000100';
const OPS_ASK_TITLE = 'Slack mention in #ops-requests';
const ISSUE = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f';
const ISSUE_TITLE = 'Post the Q3 close summary for the board pack';

type SurfaceSpec = { kind: 'slack'; slug?: string; workspace?: string } | { kind: 'linear'; slug: string };

/**
 * One employee with an approved charter that covers close summaries, the
 * skills and grants a threaded reply and a ticket close need, and its own
 * connected cards. No manager channel, so a drafted plan waits on the
 * dashboard and nothing is sent.
 *
 * Args:
 *   harness: Convex test harness.
 *   options: The employee's name, its owner and its cards.
 *
 * Returns:
 *   The agent id.
 */
async function seedEmployee(
  harness: Harness,
  options: { name: string; userId?: string; surfaces?: SurfaceSpec[] },
): Promise<Id<'agents'>> {
  const surfaces = options.surfaces ?? [{ kind: 'slack' }];
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: options.name,
      userId: options.userId ?? 'owner',
      state: 'active',
      autonomousActions: false,
      createdAt: 1,
    });
    await ctx.db.insert('charters', {
      agentId,
      version: 'v1',
      approved: true,
      approvedAt: 1,
      createdAt: 1,
      body: {
        proposedFunction: `${options.name}'s desk`,
        proposedBoundaries: { willDo: ['close summaries'], willNotDo: [], escalationTriggers: [] },
        approvalChain: { boss: 'boss@day0.local' },
      },
    });
    for (const [name, surfaceClass, operation] of [
      ['chat-thread-reply', 'chat', 'thread-reply'],
      ['kanban-comment-and-close', 'kanban', 'comment-and-close'],
    ] as const) {
      await ctx.db.insert('skills', {
        agentId,
        name,
        description: `A ${operation} on a ${surfaceClass} surface.`,
        body: 'Do the documented thing.',
        sourceType: 'agent-authored',
        state: 'registered',
        surfaceClass,
        operation,
        createdAt: 1,
        registeredAt: 1,
      });
    }
    const scopes = new Set(['boss:message']);
    const live = { credentialLanded: true, lastVerifiedAt: Date.now(), whereFound: [], createdAt: 1 };
    for (const surface of surfaces) {
      const slug = surface.slug ?? 'slack';
      scopes.add(`${slug}:read`);
      if (surface.kind === 'slack') {
        await ctx.db.insert('surfaces', {
          agentId,
          slug,
          displayName: 'Slack',
          class: 'chat',
          verdict: 'connected',
          endpoint: 'https://slack.com/api/',
          path: 'documented-api',
          toolAllowlist: ['conversations.list', 'conversations.history', 'chat.postMessage'],
          credentialId: 'cred-slack',
          providerIdentityId: 'U0DAY0BOT',
          providerWorkspaceId: surface.workspace ?? WORKSPACE,
          ...live,
        } as never);
      } else {
        await ctx.db.insert('surfaces', {
          agentId,
          slug,
          displayName: 'Linear',
          class: 'kanban',
          verdict: 'connected',
          endpoint: 'https://mcp.linear.app/mcp',
          path: 'mcp',
          toolAllowlist: ['list_issues', 'save_comment', 'save_issue'],
          credentialId: 'cred-linear',
          ...live,
        } as never);
      }
    }
    for (const scope of scopes) {
      await ctx.db.insert('permissionGrants', { agentId, scope, createdAt: 1 });
    }
    return agentId;
  });
}

/** Seed the #ops-requests ask for one employee, the way intake's Slack reader does. */
async function seedAsk(harness: Harness, agentId: Id<'agents'>, slug = 'slack'): Promise<Id<'workItems'>> {
  return await harness.mutation(internal.work.seedItem, {
    agentId,
    sourceCategory: 'event-stream',
    sourceSystem: slug,
    externalId: OPS_ASK,
    title: OPS_ASK_TITLE,
    contentSummary: '<@U0DAY0BOT> please send the Q3 close summary to the leadership thread today.',
    contentRefs: [`https://app.slack.com/client/${WORKSPACE}/C0OPSREQ/thread/C0OPSREQ-1789000000000100`],
    requesterLabel: 'U0OPERATOR',
    requester: 'U0OPERATOR',
    replyTarget: { channel: 'C0OPSREQ', channelName: 'ops-requests', threadTs: '1789000000.000100' },
  });
}

/** Seed the shared Linear issue for one employee, the way intake's Linear reader does. */
async function seedIssue(harness: Harness, agentId: Id<'agents'>, slug: string): Promise<Id<'workItems'>> {
  return await harness.mutation(internal.work.seedItem, {
    agentId,
    sourceCategory: 'ticket-queue',
    sourceSystem: slug,
    externalId: ISSUE,
    title: ISSUE_TITLE,
    contentSummary: 'Post the Q3 close summary on this ticket and close it.',
    contentRefs: ['https://linear.app/day0/issue/OPS-7'],
    priority: 'High',
  });
}

/** Run every job the scheduler holds that is due now, and every job those schedule. */
async function drain(harness: Harness): Promise<void> {
  await harness.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0));
}

async function readItem(harness: Harness, workItemId: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
  if (!row) throw new Error('work item missing');
  return row;
}

async function claimsOf(harness: Harness): Promise<Doc<'externalClaims'>[]> {
  return await harness.run(async (ctx) => await ctx.db.query('externalClaims').collect());
}

async function eventsOf(
  harness: Harness,
  type: string,
  agentId?: Id<'agents'>,
): Promise<Doc<'events'>[]> {
  return (await harness.run(async (ctx) => await ctx.db.query('events').collect())).filter(
    (event) => event.type === type && (agentId === undefined || event.agentId === agentId),
  );
}

/**
 * The holder and the colleague of one item after both verdicts landed.
 *
 * Args:
 *   harness: Convex test harness.
 *   rows: The two employees' work items for the same item.
 *
 * Returns:
 *   The claimed row and the other one.
 */
async function holderAndColleague(
  harness: Harness,
  rows: Array<Id<'workItems'>>,
): Promise<{ holder: Doc<'workItems'>; colleague: Doc<'workItems'> }> {
  const read = await Promise.all(rows.map(async (id) => await readItem(harness, id)));
  const holder = read.find((row) => row.state !== 'skipped');
  const colleague = read.find((row) => row.state === 'skipped');
  if (!holder || !colleague) {
    throw new Error(`expected one holder and one skipped colleague, got ${read.map((row) => row.state).join(', ')}`);
  }
  return { holder, colleague };
}

describe('two employees of one owner reach one item', (): void => {
  it('lets exactly one claim the #ops-requests ask when both verdicts land at once', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const priya = await seedEmployee(harness, { name: 'Priya' });
    const mateo = await seedEmployee(harness, { name: 'Mateo' });
    const rows = [await seedAsk(harness, priya), await seedAsk(harness, mateo)];
    // Two first imports of one module racing after `vi.resetModules()` can
    // hand one of them a module whose imported bindings are still unset, so
    // `SURFACE_MODE` reads as not real. Load it once before the race.
    await import('../../convex/workActions');
    let release = (): void => {};
    recorded.scopeGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const verdicts = rows.map((workItemId) =>
      harness.action(internal.workActions.evaluateWorkItemInternal, { workItemId }),
    );
    await vi.waitFor(() => expect(recorded.scopeCalls).toHaveLength(2));
    release();
    const decisions = (await Promise.all(verdicts)).map((verdict) => verdict.decision).sort();

    expect(decisions).toEqual(['claim', 'skip']);
    const { holder, colleague } = await holderAndColleague(harness, rows);
    expect(holder.state).toBe('claimed');
    const holderName = holder.agentId === priya ? 'Priya' : 'Mateo';
    expect(colleague.skipReason).toBe(`claimed-by-colleague: ${holderName} holds it (${OPS_ASK_TITLE})`);
    expect(colleague.verdict).toMatchObject({
      decision: 'skip',
      claimedBy: { agentId: holder.agentId, workItemId: holder._id, name: holderName, title: OPS_ASK_TITLE },
    });

    const refused = await eventsOf(harness, 'work.claim-refused');
    expect(refused).toHaveLength(1);
    expect(refused[0].agentId).toBe(colleague.agentId);
    expect(refused[0].payload).toMatchObject({
      workItemId: colleague._id,
      key: `slack:${WORKSPACE}:${OPS_ASK}`,
      holder: { agentId: holder.agentId, workItemId: holder._id, name: holderName },
    });

    const claims = await claimsOf(harness);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      userId: 'owner',
      key: `slack:${WORKSPACE}:${OPS_ASK}`,
      agentId: holder.agentId,
      workItemId: holder._id,
    });
    expect(claims[0]).not.toHaveProperty('releasedAt');
  });

  it('claims one Linear ticket once when two cards name Linear by different slugs', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const priya = await seedEmployee(harness, { name: 'Priya', surfaces: [{ kind: 'linear', slug: 'linear' }] });
    const aiko = await seedEmployee(harness, {
      name: 'Aiko',
      surfaces: [{ kind: 'linear', slug: 'linear-finance' }],
    });
    const first = await seedIssue(harness, priya, 'linear');
    await drain(harness);
    const second = await seedIssue(harness, aiko, 'linear-finance');
    await drain(harness);

    expect((await readItem(harness, first)).state).toBe('plan-pending');
    const refused = await readItem(harness, second);
    expect(refused.state).toBe('skipped');
    expect(refused.skipReason).toBe(`claimed-by-colleague: Priya holds it (${ISSUE_TITLE})`);
    expect(recorded.planCalls).toEqual([ISSUE_TITLE]);
    expect(await claimsOf(harness)).toEqual([
      expect.objectContaining({ key: `linear:${ISSUE}`, agentId: priya, workItemId: first }),
    ]);
  });

  it('keeps the claim of a completed item: a colleague reaching it later is refused', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const priya = await seedEmployee(harness, { name: 'Priya' });
    const mateo = await seedEmployee(harness, { name: 'Mateo' });
    const first = await seedAsk(harness, priya);
    await drain(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(first, { state: 'completed' });
    });

    const second = await seedAsk(harness, mateo);
    await drain(harness);

    expect((await readItem(harness, second)).skipReason).toBe(
      `claimed-by-colleague: Priya holds it (${OPS_ASK_TITLE})`,
    );
    expect((await claimsOf(harness)).filter((claim) => claim.releasedAt === undefined)).toEqual([
      expect.objectContaining({ workItemId: first }),
    ]);
  });

  it('refuses a row re-admitted after its skill registers while a colleague holds the item', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const priya = await seedEmployee(harness, { name: 'Priya' });
    const mateo = await seedEmployee(harness, { name: 'Mateo' });
    const first = await seedAsk(harness, priya);
    await drain(harness);
    const second = await seedAsk(harness, mateo);
    await harness.run(async (ctx) => {
      await ctx.db.patch(second, {
        state: 'needs-skill',
        verdict: { decision: 'needs-skill', reason: 'no registered skill covers a threaded reply' },
      });
    });

    await harness.mutation(internal.work.setVerdict, { workItemId: second, verdict: { decision: 'claim' } });

    const refused = await readItem(harness, second);
    expect(refused.state).toBe('skipped');
    expect(refused.skipReason).toBe(`claimed-by-colleague: Priya holds it (${OPS_ASK_TITLE})`);
    expect((await claimsOf(harness)).map((claim) => claim.workItemId)).toEqual([first]);
  });

  it('refuses a second row of the same employee reaching the item through another card', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const priya = await seedEmployee(harness, {
      name: 'Priya',
      surfaces: [
        { kind: 'linear', slug: 'linear' },
        { kind: 'linear', slug: 'linear-ops' },
      ],
    });
    await harness.run(async (ctx) => {
      await ctx.db.patch(priya, { autonomousActions: true });
    });
    const first = await seedIssue(harness, priya, 'linear');
    const second = await seedIssue(harness, priya, 'linear-ops');
    await harness.mutation(internal.work.setVerdict, { workItemId: first, verdict: { decision: 'claim' } });
    await harness.mutation(internal.work.setVerdict, { workItemId: second, verdict: { decision: 'claim' } });

    const refused = await readItem(harness, second);
    expect(refused.state).toBe('skipped');
    expect(refused.skipReason).toBe('already-claimed: state=claimed');
    expect(await eventsOf(harness, 'work.claim-refused', priya)).toHaveLength(1);
    expect((await claimsOf(harness)).map((claim) => claim.workItemId)).toEqual([first]);
  });
});

describe('the claim is the owner\'s', (): void => {
  it('lets two owners each claim the same item', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const priya = await seedEmployee(harness, { name: 'Priya' });
    const noor = await seedEmployee(harness, { name: 'Noor', userId: 'other-owner' });
    const first = await seedAsk(harness, priya);
    const second = await seedAsk(harness, noor);
    await drain(harness);

    expect((await readItem(harness, first)).state).toBe('plan-pending');
    expect((await readItem(harness, second)).state).toBe('plan-pending');
    expect(await eventsOf(harness, 'work.claim-refused')).toEqual([]);
    const claims = await claimsOf(harness);
    expect(claims.map((claim) => claim.userId).sort()).toEqual(['other-owner', 'owner']);
    expect(claims.every((claim) => claim.releasedAt === undefined)).toBe(true);
  });
});

describe('releasing a claim', (): void => {
  /**
   * Priya holds the ask with a plan waiting for the manager; Mateo was
   * refused at the claim.
   */
  async function heldAndRefused(harness: Harness): Promise<{
    priya: Id<'agents'>;
    mateo: Id<'agents'>;
    held: Id<'workItems'>;
    refused: Id<'workItems'>;
  }> {
    const priya = await seedEmployee(harness, { name: 'Priya' });
    const mateo = await seedEmployee(harness, { name: 'Mateo' });
    const held = await seedAsk(harness, priya);
    await drain(harness);
    const refused = await seedAsk(harness, mateo);
    await drain(harness);
    expect((await readItem(harness, held)).state).toBe('plan-pending');
    expect((await readItem(harness, refused)).state).toBe('skipped');
    return { priya, mateo, held, refused };
  }

  it('returns the colleague\'s row for evaluation when the holder\'s plan is cancelled', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const { mateo, held, refused } = await heldAndRefused(harness);

    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.work.cancelPlan, { workItemId: held, reason: 'finance owns this ask' });
    await drain(harness);

    const taken = await readItem(harness, refused);
    expect(taken.state).toBe('plan-pending');
    expect(taken.reevaluation).toMatchObject({ trigger: 'claim-released' });
    expect(await eventsOf(harness, 'work.requeued', mateo)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ workItemId: refused, trigger: 'claim-released' }),
      }),
    ]);
    const claims = await claimsOf(harness);
    expect(claims.find((claim) => claim.workItemId === held)?.releasedAt).toEqual(expect.any(Number));
    expect(claims.filter((claim) => claim.releasedAt === undefined)).toEqual([
      expect.objectContaining({ agentId: mateo, workItemId: refused }),
    ]);
  });

  it('returns only the rows the released claim refused, not a colleague who skipped at scope', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const aiko = await seedEmployee(harness, { name: 'Aiko' });
    recorded.outOfScope.add("Aiko's desk");
    const { mateo, held, refused } = await heldAndRefused(harness);
    const atScope = await seedAsk(harness, aiko);
    await drain(harness);
    expect((await readItem(harness, atScope)).skipReason).toBe('out-of-scope: the ask belongs to another desk');

    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.work.cancelPlan, { workItemId: held, reason: 'finance owns this ask' });
    await drain(harness);

    expect((await readItem(harness, refused)).state).toBe('plan-pending');
    const stays = await readItem(harness, atScope);
    expect(stays.state).toBe('skipped');
    expect(stays.skipReason).toBe('out-of-scope: the ask belongs to another desk');
    expect(stays).not.toHaveProperty('reevaluation');
    expect((await eventsOf(harness, 'work.requeued')).map((event) => event.agentId)).toEqual([mateo]);
  });

  it.fails('refuses a retry of the cancelled item while a colleague holds it', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const { held, refused } = await heldAndRefused(harness);
    const owner = harness.withIdentity({ subject: 'owner' });
    await owner.mutation(api.work.cancelPlan, { workItemId: held, reason: 'finance owns this ask' });
    await drain(harness);
    expect((await readItem(harness, refused)).state).toBe('plan-pending');

    await expect(owner.mutation(api.work.retryFailed, { workItemId: held })).rejects.toThrow(
      'another employee holds this: Mateo',
    );
    expect((await readItem(harness, held)).state).toBe('cancelled');
    expect((await claimsOf(harness)).filter((claim) => claim.releasedAt === undefined)).toEqual([
      expect.objectContaining({ workItemId: refused }),
    ]);
  });

  it.fails('takes the claim again for a retried item nobody else holds', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const priya = await seedEmployee(harness, { name: 'Priya' });
    const held = await seedAsk(harness, priya);
    await drain(harness);
    const owner = harness.withIdentity({ subject: 'owner' });
    await owner.mutation(api.work.cancelPlan, { workItemId: held, reason: 'not yet' });

    await expect(owner.mutation(api.work.retryFailed, { workItemId: held })).resolves.toMatchObject({
      resumeState: 'plan-approved',
    });

    const claims = await claimsOf(harness);
    expect(claims).toHaveLength(2);
    expect(claims.filter((claim) => claim.releasedAt === undefined)).toEqual([
      expect.objectContaining({ workItemId: held }),
    ]);
  });

  it('treats a claim whose holder was cancelled without a release as released', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const priya = await seedEmployee(harness, { name: 'Priya' });
    const mateo = await seedEmployee(harness, { name: 'Mateo' });
    const stale = await seedAsk(harness, priya);
    await drain(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(stale, { state: 'cancelled' });
    });

    const taken = await seedAsk(harness, mateo);
    await drain(harness);

    expect((await readItem(harness, taken)).state).toBe('plan-pending');
    const claims = await claimsOf(harness);
    expect(claims.find((claim) => claim.workItemId === stale)?.releasedAt).toEqual(expect.any(Number));
    expect(claims.filter((claim) => claim.releasedAt === undefined)).toEqual([
      expect.objectContaining({ workItemId: taken }),
    ]);
  });
});

describe('what claims nothing', (): void => {
  it('takes no claim and refuses nothing in mock mode', async (): Promise<void> => {
    useSurfaceMode('mock');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const priya = await seedEmployee(harness, { name: 'Priya' });
    const mateo = await seedEmployee(harness, { name: 'Mateo' });
    const rows = [await seedAsk(harness, priya), await seedAsk(harness, mateo)];

    for (const workItemId of rows) {
      await harness.mutation(internal.work.setVerdict, { workItemId, verdict: { decision: 'claim' } });
    }

    for (const workItemId of rows) expect((await readItem(harness, workItemId)).state).toBe('claimed');
    expect(await claimsOf(harness)).toEqual([]);
    expect(await eventsOf(harness, 'work.claim-refused')).toEqual([]);
  });

  it('takes no claim for a revocation trial row', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const priya = await seedEmployee(harness, { name: 'Priya' });
    const workItemId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('workItems', {
          agentId: priya,
          sourceCategory: 'event-stream',
          sourceSystem: 'slack',
          externalId: 'EVAL-rev-scope-01',
          title: 'Revocation trial rev-scope-01',
          contentSummary: 'A queued read the trial revokes.',
          contentRefs: [],
          state: 'discovered',
          observedAt: Date.now(),
          createdAt: Date.now(),
        }),
    );

    await harness.mutation(internal.work.setVerdict, { workItemId, verdict: { decision: 'claim' } });

    expect((await readItem(harness, workItemId)).state).toBe('claimed');
    expect(await claimsOf(harness)).toEqual([]);
  });
});
