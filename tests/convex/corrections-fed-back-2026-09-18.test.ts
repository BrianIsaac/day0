/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import type { ExecutionPlan } from '../../src/work/types';
import { allConvexModules } from './all-modules';
import { contractSchema } from './contract-schema';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { randomBytes } from 'node:crypto';

/**
 * Corrections are kept and fed back into the employee's later work. The
 * logistics beat of the finals run, in real mode with a scripted model and
 * everything between the model and the provider the real code: exception
 * ticket one stops asking which notice template to use, the manager retries
 * it with a note, it completes; exception ticket two arrives later, and its
 * plan is drafted with the note in front of the planner, says it applies it,
 * and the executor carries it. Beside it the rule that a correction revises
 * and never overrides: another employee's never reaches the prompt, a
 * retired one does not, the scope judgement never reads one, and a stored
 * value is scrubbed on the way in. And the defect found beside it: retrying
 * a cancelled plan drafts a new plan for the manager instead of executing
 * the one they turned down.
 */

const CANCEL_REASON = 'Do not email the customer directly; comment on the ticket and let the account team send it.';

const recorded = vi.hoisted(() => ({
  model: [] as Array<{ agent: string; user: string }>,
  http: [] as Array<{ url: string; body: unknown }>,
}));

/** The correction ids the planner prompt offers, read the way a model would see them. */
function offeredIds(user: string): string[] {
  const lines = user.split('\n');
  const start = lines.indexOf('--- Corrections the manager gave on earlier work ---');
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
      return { inScope: true, fit: true, reason: 'shipment exceptions are the logistics desk work' } as T;
    }
    if (name === 'day0-plan') {
      // The scripted planner applies every correction it was offered, and
      // names one it was not, which must never be stored.
      return args.schema.parse({
        summary: 'Send the customs-hold notice and set the follow-up.',
        steps: ['Tell the manager which notice goes out and when the follow-up is due.'],
        expectedOutputType: 'message',
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 2,
        stepObligations: [{ kind: 'write', reads: [], writes: ['slack'] }],
        transition: 'none',
        transitionStep: null,
        appliedCorrections: [...offeredIds(args.user), 'forged-correction-id'],
      }) as T;
    }
    if (name === 'day0-plan-obligations') {
      return {
        steps: [{ step: 1, kind: 'write', reads: [], writes: ['slack'], reason: 'the manager DM' }],
        transition: 'none',
        transitionStep: null,
        reason: 'the plan leaves the ticket state alone',
      } as T;
    }
    if (name.startsWith('day0-skill-') && name.endsWith('-initial')) {
      return args.schema.parse({
        draft: 'Following up on the customs hold with the notice the manager chose.',
        notes: '',
        needsDependentPhase: false,
        deferredActions: [],
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
                text: 'Following up on the customs hold with the Delay notice B template; the carrier follow-up is due in 48 hours.',
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

vi.mock('../../src/surfaces/credentials', () => ({
  decryptCredentialRef: { name: 'credentials:decrypt' },
  decryptCredential: async (_ctx: unknown, credentialId: string): Promise<string> => `plain-${credentialId}`,
}));

vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit): Promise<Response> => {
  recorded.http.push({
    url: String(input),
    body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
  });
  return new Response(JSON.stringify({ ok: true, ts: '1789000000.000100' }), { status: 200 });
});

type Harness = TestConvex<typeof schema>;
const OWNER = { subject: 'owner' };
const CREDENTIAL_KEY = randomBytes(32).toString('base64');

beforeEach((): void => {
  useSurfaceMode('real');
  vi.stubEnv('DAY0_CREDENTIAL_KEY', CREDENTIAL_KEY);
  vi.useFakeTimers();
});

afterEach((): void => {
  recorded.model.length = 0;
  recorded.http.length = 0;
  vi.useRealTimers();
  restoreSurfaceMode();
});

/**
 * One employee of the company: an approved charter, a registered skill for
 * its tickets, the grants, a connected Linear queue and a connected Slack
 * manager channel. Supervised: every plan asks the manager.
 */
async function seedEmployee(
  harness: Harness,
  options: { name?: string; role?: string } = {},
): Promise<Id<'agents'>> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: options.name ?? 'Aiko',
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
        proposedFunction: options.role ?? 'Logistics desk: handle shipment exception tickets in Linear.',
        proposedBoundaries: { willDo: ['shipment exception tickets'], willNotDo: [], escalationTriggers: [] },
        approvalChain: { boss: 'boss@day0.local' },
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
    const live = { credentialLanded: true, lastVerifiedAt: Date.now(), whereFound: [], createdAt: 1 };
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

/** The plan exception ticket one ran on: one manager DM, the ticket state left alone. */
const ticketOnePlan: ExecutionPlan = {
  summary: 'Send the customs-hold notice for SH-4471.',
  steps: ['Tell the manager which notice goes out and when the follow-up is due.'],
  expectedOutputType: 'message',
  riskNotes: '',
  reversibility: 'reversible',
  estimatedMinutes: 2,
  obligations: {
    steps: [{ kind: 'write', reads: [], writes: ['slack'] }],
    transition: 'none',
    transitionStep: null,
    basis: 'judgement',
  },
};

/** Run every scheduled job that is due now, and every job those schedule. */
async function drain(harness: Harness): Promise<void> {
  await harness.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0));
}

async function readItem(harness: Harness, workItemId: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
  if (!row) throw new Error('work item missing');
  return row;
}

async function eventsOf(harness: Harness, type: string): Promise<Doc<'events'>[]> {
  return (await harness.run(async (ctx) => await ctx.db.query('events').collect())).filter(
    (event) => event.type === type,
  );
}

function promptsOf(agent: (name: string) => boolean): string[] {
  return recorded.model.filter((call) => agent(call.agent)).map((call) => call.user);
}

describe('retrying a cancelled plan', (): void => {
  async function seedPendingPlan(harness: Harness, agentId: Id<'agents'>): Promise<Id<'workItems'>> {
    return await harness.run(
      async (ctx) =>
        await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: 'LOG-5',
          title: 'Exception: SH-4533 missed the vessel',
          contentSummary: 'Notify the customer of the new sailing.',
          contentRefs: [],
          state: 'plan-pending',
          verdict: { decision: 'claim' },
          plan: { ...ticketOnePlan, summary: 'Email the customer the new sailing directly.' },
          observedAt: 1,
          createdAt: 1,
        }),
    );
  }

  it('returns the row to claimed with the plan cleared, and the turned-down plan never runs', async (): Promise<void> => {
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const workItemId = await seedPendingPlan(harness, agentId);
    await harness.withIdentity(OWNER).mutation(api.work.cancelPlan, { workItemId, reason: CANCEL_REASON });

    const result = await harness.withIdentity(OWNER).mutation(api.work.retryFailed, { workItemId });

    expect(result).toEqual({ ok: true, resumeState: 'claimed' });
    const retried = await readItem(harness, workItemId);
    expect(retried.state).toBe('claimed');
    expect(retried.plan).toBeUndefined();
    expect(retried.decision).toBeUndefined();

    await drain(harness);

    const redrafted = await readItem(harness, workItemId);
    expect(redrafted.state).toBe('plan-pending');
    expect((redrafted.plan as ExecutionPlan).summary).toBe('Send the customs-hold notice and set the follow-up.');
    expect(await eventsOf(harness, 'work.execution-claimed')).toEqual([]);
    expect(promptsOf((name) => name.startsWith('day0-skill-'))).toEqual([]);
  });
});
