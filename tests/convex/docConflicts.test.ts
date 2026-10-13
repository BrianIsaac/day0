import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { conflictsUnderPlan, decisionsOffered } from '../../convex/docConflicts';
import type { SelectionRequest } from '../../src/docs/select';
import { openQuestionStopReason } from '../../src/work/obligations';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';
import { fieldsOf } from './fakes/reorientation';
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

  // Re-pinned by W16-R10: these plans declare no writes, so the hold withholds every write and
  // the question says so.
  const ASKED =
    'Two pages disagree under “Thresholds”: A, Finance escalation (Finance wiki), and B, Pipeline runbook (Handbook). Which is right? Priya holds every write of the plan until you answer and Retry.';

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

  it('names the surfaces whose writes the question holds, by their names, where the plan declares them (W16-R10)', async (): Promise<void> => {
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
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'finance-tracker',
        displayName: 'Finance tracker',
        class: 'kanban',
        verdict: 'connected',
        whereFound: [],
        credentialLanded: true,
        createdAt: 1,
      });
    });
    const workItemId = await planned(harness, agentId, {
      steps: ['Read the variance', 'Comment the threshold on the ticket'],
      cites: [{ step: 2, ...disputed }],
      obligations: {
        steps: [
          { kind: 'read', reads: ['finance-tracker'], writes: [] },
          { kind: 'write', reads: [], writes: ['finance-tracker'] },
        ],
        transition: 'none',
        transitionStep: null,
        basis: 'judgement',
      },
    });
    await harness.mutation(internal.work.decidePlan, { workItemId });
    const [question] = await questionsOf(harness, workItemId);
    expect(question.question).toBe(
      'Two pages disagree under “Thresholds”: A, Finance escalation (Finance wiki), and B, Pipeline runbook (Handbook). Which is right? Priya runs the other steps now and holds its writes to Finance tracker until you answer and Retry.',
    );
  });

  it('asks from the selection kept on the item, with no selection record left to read (the joins: W15-R17 beside W15-R18)', async (): Promise<void> => {
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
    // What `docSelection.recordPlanSelection` keeps at the plan's selection (16-FD), and no
    // `work.documentation-selected` record among the employee's newest that names the item.
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        selectedBlocks: disputed.blocks.map((block) => ({
          id: block.id as Id<'docBlocks'>,
          hash: block.hash!,
        })),
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

  it('reads the whole mirror when a redraft’s selection failed after an earlier draft’s was kept (W16-R11, probes P2 and P3)', async (): Promise<void> => {
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
    // The first draft was selected from the third page alone; the redraft's selection failed, so
    // its planner read the whole mirror, both disputed pages among it.
    const holidays = await harness.run(
      async (ctx) =>
        (await ctx.db.query('docBlocks').collect()).find((block) =>
          block.pageRef.includes('holiday'),
        ) ?? null,
    );
    await harness.run(async (ctx) => {
      await ctx.db.insert('events', {
        agentId,
        type: 'work.documentation-selected',
        payload: {
          workItemId,
          site: 'plan',
          blockIds: holidays === null ? [] : [holidays._id],
          chars: 10,
        },
        createdAt: 2,
      });
      await ctx.db.insert('events', {
        agentId,
        type: 'work.documentation-selection-failed',
        payload: { workItemId, site: 'plan', reason: 'the library is past its reads' },
        createdAt: 3,
      });
      // The failure clears the kept list as it is recorded (`recordPlanSelection` with none).
      await ctx.db.patch(workItemId, { selectedBlocks: [] });
    });
    await harness.mutation(internal.work.decidePlan, { workItemId });
    expect(await questionsOf(harness, workItemId)).toEqual([
      expect.objectContaining({ question: ASKED, relationId }),
    ]);
  });

  it('asks beside a plan whose cite of the disputed passage carries no tag, the conflict confirmed after it was drafted (the second pass’s minor)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, relationId } = await disagreement(harness);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId,
      decision: 'disagree',
    });
    // The planner drafted from the passage before the conflict was confirmed: its cite has no tag.
    const { citations } = await selection(harness, agentId);
    const untagged = citations.find((citation) => citation.conflict !== undefined)!;
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
    const cite = Object.fromEntries(Object.entries(untagged).filter(([key]) => key !== 'conflict'));
    const workItemId = await planned(harness, agentId, { cites: [{ step: 1, ...cite }] });
    await harness.mutation(internal.work.decidePlan, { workItemId });
    expect(await questionsOf(harness, workItemId)).toEqual([
      expect.objectContaining({ question: ASKED, relationId }),
    ]);
  });

  it('finds a conflict confirmed since approval under a plan that read the whole mirror (the second pass’s D-4 (b) minor)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, relationId } = await disagreement(harness);
    const workItemId = await planned(harness, agentId, {});
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, { state: 'plan-approved' });
      await ctx.db.insert('events', {
        agentId,
        type: 'work.documentation-selection-failed',
        payload: { workItemId, site: 'plan', reason: 'the library is past its reads' },
        createdAt: 2,
      });
    });
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId,
      decision: 'disagree',
    });
    expect(
      await harness.query(internal.managerQuestions.conflictConfirmedSince, { workItemId }),
    ).toMatchObject({ heading: 'Thresholds' });
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
    // The plan cites the passage under the heading the pages disagree on, as a planner's cite
    // carries its blocks; since W16-R9 the confirmation asks the plans whose own decision would.
    const label = 'Finance wiki/escalation.md#Finance escalation > Thresholds';
    const { citations } = await selection(harness, agentId);
    const cited = citations.find((citation) => citation.label === label)!;
    const workItemId = await planned(harness, agentId, {
      cites: [
        {
          step: 1,
          label,
          sourceId: relation.from.sourceId,
          pageRef: relation.from.ref,
          blocks: cited.blocks.map((block) => ({ id: block.id, hash: block.hash! })),
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

  it('asks beside a pending plan that cites nothing, from its kept selection, once the manager confirms the conflict after it (W16-R9)', async (): Promise<void> => {
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
    // Drafted from a selection holding both pages, before the conflict was confirmed: no cites.
    const { citations } = await selection(harness, agentId);
    const workItemId = await planned(harness, agentId, {});
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        selectedBlocks: citations.flatMap((citation) =>
          citation.blocks.map((block) => ({ id: block.id as Id<'docBlocks'>, hash: block.hash! })),
        ),
      });
    });
    expect((await harness.run(async (ctx) => await ctx.db.get(workItemId)))?.state).toBe(
      'plan-pending',
    );
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
        answer: expect.objectContaining({
          text: 'B, Pipeline runbook (Handbook) is right',
          via: 'slack',
        }),
      }),
    ]);
    // The acknowledgement says what Retry does with the steps that waited (the second pass's m7).
    const [notice] = await harness.run(
      async (ctx) => await ctx.db.query('managerDecisionNotices').collect(),
    );
    expect(notice.text).toBe(
      'Recorded: B, Pipeline runbook (Handbook) is right. Retry runs the steps that waited on it, drafted again where they relied on the other page.',
    );
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

  it('closes another plan’s question on the same conflict as answered where the answer came from (the walk’s W-4)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const harness = convexTest(schema, allConvexModules());
    const { relationId, surfaceId, workItemId } = await askedInRequest(harness);
    const [first] = await questionsOf(harness, workItemId);
    const other = await harness.run(async (ctx) => {
      const row = await ctx.db.get(workItemId);
      const otherItem = await ctx.db.insert('workItems', {
        ...fieldsOf(row!),
        decision: undefined,
        externalId: 'REVOPS-13',
      });
      return await ctx.db.insert('managerQuestions', {
        agentId: first.agentId,
        key: first.key,
        question: first.question,
        context: first.context,
        askedAt: first.askedAt,
        workItemId: otherItem,
        charterId: first.charterId,
        blocking: false,
        type: 'retrieval',
        relationId,
      });
    });
    await harness.mutation(internal.work.resolveChannelDecision, {
      surfaceId,
      userId: 'UMANAGER',
      messageTs: '1790000000.000100',
      reply: { verb: 'answer', id: 'ab3xyz', choice: 'to' },
    });
    expect((await harness.run(async (ctx) => await ctx.db.get(other)))?.answer).toMatchObject({
      text: 'B, Pipeline runbook (Handbook) is right',
      via: 'slack',
    });
  });

  it('drafts the plan again on the first Retry once the answer superseded a page it cites (W16-R25, W3h)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const harness = convexTest(schema, allConvexModules());
    const { relationId, workItemId } = await askedInRequest(harness);
    const item = await harness.run(async (ctx) => await ctx.db.get(workItemId));
    const [cite] = (item!.plan as { cites: Array<{ sourceId?: string; pageRef?: string }> }).cites;
    const relation = (await relations(harness)).find((row) => row._id === relationId)!;
    const citesFrom =
      cite.sourceId === relation.from.sourceId && cite.pageRef === relation.from.ref;
    const [question] = await questionsOf(harness, workItemId);
    // The run stopped at the hold with the conflict's question open (16-J's REVOPS-5).
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        state: 'failed',
        skipReason: `stopped: ${openQuestionStopReason({ question: question.question, steps: [1] })}`,
        output: {
          draft: '',
          notes: '',
          actions: [],
          applied: [],
          openQuestion: { question: question.question, steps: [1], relationId },
        },
      });
    });
    // The manager says the other page is right, so the page the plan cites is superseded.
    await asManager(harness).mutation(api.managerQuestions.answerConflict, {
      questionId: question._id,
      choice: citesFrom ? 'to' : 'from',
    });
    await expect(
      asManager(harness).mutation(api.workRuns.retryFailed, { workItemId }),
    ).resolves.toEqual({ ok: true, resumeState: 'discovered' });
    const retried = await harness.run(async (ctx) => await ctx.db.get(workItemId));
    expect(retried?.plan).toBeUndefined();
    expect(await eventsOf(harness, retried!.agentId, 'work.plan-redraft')).toHaveLength(1);
  });

  it('drafts a plan that cites nothing again on the first Retry too, once the answer superseded a page of its question (the second pass)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await askedInRequest(harness);
    const [question] = await questionsOf(harness, workItemId);
    // The plan cites nothing: the hold covered every step, and the question was asked from its
    // selection, which holds both disputed pages.
    await harness.run(async (ctx) => {
      const row = await ctx.db.get(workItemId);
      await ctx.db.patch(workItemId, {
        state: 'failed',
        plan: { ...(row!.plan as object), cites: [] },
        skipReason: `stopped: ${openQuestionStopReason({ question: question.question, steps: [1] })}`,
        output: {
          draft: '',
          notes: '',
          actions: [],
          applied: [],
          openQuestion: {
            question: question.question,
            steps: [1],
            relationId: question.relationId,
          },
        },
      });
    });
    await asManager(harness).mutation(api.managerQuestions.answerConflict, {
      questionId: question._id,
      choice: 'from',
    });
    await expect(
      asManager(harness).mutation(api.workRuns.retryFailed, { workItemId }),
    ).resolves.toEqual({ ok: true, resumeState: 'discovered' });
  });

  it('keeps reading the DM while a question waits, however long ago its plan was approved (the second pass’s M1)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId, workItemId } = await askedInRequest(harness);
    // The manager approved the plan two hours ago; the question beside it is still open.
    await harness.run(async (ctx) => {
      const row = await ctx.db.get(workItemId);
      await ctx.db.patch(workItemId, {
        state: 'plan-approved',
        decision: { ...row!.decision!, decidedAt: Date.now() - 2 * 60 * 60 * 1000 },
      });
    });
    expect((await harness.query(internal.work.openDecisions, { surfaceId })).noticeOwed).toBe(true);
  });

  it('answers a code a redraft replaced with the replaced notice, not as unknown (the second pass’s M1)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const harness = convexTest(schema, allConvexModules());
    const { agentId, surfaceId, workItemId } = await askedInRequest(harness);
    await harness.run(async (ctx) => {
      const row = await ctx.db.get(workItemId);
      await ctx.db.insert('replacedDecisionRequests', {
        agentId,
        workItemId,
        decisionId: 'ab3xyz',
        replacedBy: 'cd4xyz',
        kind: 'plan',
        surfaceSlug: 'team-chat',
        channel: 'D0MANAGER',
        ts: row!.decision!.ts,
        replacedAt: Date.now(),
      });
      await ctx.db.patch(workItemId, { decision: { ...row!.decision!, id: 'cd4xyz' } });
    });
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs: '1790000000.000100',
        reply: { verb: 'answer', id: 'ab3xyz', choice: 'to' },
      }),
    ).resolves.toMatchObject({ status: 'replaced', replacedBy: 'cd4xyz' });
  });

  it('answers the first question whose conflict still stands, passing over one that no longer does (the second pass’s m3)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const harness = convexTest(schema, allConvexModules());
    const { relationId, surfaceId, workItemId } = await askedInRequest(harness);
    const [stale] = await questionsOf(harness, workItemId);
    // A second conflict on the same pages stands; the first question's relation no longer does.
    const live = await harness.run(async (ctx) => {
      const relation = await ctx.db.get(relationId);
      const liveRelation = await ctx.db.insert('docRelations', fieldsOf(relation!));
      await ctx.db.patch(relationId, { status: 'proposed' });
      return await ctx.db.insert('managerQuestions', {
        agentId: stale.agentId,
        key: `conflict:${liveRelation}`,
        question: stale.question,
        context: stale.context,
        askedAt: stale.askedAt + 1,
        workItemId,
        charterId: stale.charterId,
        blocking: false,
        type: 'retrieval',
        relationId: liveRelation,
      });
    });
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs: '1790000000.000100',
        reply: { verb: 'answer', id: 'ab3xyz', choice: 'to' },
      }),
    ).resolves.toMatchObject({ status: 'answered' });
    expect((await harness.run(async (ctx) => await ctx.db.get(live)))?.answer).toMatchObject({
      text: 'B, Pipeline runbook (Handbook) is right',
    });
    expect((await harness.run(async (ctx) => await ctx.db.get(stale._id)))?.answer).toBeUndefined();
  });

  it('answers a reply once, so a poll that delivers it again answers no second question (the second pass’s minor)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const harness = convexTest(schema, allConvexModules());
    const { relationId, surfaceId, workItemId } = await askedInRequest(harness);
    const reply = {
      surfaceId,
      userId: 'UMANAGER',
      messageTs: '1790000000.000100',
      reply: { verb: 'answer' as const, id: 'ab3xyz', choice: 'to' as const },
    };
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, reply),
    ).resolves.toMatchObject({ status: 'answered' });
    // A second conflict asked beside the same plan meanwhile.
    const [first] = await questionsOf(harness, workItemId);
    const second = await harness.run(
      async (ctx) =>
        await ctx.db.insert('managerQuestions', {
          agentId: first.agentId,
          key: 'conflict:another',
          question: 'Two pages disagree under “Owners”.',
          context: first.context,
          askedAt: first.askedAt,
          workItemId,
          charterId: first.charterId,
          blocking: false,
          type: 'retrieval',
          relationId,
        }),
    );
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, reply),
    ).resolves.toMatchObject({ status: 'ignored', reason: 'already answered' });
    expect((await harness.run(async (ctx) => await ctx.db.get(second)))?.answer).toBeUndefined();
  });

  /** A second conflict between the same two pages, standing, and its question beside the plan. */
  async function secondQuestion(
    harness: Harness,
    asked: { relationId: Id<'docRelations'>; workItemId: Id<'workItems'> },
  ) {
    const [first] = await questionsOf(harness, asked.workItemId);
    return await harness.run(async (ctx) => {
      const relation = await ctx.db.get(asked.relationId);
      const relationId = await ctx.db.insert('docRelations', fieldsOf(relation!));
      const questionId = await ctx.db.insert('managerQuestions', {
        agentId: first.agentId,
        key: `conflict:${relationId}`,
        question: first.question,
        context: { ...first.context, text: 'Owners' },
        askedAt: first.askedAt + 1,
        workItemId: asked.workItemId,
        charterId: first.charterId,
        blocking: false,
        type: 'retrieval',
        relationId,
      });
      return { relationId, questionId };
    });
  }

  /** The acknowledgements queued for the manager's replies, oldest first. */
  async function noticeTexts(harness: Harness): Promise<string[]> {
    return await harness.run(async (ctx) =>
      (await ctx.db.query('managerDecisionNotices').collect()).map((notice) => notice.text),
    );
  }

  it('decides the second question from “answer {code} 2 B”, and nothing from a bare answer while two stand (17-C; W16-R27)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const harness = convexTest(schema, allConvexModules());
    const asked = await askedInRequest(harness);
    const { surfaceId, workItemId } = asked;
    const second = await secondQuestion(harness, asked);
    const reply = (messageTs: string, answer: { choice: 'from' | 'to'; number?: number }) =>
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs,
        reply: { verb: 'answer', id: 'ab3xyz', ...answer },
      });
    // Bare, with two standing: which one is asked, and nothing is decided.
    await expect(reply('1790000000.000100', { choice: 'to' })).resolves.toMatchObject({
      status: 'ignored',
      reason: 'several questions open',
      notified: true,
    });
    expect(await noticeTexts(harness)).toEqual([
      'Which one? This plan has 2 questions open: answer with its number, for example “answer ab3xyz 2 B”. They are: 1, under “Thresholds”; 2, under “Owners”.',
    ]);
    expect((await questionsOf(harness, workItemId)).map((question) => question.answer)).toEqual([
      undefined,
      undefined,
    ]);
    const pages = async () =>
      await harness.run(async (ctx) => await ctx.db.query('docPages').collect());
    expect((await pages()).every((page) => page.status === undefined)).toBe(true);
    // A number that names no question of the plan decides nothing either.
    await expect(reply('1790000001.000100', { choice: 'to', number: 5 })).resolves.toMatchObject({
      status: 'ignored',
      reason: 'no such question',
    });
    // By its number: the second question is the one decided, in the manager's name.
    await expect(reply('1790000002.000100', { choice: 'to', number: 2 })).resolves.toMatchObject({
      status: 'answered',
      notified: true,
    });
    const [first, answered] = await questionsOf(harness, workItemId);
    expect(answered).toMatchObject({
      _id: second.questionId,
      answer: { text: 'B, Pipeline runbook (Handbook) is right', via: 'slack' },
    });
    expect(first.answer).toBeUndefined();
    expect((await pages()).find((page) => page.title === 'Finance escalation')?.status).toBe(
      'superseded',
    );
    expect((await noticeTexts(harness)).slice(1)).toEqual([
      'This plan has no question 5: its questions are numbered 1 to 2.',
      'Recorded for question 2: B, Pipeline runbook (Handbook) is right. Retry runs the steps that waited on it, drafted again where they relied on the other page.',
    ]);
    // The answered question's number still names it, and says what it was answered.
    await expect(reply('1790000003.000100', { choice: 'from', number: 2 })).resolves.toMatchObject({
      status: 'ignored',
      reason: 'question no longer open',
    });
    expect((await noticeTexts(harness)).at(-1)).toBe(
      'Question 2 was already answered: B, Pipeline runbook (Handbook) is right.',
    );
  });

  it('takes a numbered answer to the first question while a second stands, and says one more is open (17-C)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const harness = convexTest(schema, allConvexModules());
    const asked = await askedInRequest(harness);
    await secondQuestion(harness, asked);
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId: asked.surfaceId,
        userId: 'UMANAGER',
        messageTs: '1790000000.000100',
        reply: { verb: 'answer', id: 'ab3xyz', choice: 'both', number: 1 },
      }),
    ).resolves.toMatchObject({ status: 'answered' });
    expect(await noticeTexts(harness)).toEqual([
      'Recorded for question 1: Both hold. Retry runs the steps that waited on it, drafted again where they relied on the other page. 1 more question of this plan is still open.',
    ]);
    const [first, second] = await questionsOf(harness, asked.workItemId);
    expect(first.answer).toMatchObject({ text: 'Both hold', via: 'slack' });
    expect(second.answer).toBeUndefined();
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

  it('stores a page settled on the Documentation tab by its letter, title and source (W16-R12, W3g)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { relationId, workItemId } = await askedInRequest(harness);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId,
      decision: 'from-is-right',
    });
    const [question] = await questionsOf(harness, workItemId);
    expect(question.answer).toMatchObject({
      text: 'A, Finance escalation (Finance wiki) is right',
      via: 'dashboard',
    });
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

  it('refuses an answer to a question whose conflict no longer stands, recording nothing (W16-R27)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { relationId, workItemId } = await askedInRequest(harness);
    const [question] = await questionsOf(harness, workItemId);
    // A card left open in another tab: the conflict was set aside on the Documentation tab by a
    // row the decision did not close (a page archived there would leave the same stale card).
    await harness.run(async (ctx) => {
      await ctx.db.patch(relationId, { status: 'dismissed' });
    });
    await expect(
      asManager(harness).mutation(api.managerQuestions.answerConflict, {
        questionId: question._id,
        choice: 'from',
      }),
    ).rejects.toThrow('These two pages no longer disagree as they did, so nothing is recorded.');
    expect((await questionsOf(harness, workItemId))[0].answer).toBeUndefined();
  });

  it('asks again, and stops an approved plan, when a conflict settled as both holding is confirmed again (W16-R27)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { relationId, workItemId } = await askedInRequest(harness);
    const decide = async (decision: 'both-hold' | 'undo' | 'disagree'): Promise<void> => {
      await asManager(harness).mutation(api.docRelations.decide, { relationId, decision });
    };
    // The plan is still the manager's to approve when the pages come to disagree again.
    await harness.run(async (ctx) => await ctx.db.patch(workItemId, { state: 'plan-pending' }));
    await decide('both-hold');
    expect((await questionsOf(harness, workItemId)).map((row) => row.answer?.text)).toEqual([
      'Both hold',
    ]);
    // "Both hold", Undo, "They disagree": the same pages disagree again under the same plan.
    await decide('undo');
    await decide('disagree');
    const asked = await questionsOf(harness, workItemId);
    expect(asked.map((row) => row.answer?.text)).toEqual(['Both hold', undefined]);
    expect(
      await harness.query(internal.managerQuestions.conflictHoldsFor, { workItemId }),
    ).toHaveLength(1);
    // The same again with the plan already approved: nobody is asked beside an approved plan, so
    // the run stops on the conflict confirmed since.
    await decide('both-hold');
    await harness.run(async (ctx) => await ctx.db.patch(workItemId, { state: 'plan-approved' }));
    await decide('undo');
    await decide('disagree');
    expect(
      await harness.query(internal.managerQuestions.conflictConfirmedSince, { workItemId }),
    ).toMatchObject({ heading: 'Thresholds' });
  });

  it('asks beside a plan that names the dispute in its own words and cites another passage, and holds every step (D-1 (c))', async (): Promise<void> => {
    // The pre-tag bed's REVOPS-1 on the hosted model: told to cite the tagged passage a step
    // relies on, the planner said the step was held on the dispute and cited a neighbouring
    // passage of the page, so nothing was asked and nothing held.
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
    const elsewhere = {
      step: 1,
      label: 'Handbook/runbooks/pipeline-runbook.md#Pipeline runbook > Refresh',
      blocks: [],
    };
    const kept = disputed.blocks.map((block) => ({
      id: block.id as Id<'docBlocks'>,
      hash: block.hash!,
    }));
    const leaning = await planned(harness, agentId, {
      summary:
        'Escalate the variance as the finance escalation page says; the two pages disagree on the figure, so that step waits for you.',
      cites: [elsewhere],
    });
    // The same selection shown to a plan whose words rest on neither page: the narrow ask is narrow.
    const apart = await planned(harness, agentId, {
      summary: 'Refresh the tile.',
      steps: ['Press Refresh'],
      cites: [elsewhere],
    });
    await harness.run(async (ctx) => {
      await ctx.db.patch(leaning, { selectedBlocks: kept });
      await ctx.db.patch(apart, { selectedBlocks: kept });
    });
    await harness.mutation(internal.work.decidePlan, { workItemId: leaning });
    await harness.mutation(internal.work.decidePlan, { workItemId: apart });
    expect(await questionsOf(harness, leaning)).toEqual([
      expect.objectContaining({ question: ASKED, relationId }),
    ]);
    expect(await questionsOf(harness, apart)).toEqual([]);
    // No cite says which step relies on the passage, so the apply holds every step's writes.
    expect(
      await harness.query(internal.managerQuestions.conflictHoldsFor, { workItemId: leaning }),
    ).toEqual([expect.objectContaining({ relationId, leaned: true })]);
    // Settled as both holding and confirmed again with both plans approved (W16-R27's shape):
    // nobody is asked beside an approved plan, so the run of the one that leans on it stops too.
    const decide = async (decision: 'both-hold' | 'undo' | 'disagree'): Promise<void> => {
      await asManager(harness).mutation(api.docRelations.decide, { relationId, decision });
    };
    await decide('both-hold');
    await harness.run(async (ctx) => {
      await ctx.db.patch(leaning, { state: 'plan-approved' });
      await ctx.db.patch(apart, { state: 'plan-approved' });
    });
    await decide('undo');
    await decide('disagree');
    expect(
      await harness.query(internal.managerQuestions.conflictConfirmedSince, {
        workItemId: leaning,
      }),
    ).toMatchObject({ heading: 'Thresholds' });
    expect(
      await harness.query(internal.managerQuestions.conflictConfirmedSince, { workItemId: apart }),
    ).toBeNull();
  });

  it('drafts a plan that leans on the conflict again on the first Retry, whichever page the answer superseded (D-1 (c))', async (): Promise<void> => {
    // Its words were written round the dispute ("that step waits for you"), so the plan as it
    // stood is stale once the manager has answered, though no page it cites has gone.
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
    const workItemId = await planned(harness, agentId, {
      summary:
        'Escalate the variance as the finance escalation page says; the two pages disagree on the figure, so that step waits for you.',
      cites: [
        {
          step: 1,
          label: 'Handbook/runbooks/pipeline-runbook.md#Pipeline runbook > Refresh',
          blocks: [],
        },
      ],
    });
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        selectedBlocks: disputed.blocks.map((block) => ({
          id: block.id as Id<'docBlocks'>,
          hash: block.hash!,
        })),
      });
    });
    await harness.mutation(internal.work.decidePlan, { workItemId });
    const [question] = await questionsOf(harness, workItemId);
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        state: 'failed',
        skipReason: `stopped: ${openQuestionStopReason({ question: question.question, steps: [1] })}`,
        output: {
          draft: '',
          notes: '',
          actions: [],
          applied: [],
          openQuestion: { question: question.question, steps: [1], relationId },
        },
      });
    });
    await asManager(harness).mutation(api.managerQuestions.answerConflict, {
      questionId: question._id,
      choice: 'from',
    });
    await expect(
      asManager(harness).mutation(api.workRuns.retryFailed, { workItemId }),
    ).resolves.toEqual({ ok: true, resumeState: 'discovered' });
    expect(await eventsOf(harness, agentId, 'work.plan-redraft')).toHaveLength(1);
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
