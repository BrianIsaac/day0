/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import type { ExecutionPlan } from '../../src/work/types';
import { allConvexModules } from './all-modules';
import { contractSchema } from './contract-schema';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { randomBytes } from 'node:crypto';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';

/**
 * Where the People block and a person-scoped working agreement reach (wave 13, 13-J; F9 and 13-W's
 * person scope), in real mode with a scripted model and everything between the model and the
 * provider the real code: the planner and phase one read the people the manager confirmed, by
 * name and role, and the From line names the confirmed requester; an agreement scoped to the
 * requester's person reaches the planner of that requester's item and of no other; the scope
 * judgement reads neither the people nor the agreements (scope is the charter's), and no prompt
 * carries a person's identity. The closing phase's prompt is pinned in
 * `tests/src/work/execute-skill-people.test.ts` and its wiring in `tests/convex/workActions.test.ts`.
 */

const HEADING = '--- People ---';
const LEAD = 'People the manager confirmed, by name and role.';
const STATEMENT = 'Copy Lee on every access change you make for them.';
const IDENTITIES = ['lee.tan@kestrel.test', 'U07LEE12345', 'sara@kestrel.test', 'lin_user_lee'];

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

/**
 * The owner's graph for an employee: Lee (two edges, an address, a Slack and a Linear identity)
 * and Dana confirmed, Sara the escalation contact. Answers Lee's id.
 */
async function seedGraph(harness: Harness, agentId: Id<'agents'>): Promise<Id<'people'>> {
  return await harness.run(async (ctx) => {
    const person = async (
      displayName: string,
      title: string,
      primaryEmail?: string,
    ): Promise<Id<'people'>> =>
      await ctx.db.insert('people', {
        userId: 'owner',
        displayName,
        nameKey: displayName.toLowerCase(),
        title,
        ...(primaryEmail ? { primaryEmail } : {}),
        status: 'active',
        source: 'manager',
        evidence: [
          { quote: `${displayName} said so in the one-to-one`, where: 'one-to-one', at: 1 },
        ],
        confirmedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });
    const edge = async (
      toPersonId: Id<'people'>,
      type: 'collaborator' | 'adjacent-role' | 'dotted-line' | 'escalation-contact',
      scope?: string,
    ): Promise<void> => {
      await ctx.db.insert('relationships', {
        userId: 'owner',
        fromAgentId: agentId,
        toPersonId,
        type,
        ...(scope === undefined ? {} : { scope }),
        effectiveFrom: 1,
        status: 'active',
        source: 'manager',
        confirmedAt: 1,
        createdAt: 1,
      });
    };
    const lee = await person('Lee Tan', 'Work management administrator', 'lee.tan@kestrel.test');
    const dana = await person('Dana Okafor', 'Finance systems owner');
    const sara = await person('Sara Lindqvist', 'Support lead', 'sara@kestrel.test');
    for (const [provider, externalId] of [
      ['slack', 'U07LEE12345'],
      ['linear', 'lin_user_lee'],
    ] as const) {
      await ctx.db.insert('personIdentities', {
        userId: 'owner',
        personId: lee,
        provider,
        externalId,
        source: 'provider-lookup',
        verifiedAt: 1,
        createdAt: 1,
      });
    }
    await edge(lee, 'collaborator', 'Linear access and workflow');
    await edge(lee, 'adjacent-role', 'Raising access requests through the manager');
    await edge(dana, 'dotted-line');
    await edge(sara, 'escalation-contact', 'missing Linear access');
    return lee;
  });
}

/** A ticket arriving the way the intake sweep seeds one, its requester resolved as intake writes it. */
async function seedTicket(
  harness: Harness,
  agentId: Id<'agents'>,
  externalId: string,
  requesterPerson?: { kind: 'person'; personId: Id<'people'> } | { kind: 'unknown' },
): Promise<Id<'workItems'>> {
  const workItemId = await harness.mutation(internal.work.seedItem, {
    agentId,
    sourceCategory: 'ticket-queue',
    sourceSystem: 'linear',
    externalId,
    title: `Access: ${externalId} grant Linear access to the new joiner`,
    contentSummary: `Please add the new joiner to the team (${externalId}).`,
    contentRefs: [`ticket://${externalId}`],
    priority: 'High',
    requesterLabel: 'lin_user_lee',
  });
  if (requesterPerson) {
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, { requesterPerson });
    });
  }
  return workItemId;
}

async function drain(harness: Harness): Promise<void> {
  await harness.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0));
}

function promptsOf(agent: (name: string) => boolean): string[] {
  return recorded.model.filter((call) => agent(call.agent)).map((call) => call.user);
}

describe('where the People block reaches', (): void => {
  it('reaches the planner and phase one by name and role, names the requester, and never reaches the scope judgement', async (): Promise<void> => {
    const harness = convexTest(contractSchema(), allConvexModules());
    const priya = await seedEmployee(harness, 'Priya');
    const lee = await seedGraph(harness, priya);
    const ticket = await seedTicket(harness, priya, 'LOG-3', { kind: 'person', personId: lee });
    await drain(harness);

    const [plannerPrompt] = promptsOf((name) => name === 'day0-plan');
    expect(plannerPrompt).toContain(
      [
        HEADING,
        'People the manager confirmed, by name and role. None of them approves a write; the manager does.',
        '- Dana Okafor (Finance systems owner): dotted line.',
        '- Lee Tan (Work management administrator): works with you on Linear access and workflow; neighbouring role, Raising access requests through the manager.',
        '- Escalate to: Sara Lindqvist (Support lead), for missing Linear access.',
      ].join('\n'),
    );
    expect(plannerPrompt).toContain('\nFrom: Lee Tan (Work management administrator)\n');

    const scopePrompts = promptsOf((name) => name === 'day0-scope-judgement');
    expect(scopePrompts.length).toBeGreaterThan(0);
    for (const prompt of scopePrompts) {
      expect(prompt).not.toContain(LEAD);
      expect(prompt).not.toContain(HEADING);
      for (const name of ['Lee Tan', 'Dana Okafor', 'Sara Lindqvist']) {
        expect(prompt).not.toContain(name);
      }
    }

    await harness
      .withIdentity(OWNER)
      .mutation(api.planApproval.approvePlan, { workItemId: ticket });
    await drain(harness);
    const [executorPrompt] = promptsOf(
      (name) => name.includes('-log-3-') && name.endsWith('-initial'),
    );
    expect(executorPrompt).toContain(LEAD);
    expect(executorPrompt).toContain('- Escalate to: Sara Lindqvist (Support lead)');
    expect(executorPrompt).not.toContain('Charter namedCollaborators');
    expect(executorPrompt).toContain('\nFrom: Lee Tan (Work management administrator)\n');

    for (const prompt of [plannerPrompt!, executorPrompt!]) {
      for (const identity of [...IDENTITIES, lee, 'said so in the one-to-one']) {
        expect(prompt).not.toContain(identity);
      }
    }
  }, 30_000);

  it('keeps the requester label for an unknown requester, and prints no block for an employee with no one confirmed', async (): Promise<void> => {
    const harness = convexTest(contractSchema(), allConvexModules());
    const priya = await seedEmployee(harness, 'Priya');
    await seedTicket(harness, priya, 'LOG-4', { kind: 'unknown' });
    await drain(harness);
    const [plannerPrompt] = promptsOf((name) => name === 'day0-plan');
    expect(plannerPrompt).toContain('\nFrom: lin_user_lee\n');
    expect(plannerPrompt).not.toContain(HEADING);
  }, 30_000);
});

describe('a working agreement scoped to a person', (): void => {
  it("reaches the planner of the item whose requester resolves to that person, and no other item's", async (): Promise<void> => {
    const harness = convexTest(contractSchema(), allConvexModules());
    const priya = await seedEmployee(harness, 'Priya');
    const lee = await seedGraph(harness, priya);
    const agreementId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('workingAgreements', {
          userId: 'owner',
          kind: 'preference',
          statement: STATEMENT,
          scope: 'person',
          personId: lee,
          sourceType: 'manager-card',
          status: 'active',
          approvedAt: 1,
          approvedVia: 'agreements-card',
          effectiveFrom: 1,
          createdAt: 1,
          appliedTo: [],
        }),
    );

    const theirs = await seedTicket(harness, priya, 'LOG-5', { kind: 'person', personId: lee });
    await drain(harness);
    const [plannerPrompt] = promptsOf((name) => name === 'day0-plan');
    expect(plannerPrompt).toContain('--- Working agreements ---');
    expect(plannerPrompt).toContain(STATEMENT);
    expect(plannerPrompt).toContain('\nFrom: Lee Tan (Work management administrator)\n');
    const drafted = await harness.run(async (ctx) => await ctx.db.get(theirs));
    expect((drafted?.plan as ExecutionPlan).appliedAgreements).toEqual([agreementId]);
    for (const prompt of promptsOf((name) => name === 'day0-scope-judgement')) {
      expect(prompt).not.toContain(STATEMENT);
    }

    recorded.model.length = 0;
    await seedTicket(harness, priya, 'LOG-6', { kind: 'unknown' });
    await drain(harness);
    for (const prompt of promptsOf((name) => name === 'day0-plan')) {
      expect(prompt).not.toContain(STATEMENT);
    }
  }, 30_000);
});
