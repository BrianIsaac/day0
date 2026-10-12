import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { conflictsUnderPlan, decisionsOffered } from '../../convex/docConflicts';
import type { SelectionRequest } from '../../src/docs/select';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';
import {
  asManager,
  eventsOf,
  measure,
  relations,
  syncingSource,
  twoThatDisagree,
  type Harness,
} from './fakes/doc-relations';

// A decision that supersedes a page re-admits parked work, which schedules its next step.
beforeEach((): void => {
  vi.useFakeTimers();
});
afterEach((): void => {
  vi.useRealTimers();
});

describe('decisionsOffered: the answers a relation’s card offers as the relation stands', (): void => {
  it('offers a proposed version its three answers, and an answered one only "Undo"', (): void => {
    for (const kind of ['possible_duplicate', 'possible_successor'] as const) {
      expect(decisionsOffered({ kind, status: 'proposed' })).toEqual([
        'supersedes',
        'keep-both',
        'not-the-same',
      ]);
      expect(decisionsOffered({ kind, status: 'confirmed' })).toEqual(['undo']);
      expect(decisionsOffered({ kind, status: 'dismissed' })).toEqual(['undo']);
    }
  });

  it('offers no "They disagree" on a proposed conflict between pages not trusted alike', (): void => {
    const proposed = { kind: 'possible_conflict', status: 'proposed' } as const;
    expect(decisionsOffered(proposed)).toEqual([
      'disagree',
      'from-is-right',
      'to-is-right',
      'both-hold',
    ]);
    expect(decisionsOffered(proposed, false)).toEqual([
      'from-is-right',
      'to-is-right',
      'both-hold',
    ]);
  });

  it('keeps a confirmed conflict’s three answers, and offers a set-aside one only "Undo"', (): void => {
    expect(decisionsOffered({ kind: 'possible_conflict', status: 'confirmed' })).toEqual([
      'from-is-right',
      'to-is-right',
      'both-hold',
    ]);
    expect(decisionsOffered({ kind: 'possible_conflict', status: 'dismissed' })).toEqual(['undo']);
  });
});

describe('conflictsUnderPlan: the conflicts a drafted plan rests on (16-O; W15-R18)', (): void => {
  it('reads none from a plan with no cites and no recorded selection, or whose disputed cite names no stored relation', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const plans: unknown[] = [
      null,
      'a plan as text',
      { steps: [] },
      { cites: 'not a list' },
      { cites: [{}] },
      { cites: [{ conflict: { relationId: 'not-an-id', heading: 'Thresholds', pages: [] } }] },
    ];
    const agentId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name: 'Priya',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        }),
    );
    for (const plan of plans) {
      const conflicts = await harness.run(async (ctx) => {
        const workItemId = await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: 'REVOPS-1',
          title: 'Escalate the variance',
          contentSummary: 'Synthetic.',
          contentRefs: [],
          observedAt: 1,
          createdAt: 1,
          state: 'plan-pending',
          plan,
        });
        const row = await ctx.db.get(workItemId);
        const agent = await ctx.db.get(agentId);
        return row && agent ? await conflictsUnderPlan(ctx, row, agent) : null;
      });
      expect(conflicts, JSON.stringify(plan)).toEqual([]);
    }
  });
});

describe('a confirmed conflict in a selection and at a plan’s decision (the sixth hold reason; A-3)', (): void => {
  const request: SelectionRequest = {
    site: 'plan',
    title: 'Escalate the variance',
    summary: 'A variance above the threshold needs the finance lead.',
    roleFunction: 'Revenue operations coordination',
    writtenBrowserSurfaces: [],
  };

  afterEach((): void => {
    restoreSurfaceMode();
  });

  /** Two pages that disagree, mirrored for an employee with autonomous actions on, and the relation. */
  async function disagreement(harness: Harness) {
    const pages = await twoThatDisagree(harness);
    const agentId = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Priya',
        userId: 'owner',
        state: 'deployed',
        createdAt: 1,
        autonomousActions: true,
      });
      for (const page of await ctx.db.query('docPages').collect()) {
        await ctx.db.insert('mockDocs', {
          agentId,
          slug: `source-${page.ref.replace(/[^a-z0-9]+/gi, '-')}`,
          title: page.title,
          body: page.markdown,
          category: 'team-doc',
          sourceId: page.sourceId,
          sourceRef: page.ref,
          updatedAt: 3,
        });
      }
      // A third page, so the item's words tell pages apart.
      await ctx.db.insert('mockDocs', {
        agentId,
        slug: 'office-holidays',
        title: 'Office holidays',
        body: '# Office holidays\n\nClosed in August.',
        category: 'team-doc',
        updatedAt: 3,
      });
      return agentId;
    });
    await measure(harness, pages.finance, 'escalation.md');
    const relation = (await relations(harness)).find((row) => row.kind === 'possible_conflict')!;
    return { ...pages, agentId, relationId: relation._id };
  }

  /** The cite lines a plan-site selection prints for the employee. */
  async function selection(harness: Harness, agentId: Id<'agents'>) {
    const snapshot = await harness.query(internal.mock.snapshotInternal, {
      agentId,
      selection: request,
    });
    return {
      lines: snapshot.teamDocs.flatMap((doc) =>
        doc.body.split('\n').filter((line) => line.startsWith('[cite: ')),
      ),
      citations: snapshot.documentation?.citations ?? [],
    };
  }

  it('tags both pages’ cites [conflict] once the manager confirms it, and no cite before or after it is settled', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, relationId } = await disagreement(harness);
    // Proposed only: a measure tags nothing.
    expect((await selection(harness, agentId)).lines.join('\n')).not.toContain('[conflict]');
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId,
      decision: 'disagree',
    });
    const tagged = await selection(harness, agentId);
    expect(tagged.lines).toEqual(
      expect.arrayContaining([
        '[cite: Handbook/runbooks/pipeline-runbook.md#Pipeline runbook > Thresholds] [conflict]',
        '[cite: Finance wiki/escalation.md#Finance escalation > Thresholds] [conflict]',
      ]),
    );
    // Only the passages that disagree are tagged, and each carries what it disagrees with.
    expect(tagged.lines.filter((line) => line.endsWith('[conflict]'))).toHaveLength(2);
    const conflicts = tagged.citations.flatMap((citation) =>
      citation.conflict ? [citation.conflict] : [],
    );
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0]).toEqual({
      relationId,
      heading: 'Thresholds',
      pages: [
        { title: 'Finance escalation', source: 'Finance wiki' },
        { title: 'Pipeline runbook', source: 'Handbook' },
      ],
    });
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId,
      decision: 'both-hold',
    });
    expect((await selection(harness, agentId)).lines.join('\n')).not.toContain('[conflict]');
  });

  it('sees a confirmed conflict among any number of other confirmed relations, older or newer', async (): Promise<void> => {
    // The second pass's major 2: the selection read the owner's oldest 64 confirmed relations of
    // every kind, and every kept version and settled conflict stays confirmed for good, so past
    // 64 a newly confirmed conflict tagged no cite and held no plan; and its card, read newest
    // first, went the same way once 64 later answers stood above it.
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const kept = await syncingSource(harness, 'Kept versions');
    /** 65 relations the manager confirmed that are no conflict: two versions, both kept. */
    const keptVersions = async (from: number): Promise<void> =>
      await harness.run(async (ctx) => {
        for (let pair = from; pair < from + 65; pair += 1) {
          await ctx.db.insert('docRelations', {
            userId: 'owner',
            from: { sourceId: kept.sourceId, ref: `kept-${pair}-v2.md` },
            to: { sourceId: kept.sourceId, ref: `kept-${pair}.md` },
            kind: 'possible_duplicate',
            evidence: [{ measure: 'shared-text', value: 80 }],
            status: 'confirmed',
            decidedAt: 5,
            createdAt: 5,
          });
        }
      });
    await keptVersions(0);
    const { agentId, relationId } = await disagreement(harness);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId,
      decision: 'disagree',
    });
    await keptVersions(65);
    const { lines } = await selection(harness, agentId);
    expect(lines.filter((line) => line.endsWith('[conflict]')).sort()).toEqual([
      '[cite: Finance wiki/escalation.md#Finance escalation > Thresholds] [conflict]',
      '[cite: Handbook/runbooks/pipeline-runbook.md#Pipeline runbook > Thresholds] [conflict]',
    ]);
    expect(await asManager(harness).query(api.docRelations.listOpen, {})).toMatchObject([
      { _id: relationId, kind: 'possible_conflict', status: 'confirmed' },
    ]);
  });

  /** A plan-pending item of the employee's, with the plan given. */
  async function planned(
    harness: Harness,
    agentId: Id<'agents'>,
    plan: Record<string, unknown>,
  ): Promise<Id<'workItems'>> {
    return await harness.run(
      async (ctx) =>
        await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: 'REVOPS-12',
          title: 'Escalate the variance',
          contentSummary: 'A variance above the threshold needs the finance lead.',
          contentRefs: [],
          observedAt: 1,
          createdAt: 1,
          state: 'plan-pending',
          plan: {
            summary: 'Escalate the variance to the finance lead.',
            steps: ['Message the finance lead when the variance passes the threshold'],
            expectedOutputType: 'slack-reply',
            riskNotes: '',
            reversibility: 'A message.',
            estimatedMinutes: 5,
            ...plan,
          },
        }),
    );
  }

  /** The questions asked beside an item's plan. */
  async function questionsOf(harness: Harness, workItemId: Id<'workItems'>) {
    return await harness.run(async (ctx) =>
      (await ctx.db.query('managerQuestions').collect()).filter(
        (question) => question.workItemId === workItemId,
      ),
    );
  }

  const ASKED =
    'Two pages disagree under “Thresholds”: Finance escalation (Finance wiki) and Pipeline runbook (Handbook). Which is right? Priya runs the other steps now and holds the ones that rely on this until you answer.';

  it('asks one non-blocking question beside a plan that cites the disputed passage, and lets the plan go on (D-4 (c), RM20 (a))', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, relationId } = await disagreement(harness);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId,
      decision: 'disagree',
    });
    const { citations } = await selection(harness, agentId);
    const disputed = citations.find((citation) => citation.conflict !== undefined)!;
    await harness.run(async (ctx) => {
      await ctx.db.insert('charters', {
        agentId,
        version: '0.1',
        body: { proposedFunction: 'Revenue operations coordination' },
        approved: true,
        approvedAt: 1,
        createdAt: 1,
      });
    });
    const workItemId = await planned(harness, agentId, { cites: [{ step: 1, ...disputed }] });
    expect(await harness.mutation(internal.work.decidePlan, { workItemId })).toEqual({
      approved: true,
    });
    expect(await questionsOf(harness, workItemId)).toEqual([
      expect.objectContaining({
        question: ASKED,
        blocking: false,
        type: 'retrieval',
        relationId,
        workItemId,
      }),
    ]);
    expect(await eventsOf(harness, agentId, 'work.plan-held')).toEqual([]);
    expect(await eventsOf(harness, agentId, 'manager.question-asked')).toEqual([
      expect.objectContaining({ question: ASKED, type: 'retrieval', blocking: false, relationId }),
    ]);
    // Asked once: the sweep's next look asks nothing more.
    await harness.mutation(internal.work.decidePlan, { workItemId, recovery: true });
    expect(await questionsOf(harness, workItemId)).toHaveLength(1);
  });

  it('asks from the recorded selection when the plan cites nothing (W15-R18, the first input)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, relationId } = await disagreement(harness);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId,
      decision: 'disagree',
    });
    const { citations } = await selection(harness, agentId);
    const disputed = citations.find((citation) => citation.conflict !== undefined)!;
    await harness.run(async (ctx) => {
      await ctx.db.insert('charters', {
        agentId,
        version: '0.1',
        body: { proposedFunction: 'Revenue operations coordination' },
        approved: true,
        approvedAt: 1,
        createdAt: 1,
      });
    });
    const workItemId = await planned(harness, agentId, {});
    await harness.run(async (ctx) => {
      await ctx.db.insert('events', {
        agentId,
        type: 'work.documentation-selected',
        payload: {
          workItemId,
          site: 'plan',
          blockIds: disputed.blocks.map((block) => block.id),
          chars: 100,
        },
        createdAt: 2,
      });
    });
    await harness.mutation(internal.work.decidePlan, { workItemId });
    expect(await questionsOf(harness, workItemId)).toEqual([
      expect.objectContaining({ question: ASKED, relationId }),
    ]);
  });

  it('asks about every conflict between pages the employee reads when the plan read the whole mirror (W15-R18, the third input)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, relationId } = await disagreement(harness);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId,
      decision: 'disagree',
    });
    await harness.run(async (ctx) => {
      await ctx.db.insert('charters', {
        agentId,
        version: '0.1',
        body: { proposedFunction: 'Revenue operations coordination' },
        approved: true,
        approvedAt: 1,
        createdAt: 1,
      });
    });
    const workItemId = await planned(harness, agentId, {});
    await harness.run(async (ctx) => {
      await ctx.db.insert('events', {
        agentId,
        type: 'work.documentation-selection-failed',
        payload: { workItemId, site: 'plan', reason: 'the library is past its reads' },
        createdAt: 2,
      });
    });
    await harness.mutation(internal.work.decidePlan, { workItemId });
    expect(await questionsOf(harness, workItemId)).toEqual([
      expect.objectContaining({ question: ASKED, relationId }),
    ]);
  });

  it('asks beside a drafted plan citing either page once the manager confirms the conflict after it (section 3’s conflict row)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, relationId } = await disagreement(harness);
    await harness.run(async (ctx) => {
      await ctx.db.insert('charters', {
        agentId,
        version: '0.1',
        body: { proposedFunction: 'Revenue operations coordination' },
        approved: true,
        approvedAt: 1,
        createdAt: 1,
      });
    });
    const relation = (await relations(harness)).find((row) => row._id === relationId)!;
    const workItemId = await planned(harness, agentId, {
      cites: [
        {
          step: 1,
          label: 'Finance wiki/escalation.md#Finance escalation > Thresholds',
          sourceId: relation.from.sourceId,
          pageRef: relation.from.ref,
          blocks: [],
        },
      ],
    });
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId,
      decision: 'disagree',
    });
    expect(await questionsOf(harness, workItemId)).toEqual([
      expect.objectContaining({ question: ASKED, relationId, blocking: false }),
    ]);
  });

  /** Ask the question beside a plan citing the disputed passage, sent as a Slack request. */
  async function askedInRequest(harness: Harness) {
    const { agentId, relationId, ...pages } = await disagreement(harness);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId,
      decision: 'disagree',
    });
    const { citations } = await selection(harness, agentId);
    const disputed = citations.find((citation) => citation.conflict !== undefined)!;
    const surfaceId = await harness.run(async (ctx) => {
      await ctx.db.insert('charters', {
        agentId,
        version: '0.1',
        body: { proposedFunction: 'Revenue operations coordination' },
        approved: true,
        approvedAt: 1,
        createdAt: 1,
      });
      return await ctx.db.insert('surfaces', {
        agentId,
        slug: 'team-chat',
        displayName: 'Team chat',
        class: 'chat',
        verdict: 'connected',
        whereFound: [],
        managerDmChannelId: 'D0MANAGER',
        managerUserId: 'UMANAGER',
        providerIdentityId: 'U0DAY0BOT',
        credentialLanded: true,
        createdAt: 1,
      });
    });
    const workItemId = await planned(harness, agentId, { cites: [{ step: 1, ...disputed }] });
    await harness.mutation(internal.work.decidePlan, { workItemId });
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        decision: {
          id: 'ab3xyz',
          kind: 'plan',
          requestedAt: 1,
          channel: 'D0MANAGER',
          surfaceSlug: 'team-chat',
          surfaceName: 'Team chat',
          ts: '1787770800.000100',
        },
      });
    });
    return { agentId, relationId, surfaceId, workItemId, pages };
  }

  it('decides the relation from the answer in the plan’s Slack request, after the approval too (RM20 (a))', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const harness = convexTest(schema, allConvexModules());
    const { relationId, surfaceId, workItemId } = await askedInRequest(harness);
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs: '1790000000.000100',
        reply: { verb: 'answer', id: 'ab3xyz', choice: 'to' },
      }),
    ).resolves.toMatchObject({ status: 'answered', notified: true });
    const relation = (await relations(harness)).find((row) => row._id === relationId)!;
    expect(relation.status).toBe('confirmed');
    const pages = await harness.run(async (ctx) => await ctx.db.query('docPages').collect());
    expect(pages.find((page) => page.title === 'Finance escalation')?.status).toBe('superseded');
    expect(await questionsOf(harness, workItemId)).toEqual([
      expect.objectContaining({
        answer: expect.objectContaining({ text: 'Pipeline runbook is right', via: 'slack' }),
      }),
    ]);
    // A second answer finds nothing waiting, and says so.
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs: '1790000001.000100',
        reply: { verb: 'answer', id: 'ab3xyz', choice: 'from' },
      }),
    ).resolves.toMatchObject({ status: 'ignored', reason: 'no open question' });
  });

  it('closes the question when the conflict is settled on the Documentation tab, so nothing waits on it (second pass B1)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { relationId, workItemId } = await askedInRequest(harness);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId,
      decision: 'both-hold',
    });
    const [question] = await questionsOf(harness, workItemId);
    expect(question.answer).toMatchObject({ text: 'Both hold', via: 'dashboard' });
    expect(await harness.query(internal.managerQuestions.conflictHoldsFor, { workItemId })).toEqual(
      [],
    );
  });

  it('opens no card about the page its own answer superseded (second pass M4)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, relationId, workItemId } = await askedInRequest(harness);
    const [question] = await questionsOf(harness, workItemId);
    // The answer that supersedes the very page the plan cites.
    const relation = (await relations(harness)).find((row) => row._id === relationId)!;
    const cited = await harness.run(
      async (ctx) =>
        ((await ctx.db.get(workItemId))?.plan as { cites: Array<{ pageRef?: string }> }).cites[0]
          .pageRef,
    );
    await asManager(harness).mutation(api.managerQuestions.answerConflict, {
      questionId: question._id,
      choice: relation.from.ref === cited ? 'to' : 'from',
    });
    const pages = await harness.run(async (ctx) => await ctx.db.query('docPages').collect());
    expect(pages.find((page) => page.ref === cited)?.status).toBe('superseded');
    const cards = await harness.run(async (ctx) =>
      (await ctx.db.query('reorientations').collect()).filter((card) => card.agentId === agentId),
    );
    expect(cards).toEqual([]);
  });

  it('decides the relation from the answer on the plan’s card, and refuses a second answer', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, relationId, workItemId } = await askedInRequest(harness);
    const [question] = await questionsOf(harness, workItemId);
    expect(
      await asManager(harness).query(api.managerQuestions.conflictsForAgent, { agentId }),
    ).toEqual([
      {
        _id: question._id,
        workItemId,
        question: ASKED,
        pages: [
          { title: 'Finance escalation', source: 'Finance wiki' },
          { title: 'Pipeline runbook', source: 'Handbook' },
        ],
      },
    ]);
    await expect(
      asManager(harness).mutation(api.managerQuestions.answerConflict, {
        questionId: question._id,
        choice: 'both',
      }),
    ).resolves.toEqual({ text: 'Both hold' });
    expect((await relations(harness)).find((row) => row._id === relationId)?.status).toBe(
      'dismissed',
    );
    await expect(
      asManager(harness).mutation(api.managerQuestions.answerConflict, {
        questionId: question._id,
        choice: 'from',
      }),
    ).rejects.toThrow('That question has already been answered.');
    expect(
      await asManager(harness).query(api.managerQuestions.conflictsForAgent, { agentId }),
    ).toEqual([]);
  });

  it('holds nothing for a plan that cites other passages of the same pages', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, relationId } = await disagreement(harness);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId,
      decision: 'disagree',
    });
    const workItemId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: 'REVOPS-13',
          title: 'Refresh the tile',
          contentSummary: 'The tile is stale.',
          contentRefs: [],
          observedAt: 1,
          createdAt: 1,
          state: 'plan-pending',
          plan: {
            summary: 'Refresh the tile.',
            steps: ['Press Refresh'],
            expectedOutputType: 'ticket-update',
            riskNotes: '',
            reversibility: 'Nothing is written.',
            estimatedMinutes: 5,
            cites: [
              {
                step: 1,
                label: 'Handbook/runbooks/pipeline-runbook.md#Pipeline runbook > Refresh',
                blocks: [],
              },
            ],
          },
        }),
    );
    expect(await harness.mutation(internal.work.decidePlan, { workItemId })).toEqual({
      approved: true,
    });
  });
});
