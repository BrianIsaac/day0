import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { stampRecheckDue, stampRecheckDueOnSurfaces } from '../../convex/skillVersions';
import { reevaluatePendingInTransaction } from '../../convex/workReevaluation';
import { transferExpiresAt } from '../../src/agent/manager-transfer';
import { CORPUS_SLOTS } from '../fixtures/redaction-corpus';
import { allConvexModules } from './all-modules';
import {
  MANAGER_ADDRESS,
  OWNER_SUBJECT,
  fixtureAddressOf,
  managerIdentity,
} from './fakes/manager-identity';
import {
  cardsOf,
  openTestCard,
  runCardChain,
  scheduledAs,
  shownOf,
  seedEmployee,
  seedWork,
  type Harness,
} from './fakes/reorientation';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

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

/** The types of an employee's events, oldest first. */
async function eventTypesOfAgent(harness: Harness, agentId: Id<'agents'>): Promise<string[]> {
  return await harness.run(async (ctx) =>
    (await ctx.db.query('events').collect())
      .filter((event) => event.agentId === agentId)
      .map((event) => event.type),
  );
}

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
    // The judgement is offered no grant of what the manager just revoked (the second pass's minor).
    const read = await harness.query(internal.reorientation.proposalInput, {
      reorientationId: card._id,
    });
    expect(read?.input.candidates.filter((candidate) => candidate.kind === 'scope')).toEqual([]);
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
      // The withdrawal retired the skill: the judgement is offered no action on it (the walk's
      // W-2: a card proposed re-checking a retired skill, which Approve then refused).
      const read = await harness.query(internal.reorientation.proposalInput, {
        reorientationId: card._id,
      });
      expect(read?.input.candidates.filter((candidate) => candidate.kind === 'skill')).toEqual([]);
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

// W17-R2 with D-1 (a) (17-J's W2, the joins' walk row: archive, return, Approve): a card opened
// by a page's archive kept saying the page was archived once it was current again, and Approve of
// its `archived` proposal pinned the page to the manager, after which its source's word was lost.
describe('a page whose status opened a card is current again (W17-R2, D-1 (a))', (): void => {
  const REF = 'policies/close-review-window.md';

  /** A folder source mid-sync with one page, and a held plan of the employee's citing it. */
  async function archivedUnderPlan(harness: Harness) {
    const agentId = await seedEmployee(harness);
    const { sourceId, runId } = await harness.run(async (ctx) => {
      const sourceId = await ctx.db.insert('docSources', {
        userId: OWNER_SUBJECT,
        kind: 'folder',
        label: 'Company folder',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      const runId = await ctx.db.insert('docSyncRuns', {
        sourceId,
        listing: 0,
        credentialRefs: [],
        pageCount: 0,
        redactionCount: 0,
        state: 'running',
        createdAt: 1,
      });
      await ctx.db.patch(sourceId, { activeSyncId: runId });
      await ctx.db.insert('docPages', {
        sourceId,
        ref: REF,
        title: 'Close review window',
        markdown: '# Close review window',
        updatedAt: 1,
      });
      return { sourceId, runId };
    });
    const held = await seedWork(harness, agentId, 'plan-pending', {
      plan: {
        summary: 'Review the close.',
        steps: ['Read the review window', 'Reply'],
        cites: [{ step: 1, label: 'Close review window', sourceId, pageRef: REF, blocks: [] }],
      },
    });
    const read = async (nativeStatus?: 'archived'): Promise<boolean> =>
      await harness.mutation(internal.docStatus.recordRead, {
        sourceId,
        syncRunId: runId,
        ref: REF,
        ...(nativeStatus === undefined ? {} : { nativeStatus }),
      });
    expect(await read('archived')).toBe(true);
    const [card] = await cardsOf(harness, agentId);
    expect(card).toMatchObject({
      trigger: 'page-status-changed',
      triggerSummary: '“Close review window” was archived',
      status: 'open',
      blockingWork: [held],
    });
    // The judgement on the hosted model proposed the status the page had at its source.
    await harness.run(async (ctx) => {
      await ctx.db.patch(card._id, {
        proposed: {
          kind: 'page-status',
          page: { sourceId, ref: REF },
          status: 'archived',
          rationale: 'The source archived it.',
        },
      });
    });
    return { agentId, sourceId, held, card, read };
  }

  /** Run the question turns a status change handed over, as the scheduler would. */
  async function turnQuestions(harness: Harness): Promise<void> {
    for (const job of await scheduledAs(harness, 'docRelations:turnPageQuestions')) {
      await harness.mutation(
        internal.docRelations.turnPageQuestions,
        job.args[0] as { pages: Array<{ sourceId: Id<'docSources'>; ref: string; back: boolean }> },
      );
    }
  }

  it('closes the card as no longer needed once the page is current again, says so in the record, and lets its plan go on', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, held, card, read } = await archivedUnderPlan(harness);
    await turnQuestions(harness);
    expect(await read()).toBe(true);
    await turnQuestions(harness);
    const [closed] = await cardsOf(harness, agentId);
    expect(closed).toMatchObject({
      _id: card._id,
      status: 'dismissed',
      outcome: { summary: 'no longer needed: “Close review window” is current again' },
    });
    expect(closed.decidedAt).toEqual(expect.any(Number));
    const dismissed = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect()).filter(
        (event) => event.type === 'reorientation.dismissed',
      ),
    );
    expect(dismissed.map((event) => event.payload)).toEqual([
      {
        reorientationId: card._id,
        summary: '“Close review window” was archived',
        outcome: 'no longer needed: “Close review window” is current again',
      },
    ]);
    // The plan it held is asked for its decision again; nothing it was drafted under moved.
    const decided = await scheduledAs(harness, 'work:decidePlan');
    expect(decided.map((job) => job.args[0])).toContainEqual({
      workItemId: held,
      recovery: true,
    });
    await expect(
      harness
        .withIdentity(OWNER)
        .mutation(api.reorientationDecisions.approve, await shownOf(harness, card._id)),
    ).rejects.toThrow('That card has already been decided.');
  });

  it('keeps a card open while another page it rests on is still not current', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, sourceId, card, read } = await archivedUnderPlan(harness);
    await harness.run(async (ctx) => {
      await ctx.db.insert('docPages', {
        sourceId,
        ref: 'policies/close-checklist.md',
        title: 'Close checklist',
        markdown: '# Close checklist',
        updatedAt: 1,
        status: 'archived',
        statusSource: 'source-native',
      });
      const row = await ctx.db.get(card._id);
      await ctx.db.patch(card._id, {
        evidence: {
          ...row!.evidence,
          pageRefs: [...row!.evidence.pageRefs, { sourceId, ref: 'policies/close-checklist.md' }],
        },
      });
    });
    await turnQuestions(harness);
    expect(await read()).toBe(true);
    await turnQuestions(harness);
    expect((await cardsOf(harness, agentId))[0]).toMatchObject({ status: 'open' });
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

describe('a handover card names a reporting-line rule drafted before rules were bound (W16-R21, W7a)', (): void => {
  it('puts the rule’s own words on the card and before the judgement when it binds no clause', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const quote = 'Go through me for all of them for now, I’ll intro you.';
    await harness.run(async (ctx) => {
      const charter = await ctx.db
        .query('charters')
        .withIndex('by_agent', (q) => q.eq('agentId', agentId))
        .first();
      // The wave 6 draft's shape (bed 1, 16-J's W7a): no `binds`, empty `wording`.
      await ctx.db.patch(charter!._id, {
        body: {
          ...(charter!.body as object),
          constraints: [{ kind: 'reporting-line', quote, wording: [], origin: 'synthesis' }],
        },
      });
    });
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
    const colleague = harness.withIdentity(managerIdentity('colleague'));
    await colleague.mutation(api.transferAcceptance.accept, { transferId });
    const [view] = await colleague.query(api.reorientationDecisions.listForAgent, { agentId });
    expect(view.card).toMatchObject({ trigger: 'manager-changed', status: 'open' });
    expect(view.card.affected.charterClauses).toEqual([]);
    expect(view.carriedRules).toEqual([quote]);
    const read = await harness.query(internal.reorientation.proposalInput, {
      reorientationId: view.card._id,
    });
    expect(read?.input.evidence).toContain(
      `A reporting-line rule of the previous manager’s that the charter carries: “${quote}”`,
    );
  });
});

describe('a handover closes what the old manager was deciding (W16-R1, D-5 (a))', (): void => {
  it('closes the undecided cards and every talk with the words cleared, and shows the new manager nothing of the old graph', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const ines = await seedPerson(harness, 'Ines Duarte');
    const edgeId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('relationships', {
          userId: OWNER_SUBJECT,
          toPersonId: ines,
          type: 'approval-authority',
          scope: 'NetLedger journal changes',
          effectiveFrom: 1,
          status: 'active',
          source: 'manager',
          confirmedAt: 1,
          createdAt: 1,
        }),
    );
    const standing = await openTestCard(harness, {
      agentId,
      trigger: 'relationship-changed',
      triggerKey: 'edge-change',
      summary: 'Ines Duarte, its approver, changed',
      evidence: { relationshipIds: [edgeId] },
    });
    const decided = await openTestCard(harness, {
      agentId,
      trigger: 'role-changed',
      triggerKey: 'by-hand',
      summary: 'Its role changed',
    });
    if (standing === null || decided === null) throw new Error('no card opened');
    const turns = [
      { id: 'e0', speaker: 'employee' as const, text: 'Who approves now?', at: 1 },
      { id: 'm0', speaker: 'manager' as const, text: 'Aisha does, Ines never did well.', at: 2 },
    ];
    await harness.run(async (ctx) => {
      await ctx.db.patch(standing, { status: 'discussing' });
      await ctx.db.insert('reorientationTalks', {
        agentId,
        reorientationId: standing,
        state: 'active',
        turns,
        replyDraft: 'And tell Ines',
        conversation: 1,
        startedAt: 1,
      });
      await ctx.db.patch(decided, { status: 'dismissed', decidedAt: 2 });
      await ctx.db.insert('reorientationTalks', {
        agentId,
        reorientationId: decided,
        state: 'finished',
        turns,
        conversation: 1,
        outcome: {
          proposed: { kind: 'none', rationale: 'Nothing changes.' },
          quotes: ['Aisha does, Ines never did well.'],
        },
        startedAt: 1,
        endedAt: 2,
      });
    });
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
    const colleague = harness.withIdentity(managerIdentity('colleague'));
    await colleague.mutation(api.transferAcceptance.accept, { transferId });
    await harness.finishInProgressScheduledFunctions();

    const cards = await cardsOf(harness, agentId);
    expect(cards.find((card) => card._id === standing)).toMatchObject({
      status: 'dismissed',
      userId: 'colleague',
      outcome: { summary: 'closed at the handover, as it was the previous manager’s to decide' },
    });
    expect(cards.filter((card) => card.trigger === 'manager-changed')).toMatchObject([
      { status: 'open', userId: 'colleague' },
    ]);
    const talks = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('reorientationTalks')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .collect(),
    );
    expect(talks).toHaveLength(2);
    for (const talk of talks) {
      expect(talk).toMatchObject({ state: 'closed', turns: [] });
      expect(talk.replyDraft).toBeUndefined();
      expect(talk.outcome?.quotes ?? []).toEqual([]);
    }
    for (const cardId of [standing, decided]) {
      const room = await colleague.query(api.reorientationTalk.forCard, {
        reorientationId: cardId,
      });
      expect(room?.talk?.turns).toEqual([]);
    }
    const listed = await colleague.query(api.reorientationDecisions.listForAgent, { agentId });
    // The card keeps its own summary, as the employee's record does; the old manager's edge, its
    // person and its scope are no longer resolved onto it.
    const said = JSON.stringify(listed);
    expect(said).not.toContain('Ines Duarte, its approver for');
    expect(said).not.toContain('NetLedger journal changes');
    expect(listed.find((view) => view.card._id === standing)?.people).toEqual([]);
  });
});

/** A confirmed person of the owner's graph. */
async function seedPerson(harness: Harness, displayName: string): Promise<Id<'people'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('people', {
        userId: OWNER_SUBJECT,
        displayName,
        nameKey: displayName.toLowerCase(),
        status: 'active',
        source: 'manager',
        evidence: [],
        confirmedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      }),
  );
}

/** An active working agreement of the employee's, about a person when one is named. */
async function seedAgreement(
  harness: Harness,
  agentId: Id<'agents'>,
  fields: Partial<Doc<'workingAgreements'>> = {},
): Promise<Id<'workingAgreements'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('workingAgreements', {
        userId: OWNER_SUBJECT,
        agentId,
        kind: 'preference',
        statement: 'Copy Priya on tier-2 answers about committee-deck numbers.',
        scope: 'global',
        sourceType: 'manager-card',
        status: 'active',
        createdAt: 1,
        appliedTo: [],
        ...fields,
      }),
  );
}

describe('approver or escalation contact changed (relationship.changed)', (): void => {
  it('opens one high-risk card holding the open plans when an approval authority is edited, with the person’s agreements', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const priya = await seedPerson(harness, 'Priya');
    const edge = await harness.run(
      async (ctx) =>
        await ctx.db.insert('relationships', {
          userId: OWNER_SUBJECT,
          toPersonId: priya,
          type: 'approval-authority',
          scope: 'committee-deck numbers',
          effectiveFrom: 1,
          status: 'active',
          source: 'manager',
          confirmedAt: 1,
          createdAt: 1,
        }),
    );
    const agreement = await seedAgreement(harness, agentId, { scope: 'person', personId: priya });
    const plan = await seedWork(harness, agentId, 'plan-pending');
    const edited = await harness.withIdentity(OWNER).mutation(api.people.editRelationship, {
      relationshipId: edge,
      agentId,
      type: 'approval-authority',
      scope: 'renewals only',
    });
    expect(await cardsSaid(harness, agentId)).toEqual([
      {
        trigger: 'relationship-changed',
        // Re-taken (17-O; the pre-tag's re-walk): the card said "Priya, its approver, changed"
        // whatever changed, and the judgement read a changed scope as Priya having left.
        triggerSummary:
          'Priya, its approver: now for “renewals only”, where it was “committee-deck numbers”',
        risk: 'high',
        userId: OWNER_SUBJECT,
      },
    ]);
    const [card] = await cardsOf(harness, agentId);
    expect(card.evidence.relationshipIds).toEqual([edited]);
    expect(card.affected.agreements).toEqual([agreement]);
    expect(card.blockingWork).toEqual([plan]);
  });

  it('opens no card for a collaborator edge', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const pip = await seedPerson(harness, 'Pip');
    await harness
      .withIdentity(OWNER)
      .mutation(api.people.addRelationship, { personId: pip, agentId, type: 'collaborator' });
    expect(await cardsOf(harness, agentId)).toEqual([]);
  });
});

describe('a person dismissed (person.dismissed)', (): void => {
  it('opens one card on the employee whose edge it retired', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const nell = await harness.run(
      async (ctx) =>
        await ctx.db.insert('people', {
          userId: OWNER_SUBJECT,
          displayName: 'Nell',
          nameKey: 'nell',
          status: 'unverified',
          source: 'documentation',
          evidence: [],
          createdAt: 1,
          updatedAt: 1,
        }),
    );
    await harness.run(
      async (ctx) =>
        await ctx.db.insert('relationships', {
          userId: OWNER_SUBJECT,
          fromAgentId: agentId,
          toPersonId: nell,
          type: 'escalation-contact',
          effectiveFrom: 1,
          status: 'proposed',
          source: 'documentation',
          createdAt: 1,
        }),
    );
    await harness.withIdentity(OWNER).mutation(api.people.dismiss, { personId: nell, agentId });
    expect(await cardsSaid(harness, agentId)).toEqual([
      {
        trigger: 'person-dismissed',
        triggerSummary: 'You dismissed Nell',
        risk: 'low',
        userId: OWNER_SUBJECT,
      },
    ]);
    // The dismissal retired the edge: the judgement is offered no edge to retire again (the
    // walk's W-3: the card proposed retiring the edge the dismissal had retired).
    const [card] = await cardsOf(harness, agentId);
    const read = await harness.query(internal.reorientation.proposalInput, {
      reorientationId: card._id,
    });
    expect(read?.input.candidates.filter((candidate) => candidate.kind === 'relationship')).toEqual(
      [],
    );
  });
});

describe('a correction on an item that applied an agreement (a kept correction)', (): void => {
  afterEach((): void => {
    restoreSurfaceMode();
  });

  it('opens one card about the agreement the corrected plan applied, and none for an item that applied none', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const applied = await seedWork(harness, agentId, 'plan-pending', {
      plan: { steps: ['Reply'] },
    });
    const plain = await seedWork(harness, agentId, 'plan-pending', {
      externalId: 'REVOPS-2',
      plan: { steps: ['Reply'] },
    });
    const agreement = await seedAgreement(harness, agentId, { appliedTo: [applied] });
    const owner = harness.withIdentity(OWNER);
    await owner.mutation(api.work.cancelPlan, {
      workItemId: plain,
      reason: 'Not this week.',
    });
    expect(await cardsOf(harness, agentId)).toEqual([]);
    await owner.mutation(api.work.cancelPlan, {
      workItemId: applied,
      reason: 'Do not copy Priya on this one.',
    });
    expect(await cardsSaid(harness, agentId)).toEqual([
      {
        trigger: 'agreement-corrected',
        triggerSummary:
          'You corrected “Answer the tier-2 ask about the committee deck”, which followed a working agreement',
        risk: 'low',
        userId: OWNER_SUBJECT,
      },
    ]);
    const [card] = await cardsOf(harness, agentId);
    expect(card.affected.agreements).toEqual([agreement]);
    expect(card.evidence.correctionIds).toHaveLength(1);
  });
});

describe('the revocation rows (credential.revoked-at-source failed; organisation.connection-revoked)', (): void => {
  it('opens one card when Day0 could not end an employee’s access at the vendor, and none when it did', async (): Promise<void> => {
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
          credentialLanded: true,
          createdAt: 1,
        }),
    );
    const job = (credentialId: Id<'credentials'>) => ({
      agentId,
      surfaceId,
      surfaceName: 'Linear',
      credentialId,
      companionIds: [],
    });
    const credential = async (attempts: number): Promise<Id<'credentials'>> =>
      await harness.run(
        async (ctx) =>
          await ctx.db.insert('credentials', {
            userId: OWNER_SUBJECT,
            kind: 'oauth',
            label: 'Linear access token',
            source: 'oauth',
            issuedBy: { system: 'linear', grant: 'authorisation-code' },
            createdAt: 1,
            revokedAt: 1,
            sourceRevocation: { state: 'pending', attempts, at: 1, end: 'disconnect' },
          }),
      );
    const done = await credential(1);
    await harness.mutation(internal.sourceRevocation.recordAttempt, {
      job: job(done),
      attempt: 1,
      last: false,
      result: { kind: 'final', outcome: 'token-revoked' },
    });
    expect(await cardsOf(harness, agentId)).toEqual([]);
    const failed = await credential(3);
    await harness.mutation(internal.sourceRevocation.recordAttempt, {
      job: job(failed),
      attempt: 3,
      last: true,
      result: { kind: 'failure', permanent: false, words: 'Linear answered HTTP 503.' },
    });
    expect(await cardsSaid(harness, agentId)).toEqual([
      {
        trigger: 'revocation-failed',
        triggerSummary: 'Day0 could not end its Linear access at linear: Linear answered HTTP 503.',
        risk: 'low',
        userId: OWNER_SUBJECT,
      },
    ]);
  });

  it('opens one card on every employee whose card ran on a revoked organisation connection', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await seedEmployee(harness);
    const pip = await seedEmployee(harness, { name: 'Pip' });
    const nell = await seedEmployee(harness, { name: 'Nell' });
    const connectionId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('organisationConnections', {
          system: 'linear',
          displayName: 'Linear',
          kind: 'oauth-app',
          mode: 'shared',
          scopes: ['read', 'write'],
          registeredBy: { via: 'setup-cli', at: 1 },
          status: 'active',
          createdAt: 1,
        }),
    );
    for (const agentId of [mira, pip]) {
      await harness.run(
        async (ctx) =>
          await ctx.db.insert('surfaces', {
            agentId,
            slug: 'linear',
            displayName: 'Linear',
            class: 'kanban',
            verdict: 'connected',
            whereFound: [],
            credentialLanded: true,
            organisationConnectionId: connectionId,
            createdAt: 1,
          }),
      );
    }
    await harness.mutation(internal.organisationConnections.revokeFromSetup, {
      organisationConnectionId: connectionId,
      reason: 'the app was replaced',
    });
    const ledger = await harness.run(async (ctx) =>
      (await ctx.db.query('connectionEvents').collect()).filter(
        (line) => line.type === 'organisation.connection-revoked',
      ),
    );
    expect(ledger).toHaveLength(1);
    for (const agentId of [mira, pip]) {
      expect(await cardsSaid(harness, agentId)).toEqual([
        {
          trigger: 'connection-revoked',
          triggerSummary: "The organisation's Linear connection was revoked: the app was replaced",
          risk: 'low',
          userId: OWNER_SUBJECT,
        },
      ]);
      // The revocation's line on the connection's ledger is the card's evidence (17-O), and the
      // page is given the line to say in the record's words.
      const [card] = await cardsOf(harness, agentId);
      expect(card.evidence.connectionEventIds).toEqual([ledger[0]._id]);
      const [view] = await harness
        .withIdentity(OWNER)
        .query(api.reorientationDecisions.listForAgent, { agentId });
      expect(view.ledger.map((line) => [line._id, line.type])).toEqual([
        [ledger[0]._id, 'organisation.connection-revoked'],
      ]);
    }
    expect(await cardsOf(harness, nell)).toEqual([]);
    // The same line reported again opens nothing more: a card carries it by its ledger id.
    const { openCardsOnSurfaces } = await import('../../convex/reorientation');
    const surfaces = await harness.run(async (ctx) => await ctx.db.query('surfaces').collect());
    await harness.run(async (ctx) => {
      await openCardsOnSurfaces(
        ctx,
        surfaces.map((surface) => surface._id),
        {
          trigger: 'connection-revoked',
          triggerKey: 'a-second-report',
          summary: 'A second report of the same line',
          evidence: { connectionEventIds: [ledger[0]._id] },
        },
      );
    });
    const [joined] = await cardsOf(harness, mira);
    // A different key joins the day's card, and its ledger line is kept once.
    expect(joined.evidence.connectionEventIds).toEqual([ledger[0]._id]);
    await harness.run(async (ctx) => {
      await openCardsOnSurfaces(
        ctx,
        surfaces.map((surface) => surface._id),
        {
          trigger: 'connection-revoked',
          triggerKey: ledger[0]._id,
          summary: 'The line itself, reported again',
        },
      );
    });
    expect(
      (await eventTypesOfAgent(harness, mira)).filter((type) => type === 'reorientation.opened'),
    ).toHaveLength(2);
  });

  it('opens one card on every employee of the connection when its shared token could not be revoked', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await seedEmployee(harness);
    const connectionId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('organisationConnections', {
          system: 'linear',
          displayName: 'Linear',
          kind: 'oauth-app',
          mode: 'shared',
          scopes: ['read'],
          registeredBy: { via: 'setup-cli', at: 1 },
          status: 'revoked',
          revokedAt: 1,
          createdAt: 1,
        }),
    );
    const credentialId = await harness.run(async (ctx) => {
      await ctx.db.insert('surfaces', {
        agentId: mira,
        slug: 'linear',
        displayName: 'Linear',
        class: 'kanban',
        verdict: 'approved',
        whereFound: [],
        credentialLanded: false,
        organisationConnectionId: connectionId,
        createdAt: 1,
      });
      return await ctx.db.insert('credentials', {
        userId: OWNER_SUBJECT,
        kind: 'oauth',
        label: 'Linear shared token',
        source: 'oauth',
        createdAt: 1,
      });
    });
    await harness.mutation(internal.organisationSecrets.finishSharedRevocation, {
      organisationConnectionId: connectionId,
      credentialId,
      attempt: 3,
      outcome: 'failed',
      reason: 'Linear answered HTTP 503.',
    });
    expect(await cardsSaid(harness, mira)).toEqual([
      {
        trigger: 'revocation-failed',
        triggerSummary:
          "Day0 could not end the organisation's shared Linear token at linear: Linear answered HTTP 503.",
        risk: 'low',
        userId: OWNER_SUBJECT,
      },
    ]);
  });
});

describe('the counted rows: three refusals, skips or rejections', (): void => {
  it('opens one card on the third gate refusal of one scope in seven days, and none for two', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const refusedRun = async (index: number): Promise<void> => {
      const runId = await harness.run(
        async (ctx) =>
          await ctx.db.insert('events', {
            agentId,
            type: 'work.execution-claimed',
            payload: {},
            createdAt: 1,
          }),
      );
      const workItemId = await seedWork(harness, agentId, 'executing', {
        externalId: `REVOPS-${index}`,
        executionRunId: runId,
      });
      await harness.mutation(internal.workRuns.setCompleted, {
        workItemId,
        runId,
        output: {
          actions: [],
          applied: [
            { tool: 'mcp.call', ok: true, effect: 'landed', idempotencyKey: `k${index}` },
            {
              tool: 'linear.read',
              ok: true,
              held: true,
              reason:
                "dropped: Day0's gate refused this read before sending it: no grant (linear:read)",
            },
          ],
        },
      });
    };
    await refusedRun(1);
    await refusedRun(2);
    expect(await cardsOf(harness, agentId)).toEqual([]);
    await refusedRun(3);
    expect(await cardsSaid(harness, agentId)).toEqual([
      {
        trigger: 'repeated-refusal',
        // Counted by run since the second pass (a run refusing a scope twice is one refusal).
        triggerSummary: "Day0's gate refused its “linear:read” work in 3 runs in seven days",
        risk: 'low',
        userId: OWNER_SUBJECT,
      },
    ]);
    await refusedRun(4);
    expect(await cardsOf(harness, agentId)).toHaveLength(1);
  });

  it('counts refusals by run, joins a second scope once at its crossing, and restarts both counts after the card is decided (second pass M1)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    let index = 0;
    const refusedRun = async (scopes: readonly string[]): Promise<void> => {
      index += 1;
      const runId = await harness.run(
        async (ctx) =>
          await ctx.db.insert('events', {
            agentId,
            type: 'work.execution-claimed',
            payload: {},
            createdAt: 1,
          }),
      );
      const workItemId = await seedWork(harness, agentId, 'executing', {
        externalId: `REVOPS-${index}`,
        executionRunId: runId,
      });
      await harness.mutation(internal.workRuns.setCompleted, {
        workItemId,
        runId,
        output: {
          actions: [],
          applied: [
            { tool: 'mcp.call', ok: true, effect: 'landed', idempotencyKey: `k${index}` },
            ...scopes.map((scope) => ({
              tool: 'mcp.call',
              ok: true,
              held: true,
              reason: `dropped: Day0's gate refused this read before sending it: no grant (${scope})`,
            })),
          ],
        },
      });
    };
    const opened = async (): Promise<number> =>
      (await eventTypesOfAgent(harness, agentId)).filter((type) => type === 'reorientation.opened')
        .length;
    // One run refusing a scope three times is one refusal.
    await refusedRun(['linear:read', 'linear:read', 'linear:read']);
    expect(await cardsOf(harness, agentId)).toEqual([]);
    await refusedRun(['linear:read']);
    await refusedRun(['linear:read', 'notion:read']);
    const [card] = await cardsOf(harness, agentId);
    expect(card?.triggerKey).toBe('refusal:linear:read');
    expect(await opened()).toBe(1);
    // A fourth refusal of the scope the card carries writes nothing more.
    await refusedRun(['linear:read']);
    expect(await opened()).toBe(1);
    // A second scope reaches three the same day and joins, once.
    await refusedRun(['notion:read']);
    await refusedRun(['notion:read']);
    expect(await cardsOf(harness, agentId)).toHaveLength(1);
    expect(await opened()).toBe(2);
    await refusedRun(['notion:read']);
    expect(await opened()).toBe(2);
    // Dismissed: neither scope opens a card again until it repeats three more times.
    vi.setSystemTime(Date.now() + 60_000);
    await harness.run(
      async (ctx) => await ctx.db.patch(card!._id, { status: 'dismissed', decidedAt: Date.now() }),
    );
    vi.setSystemTime(Date.now() + 60_000);
    await refusedRun(['notion:read', 'linear:read']);
    await refusedRun(['notion:read']);
    expect(await cardsOf(harness, agentId)).toHaveLength(1);
    await refusedRun(['notion:read']);
    expect(await cardsOf(harness, agentId)).toHaveLength(2);
  });

  it('opens one card on the third out-of-scope skip under one willNotDo clause in thirty days', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const skip = async (index: number, clause: string): Promise<void> => {
      const workItemId = await seedWork(harness, agentId, 'discovered', {
        externalId: `REVOPS-${index}`,
      });
      await harness.mutation(internal.work.setVerdict, {
        workItemId,
        verdict: {
          decision: 'skip',
          reason: 'out-of-scope: the deck is not its to change',
          clause,
        },
      });
    };
    await skip(1, 'Change committee-deck numbers');
    await skip(2, 'Change committee-deck numbers');
    await skip(3, 'Answer billing disputes');
    expect(await cardsOf(harness, agentId)).toEqual([]);
    await skip(4, 'Change committee-deck numbers');
    expect(await cardsSaid(harness, agentId)).toEqual([
      {
        trigger: 'repeated-skip',
        triggerSummary:
          '3 items in thirty days were skipped as outside its role under “Change committee-deck numbers”',
        risk: 'medium',
        userId: OWNER_SUBJECT,
      },
    ]);
    expect((await cardsOf(harness, agentId))[0].affected.charterClauses).toEqual([
      { field: 'willNotDo', index: 0, text: 'Change committee-deck numbers' },
    ]);
  });

  it('keeps a dismissed skip card dismissed when a status flip re-admits the same skips and they are skipped again (W16-R37)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const clause = 'Change committee-deck numbers';
    const skip = async (workItemId: Id<'workItems'>): Promise<void> => {
      await harness.mutation(internal.work.setVerdict, {
        workItemId,
        verdict: {
          decision: 'skip',
          reason: 'out-of-scope: the deck is not its to change',
          clause,
        },
      });
    };
    const items: Id<'workItems'>[] = [];
    for (const index of [1, 2, 3]) {
      items.push(await seedWork(harness, agentId, 'discovered', { externalId: `REVOPS-${index}` }));
    }
    for (const workItemId of items) await skip(workItemId);
    const [card] = await cardsOf(harness, agentId);
    expect(card.trigger).toBe('repeated-skip');
    vi.setSystemTime(Date.now() + 60_000);
    await harness.run(
      async (ctx) => await ctx.db.patch(card._id, { status: 'dismissed', decidedAt: Date.now() }),
    );
    // Bed 3: a page superseded re-admits the out-of-scope skips, which the model skips again
    // under the same clause; the same three items are not three new skips.
    for (const round of [1, 2]) {
      vi.setSystemTime(Date.now() + 60_000);
      await harness.run(
        async (ctx) =>
          await reevaluatePendingInTransaction(ctx, {
            agentId,
            trigger: 'documentation',
            key: `documentation-status:source:runbooks/page-${round}.md:superseded`,
          }),
      );
      for (const workItemId of items) await skip(workItemId);
    }
    expect((await cardsOf(harness, agentId)).map((row) => [row._id, row.status])).toEqual([
      [card._id, 'dismissed'],
    ]);
    // A fourth item skipped under the clause is one new skip; three new ones open a card again.
    for (const index of [4, 5]) {
      await skip(await seedWork(harness, agentId, 'discovered', { externalId: `REVOPS-${index}` }));
    }
    expect(await cardsOf(harness, agentId)).toHaveLength(1);
    await skip(await seedWork(harness, agentId, 'discovered', { externalId: 'REVOPS-6' }));
    expect(await cardsOf(harness, agentId)).toHaveLength(2);
  });

  it('opens one card when the manager rejects a third plan in thirty days, and again only after a decided card', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const owner = harness.withIdentity(OWNER);
    const reject = async (index: number): Promise<void> => {
      const workItemId = await seedWork(harness, agentId, 'plan-pending', {
        externalId: `REVOPS-${index}`,
        plan: { steps: ['Reply'] },
      });
      await owner.mutation(api.work.cancelPlan, { workItemId, reason: 'Not like this.' });
    };
    await reject(1);
    await reject(2);
    expect(await cardsOf(harness, agentId)).toEqual([]);
    await reject(3);
    expect(await cardsSaid(harness, agentId)).toEqual([
      {
        trigger: 'repeated-rejection',
        triggerSummary: 'You rejected 3 of its plans in thirty days',
        risk: 'medium',
        userId: OWNER_SUBJECT,
      },
    ]);
    const [card] = await cardsOf(harness, agentId);
    // The manager decides the card a minute later; the clock is fake, so it is moved by hand.
    vi.setSystemTime(Date.now() + 60_000);
    await harness.run(
      async (ctx) => await ctx.db.patch(card._id, { status: 'dismissed', decidedAt: Date.now() }),
    );
    vi.setSystemTime(Date.now() + 60_000);
    await reject(4);
    expect(await cardsOf(harness, agentId)).toHaveLength(1);
  });
});

describe('the counted cards show their events to the judgement (W16-R4, D-4 (a))', (): void => {
  /** The will-not-do clause 16-J's three rejections quoted. */
  const CLAUSE = 'Send anything out without manager approval.';

  /** What the judgement reads of the employee's one card. */
  async function judgementEvidence(harness: Harness, agentId: Id<'agents'>): Promise<string[]> {
    const [card] = await cardsOf(harness, agentId);
    const read = await harness.query(internal.reorientation.proposalInput, {
      reorientationId: card._id,
    });
    if (read === null) throw new Error('the card is not open to the judgement');
    return [...read.input.evidence];
  }

  it('gives the rejections’ reasons, each by its item, so three quoting one clause can propose the amendment', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const owner = harness.withIdentity(OWNER);
    for (const index of [1, 2, 3]) {
      const workItemId = await seedWork(harness, agentId, 'plan-pending', {
        externalId: `REVOPS-${index}`,
        title: `Send the REVOPS-${index} close summary to the customer`,
        plan: { steps: ['Send it'] },
      });
      await owner.mutation(api.work.cancelPlan, {
        workItemId,
        reason: `It must not go out on its own: “${CLAUSE}” ${CORPUS_SLOTS.linear_token}`,
      });
    }
    const evidence = await judgementEvidence(harness, agentId);
    for (const index of [1, 2, 3]) {
      expect(evidence).toContainEqual(
        expect.stringContaining(
          `Plan rejected for “Send the REVOPS-${index} close summary to the customer”: It must not go out on its own: “${CLAUSE}”`,
        ),
      );
    }
    // The reasons pass the token scrub before they reach a prompt.
    expect(evidence.join('\n')).not.toContain(CORPUS_SLOTS.linear_token);
  });

  it('shows at most ten events of one type, and none of a type it does not count', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const workItemId = await seedWork(harness, agentId, 'cancelled', { title: 'Send it' });
    const eventIds = await harness.run(async (ctx) => {
      const ids: Id<'events'>[] = [];
      for (let index = 0; index < 12; index += 1) {
        ids.push(
          await ctx.db.insert('events', {
            agentId,
            type: 'work.cancelled',
            payload: { workItemId, reason: `reason ${index}`, decidedVia: 'dashboard' },
            createdAt: index,
          }),
        );
      }
      ids.push(
        await ctx.db.insert('events', {
          agentId,
          type: 'work.discovered',
          payload: { workItemId },
          createdAt: 12,
        }),
      );
      return ids;
    });
    await openTestCard(harness, {
      agentId,
      trigger: 'repeated-rejection',
      triggerKey: 'rejections',
      summary: 'You rejected 12 of its plans in thirty days',
      evidence: { eventIds },
    });
    const evidence = await judgementEvidence(harness, agentId);
    expect(evidence).toHaveLength(10);
    expect(evidence[9]).toBe('Plan rejected for “Send it”: reason 9');
  });

  it('gives the skips’ clause and reason, and a refusal’s withheld reasons', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    for (const index of [1, 2, 3]) {
      const workItemId = await seedWork(harness, agentId, 'discovered', {
        externalId: `REVOPS-${index}`,
        title: `Change the deck for REVOPS-${index}`,
      });
      await harness.mutation(internal.work.setVerdict, {
        workItemId,
        verdict: {
          decision: 'skip',
          reason: 'out-of-scope: the deck is not its to change',
          clause: 'Change committee-deck numbers',
        },
      });
    }
    const evidence = await judgementEvidence(harness, agentId);
    expect(evidence).toContainEqual(
      'Skipped “Change the deck for REVOPS-1” under “Change committee-deck numbers”: out-of-scope: the deck is not its to change',
    );
    expect(evidence.filter((line) => line.startsWith('Skipped '))).toHaveLength(3);

    const refused = convexTest(schema, allConvexModules());
    const refusedAgent = await seedEmployee(refused);
    for (const index of [1, 2, 3]) {
      const runId = await refused.run(
        async (ctx) =>
          await ctx.db.insert('events', {
            agentId: refusedAgent,
            type: 'work.execution-claimed',
            payload: {},
            createdAt: 1,
          }),
      );
      const workItemId = await seedWork(refused, refusedAgent, 'executing', {
        externalId: `REVOPS-${index}`,
        title: `Read REVOPS-${index}`,
        executionRunId: runId,
      });
      await refused.mutation(internal.workRuns.setCompleted, {
        workItemId,
        runId,
        output: {
          actions: [],
          applied: [
            { tool: 'mcp.call', ok: true, effect: 'landed', idempotencyKey: `k${index}` },
            {
              tool: 'linear.read',
              ok: true,
              held: true,
              reason:
                "dropped: Day0's gate refused this read before sending it: no grant (linear:read)",
            },
          ],
        },
      });
    }
    expect(await judgementEvidence(refused, refusedAgent)).toContainEqual(
      "Held in a run of “Read REVOPS-1”: dropped: Day0's gate refused this read before sending it: no grant (linear:read)",
    );
  });
});

describe('a writer that reaches many employees hands its cards over once (wave 17, 17-O; D-9 (a), O-2)', (): void => {
  /** Employees of the owner, each with one drafted plan. */
  async function employees(harness: Harness, count: number): Promise<Id<'agents'>[]> {
    const agents: Id<'agents'>[] = [];
    for (let at = 0; at < count; at += 1) {
      const agentId = await seedEmployee(harness, { name: `Employee ${at}` });
      await seedWork(harness, agentId, 'plan-pending', { externalId: `REVOPS-${at}` });
      agents.push(agentId);
    }
    return agents;
  }

  /** How many functions for cards the writer's transaction left, and how many employees have a card. */
  async function handedOver(
    harness: Harness,
    agents: readonly Id<'agents'>[],
  ): Promise<{ functions: number; single: number; withCard: number }> {
    const functions = (await scheduledAs(harness, 'reorientation:openCardsLater')).length;
    const single = (await scheduledAs(harness, 'reorientation:openCardLater')).length;
    await runCardChain(harness);
    let withCard = 0;
    for (const agentId of agents) {
      if ((await cardsOf(harness, agentId)).length === 1) withCard += 1;
    }
    return { functions, single, withCard };
  }

  it('an approver’s edge for everyone, edited over fifty-one employees: one function, a card on each', async (): Promise<void> => {
    const harness = convexTest({ schema, modules: allConvexModules(), transactionLimits: true });
    const agents = await employees(harness, 51);
    const ines = await seedPerson(harness, 'Ines Duarte');
    const edge = await harness.run(
      async (ctx) =>
        await ctx.db.insert('relationships', {
          userId: OWNER_SUBJECT,
          toPersonId: ines,
          type: 'approval-authority',
          scope: 'NetLedger journal changes',
          effectiveFrom: 1,
          status: 'active',
          source: 'manager',
          confirmedAt: 1,
          createdAt: 1,
        }),
    );
    await harness.withIdentity(OWNER).mutation(api.people.editRelationship, {
      relationshipId: edge,
      agentId: agents[0],
      type: 'approval-authority',
      scope: 'NetLedger journal changes and the Q3 close sign-off',
    });
    expect(await handedOver(harness, agents)).toEqual({ functions: 1, single: 0, withCard: 51 });
    // Each card holds its own employee's plan, read where the card opened.
    const cards = await harness.run(async (ctx) => await ctx.db.query('reorientations').collect());
    expect(cards.every((card) => card.risk === 'high' && card.blockingWork.length === 1)).toBe(
      true,
    );
  });

  it('a library version withdrawn from twelve holders: one function, a card on each', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agents = await employees(harness, 12);
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
          authorAgentId: agents[0],
          authorName: 'Employee 0',
          readRefs: [],
          verifiedAt: 1,
          createdAt: 1,
        }),
    );
    const skills: Id<'skills'>[] = [];
    for (const agentId of agents)
      skills.push(await registeredSkill(harness, agentId, { versionId }));
    await harness.withIdentity(OWNER).mutation(api.skillControls.withdraw, {
      skillId: skills[0],
      reason: 'it closes the wrong tickets',
    });
    expect(await handedOver(harness, agents)).toEqual({ functions: 1, single: 0, withCard: 12 });
  });

  it('an organisation’s connection revoked over twelve employees: one function, a card on each', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agents = await employees(harness, 12);
    const connectionId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('organisationConnections', {
          system: 'linear',
          displayName: 'Linear',
          kind: 'oauth-app',
          mode: 'shared',
          scopes: ['read', 'write'],
          registeredBy: { via: 'setup-cli', at: 1 },
          status: 'active',
          createdAt: 1,
        }),
    );
    for (const agentId of agents) {
      await harness.run(
        async (ctx) =>
          await ctx.db.insert('surfaces', {
            agentId,
            slug: 'linear',
            displayName: 'Linear',
            class: 'kanban',
            verdict: 'connected',
            whereFound: [],
            credentialLanded: true,
            organisationConnectionId: connectionId,
            createdAt: 1,
          }),
      );
    }
    await harness.mutation(internal.organisationConnections.revokeFromSetup, {
      organisationConnectionId: connectionId,
      reason: 'the app was replaced',
    });
    expect(await handedOver(harness, agents)).toEqual({ functions: 1, single: 0, withCard: 12 });
  });

  it('a person dismissed whose edges ten employees proposed: one function, a card on each', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agents = await employees(harness, 10);
    const nell = await harness.run(
      async (ctx) =>
        await ctx.db.insert('people', {
          userId: OWNER_SUBJECT,
          displayName: 'Nell',
          nameKey: 'nell',
          status: 'unverified',
          source: 'documentation',
          evidence: [],
          createdAt: 1,
          updatedAt: 1,
        }),
    );
    for (const agentId of agents) {
      await harness.run(
        async (ctx) =>
          await ctx.db.insert('relationships', {
            userId: OWNER_SUBJECT,
            fromAgentId: agentId,
            toPersonId: nell,
            type: 'escalation-contact',
            effectiveFrom: 1,
            status: 'proposed',
            source: 'documentation',
            createdAt: 1,
          }),
      );
    }
    await harness
      .withIdentity(OWNER)
      .mutation(api.people.dismiss, { personId: nell, agentId: agents[0] });
    expect(await handedOver(harness, agents)).toEqual({ functions: 1, single: 0, withCard: 10 });
  });

  it('ten skills of one employee stamped on a system whose connection changed: one card, joined, and nothing scheduled for cards', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const [agentId] = await employees(harness, 1);
    for (let at = 0; at < 10; at += 1) {
      await registeredSkill(harness, agentId, {
        name: `skill-${at}`,
        operation: `operation-${at}`,
      });
    }
    const stamped = await harness.run(
      async (ctx) =>
        await stampRecheckDueOnSurfaces(ctx, {
          agentId,
          slugs: ['linear'],
          reasonFor: () => 'its Linear connection changed',
          now: Date.UTC(2026, 9, 13, 9),
        }),
    );
    expect(stamped).toBe(10);
    // The first eight opened and joined in the writer's transaction; the last two ride one function.
    expect(await handedOver(harness, [agentId])).toEqual({ functions: 1, single: 0, withCard: 1 });
    const [card] = await cardsOf(harness, agentId);
    expect(card.evidence.skillIds).toHaveLength(10);
  });
});
