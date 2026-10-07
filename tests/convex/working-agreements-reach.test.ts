/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import type { ExecutionPlan } from '../../src/work/types';
import { allConvexModules } from './all-modules';
import { contractSchema } from './contract-schema';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { randomBytes } from 'node:crypto';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';

/**
 * Where a working agreement reaches (wave 13, 13-W; the wave file's 13-W acceptance and its bed
 * walk step 5), in real mode with a scripted model and everything between the model and the
 * provider the real code: an agreement kept for every employee reaches the planner of an item in
 * its scope, for its own employee and for another, and the executor of the plan that applied it;
 * it never reaches an item out of its scope, and never the scope judgement, which is the
 * charter's. The closing phase's prompt is pinned in `tests/src/work/execute-skill-corrections.test.ts`
 * and its wiring in `tests/convex/workActions.test.ts`.
 */

const STATEMENT = 'Name the carrier and the new date in every delay notice.';
const HEADING = '--- Working agreements ---';

const recorded = vi.hoisted(() => ({
  model: [] as Array<{ agent: string; user: string }>,
}));

/** The agreement ids the planner prompt offers, read the way a model would see them. */
function offeredIds(user: string): string[] {
  const lines = user.split('\n');
  const start = lines.indexOf('--- Working agreements ---');
  if (start < 0) return [];
  const list = lines.slice(start + 1).find((line) => line.startsWith('['));
  return list ? (JSON.parse(list) as Array<{ id: string }>).map((entry) => entry.id) : [];
}

vi.mock('../../src/lib/mastra', () => ({
  MODEL_CONFIG: 'openai/mock',
  MODEL_PROVIDER_MAX_RETRIES: 2,
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async <T>(args: {
    agent: { name: string };
    user: string;
    schema: { parse(value: unknown): unknown };
  }): Promise<T> => {
    recorded.model.push({ agent: args.agent.name, user: args.user });
    const name = args.agent.name;
    if (name === 'day0-scope-judgement') {
      return args.schema.parse({
        inScope: true,
        fit: true,
        reason: 'shipment exceptions are the logistics desk work',
        exclusion: { kind: 'none', quote: '' },
      }) as T;
    }
    if (name === 'day0-plan') {
      // The scripted planner applies every agreement it was offered, and names one it was not.
      return args.schema.parse({
        summary: 'Send the delay notice.',
        steps: ['Tell the manager which notice goes out and when.'],
        expectedOutputType: 'message',
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 2,
        stepObligations: [{ kind: 'write', reads: [], writes: ['slack'] }],
        transition: 'none',
        transitionStep: null,
        appliedCorrections: null,
        appliedAgreements: [...offeredIds(args.user), 'forged-agreement-id'],
      }) as T;
    }
    if (name === 'day0-plan-obligations') {
      return args.schema.parse({
        steps: [{ step: 1, kind: 'write', reads: [], writes: ['slack'], reason: 'the manager DM' }],
        transition: 'none',
        transitionStep: null,
        reason: 'the plan leaves the ticket state alone',
      }) as T;
    }
    if (name === 'day0-agreement-refusal') {
      return args.schema.parse({ verdict: 'keep', clause: null }) as T;
    }
    if (name === 'day0-agreement-sameness') return args.schema.parse({ groups: [] }) as T;
    if (name.startsWith('day0-skill-') && name.endsWith('-initial')) {
      return (await import('./fakes/executor-reply')).parseRecordedReply(args.schema, {
        draft: 'The delay notice names the carrier and the new date.',
        notes: '',
        needsDependentPhase: false,
        deferredActions: [],
        openQuestion: null,
        procedureTrails: [],
        actions: [
          {
            tool: 'http.request',
            args: {
              surface: 'slack',
              method: 'POST',
              path: '/chat.postMessage',
              headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
              body: JSON.stringify({
                channel: 'D0MANAGER',
                text: 'The delay notice goes out naming Maersk and Friday 9 October.',
              }),
            },
          },
        ],
      }) as T;
    }
    throw new Error(`unscripted agent ${name}`);
  },
  agentText: async (): Promise<string> => '',
}));

vi.mock('../../src/surfaces/credentials', () => import('./fakes/surface-credentials'));

vi.stubGlobal('fetch', async (): Promise<Response> => {
  return new Response(JSON.stringify({ ok: true, ts: '1789000000.000100' }), { status: 200 });
});

type Harness = TestConvex<typeof schema>;
const OWNER = managerIdentity();
const CREDENTIAL_KEY = randomBytes(32).toString('base64');

beforeEach((): void => {
  useSurfaceMode('real');
  vi.stubEnv('DAY0_CREDENTIAL_KEY', CREDENTIAL_KEY);
  vi.useFakeTimers();
});

afterEach((): void => {
  recorded.model.length = 0;
  vi.useRealTimers();
  restoreSurfaceMode();
});

/**
 * One employee of the owner: an approved charter, a registered skill for its tickets, the grants,
 * a connected Linear queue and a connected Slack manager channel. Supervised.
 */
async function seedEmployee(harness: Harness, name: string): Promise<Id<'agents'>> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name,
      userId: 'owner',
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
        proposedFunction: 'Logistics desk: handle shipment exception tickets in Linear.',
        proposedBoundaries: {
          willDo: ['shipment exception tickets'],
          willNotDo: ['email customers directly'],
          escalationTriggers: [],
        },
        approvalChain: { boss: MANAGER_ADDRESS },
      },
    });
    await ctx.db.insert('skills', {
      agentId,
      name: 'update-linear-ticket',
      description: 'Comment on and close a linear ticket.',
      body: 'Comment, then close.',
      sourceType: 'agent-authored',
      state: 'registered',
      createdAt: 1,
      registeredAt: 1,
    });
    for (const scope of ['boss:message', 'linear:read', 'linear:write', 'slack:read']) {
      await ctx.db.insert('permissionGrants', { agentId, scope, createdAt: 1 });
    }
    const live = {
      credentialLanded: true,
      lastVerifiedAt: Date.now(),
      whereFound: [],
      createdAt: 1,
    };
    await ctx.db.insert('surfaces', {
      agentId,
      slug: 'linear',
      displayName: 'Linear',
      class: 'kanban',
      verdict: 'connected',
      endpoint: 'https://mcp.linear.app/mcp',
      path: 'mcp',
      toolAllowlist: ['save_comment', 'save_issue'],
      credentialId: 'cred-linear',
      ...live,
    } as never);
    await ctx.db.insert('surfaces', {
      agentId,
      slug: 'slack',
      displayName: 'Slack',
      class: 'chat',
      verdict: 'connected',
      endpoint: 'https://slack.com/api/',
      path: 'documented-api',
      toolAllowlist: ['chat.postMessage'],
      credentialId: 'cred-slack',
      managerDmChannelId: 'D0MANAGER',
      managerUserId: 'UMANAGER',
      ...live,
    } as never);
    return agentId;
  });
}

/** The agreement kept for every employee of the owner, on Linear work. */
async function keptForEveryEmployee(harness: Harness): Promise<Id<'workingAgreements'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('workingAgreements', {
        userId: 'owner',
        kind: 'preference',
        statement: STATEMENT,
        scope: 'surface',
        scopeRef: 'linear',
        sourceType: 'correction-promotion',
        status: 'active',
        approvedAt: 1,
        approvedVia: 'promotion-card',
        effectiveFrom: 1,
        createdAt: 1,
        appliedTo: [],
      }),
  );
}

/** A ticket arriving the way the intake sweep seeds one. */
async function seedTicket(
  harness: Harness,
  agentId: Id<'agents'>,
  externalId: string,
  sourceSystem = 'linear',
): Promise<Id<'workItems'>> {
  return await harness.mutation(internal.work.seedItem, {
    agentId,
    sourceCategory: 'ticket-queue',
    sourceSystem,
    externalId,
    title: `Exception: ${externalId} delayed at the port`,
    contentSummary: `Shipment ${externalId} is delayed; notify the customer.`,
    contentRefs: [`ticket://${externalId}`],
    priority: 'High',
  });
}

async function drain(harness: Harness): Promise<void> {
  await harness.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0));
}

async function readItem(harness: Harness, workItemId: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
  if (!row) throw new Error('work item missing');
  return row;
}

function promptsOf(agent: (name: string) => boolean): string[] {
  return recorded.model.filter((call) => agent(call.agent)).map((call) => call.user);
}

describe('where a working agreement reaches', (): void => {
  it('reaches the planner of an item in scope and the executor of the plan that applied it, and never the scope judgement', async (): Promise<void> => {
    const harness = convexTest(contractSchema(), allConvexModules());
    const priya = await seedEmployee(harness, 'Priya');
    const agreementId = await keptForEveryEmployee(harness);

    const ticket = await seedTicket(harness, priya, 'LOG-3');
    await drain(harness);

    const drafted = await readItem(harness, ticket);
    expect(drafted.state).toBe('plan-pending');
    const [plannerPrompt] = promptsOf((name) => name === 'day0-plan');
    expect(plannerPrompt).toContain(HEADING);
    expect(plannerPrompt).toContain(STATEMENT);
    // Only an id the planner was offered is stored; the forged one is dropped.
    expect((drafted.plan as ExecutionPlan).appliedAgreements).toEqual([agreementId]);
    // No span model is configured here, so the scrub ran its two floors and says so.
    expect((drafted.plan as ExecutionPlan).agreementsRedaction).toBe('structural-only');
    const agreement = await harness.run(async (ctx) => await ctx.db.get(agreementId));
    expect(agreement?.appliedTo).toEqual([ticket]);

    // The scope judgement is the charter's; it never reads an agreement.
    const scopePrompts = promptsOf((name) => name === 'day0-scope-judgement');
    expect(scopePrompts.length).toBeGreaterThan(0);
    for (const prompt of scopePrompts) {
      expect(prompt).not.toContain(STATEMENT);
      expect(prompt).not.toContain(HEADING);
    }

    await harness
      .withIdentity(OWNER)
      .mutation(api.planApproval.approvePlan, { workItemId: ticket });
    await drain(harness);
    const [executorPrompt] = promptsOf(
      (name) => name.includes('-log-3-') && name.endsWith('-initial'),
    );
    expect(executorPrompt).toContain(HEADING);
    expect(executorPrompt).toContain(STATEMENT);
    expect(executorPrompt.split(STATEMENT)).toHaveLength(2);
  }, 30_000);

  it("reaches another employee's next item in its scope, and not with one scoped elsewhere", async (): Promise<void> => {
    const harness = convexTest(contractSchema(), allConvexModules());
    await seedEmployee(harness, 'Priya');
    const mateo = await seedEmployee(harness, 'Mateo');
    await keptForEveryEmployee(harness);
    const elsewhere = 'Thread every Slack reply under the asker.';
    await harness.run(async (ctx) => {
      await ctx.db.insert('workingAgreements', {
        userId: 'owner',
        kind: 'preference',
        statement: elsewhere,
        scope: 'surface',
        scopeRef: 'slack',
        sourceType: 'plan-approval',
        status: 'active',
        effectiveFrom: 2,
        createdAt: 2,
        appliedTo: [],
      });
    });

    await seedTicket(harness, mateo, 'LOG-4');
    await drain(harness);
    const [inScope] = promptsOf((name) => name === 'day0-plan');
    expect(inScope).toContain(STATEMENT);
    expect(inScope).not.toContain(elsewhere);
  }, 30_000);

  it('carries a correction kept as an agreement once, as the agreement, never again as a correction (found on the bed)', async (): Promise<void> => {
    const harness = convexTest(contractSchema(), allConvexModules());
    const priya = await seedEmployee(harness, 'Priya');
    const agreementId = await keptForEveryEmployee(harness);
    const given = await seedTicket(harness, priya, 'LOG-1');
    await drain(harness);
    await harness.run(async (ctx) => {
      const correctionId = await ctx.db.insert('corrections', {
        agentId: priya,
        workItemId: given,
        kind: 'plan-rejection',
        text: STATEMENT,
        itemTitle: 'Exception: LOG-1 delayed at the port',
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        surfaces: ['linear'],
        createdAt: 1,
        appliedTo: [],
        origin: 'dashboard',
        agreementId,
      });
      await ctx.db.patch(agreementId, { correctionIds: [correctionId] });
      await ctx.db.patch(given, { state: 'cancelled' });
    });
    recorded.model.length = 0;

    await seedTicket(harness, priya, 'LOG-2');
    await drain(harness);
    const [plannerPrompt] = promptsOf((name) => name === 'day0-plan');
    expect(plannerPrompt).toContain(HEADING);
    expect(plannerPrompt!.split(STATEMENT)).toHaveLength(2);
    expect(plannerPrompt).not.toContain('--- Corrections the manager gave on earlier work ---');
  }, 30_000);

  /**
   * Priya's own agreement kept from two corrections given on an earlier ticket, now cancelled: the
   * planner reads the agreement and not the corrections while it is active.
   */
  async function keptFromTwoCorrections(
    harness: Harness,
    priya: Id<'agents'>,
  ): Promise<{ agreementId: Id<'workingAgreements'>; words: string[] }> {
    const given = await seedTicket(harness, priya, 'LOG-1');
    await drain(harness);
    const words = ['Name the vessel.', 'Always name the vessel in the notice.'];
    const agreementId = await harness.run(async (ctx) => {
      const agreementId = await ctx.db.insert('workingAgreements', {
        userId: 'owner',
        agentId: priya,
        kind: 'preference',
        statement: 'Name the vessel.',
        scope: 'surface',
        scopeRef: 'linear',
        sourceType: 'correction-promotion',
        status: 'active',
        approvedAt: 1,
        approvedVia: 'promotion-card',
        effectiveFrom: 1,
        createdAt: 1,
        appliedTo: [],
      });
      const correctionIds: Id<'corrections'>[] = [];
      for (const text of words) {
        correctionIds.push(
          await ctx.db.insert('corrections', {
            agentId: priya,
            workItemId: given,
            kind: 'plan-rejection',
            text,
            itemTitle: 'Exception: LOG-1 delayed at the port',
            sourceCategory: 'ticket-queue',
            sourceSystem: 'linear',
            surfaces: ['linear'],
            createdAt: 1,
            appliedTo: [],
            origin: 'dashboard',
            agreementId,
          }),
        );
      }
      await ctx.db.patch(agreementId, { correctionIds });
      await ctx.db.patch(given, { state: 'cancelled' });
      return agreementId;
    });
    recorded.model.length = 0;
    return { agreementId, words };
  }

  const CORRECTIONS_HEADING = '--- Corrections the manager gave on earlier work ---';

  it("leaves the planner none of a retired agreement's corrections (W13-R5)", async (): Promise<void> => {
    const harness = convexTest(contractSchema(), allConvexModules());
    const priya = await seedEmployee(harness, 'Priya');
    const { agreementId, words } = await keptFromTwoCorrections(harness, priya);
    await harness
      .withIdentity(OWNER)
      .mutation(api.workingAgreements.retire, { agreementId, agentId: priya });

    await seedTicket(harness, priya, 'LOG-6');
    await drain(harness);
    const [plannerPrompt] = promptsOf((name) => name === 'day0-plan');
    expect(plannerPrompt).not.toContain(HEADING);
    expect(plannerPrompt).not.toContain(CORRECTIONS_HEADING);
    for (const text of words) expect(plannerPrompt).not.toContain(text);
  }, 30_000);

  it("gives the planner an edited agreement's new words and none of its corrections beside them (W13-R5)", async (): Promise<void> => {
    const harness = convexTest(contractSchema(), allConvexModules());
    const priya = await seedEmployee(harness, 'Priya');
    const { agreementId, words } = await keptFromTwoCorrections(harness, priya);
    const edited = 'Name the vessel and the carrier.';
    await harness
      .withIdentity(OWNER)
      .mutation(api.workingAgreements.edit, { agreementId, agentId: priya, statement: edited });
    await drain(harness);
    recorded.model.length = 0;

    await seedTicket(harness, priya, 'LOG-7');
    await drain(harness);
    const [plannerPrompt] = promptsOf((name) => name === 'day0-plan');
    expect(plannerPrompt).toContain(edited);
    expect(plannerPrompt).not.toContain(CORRECTIONS_HEADING);
    for (const text of words) expect(plannerPrompt).not.toContain(text);
  }, 30_000);

  it('reaches no planner once retired', async (): Promise<void> => {
    const harness = convexTest(contractSchema(), allConvexModules());
    const priya = await seedEmployee(harness, 'Priya');
    const agreementId = await keptForEveryEmployee(harness);
    await harness
      .withIdentity(OWNER)
      .mutation(api.workingAgreements.retire, { agreementId, agentId: priya });

    await seedTicket(harness, priya, 'LOG-5');
    await drain(harness);
    for (const prompt of promptsOf((name) => name === 'day0-plan')) {
      expect(prompt).not.toContain(STATEMENT);
    }
  }, 30_000);
});
