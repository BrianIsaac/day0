import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  conflictsUnderPlan,
  decisionsOffered,
  standingConflictsFrom,
  standingConflictsOn,
} from '../../convex/docConflicts';
import { conflictBlocks } from '../../convex/docRelationProposals';
import { rememberRequestWithQuestion } from '../../convex/decisionRequests';
import { askConflictQuestion } from '../../convex/reorientation';
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

describe('the confirmed conflicts read past one read’s window (17-C; W15-R19, with its probe R2-F)', (): void => {
  afterEach((): void => {
    restoreSurfaceMode();
  });

  /** How many conflicts the manager settled since: one read's whole window. */
  const SETTLED = 512;

  /**
   * A conflict that stands, confirmed first, and then a window of newer ones that stand no more:
   * each names blocks no page holds any longer, as a conflict settled with "{A} is right" or one
   * whose page was removed does.
   */
  async function behindSettled(harness: Harness, blocksEach: number) {
    const pages = await twoThatDisagree(harness);
    await measure(harness, pages.finance, 'escalation.md');
    const relation = (await relations(harness)).find((row) => row.kind === 'possible_conflict')!;
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: relation._id,
      decision: 'disagree',
    });
    await harness.run(async (ctx) => {
      for (let settled = 0; settled < SETTLED; settled += 1) {
        await ctx.db.insert('docRelations', {
          userId: 'owner',
          from: { sourceId: pages.handbook.sourceId, ref: `settled-${settled}-a.md` },
          to: { sourceId: pages.finance.sourceId, ref: `settled-${settled}-b.md` },
          kind: 'possible_conflict',
          evidence: [
            {
              measure: 'heading-figures',
              value: 1,
              blockRefs: Array.from({ length: blocksEach }, (_unused, n) => `gone-${settled}-${n}`),
            },
          ],
          status: 'confirmed',
          decidedAt: 5,
          createdAt: 5,
        });
      }
    });
    return { pages, relation };
  }

  it('gives a plan the standing conflict its cited page is an end of, behind five hundred and twelve settled since', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { pages, relation } = await behindSettled(harness, 2);
    const found = await harness.run(async (ctx) => {
      const hashes = new Set(conflictBlocks(relation));
      const blocks = (await ctx.db.query('docBlocks').collect()).filter((block) =>
        hashes.has(block.hash),
      );
      const cite = {
        step: 1,
        label: 'Finance wiki/escalation.md#Finance escalation > Thresholds',
        blocks: blocks.map((block) => ({ id: block._id, hash: block.hash })),
      };
      const agent = { userId: 'owner' };
      const item = { _id: 'w' as Id<'workItems'>, agentId: 'a' as Id<'agents'> };
      return {
        // The cite names its page, as every cite since W14-R27 does.
        named: await conflictsUnderPlan(
          ctx,
          {
            ...item,
            plan: {
              cites: [{ ...cite, sourceId: pages.finance.sourceId, pageRef: 'escalation.md' }],
            },
          },
          agent,
        ),
        // An older cite names no page: its blocks' own rows say which it is.
        unnamed: await conflictsUnderPlan(ctx, { ...item, plan: { cites: [cite] } }, agent),
        // A plan that cites nothing is read by the selection kept on the item.
        kept: await conflictsUnderPlan(
          ctx,
          {
            ...item,
            plan: { summary: 'Escalate the variance.' },
            selectedBlocks: blocks.map((block) => ({ id: block._id, hash: block.hash })),
          },
          agent,
        ),
      };
    });
    const asked = [expect.objectContaining({ relationId: relation._id, heading: 'Thresholds' })];
    expect(found).toEqual({ named: asked, unnamed: asked, kept: asked });
  });

  it('walks the owner’s conflicts by page within a transaction’s limits, and reaches the standing one behind the settled', async (): Promise<void> => {
    useSurfaceMode('real');
    // Convex's own limits enforced: at the tip the cards' read of this owner threw "Too many
    // index ranges" (R2-F: 512 settled conflicts of four blocks each).
    const harness = convexTest({ schema, modules: allConvexModules(), transactionLimits: true });
    const { relation } = await behindSettled(harness, 4);
    const first = await harness.run(
      async (ctx) => await standingConflictsFrom(ctx, 'owner', { most: 20 }),
    );
    // One walk makes the lookups it may and says where the next goes on from.
    expect(first.standing).toEqual([]);
    expect(first.next).toEqual(expect.any(Number));
    const reached: string[] = [];
    let next = first.next;
    for (let walk = 0; next !== null && walk < 8; walk += 1) {
      const from: number = next;
      const page = await harness.run(
        async (ctx) => await standingConflictsFrom(ctx, 'owner', { most: 20, before: from }),
      );
      reached.push(...page.standing.map((found) => found.conflict.relationId));
      next = page.next;
    }
    expect(reached).toEqual([relation._id]);
    expect(next).toBeNull();
  });

  it('draws the cards of an owner with a window of settled conflicts, each read going on from where the last stopped (R2-F)', async (): Promise<void> => {
    useSurfaceMode('real');
    // Convex's own limits enforced: at v0.20.0 the cards' one read threw "Too many index ranges"
    // for this owner (W15-R19), and no single read reaches past the settled ones (F12).
    const harness = convexTest({ schema, modules: allConvexModules(), transactionLimits: true });
    const { relation } = await behindSettled(harness, 4);
    const manager = asManager(harness);
    const first = await manager.query(api.docRelations.listOpen, {});
    expect(first.cards).toEqual([]);
    const drawn = [...first.cards];
    let next = first.next;
    for (let read = 0; next !== null && read < 8; read += 1) {
      const later = await manager.query(api.docRelations.listOpen, { conflictsBefore: next });
      drawn.push(...later.cards);
      next = later.next;
    }
    expect(drawn).toMatchObject([{ _id: relation._id, status: 'confirmed' }]);
    expect(next).toBeNull();
  });

  it('draws the proposals on the first read alone, so a read going on from a cursor repeats none', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const pages = await twoThatDisagree(harness);
    await measure(harness, pages.finance, 'escalation.md');
    const manager = asManager(harness);
    const first = await manager.query(api.docRelations.listOpen, {});
    expect(first).toMatchObject({ cards: [{ status: 'proposed' }], next: null });
    const later = await manager.query(api.docRelations.listOpen, { conflictsBefore: Date.now() });
    // Re-pinned for W17-R9 (D-10 (a)): a read going on from a cursor draws no proposal, so it
    // leaves none unshown; and by 18-D for D-10's read-more: nor does it say where the
    // proposals' next read goes on.
    expect(later).toEqual({
      cards: [],
      next: null,
      notShown: { proposals: 0, atLeast: false },
      proposalsNext: null,
    });
  });

  it('stops a walk at its byte bound with the conflict that passed it still to come, and passes over a relation the reader does not read for no lookup', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const pages = await twoThatDisagree(harness);
    await measure(harness, pages.finance, 'escalation.md');
    const relation = (await relations(harness)).find((row) => row.kind === 'possible_conflict')!;
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: relation._id,
      decision: 'disagree',
    });
    // A second standing conflict between the same two pages, confirmed later.
    const later = await harness.run(
      async (ctx) =>
        await ctx.db.insert('docRelations', fieldsOf((await ctx.db.get(relation._id))!)),
    );
    const walked = await harness.run(async (ctx) => ({
      whole: await standingConflictsFrom(ctx, 'owner', { most: 20 }),
      // A bound one conflict's two pages pass: the first is given, the second waits for the next.
      bounded: await standingConflictsFrom(ctx, 'owner', { most: 20, bytes: 1 }),
      unread: await standingConflictsFrom(ctx, 'owner', { most: 20, reads: () => false }),
    }));
    expect(walked.whole.standing.map((found) => found.conflict.relationId)).toEqual([
      later,
      relation._id,
    ]);
    expect(walked.whole.next).toBeNull();
    expect(walked.bounded.standing.map((found) => found.conflict.relationId)).toEqual([later]);
    const rest = await harness.run(
      async (ctx) =>
        await standingConflictsFrom(ctx, 'owner', { most: 20, before: walked.bounded.next! }),
    );
    expect(rest.standing.map((found) => found.conflict.relationId)).toEqual([relation._id]);
    expect(walked.unread).toEqual({ standing: [], next: null });
    // The read by the blocks a reader carries counts the same bytes: both conflicts within the
    // bound, and past it the read stops with what it has (17-C's second pass).
    const carried = new Set(conflictBlocks(relation));
    const byBlock = await harness.run(async (ctx) => ({
      whole: await standingConflictsOn(ctx, 'owner', carried, () => []),
      bounded: await standingConflictsOn(ctx, 'owner', carried, () => [], 1),
    }));
    expect(byBlock.whole).toHaveLength(2);
    expect(byBlock.bounded).toHaveLength(1);
  });

  it('gives both of two conflicts that share a block, each once (17-C: keyed by block, the second was lost)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const pages = await twoThatDisagree(harness);
    await measure(harness, pages.finance, 'escalation.md');
    const relation = (await relations(harness)).find((row) => row.kind === 'possible_conflict')!;
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: relation._id,
      decision: 'disagree',
    });
    const found = await harness.run(async (ctx) => {
      const second = await ctx.db.insert(
        'docRelations',
        fieldsOf((await ctx.db.get(relation._id))!),
      );
      const standing = await standingConflictsOn(
        ctx,
        'owner',
        new Set(conflictBlocks(relation)),
        () => [],
      );
      return { second, relations: standing.map((conflict) => conflict.relationId) };
    });
    expect(found.relations.sort()).toEqual([relation._id, found.second].sort());
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
      // Re-pinned for W17-R1 (D-11 (a)): each page carries its ref, by which two pages of one
      // title in one source are named apart.
      pages: [
        { title: 'Finance escalation', source: 'Finance wiki', ref: 'escalation.md' },
        { title: 'Pipeline runbook', source: 'Handbook', ref: 'runbooks/pipeline-runbook.md' },
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
    expect((await asManager(harness).query(api.docRelations.listOpen, {})).cards).toMatchObject([
      { _id: relationId, kind: 'possible_conflict', status: 'confirmed' },
    ]);
  });

  /**
   * Run the asking a confirmation schedules out of its own transaction (17-C): the first timer
   * after it, and nothing that asking schedules in turn (a notice's send among them).
   */
  async function ranAsks(harness: Harness): Promise<void> {
    vi.advanceTimersToNextTimer();
    await harness.finishInProgressScheduledFunctions();
  }

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
    await ranAsks(harness);
    expect(await questionsOf(harness, workItemId)).toEqual([
      expect.objectContaining({ question: ASKED, relationId, blocking: false }),
    ]);
  });

  it('closes the question when a page of its conflict leaves current, and asks it again when the page comes back (17-C’s two docStatus lines; F13)', async (): Promise<void> => {
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
    const manager = asManager(harness);
    await manager.mutation(api.docRelations.decide, { relationId, decision: 'disagree' });
    await ranAsks(harness);
    const closes = async (): Promise<Array<string | undefined>> =>
      (await questionsOf(harness, workItemId)).map((question) => question.closed?.reason);
    expect(await closes()).toEqual([undefined]);
    const pageId = await harness.run(
      async (ctx) =>
        (await ctx.db
          .query('docPages')
          .withIndex('by_source_ref', (q) =>
            q.eq('sourceId', relation.to.sourceId).eq('ref', relation.to.ref),
          )
          .unique())!._id,
    );
    // The manager archives one page: the conflict no longer stands, so its question closes at
    // the flip, not at the plan's next run.
    await manager.mutation(api.docStatus.setPageStatus, { pageId, status: 'archived' });
    await ranAsks(harness);
    expect(await closes()).toEqual(['settled']);
    // The page made current again: the conflict stands once more and the plan is asked again.
    await manager.mutation(api.docStatus.clearPageStatus, { pageId });
    await ranAsks(harness);
    await ranAsks(harness);
    expect(await closes()).toEqual(['settled', undefined]);
    expect((await questionsOf(harness, workItemId))[1]).toMatchObject({
      question: ASKED,
      relationId,
    });
  });

  it('asks out of the confirming transaction, a page of the reader’s drafted plans a step, until every plan was read (17-C; the pre-tag’s second pass)', async (): Promise<void> => {
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
    const label = 'Finance wiki/escalation.md#Finance escalation > Thresholds';
    const { citations } = await selection(harness, agentId);
    const cited = citations.find((citation) => citation.label === label)!;
    const cites = [
      {
        step: 1,
        label,
        sourceId: relation.from.sourceId,
        pageRef: relation.from.ref,
        blocks: cited.blocks.map((block) => ({ id: block.id, hash: block.hash! })),
      },
    ];
    // More drafted plans than one step reads, every other one resting on the disputed passage.
    const items: Id<'workItems'>[] = [];
    for (let plan = 0; plan < 23; plan += 1) {
      items.push(await planned(harness, agentId, plan % 2 === 0 ? { cites } : {}));
    }
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId,
      decision: 'disagree',
    });
    // The confirmation itself asked nothing: its transaction read no drafted plan.
    const askedOf = async (): Promise<number> =>
      (await harness.run(async (ctx) => await ctx.db.query('managerQuestions').collect())).length;
    expect(await askedOf()).toBe(0);
    // Each step reads ten plans and schedules the next: five of them asked a step.
    await ranAsks(harness);
    expect(await askedOf()).toBe(5);
    await ranAsks(harness);
    expect(await askedOf()).toBe(10);
    await ranAsks(harness);
    expect(await askedOf()).toBe(12);
    // The last step scheduled nothing more.
    const pending = await harness.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect()).filter(
        (job) => job.name.includes('askConfirmed') && job.state.kind === 'pending',
      ),
    );
    expect(pending).toEqual([]);
    const asked = await harness.run(
      async (ctx) => await ctx.db.query('managerQuestions').collect(),
    );
    expect(new Set(asked.map((question) => question.workItemId))).toEqual(
      new Set(items.filter((_item, plan) => plan % 2 === 0)),
    );
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
    await ranAsks(harness);
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
    await ranAsks(harness);
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

  it('reads the request’s thread ninety minutes after the decision while its question stands, and no longer once it is answered (17-C; W16-R27)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId, workItemId } = await askedInRequest(harness);
    await harness.run(async (ctx) => {
      const row = await ctx.db.get(workItemId);
      await ctx.db.patch(workItemId, {
        state: 'plan-approved',
        decision: {
          ...row!.decision!,
          decidedAt: Date.now() - 90 * 60 * 1000,
          outcome: 'approved',
        },
      });
    });
    expect(await harness.query(internal.work.openDecisions, { surfaceId })).toMatchObject({
      requests: [],
      noticeOwed: true,
      threads: [REQUEST_TS],
    });
    const [question] = await questionsOf(harness, workItemId);
    await asManager(harness).mutation(api.managerQuestions.answerConflict, {
      questionId: question._id,
      choice: 'both',
    });
    const after = await harness.query(internal.work.openDecisions, { surfaceId });
    expect(after.noticeOwed).toBe(false);
    expect(after.threads).toBeUndefined();
  });

  it('looks up the newest twenty items with an open question for their requests, and no further (17-C’s second pass)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const harness = convexTest(schema, allConvexModules());
    const { agentId, relationId, surfaceId, workItemId } = await askedInRequest(harness);
    const [asked] = await questionsOf(harness, workItemId);
    // Newer items, each with an open question of its own and no request on this DM.
    const newer = async (count: number): Promise<void> => {
      await harness.run(async (ctx) => {
        for (let n = 0; n < count; n += 1) {
          const other = await ctx.db.insert('workItems', {
            agentId,
            sourceCategory: 'ticket-queue',
            sourceSystem: 'linear',
            externalId: `REVOPS-${100 + n}`,
            title: 'Another plan',
            contentSummary: 'A plan with a question and no request yet.',
            contentRefs: [],
            observedAt: 1,
            createdAt: 1,
            state: 'plan-pending',
          });
          await ctx.db.insert('managerQuestions', {
            agentId,
            key: `conflict:${relationId}:${other}`,
            question: asked.question,
            context: asked.context,
            askedAt: asked.askedAt + 1 + n,
            workItemId: other,
            charterId: asked.charterId,
            blocking: false,
            type: 'retrieval',
            relationId,
          });
        }
      });
    };
    await newer(19);
    expect((await harness.query(internal.work.openDecisions, { surfaceId })).threads).toEqual([
      REQUEST_TS,
    ]);
    await newer(1);
    expect(
      (await harness.query(internal.work.openDecisions, { surfaceId })).threads,
    ).toBeUndefined();
  });

  it('keeps the plan’s request answerable by its code, and its thread read, after a park cleared it from the item (17-C, C-3)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const harness = convexTest(schema, allConvexModules());
    const { relationId, surfaceId, workItemId } = await askedInRequest(harness);
    // Approved ninety minutes ago; the first set then parked for approval under a request of its
    // own, as the two parks leave the item.
    await harness.run(async (ctx) => {
      const row = (await ctx.db.get(workItemId))!;
      const decided = {
        ...row.decision!,
        decidedAt: Date.now() - 90 * 60 * 1000,
        outcome: 'approved' as const,
      };
      await rememberRequestWithQuestion(ctx, { ...row, decision: decided }, Date.now());
      await ctx.db.patch(workItemId, {
        state: 'actions-pending',
        decision: { ...decided, id: 'cd4xyz', kind: 'actions', ts: '1790000000.000900' },
      });
    });
    const open = await harness.query(internal.work.openDecisions, { surfaceId });
    expect(open.noticeOwed).toBe(true);
    expect(open.threads).toContain(REQUEST_TS);
    // The plan's code still answers its question, and the acknowledgement goes to its thread.
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs: '1790000001.000100',
        reply: { verb: 'answer', id: 'ab3xyz', choice: 'both' },
      }),
    ).resolves.toMatchObject({ status: 'answered', notified: true });
    expect((await questionsOf(harness, workItemId))[0].answer).toMatchObject({
      text: 'Both hold',
      via: 'slack',
    });
    expect((await relations(harness)).find((row) => row._id === relationId)?.status).not.toBe(
      'confirmed',
    );
    const [acknowledgement] = await notices(harness);
    expect(acknowledgement).toMatchObject({ decisionId: 'ab3xyz', kind: 'received' });
    await expect(
      harness.mutation(internal.work.prepareManagerReplyNotice, {
        noticeId: acknowledgement._id,
      }),
    ).resolves.toMatchObject({ prepared: true, threadTs: REQUEST_TS });
    // With the question answered the old code answers nothing more: it reads as replaced.
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs: '1790000002.000100',
        reply: { verb: 'answer', id: 'ab3xyz', choice: 'from' },
      }),
    ).resolves.toMatchObject({ status: 'replaced' });
  });

  it('answers the kept code of a plan since drafted again as replaced, never as a question of the new plan (17-C’s second pass)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const harness = convexTest(schema, allConvexModules());
    const { relationId, surfaceId, workItemId } = await askedInRequest(harness);
    const cited = (await harness.run(async (ctx) => await ctx.db.get(workItemId)))!.plan as {
      cites: unknown[];
    };
    // Approved, its first set parked (the request kept with its question open), then stopped.
    await harness.run(async (ctx) => {
      const row = (await ctx.db.get(workItemId))!;
      const decided = { ...row.decision!, decidedAt: Date.now(), outcome: 'approved' as const };
      await rememberRequestWithQuestion(ctx, { ...row, decision: decided }, Date.now());
      await ctx.db.patch(workItemId, { state: 'cancelled', decision: undefined });
    });
    // Retry drafts the plan again an hour on: the old question closes, and the new plan, citing
    // the disputed passage too, is asked a question of its own before its request has gone out.
    vi.setSystemTime(Date.UTC(2026, 9, 1, 1));
    await asManager(harness).mutation(api.workRuns.retryFailed, { workItemId });
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        state: 'plan-pending',
        plan: {
          summary: 'Escalate the variance to the finance lead.',
          steps: ['Message the finance lead when the variance passes the threshold'],
          cites: cited.cites,
        },
      });
    });
    await harness.mutation(internal.work.decidePlan, { workItemId });
    const [old, fresh] = await questionsOf(harness, workItemId);
    expect(old.closed?.reason).toBe('redrafted');
    expect(fresh.closed).toBeUndefined();
    // The old request's code, typed from the old message, decides nothing of the new plan's.
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs: '1790003600.000100',
        reply: { verb: 'answer', id: 'ab3xyz', choice: 'both' },
      }),
    ).resolves.toMatchObject({ status: 'replaced' });
    expect((await questionsOf(harness, workItemId))[1].answer).toBeUndefined();
    expect((await relations(harness)).find((row) => row._id === relationId)?.status).toBe(
      'confirmed',
    );
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
    // Re-pinned for W17-R10: "Both hold" gives no page away, so nothing is drafted again.
    expect(await noticeTexts(harness)).toEqual([
      'Recorded for question 1: Both hold. Retry runs the steps that waited on it. 1 more question of this plan is still open.',
    ]);
    const [first, second] = await questionsOf(harness, asked.workItemId);
    expect(first.answer).toMatchObject({ text: 'Both hold', via: 'slack' });
    expect(second.answer).toBeUndefined();
  });

  /** A drafted plan citing the disputed passage, the conflict still only proposed, with its request as given. */
  async function plannedBeforeConfirmation(
    harness: Harness,
    decision: Record<string, unknown> | undefined,
  ) {
    const { agentId, relationId } = await disagreement(harness);
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
    const relation = (await relations(harness)).find((row) => row._id === relationId)!;
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
    if (decision !== undefined) {
      await harness.run(async (ctx) => {
        await ctx.db.patch(workItemId, {
          decision: {
            id: 'ab3xyz',
            kind: 'plan',
            requestedAt: 1,
            channel: 'D0MANAGER',
            surfaceSlug: 'team-chat',
            surfaceName: 'Team chat',
            ...decision,
          },
        });
      });
    }
    return { agentId, relationId, surfaceId, workItemId };
  }

  /** The notices queued for the manager's DM, as stored. */
  async function notices(harness: Harness) {
    return await harness.run(async (ctx) => await ctx.db.query('managerDecisionNotices').collect());
  }

  const REQUEST_TS = '1787770800.000100';
  const NOTICE =
    'Since I asked you about this plan, you confirmed that two pages disagree under “Thresholds”: A, Finance escalation (Finance wiki), and B, Pipeline runbook (Handbook). Which is right? Priya holds every write of the plan until you answer.';

  it('queues the question for the thread of a request already delivered when the conflict is confirmed after it, once (17-C; O-23)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const harness = convexTest(schema, allConvexModules());
    const { agentId, relationId, surfaceId, workItemId } = await plannedBeforeConfirmation(
      harness,
      { ts: REQUEST_TS, requestText: 'Priya needs your decision on “Escalate the variance”.' },
    );
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId,
      decision: 'disagree',
    });
    await ranAsks(harness);
    const [question] = await questionsOf(harness, workItemId);
    expect(await notices(harness)).toEqual([
      expect.objectContaining({
        agentId,
        surfaceId,
        workItemId,
        decisionId: 'ab3xyz',
        kind: 'question',
        questionId: question._id,
        messageTs: `question:${question._id}`,
        text: NOTICE,
      }),
    ]);
    // The plan's decision looks again (the stalled-step sweep, a card's Approve): the question is
    // open, so nothing is asked and nothing more is queued.
    await harness.mutation(internal.work.decidePlan, { workItemId, recovery: true });
    expect(await notices(harness)).toHaveLength(1);
    // Its claim: the request's own thread, the question, and how to answer it. One question
    // stands, so it is asked and answered without a number.
    const [notice] = await notices(harness);
    await expect(
      harness.mutation(internal.work.prepareManagerReplyNotice, { noticeId: notice._id }),
    ).resolves.toMatchObject({
      prepared: true,
      threadTs: REQUEST_TS,
      text: `${NOTICE}\nAnswer with “answer ab3xyz A”, “answer ab3xyz B” or “answer ab3xyz both”.`,
    });
    expect(await eventsOf(harness, agentId, 'work.decision-acknowledging')).toEqual([
      {
        workItemId,
        decisionId: 'ab3xyz',
        messageTs: `question:${question._id}`,
        kind: 'question',
        questionId: question._id,
      },
    ]);
    // Claimed once: a second look sends nothing.
    await expect(
      harness.mutation(internal.work.prepareManagerReplyNotice, { noticeId: notice._id }),
    ).resolves.toEqual({ prepared: false });
  });

  it('numbers the thread’s question, and its answer line, when the plan already has one standing (17-C)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const harness = convexTest(schema, allConvexModules());
    const asked = await askedInRequest(harness);
    // A second conflict under the plan comes to stand after the request went out, and is asked
    // as a confirmation asks it.
    const second = await harness.run(async (ctx) => {
      const relation = await ctx.db.get(asked.relationId);
      const row = await ctx.db.get(asked.workItemId);
      await ctx.db.patch(asked.workItemId, {
        decision: { ...row!.decision!, requestText: `1 question.\n${ASKED}` },
      });
      const relationId = await ctx.db.insert('docRelations', fieldsOf(relation!));
      await askConflictQuestion(ctx, {
        row: (await ctx.db.get(asked.workItemId))!,
        conflict: {
          relationId,
          heading: 'Thresholds',
          pages: [
            { title: 'Finance escalation', source: 'Finance wiki' },
            { title: 'Pipeline runbook', source: 'Handbook' },
          ],
        },
        now: Date.now(),
      });
      return relationId;
    });
    const [first, later] = await questionsOf(harness, asked.workItemId);
    expect(later.relationId).toBe(second);
    // The first question rode the request's own body, so it has no notice; the second has one.
    const queued = await notices(harness);
    expect(queued.map((notice) => notice.questionId)).toEqual([later._id]);
    await expect(
      harness.mutation(internal.work.prepareManagerReplyNotice, { noticeId: queued[0]._id }),
    ).resolves.toMatchObject({
      prepared: true,
      threadTs: REQUEST_TS,
      text: `${NOTICE}\nThis is question 2 of the plan: answer with “answer ab3xyz 2 A”, “answer ab3xyz 2 B” or “answer ab3xyz 2 both”.`,
    });
    expect(first.answer).toBeUndefined();
  });

  it('posts nothing in the thread for a question its request carried, a request that failed, or a question answered meanwhile (17-C)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    // A request still on its way out: its body was built before or after the question was asked.
    const inFlight = convexTest(schema, allConvexModules());
    const flying = await plannedBeforeConfirmation(inFlight, {});
    await asManager(inFlight).mutation(api.docRelations.decide, {
      relationId: flying.relationId,
      decision: 'disagree',
    });
    await ranAsks(inFlight);
    const [waiting] = await notices(inFlight);
    await expect(
      inFlight.mutation(internal.work.prepareManagerReplyNotice, { noticeId: waiting._id }),
    ).resolves.toEqual({ prepared: false, wait: true });
    expect(await notices(inFlight)).toHaveLength(1);
    // It lands after the question was asked, and its text carries the question: the notice is
    // dropped unsent.
    const landed = `${Date.UTC(2026, 9, 1) / 1000 + 2}.000100`;
    await inFlight.run(async (ctx) => {
      const row = await ctx.db.get(flying.workItemId);
      await ctx.db.patch(flying.workItemId, {
        decision: { ...row!.decision!, ts: landed, requestText: `Plan.\n\n${ASKED}` },
      });
    });
    await expect(
      inFlight.mutation(internal.work.prepareManagerReplyNotice, { noticeId: waiting._id }),
    ).resolves.toEqual({ prepared: false, dropped: true });
    expect(await notices(inFlight)).toEqual([]);

    // The deployment's clock a second ahead of the provider's: the request that carried the
    // question is stamped before the question's own time, and the notice is dropped all the same.
    const skewed = convexTest(schema, allConvexModules());
    const ahead = await plannedBeforeConfirmation(skewed, {});
    await asManager(skewed).mutation(api.docRelations.decide, {
      relationId: ahead.relationId,
      decision: 'disagree',
    });
    await ranAsks(skewed);
    await skewed.run(async (ctx) => {
      const row = await ctx.db.get(ahead.workItemId);
      await ctx.db.patch(ahead.workItemId, {
        decision: {
          ...row!.decision!,
          ts: `${Date.UTC(2026, 9, 1) / 1000 - 1}.000100`,
          requestText: `Plan.\n\n${ASKED}`,
        },
      });
    });
    const [carried] = await notices(skewed);
    await expect(
      skewed.mutation(internal.work.prepareManagerReplyNotice, { noticeId: carried._id }),
    ).resolves.toEqual({ prepared: false, dropped: true });

    // The same race the other way: the request's text was built before the question was asked,
    // so the thread asks it.
    const raced = convexTest(schema, allConvexModules());
    const built = await plannedBeforeConfirmation(raced, {});
    await asManager(raced).mutation(api.docRelations.decide, {
      relationId: built.relationId,
      decision: 'disagree',
    });
    await ranAsks(raced);
    await raced.run(async (ctx) => {
      const row = await ctx.db.get(built.workItemId);
      await ctx.db.patch(built.workItemId, {
        decision: { ...row!.decision!, ts: landed, requestText: 'Plan.' },
      });
    });
    const [owed] = await notices(raced);
    await expect(
      raced.mutation(internal.work.prepareManagerReplyNotice, { noticeId: owed._id }),
    ).resolves.toMatchObject({ prepared: true, threadTs: landed });

    // A request that failed is resent with the question in it: nothing is queued.
    const failed = convexTest(schema, allConvexModules());
    const undelivered = await plannedBeforeConfirmation(failed, {
      requestFailedAt: 5,
      requestFailure: 'channel_not_found',
    });
    await asManager(failed).mutation(api.docRelations.decide, {
      relationId: undelivered.relationId,
      decision: 'disagree',
    });
    await ranAsks(failed);
    expect(await questionsOf(failed, undelivered.workItemId)).toHaveLength(1);
    expect(await notices(failed)).toEqual([]);

    // A plan with no request yet asks in the request's own body.
    const unasked = convexTest(schema, allConvexModules());
    const drafted = await plannedBeforeConfirmation(unasked, undefined);
    await asManager(unasked).mutation(api.docRelations.decide, {
      relationId: drafted.relationId,
      decision: 'disagree',
    });
    await ranAsks(unasked);
    expect(await questionsOf(unasked, drafted.workItemId)).toHaveLength(1);
    expect(await notices(unasked)).toEqual([]);

    // Answered on the card before the notice is sent: nothing is posted.
    const answered = convexTest(schema, allConvexModules());
    const settled = await plannedBeforeConfirmation(answered, { ts: REQUEST_TS });
    await asManager(answered).mutation(api.docRelations.decide, {
      relationId: settled.relationId,
      decision: 'disagree',
    });
    await ranAsks(answered);
    const [question] = await questionsOf(answered, settled.workItemId);
    await asManager(answered).mutation(api.managerQuestions.answerConflict, {
      questionId: question._id,
      choice: 'both',
    });
    const [stale] = await notices(answered);
    await expect(
      answered.mutation(internal.work.prepareManagerReplyNotice, { noticeId: stale._id }),
    ).resolves.toEqual({ prepared: false, dropped: true });
    expect(await notices(answered)).toEqual([]);
  });

  // W17-R10 (reader 2): the acknowledgement said "Retry runs the steps that waited on it, drafted
  // again where they relied on the other page." for "Both hold", where no page gives way, and for a
  // question beside an item already finished, where nothing waits (C-9 (a)).
  it('acknowledges a question answered beside a finished item as holding nothing of it (W17-R10)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const harness = convexTest(schema, allConvexModules());
    const asked = await askedInRequest(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(asked.workItemId, { state: 'completed' });
    });
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId: asked.surfaceId,
        userId: 'UMANAGER',
        messageTs: '1790000000.000100',
        reply: { verb: 'answer', id: 'ab3xyz', choice: 'from' },
      }),
    ).resolves.toMatchObject({ status: 'answered' });
    expect(await noticeTexts(harness)).toEqual([
      'Recorded: A, Finance escalation (Finance wiki) is right. Nothing of this item waits on the answer.',
    ]);
  });

  it('draws the question with what Day0 holds now, by its relation, and gives a settled one to the stop’s words (17-C)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const harness = convexTest(schema, allConvexModules());
    const { agentId, relationId, workItemId } = await askedInRequest(harness);
    const drawn = async () =>
      await asManager(harness).query(api.managerQuestions.conflictsForAgent, { agentId });
    // As asked: the plan declared no writes, so every write waits.
    expect(await drawn()).toEqual([
      {
        _id: expect.any(String),
        workItemId,
        relationId,
        question: ASKED,
        // Re-pinned for W17-R1 (D-11 (a)): each page carries its ref.
        pages: [
          { title: 'Finance escalation', source: 'Finance wiki', ref: 'escalation.md' },
          { title: 'Pipeline runbook', source: 'Handbook', ref: 'runbooks/pipeline-runbook.md' },
        ],
      },
    ]);
    // The plan as it stands now declares what its cited step writes: the card says that, where
    // the stored words still say every write (the pre-tag's "a question's stored words").
    await harness.run(async (ctx) => {
      const row = await ctx.db.get(workItemId);
      await ctx.db.patch(workItemId, {
        plan: {
          ...(row!.plan as object),
          obligations: {
            source: 'planner',
            steps: [{ kind: 'write', reads: [], writes: ['team-chat'] }],
          },
        },
      });
    });
    const [live] = await drawn();
    expect(live.question).toBe(
      'Two pages disagree under “Thresholds”: A, Finance escalation (Finance wiki), and B, Pipeline runbook (Handbook). Which is right? Priya runs the other steps now and holds its writes to Team chat until you answer and Retry.',
    );
    expect((await questionsOf(harness, workItemId))[0].question).toBe(ASKED);
    // Beside an item that is done or whose plan was turned down nothing is held, and the card
    // says so, its answers still offered: they decide the relation (the joins' W3k).
    for (const state of ['completed', 'cancelled'] as const) {
      await harness.run(async (ctx) => await ctx.db.patch(workItemId, { state }));
      const [finished] = await drawn();
      expect(finished.question).toBe(
        'Two pages disagree under “Thresholds”: A, Finance escalation (Finance wiki), and B, Pipeline runbook (Handbook). Which is right? Nothing of this item waits on the answer: other plans of Priya’s that rest on these pages do.',
      );
      expect(finished.pages).not.toBeNull();
    }
    await harness.run(async (ctx) => await ctx.db.patch(workItemId, { state: 'plan-pending' }));
    // Answered: no card draws it, and the stop beside it reads the answer.
    await asManager(harness).mutation(api.managerQuestions.answerConflict, {
      questionId: live._id,
      choice: 'from',
    });
    expect(await drawn()).toEqual([
      {
        _id: live._id,
        workItemId,
        relationId,
        question: ASKED,
        pages: null,
        settled: { answer: 'A, Finance escalation (Finance wiki) is right' },
      },
    ]);
  });

  it('closes the item’s open question at a redraft, and asks the new plan afresh on what it cites (17-C; W16-R27)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const harness = convexTest(schema, allConvexModules());
    const { relationId, surfaceId, workItemId } = await askedInRequest(harness);
    const cited = (await harness.run(async (ctx) => await ctx.db.get(workItemId)))!.plan as {
      cites: unknown[];
    };
    // The manager turned the plan down: Retry drafts a new one.
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, { state: 'cancelled', decision: undefined });
    });
    await asManager(harness).mutation(api.workRuns.retryFailed, { workItemId });
    const [old] = await questionsOf(harness, workItemId);
    expect(old.closed).toEqual({ reason: 'redrafted', at: Date.UTC(2026, 9, 1) });
    expect(old.answer).toBeUndefined();
    // Nothing of the old plan's is asked in the next request, on the card or of the poll.
    expect(
      await harness.query(internal.managerQuestions.conflictQuestionsForRequest, { workItemId }),
    ).toEqual([]);
    expect(
      await asManager(harness).query(api.managerQuestions.conflictsForAgent, {
        agentId: old.agentId,
      }),
    ).toMatchObject([{ _id: old._id, pages: null, settled: { closed: 'redrafted' } }]);
    // A new plan that rests on nothing of the conflict is asked nothing.
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        state: 'plan-pending',
        plan: { summary: 'Message the finance lead.', steps: ['Message the finance lead'] },
      });
    });
    await harness.mutation(internal.work.decidePlan, { workItemId });
    expect(await questionsOf(harness, workItemId)).toHaveLength(1);
    // One that cites the disputed passage again is asked afresh, as the plan's second question.
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        state: 'plan-pending',
        plan: {
          summary: 'Escalate the variance to the finance lead.',
          steps: ['Message the finance lead when the variance passes the threshold'],
          cites: cited.cites,
        },
      });
    });
    await harness.mutation(internal.work.decidePlan, { workItemId });
    const asked = await questionsOf(harness, workItemId);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatchObject({ relationId, question: ASKED });
    expect(asked[1].closed).toBeUndefined();
    expect(
      await harness.query(internal.managerQuestions.conflictQuestionsForRequest, { workItemId }),
    ).toEqual([{ text: ASKED, number: 2 }]);
    // A reply that numbers the old question is told what became of it: its pages still disagree,
    // so it is not said that they do not (17-C's second pass).
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        decision: {
          id: 'cd4xyz',
          kind: 'plan',
          requestedAt: Date.now(),
          channel: 'D0MANAGER',
          surfaceSlug: 'team-chat',
          surfaceName: 'Team chat',
          ts: '1790000100.000100',
        },
      });
    });
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs: '1790000200.000100',
        reply: { verb: 'answer', id: 'cd4xyz', choice: 'to', number: 1 },
      }),
    ).resolves.toMatchObject({ status: 'ignored', reason: 'question no longer open' });
    expect((await notices(harness)).map((notice) => notice.text)).toEqual([
      'Question 1 was closed when the plan was drafted again.',
    ]);
    expect((await relations(harness)).find((row) => row._id === relationId)?.status).toBe(
      'confirmed',
    );
  });

  it('writes a page’s own words into its replies escaped, so Slack reads no mention in a title (17-C’s second pass)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId, workItemId } = await askedInRequest(harness);
    await harness.run(async (ctx) => {
      for (const page of await ctx.db.query('docPages').collect()) {
        if (page.title === 'Pipeline runbook') {
          await ctx.db.patch(page._id, { title: 'Pipeline <!channel> runbook' });
        }
      }
    });
    await harness.mutation(internal.work.resolveChannelDecision, {
      surfaceId,
      userId: 'UMANAGER',
      messageTs: '1790000000.000100',
      reply: { verb: 'answer', id: 'ab3xyz', choice: 'to' },
    });
    await harness.mutation(internal.work.resolveChannelDecision, {
      surfaceId,
      userId: 'UMANAGER',
      messageTs: '1790000001.000100',
      reply: { verb: 'answer', id: 'ab3xyz', choice: 'to', number: 1 },
    });
    expect((await questionsOf(harness, workItemId))[0].answer?.text).toBe(
      'B, Pipeline <!channel> runbook (Handbook) is right',
    );
    expect((await notices(harness)).map((notice) => notice.text)).toEqual([
      'Recorded: B, Pipeline &lt;!channel&gt; runbook (Handbook) is right. Retry runs the steps that waited on it, drafted again where they relied on the other page.',
      'Question 1 was already answered: B, Pipeline &lt;!channel&gt; runbook (Handbook) is right.',
    ]);
  });

  it('closes a question whose conflict is settled by another’s answer, where it is refused, unlisted and owed nothing (17-C)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const harness = convexTest(schema, allConvexModules());
    const asked = await askedInRequest(harness);
    const { surfaceId, workItemId } = asked;
    const second = await secondQuestion(harness, asked);
    await harness.run(async (ctx) => {
      const row = await ctx.db.get(workItemId);
      await ctx.db.patch(workItemId, {
        state: 'plan-approved',
        decision: { ...row!.decision!, decidedAt: Date.now() - 2 * 60 * 60 * 1000 },
      });
    });
    // On the Documentation tab the manager names one page right on the second conflict: the
    // Finance page goes out of use, and with it the first conflict, which nobody answered.
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: second.relationId,
      decision: 'to-is-right',
    });
    const [first, answered] = await questionsOf(harness, workItemId);
    expect(answered.answer).toMatchObject({
      text: 'B, Pipeline runbook (Handbook) is right',
      via: 'dashboard',
    });
    expect(answered.closed).toBeUndefined();
    expect(first.answer).toBeUndefined();
    expect(first.closed).toEqual({ reason: 'settled', at: Date.UTC(2026, 9, 1) });
    // The closed question takes no answer, by the card or by its number, and is no longer drawn.
    await expect(
      asManager(harness).mutation(api.managerQuestions.answerConflict, {
        questionId: first._id,
        choice: 'from',
      }),
    ).rejects.toThrow('These two pages no longer disagree, so this question is closed.');
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs: '1790000000.000100',
        reply: { verb: 'answer', id: 'ab3xyz', choice: 'from', number: 1 },
      }),
    ).resolves.toMatchObject({ status: 'ignored', reason: 'question no longer open' });
    expect((await noticeTexts(harness)).at(-1)).toBe(
      'These two pages no longer disagree, so this question is closed.',
    );
    // Neither waits: the card draws no settled question.
    expect(
      (
        await asManager(harness).query(api.managerQuestions.conflictsForAgent, {
          agentId: first.agentId,
        })
      ).map((view) => view.settled),
    ).toEqual([{ answer: 'B, Pipeline runbook (Handbook) is right' }, { closed: 'settled' }]);
    expect(await harness.query(internal.managerQuestions.conflictHoldsFor, { workItemId })).toEqual(
      [],
    );
    // With nothing open the DM is no longer read for it.
    expect((await harness.query(internal.work.openDecisions, { surfaceId })).noticeOwed).toBe(
      false,
    );
  });

  it('closes, at the next run, a question whose conflict stopped standing by another path (17-C)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const harness = convexTest(schema, allConvexModules());
    const { relationId, workItemId } = await askedInRequest(harness);
    // While the conflict stands the run's read closes nothing.
    expect(await harness.mutation(internal.managerQuestions.closeSettled, { workItemId })).toBe(0);
    // The relation is taken back to a proposal by a path that passes no decision.
    await harness.run(async (ctx) => {
      await ctx.db.patch(relationId, { status: 'proposed' });
    });
    expect(await harness.mutation(internal.managerQuestions.closeSettled, { workItemId })).toBe(1);
    const [question] = await questionsOf(harness, workItemId);
    expect(question.closed).toEqual({ reason: 'settled', at: Date.UTC(2026, 9, 1) });
    expect(question.answer).toBeUndefined();
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
        // Re-pinned by 17-C: the view names the relation, by which a stop finds its question.
        relationId,
        question: ASKED,
        // Re-pinned for W17-R1 (D-11 (a)): each page carries its ref.
        pages: [
          { title: 'Finance escalation', source: 'Finance wiki', ref: 'escalation.md' },
          { title: 'Pipeline runbook', source: 'Handbook', ref: 'runbooks/pipeline-runbook.md' },
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
    // Re-pinned by 17-C: the answered question is no longer among those waiting (no card draws a
    // settled one, W16-R26), and is given with its answer for the words of a run that stopped on it.
    const after = await asManager(harness).query(api.managerQuestions.conflictsForAgent, {
      agentId,
    });
    expect(after.filter((view) => view.settled === undefined)).toEqual([]);
    expect(after).toMatchObject([{ _id: question._id, settled: { answer: 'Both hold' } }]);
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
      if (decision === 'disagree') await ranAsks(harness);
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
      if (decision === 'disagree') await ranAsks(harness);
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
