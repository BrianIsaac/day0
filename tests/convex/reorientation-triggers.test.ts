import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { stampRecheckDue } from '../../convex/skillVersions';
import { transferExpiresAt } from '../../src/agent/manager-transfer';
import { allConvexModules } from './all-modules';
import {
  MANAGER_ADDRESS,
  OWNER_SUBJECT,
  fixtureAddressOf,
  managerIdentity,
} from './fakes/manager-identity';
import { cardsOf, seedEmployee, seedWork, type Harness } from './fakes/reorientation';

/*
 * The wave file's section 3, one row a test (16-O's acceptance: "each trigger opens exactly one
 * card"): every writer of a change under an employee opens its card inside its own transaction,
 * through `openCard`, and a second report of the same change writes nothing more.
 */

const OWNER = managerIdentity();

// The cards schedule their judgement; fake timers keep the model out of these tests.
beforeEach((): void => {
  vi.useFakeTimers();
});
afterEach((): void => {
  vi.useRealTimers();
});

/** The employee's cards, as the trigger tests compare them. */
async function cardsSaid(
  harness: Harness,
  agentId: Id<'agents'>,
): Promise<Array<Pick<Doc<'reorientations'>, 'trigger' | 'triggerSummary' | 'risk' | 'userId'>>> {
  return (await cardsOf(harness, agentId)).map((card) => ({
    trigger: card.trigger,
    triggerSummary: card.triggerSummary,
    risk: card.risk,
    userId: card.userId,
  }));
}

/** A registered skill of the employee's, needing the scopes, writing the system. */
async function registeredSkill(
  harness: Harness,
  agentId: Id<'agents'>,
  fields: Partial<Doc<'skills'>> = {},
): Promise<Id<'skills'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('skills', {
        agentId,
        ownerKey: OWNER_SUBJECT,
        name: 'kanban-comment-and-close',
        description: 'Ticket comment-and-close.',
        body: '# Ticket comment-and-close',
        sourceType: 'agent-authored',
        state: 'registered',
        surfaceClass: 'kanban',
        operation: 'comment-and-close',
        targetSurface: 'linear',
        requiredScopes: ['linear:read', 'linear:write'],
        registeredAt: 1,
        createdAt: 1,
        ...fields,
      }),
  );
}

describe('access revoked: the manager revokes a scope (permission.revoked)', (): void => {
  it('opens one high-risk card for a write scope, holding the open work of the skills that need it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const skillId = await registeredSkill(harness, agentId);
    const running = await seedWork(harness, agentId, 'plan-approved', { skillId });
    await harness.run(async (ctx) => {
      await ctx.db.insert('permissionGrants', { agentId, scope: 'linear:write', createdAt: 1 });
    });
    await harness
      .withIdentity(OWNER)
      .mutation(api.agents.revokeScope, { agentId, scope: 'linear:write' });
    expect(await cardsSaid(harness, agentId)).toEqual([
      {
        trigger: 'access-revoked',
        triggerSummary: 'Its access “linear:write” was revoked',
        risk: 'high',
        userId: OWNER_SUBJECT,
      },
    ]);
    const [card] = await cardsOf(harness, agentId);
    expect(card.affected.skills).toEqual([skillId]);
    expect(card.blockingWork).toEqual([running]);
  });
});

describe('access ended: a surface’s access ends (surface.expired)', (): void => {
  it('opens one card naming the system', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const surfaceId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('surfaces', {
          agentId,
          slug: 'linear',
          displayName: 'Linear',
          class: 'kanban',
          verdict: 'connected',
          whereFound: [],
          managerApprovedAt: 1,
          credentialLanded: true,
          expiresAt: 1,
          createdAt: 1,
        }),
    );
    await harness.mutation(internal.surfaces.recordExpired, { surfaceId, now: Date.now() });
    expect(await cardsSaid(harness, agentId)).toEqual([
      {
        trigger: 'access-ended',
        triggerSummary: 'Its access to Linear ended',
        risk: 'low',
        userId: OWNER_SUBJECT,
      },
    ]);
    expect((await cardsOf(harness, agentId))[0].affected.surfaces).toEqual([surfaceId]);
  });
});

describe('skill withdrawn: the manager withdraws a library version (skill.revoked)', (): void => {
  it('opens one card on every employee that held it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await seedEmployee(harness);
    const pip = await seedEmployee(harness, { name: 'Pip' });
    const versionId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('skillVersions', {
          userId: OWNER_SUBJECT,
          name: 'kanban-comment-and-close',
          description: 'Ticket comment-and-close.',
          surfaceClass: 'kanban',
          operation: 'comment-and-close',
          version: 1,
          body: '# Ticket comment-and-close',
          smokeTest: 'print("ok")',
          bodyHash: 'hash',
          requiredScopes: [],
          harnessTools: [],
          authorAgentId: mira,
          authorName: 'Mira',
          readRefs: [],
          verifiedAt: 1,
          createdAt: 1,
        }),
    );
    const miraSkill = await registeredSkill(harness, mira, { versionId });
    const pipSkill = await registeredSkill(harness, pip, { versionId });
    await harness.withIdentity(OWNER).mutation(api.skillControls.withdraw, {
      skillId: miraSkill,
      reason: 'it closes the wrong tickets',
    });
    for (const [agentId, skillId] of [
      [mira, miraSkill],
      [pip, pipSkill],
    ] as const) {
      expect(await cardsSaid(harness, agentId)).toEqual([
        {
          trigger: 'skill-withdrawn',
          triggerSummary:
            'The skill “kanban-comment-and-close” was withdrawn: it closes the wrong tickets',
          risk: 'low',
          userId: OWNER_SUBJECT,
        },
      ]);
      const [card] = await cardsOf(harness, agentId);
      expect(card.evidence.skillVersionIds).toEqual([versionId]);
      expect(card.affected.skills).toEqual([skillId]);
    }
  });
});

describe('skill due a re-check (skill.recheck-due)', (): void => {
  it('opens one card naming the skill and the page, and joins a second stamp the same day', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const skillId = await registeredSkill(harness, agentId);
    const sourceId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('docSources', {
          userId: OWNER_SUBJECT,
          kind: 'folder',
          label: 'Company handbook',
          locator: '.',
          status: 'synced',
          createdAt: 1,
          updatedAt: 1,
        }),
    );
    const page = { sourceId, ref: 'revops/runbooks/how-to-refresh-the-tile.md' };
    for (const reason of ['the runbook it read changed', 'the runbook it read changed again']) {
      await harness.run(
        async (ctx) => await stampRecheckDue(ctx, { skillId, reason, now: Date.now(), page }),
      );
    }
    expect(await cardsSaid(harness, agentId)).toEqual([
      {
        trigger: 'skill-recheck-due',
        triggerSummary:
          'The skill “kanban-comment-and-close” is due a re-check: the runbook it read changed',
        risk: 'low',
        userId: OWNER_SUBJECT,
      },
    ]);
    const [card] = await cardsOf(harness, agentId);
    expect(card.evidence.pageRefs).toEqual([page]);
    expect(card.evidence.eventIds).toHaveLength(2);
  });
});

describe('skill failing its re-check (skill.verification-failed on a registered row)', (): void => {
  it('opens one card when a registered skill’s stored verification fails, and none for a new skill’s first authoring', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const runId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('events', {
          agentId,
          type: 'skill.authoring-started',
          payload: {},
          createdAt: 1,
        }),
    );
    const registered = await registeredSkill(harness, agentId, { authoringRunId: runId });
    await harness.mutation(internal.skills.failAuthoringRun, {
      skillId: registered,
      runId,
      rowReason: 'smoke test exited 1',
      reason: 'smoke test exited 1',
      eventType: 'skill.verification-failed',
    });
    const fresh = await registeredSkill(harness, agentId, {
      name: 'notion-append-note',
      state: 'authoring',
      registeredAt: undefined,
      authoringRunId: runId,
    });
    await harness.mutation(internal.skills.failAuthoringRun, {
      skillId: fresh,
      runId,
      rowReason: 'smoke test exited 1',
      reason: 'smoke test exited 1',
      eventType: 'skill.verification-failed',
    });
    expect(await cardsSaid(harness, agentId)).toEqual([
      {
        trigger: 'skill-recheck-failed',
        triggerSummary:
          'The skill “kanban-comment-and-close” failed its re-check: smoke test exited 1',
        risk: 'low',
        userId: OWNER_SUBJECT,
      },
    ]);
  });
});

describe('a page under an open plan superseded, archived or made a draft (documentation.page-status-changed)', (): void => {
  it('opens one high-risk card holding the plan that cites the page, and none where no plan cites it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const { sourceId, pageId, otherId } = await harness.run(async (ctx) => {
      const sourceId = await ctx.db.insert('docSources', {
        userId: OWNER_SUBJECT,
        kind: 'folder',
        label: 'Company handbook',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      const page = (ref: string, title: string) => ({
        sourceId,
        ref,
        title,
        markdown: `# ${title}`,
        updatedAt: 1,
      });
      return {
        sourceId,
        pageId: await ctx.db.insert(
          'docPages',
          page('revops/escalation-paths.md', 'Escalation paths'),
        ),
        otherId: await ctx.db.insert('docPages', page('revops/glossary.md', 'Glossary')),
      };
    });
    const cited = await seedWork(harness, agentId, 'plan-approved', {
      plan: {
        summary: 'Answer the ask.',
        steps: ['Read the escalation paths', 'Reply'],
        cites: [
          {
            step: 1,
            label: 'Escalation paths > Tier 2',
            sourceId,
            pageRef: 'revops/escalation-paths.md',
            blocks: [],
          },
        ],
      },
    });
    const owner = harness.withIdentity(OWNER);
    await owner.mutation(api.docStatus.setPageStatus, { pageId, status: 'archived' });
    await owner.mutation(api.docStatus.setPageStatus, { pageId: otherId, status: 'archived' });
    expect(await cardsSaid(harness, agentId)).toEqual([
      {
        trigger: 'page-status-changed',
        triggerSummary: '“Escalation paths” was archived',
        risk: 'high',
        userId: OWNER_SUBJECT,
      },
    ]);
    const [card] = await cardsOf(harness, agentId);
    expect(card.blockingWork).toEqual([cited]);
    expect(card.evidence.pageRefs).toEqual([{ sourceId, ref: 'revops/escalation-paths.md' }]);
  });
});

describe('manager changed: a handover is accepted (manager.transferred)', (): void => {
  it('opens one card under the new manager about the carried reporting-line rules, and moves the cards before it (16-K’s F2)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const before = await harness.run(
      async (ctx) =>
        await ctx.db.insert('reorientations', {
          agentId,
          userId: OWNER_SUBJECT,
          trigger: 'skill-recheck-due',
          triggerKey: 'earlier',
          triggerSummary: 'An earlier card',
          evidence: {
            eventIds: [],
            pageRefs: [],
            relationIds: [],
            correctionIds: [],
            relationshipIds: [],
            skillIds: [],
            skillVersionIds: [],
          },
          affected: {
            charterClauses: [],
            agreements: [],
            relationships: [],
            skills: [],
            surfaces: [],
            workItems: [],
          },
          proposed: { kind: 'pending' },
          risk: 'low',
          blockingWork: [],
          status: 'open',
          day: '2026-09-25',
          createdAt: 1,
        }),
    );
    const transferId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('managerTransfers', {
          agentId,
          agentName: 'Mira',
          fromOwnerKey: OWNER_SUBJECT,
          fromAddress: MANAGER_ADDRESS,
          toAddress: fixtureAddressOf('colleague'),
          state: 'asked',
          requestedAt: Date.now(),
          expiresAt: transferExpiresAt(Date.now()),
        }),
    );
    await harness
      .withIdentity(managerIdentity('colleague'))
      .mutation(api.transferAcceptance.accept, { transferId });
    await harness.finishInProgressScheduledFunctions();
    const cards = await cardsOf(harness, agentId);
    expect(cards.map((card) => [card._id === before, card.userId])).toEqual([
      [true, 'colleague'],
      [false, 'colleague'],
    ]);
    const handed = cards.find((card) => card._id !== before)!;
    expect(handed).toMatchObject({
      trigger: 'manager-changed',
      triggerSummary: `${MANAGER_ADDRESS} handed Mira over to you`,
      risk: 'medium',
    });
    expect(handed.affected.charterClauses).toEqual([
      {
        field: 'escalationTriggers',
        index: 0,
        text: 'Surface tier-2 answer drafts to the manager for review',
      },
    ]);
    const listed = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('reorientations')
          .withIndex('by_user_status', (q) => q.eq('userId', OWNER_SUBJECT).eq('status', 'open'))
          .collect(),
    );
    expect(listed).toEqual([]);
  });
});
