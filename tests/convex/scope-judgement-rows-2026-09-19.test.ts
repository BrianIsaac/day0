/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { contractSchema } from './contract-schema';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { K_REASON, mateoCharter, priyaCharter } from '../src/work/scope-run-fixtures-2026-09-19';

/**
 * Findings K and L of the second full run (19 Sep 2026), on the rows.
 *
 * K: REVOPS-27's skip cited nothing that excludes a ticket from the team and
 * project Priya's willDo names; the evaluation step asks again, keeps the
 * item, and the row carries both readings.
 *
 * L: FIN-1 was in scope on its first evaluation and skipped on the one its
 * skill's registration caused. The row keeps its in-scope judgement, a
 * re-evaluation under the same charter holds it and re-runs the rest, and a
 * policy change or a charter amendment still has the scope judged again.
 */

interface Answer {
  inScope: boolean;
  fit: boolean;
  reason: string;
  exclusion: { kind: string; quote: string };
}

const recorded = vi.hoisted(() => ({
  prompts: [] as string[],
  answers: [] as unknown[],
}));

vi.mock('../../src/lib/mastra', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/mastra')>();
  return {
    ...original,
    makeAgent: (name: string): { name: string; generate: (user: string) => Promise<unknown> } => ({
      name,
      generate: async (user: string): Promise<unknown> => {
        if (name !== 'day0-scope-judgement') throw new Error(`unscripted agent ${name}`);
        recorded.prompts.push(user);
        const next = recorded.answers.shift();
        if (next === undefined) throw new Error('unscripted scope judgement');
        return { object: next };
      },
    }),
  };
});

type Harness = TestConvex<typeof schema>;

function skip(reason: string, exclusion: Answer['exclusion'] = { kind: 'none', quote: '' }): Answer {
  return { inScope: false, fit: true, reason, exclusion };
}

afterEach((): void => {
  recorded.prompts.length = 0;
  recorded.answers.length = 0;
  restoreSurfaceMode();
});

interface Seeded {
  agentId: Id<'agents'>;
  charterId: Id<'charters'>;
  workItemId: Id<'workItems'>;
}

async function seed(
  harness: Harness,
  who: 'priya' | 'mateo',
): Promise<Seeded> {
  const charter = who === 'priya' ? priyaCharter : mateoCharter;
  const bounds = who === 'priya' ? { team: 'REVOPS', project: 'Q3 close' } : { team: 'FIN', project: 'September close' };
  const ticket =
    who === 'priya'
      ? {
          externalId: 'REVOPS-27',
          title: 'Refresh the Looker pipeline tile',
          contentSummary:
            'Update the pipeline coverage figure on the Looker pipeline tile to the figure in the Friday standup coverage summary.\n\nday0-demo-key: revops-tile',
        }
      : {
          externalId: 'FIN-1',
          title: 'Post the September close status note',
          contentSummary:
            'Post the close status note for the September close on this ticket.\n\nday0-demo-key: fin-status',
        };
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: who,
      userId: 'owner',
      state: 'active',
      autonomousActions: true,
      createdAt: 1,
    });
    const charterId = await ctx.db.insert('charters', {
      agentId,
      version: '0.0',
      approved: true,
      approvedAt: 1,
      createdAt: 1,
      body: charter,
    });
    for (const scope of ['boss:message', 'linear:read', 'linear:write']) {
      await ctx.db.insert('permissionGrants', { agentId, scope, createdAt: 1 });
    }
    const quoted = (value: string) => ({ value, ref: 'handbook.md', quote: `- \`${value}\`` });
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
      credentialLanded: true,
      lastVerifiedAt: Date.now(),
      whereFound: [],
      intakeScope: { team: quoted(bounds.team), project: quoted(bounds.project) },
      createdAt: 1,
    } as never);
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      ...ticket,
      contentRefs: [],
      priority: 'No priority',
      state: 'discovered',
      observedAt: Date.now(),
      createdAt: Date.now(),
    });
    return { agentId, charterId, workItemId };
  });
}

async function evaluate(harness: Harness, workItemId: Id<'workItems'>): Promise<string> {
  return (await harness.action(internal.workActions.evaluateWorkItemInternal, { workItemId })).decision;
}

async function row(harness: Harness, workItemId: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const found = await harness.run(async (ctx) => await ctx.db.get(workItemId));
  if (!found) throw new Error('row not found');
  return found;
}

async function eventsOf(harness: Harness, type: string): Promise<Doc<'events'>[]> {
  return (await harness.run(async (ctx) => await ctx.db.query('events').collect())).filter(
    (event) => event.type === type,
  );
}

describe('finding K on the rows: REVOPS-27', (): void => {
  it('keeps the ticket and stores both readings on the row and the timeline', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const { charterId, workItemId } = await seed(harness, 'priya');
    const second = 'A dashboard tile is analytics work the willDo clauses do not list.';
    recorded.answers.push(skip(K_REASON), skip(second));

    await expect(evaluate(harness, workItemId)).resolves.toBe('needs-skill');

    const stored = await row(harness, workItemId);
    expect(stored.state).toBe('needs-skill');
    expect(stored.scopeAdmission).toEqual({
      charterId,
      at: expect.any(Number),
      basis: 'source-named',
      namedBy: 'Work the tickets in Linear, team REVOPS, project Q3 close.',
      overruled: [K_REASON, second],
    });
    const overruled = await eventsOf(harness, 'work.scope-skip-overruled');
    expect(overruled.map((event) => event.payload)).toEqual([
      {
        workItemId,
        basis: 'source-named',
        namedBy: 'Work the tickets in Linear, team REVOPS, project Q3 close.',
        overruled: [K_REASON, second],
      },
    ]);
  });

  it('writes no admission for a skip that cites', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const { workItemId } = await seed(harness, 'priya');
    recorded.answers.push(
      skip('Configuring Linear is the admins\' lane.', {
        kind: 'will-not-do',
        quote: "Own Linear or Slack administration (the admins' lane).",
      }),
    );

    await expect(evaluate(harness, workItemId)).resolves.toBe('skip');

    expect((await row(harness, workItemId)).scopeAdmission).toBeUndefined();
    expect(await eventsOf(harness, 'work.scope-skip-overruled')).toEqual([]);
  });
});
