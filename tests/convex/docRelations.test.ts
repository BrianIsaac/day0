import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { replacePageBlocks } from '../../convex/docBlocks';
import * as docRelationsModule from '../../convex/docRelations';
import { DECISION_NOT_OFFERED, LIST_OPEN_ONE_CURSOR } from '../../convex/docRelations';
import { standingConflictOf } from '../../convex/docConflicts';
import { SUCCESSOR_NOT_CURRENT } from '../../convex/docStatus';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';
import { guardRefusal } from './fakes/anonymous-caller';
import {
  FINANCE,
  PIPELINE_V1,
  asManager,
  employee,
  eventsOf,
  measure,
  pageOf,
  relations,
  storedPage,
  syncingSource,
  twoThatDisagree,
  twoVersions,
  type Harness,
  type Source,
} from './fakes/doc-relations';

// A decision that supersedes a page re-admits parked work, which schedules its next step.
beforeEach((): void => {
  vi.useFakeTimers();
});
afterEach((): void => {
  vi.useRealTimers();
});

/** A relation as a conflict that stands, or null. */
async function standingOf(harness: Harness, relationId: Id<'docRelations'>) {
  return await harness.run(
    async (ctx) => (await standingConflictOf(ctx, await ctx.db.get(relationId))) ?? null,
  );
}

describe('decide: the manager’s answer on a relation’s card', (): void => {
  it('supersedes the older page when the successor is confirmed, and sends parked work back', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { wiki, official, v1, v2 } = await twoVersions(harness);
    const agentId = await employee(harness, 'Priya');
    const parked = await harness.run(
      async (ctx) =>
        await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: 'REVOPS-10',
          title: 'Refresh the pipeline tile',
          contentSummary: 'The tile is stale.',
          contentRefs: [],
          observedAt: 1,
          createdAt: 1,
          state: 'skipped',
          verdict: {
            decision: 'skip',
            reason: 'out-of-scope: no charter or current documented-system overlap',
          },
          skipReason: 'out-of-scope: no charter or current documented-system overlap',
        }),
    );
    await measure(harness, official, 'pipeline-runbook-v2.md');
    const [relation] = await relations(harness);
    vi.setSystemTime(new Date('2026-10-10T09:00:00.000Z'));
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: relation._id,
      decision: 'supersedes',
    });
    expect((await relations(harness))[0]).toMatchObject({
      kind: 'possible_successor',
      status: 'confirmed',
      decidedBy: MANAGER_ADDRESS,
      decidedAt: Date.parse('2026-10-10T09:00:00.000Z'),
    });
    expect(await pageOf(harness, v1)).toMatchObject({
      status: 'superseded',
      statusSource: 'relation',
      supersededBy: { sourceId: official.sourceId, ref: 'pipeline-runbook-v2.md' },
    });
    expect((await pageOf(harness, v2)).status).toBeUndefined();
    expect(await eventsOf(harness, agentId, 'work.requeued')).toEqual([
      {
        workItemId: parked,
        trigger: 'documentation',
        key: `documentation-status:${wiki.sourceId}:runbooks/pipeline-runbook.md:superseded`,
        previousState: 'skipped',
      },
    ]);
    expect(await eventsOf(harness, agentId, 'documentation.relation-decided')).toMatchObject([
      { relationId: relation._id, kind: 'possible_successor', decision: 'supersedes' },
    ]);
  });

  it('supersedes the other way when the manager says the proposed direction is wrong (W15-R45’s reverse button)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { wiki, official, v1, v2 } = await twoVersions(harness);
    await measure(harness, official, 'pipeline-runbook-v2.md');
    const [relation] = await relations(harness);
    // The measures proposed v2 as the later version; the manager says v1 is.
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: relation._id,
      decision: 'supersedes',
      reversed: true,
    });
    expect((await relations(harness))[0]).toMatchObject({
      kind: 'possible_successor',
      status: 'confirmed',
      from: { sourceId: wiki.sourceId, ref: 'runbooks/pipeline-runbook.md' },
      to: { sourceId: official.sourceId, ref: 'pipeline-runbook-v2.md' },
    });
    expect(await pageOf(harness, v2)).toMatchObject({
      status: 'superseded',
      statusSource: 'relation',
      supersededBy: { sourceId: wiki.sourceId, ref: 'runbooks/pipeline-runbook.md' },
    });
    expect((await pageOf(harness, v1)).status).toBeUndefined();
    // Undo takes the turn back with the answer: the card asks again as the measures proposed it
    // (the second pass), and the page it had superseded is current again.
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: relation._id,
      decision: 'undo',
    });
    const undone = (await relations(harness))[0];
    expect(undone).toMatchObject({
      status: 'proposed',
      from: { sourceId: official.sourceId, ref: 'pipeline-runbook-v2.md' },
      to: { sourceId: wiki.sourceId, ref: 'runbooks/pipeline-runbook.md' },
    });
    expect(undone.reversed).toBeUndefined();
    const restated = await pageOf(harness, v2);
    expect([restated.status, restated.supersededBy]).toEqual(['active', undefined]);
    // Reversing is the duplicate card's alone: no other answer has a direction to turn.
    await expect(
      asManager(harness).mutation(api.docRelations.decide, {
        relationId: relation._id,
        decision: 'keep-both',
        reversed: true,
      }),
    ).rejects.toThrow('Only “supersedes” can be answered the other way round.');
  });

  it('answers what became of the older page, which a source’s own word or the manager’s keeps as it was', async (): Promise<void> => {
    // The second pass's minor 13: the card said "now supersedes" whatever the rules made of it,
    // and a page its source calls current, or the manager decided by hand, is not superseded by
    // a relation.
    const harness = convexTest(schema, allConvexModules());
    const { official, v1 } = await twoVersions(harness);
    await measure(harness, official, 'pipeline-runbook-v2.md');
    const [relation] = await relations(harness);
    const supersede = async () =>
      await asManager(harness).mutation(api.docRelations.decide, {
        relationId: relation._id,
        decision: 'supersedes',
      });
    const undo = async () =>
      await asManager(harness).mutation(api.docRelations.decide, {
        relationId: relation._id,
        decision: 'undo',
      });
    expect(await supersede()).toEqual({ older: 'superseded', by: 'relation' });
    expect(await undo()).toBeNull();
    // The older page's front matter says it is current: the source's word stands over a relation.
    await harness.run(async (ctx) => {
      await ctx.db.patch(v1, {
        nativeStatus: 'active',
        status: 'active',
        statusSource: 'source-native',
      });
    });
    expect(await supersede()).toEqual({ older: 'active', by: 'source-native' });
    expect((await pageOf(harness, v1)).status).toBe('active');
  });

  it('changes no page for "Keep both" or "Not the same", and offers the card no second answer', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { official, v1, v2 } = await twoVersions(harness);
    await measure(harness, official, 'pipeline-runbook-v2.md');
    const [relation] = await relations(harness);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: relation._id,
      decision: 'keep-both',
    });
    // Both kept is no successor: the older page stays current.
    expect((await relations(harness))[0]).toMatchObject({
      kind: 'possible_duplicate',
      status: 'confirmed',
    });
    expect([(await pageOf(harness, v1)).status, (await pageOf(harness, v2)).status]).toEqual([
      undefined,
      undefined,
    ]);
    await expect(
      asManager(harness).mutation(api.docRelations.decide, {
        relationId: relation._id,
        decision: 'supersedes',
      }),
    ).rejects.toThrow(DECISION_NOT_OFFERED);
  });

  it('lets a confirmed conflict stand between two active pages of equal trust, until "Both hold"', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { handbook, finance } = await twoThatDisagree(harness);
    await measure(harness, finance, 'escalation.md');
    const [relation] = await relations(harness);
    const standing = async () => await standingOf(harness, relation._id);
    // Proposed only: nothing stands, nothing is held or tagged.
    expect(await standing()).toBeNull();
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: relation._id,
      decision: 'disagree',
    });
    expect(await standing()).toMatchObject({
      relationId: relation._id,
      from: { sourceId: finance.sourceId, title: 'Finance escalation', source: 'Finance wiki' },
      to: { sourceId: handbook.sourceId, title: 'Pipeline runbook', source: 'Handbook' },
      heading: 'Thresholds',
      figures: { from: '10,000', to: '5,000' },
    });
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: relation._id,
      decision: 'both-hold',
    });
    expect(await standing()).toBeNull();
    expect((await relations(harness))[0].status).toBe('dismissed');
  });

  it('marks the other page superseded in the manager’s name when one is right, which ends the conflict', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { handbook, finance, a, b } = await twoThatDisagree(harness);
    await measure(harness, finance, 'escalation.md');
    const [relation] = await relations(harness);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: relation._id,
      decision: 'disagree',
    });
    // The handbook's page is the relation's `to`.
    expect(relation.to.sourceId).toBe(handbook.sourceId);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: relation._id,
      decision: 'to-is-right',
    });
    expect(await pageOf(harness, b)).toMatchObject({
      status: 'superseded',
      statusSource: 'manager',
      decidedBy: MANAGER_ADDRESS,
      supersededBy: { sourceId: handbook.sourceId, ref: 'runbooks/pipeline-runbook.md' },
    });
    expect((await pageOf(harness, a)).status).toBeUndefined();
    expect(await standingOf(harness, relation._id)).toBeNull();
  });

  it('refuses a stale second answer on a conflict already settled, so the two pages never supersede each other (W15-R6)', async (): Promise<void> => {
    // Reader 2's vt/a.test.ts R2-A: two tabs show the proposed card; one answers "{A} is right",
    // the other, stale, "{B} is right". The second was taken, and neither page was current.
    const harness = convexTest(schema, allConvexModules());
    const { handbook, finance, a, b } = await twoThatDisagree(harness);
    await measure(harness, finance, 'escalation.md');
    const [relation] = await relations(harness);
    expect(relation.from.sourceId).toBe(finance.sourceId);
    const answer = async (decision: 'from-is-right' | 'to-is-right' | 'both-hold') =>
      await asManager(harness).mutation(api.docRelations.decide, {
        relationId: relation._id,
        decision,
      });
    await answer('from-is-right');
    expect(await pageOf(harness, a)).toMatchObject({
      status: 'superseded',
      supersededBy: { sourceId: finance.sourceId, ref: 'escalation.md' },
    });
    for (const stale of ['to-is-right', 'from-is-right', 'both-hold'] as const) {
      await expect(answer(stale), stale).rejects.toThrow(DECISION_NOT_OFFERED);
    }
    // The page the first answer named right is still current, and the other still gives way to it.
    expect((await pageOf(harness, b)).status).toBeUndefined();
    expect((await pageOf(harness, a)).status).toBe('superseded');
    expect((await relations(harness))[0]).toMatchObject({ status: 'confirmed' });
    // "This is current" on the superseded page's row is the way back: the conflict stands again
    // and takes its answers.
    await asManager(harness).mutation(api.docStatus.setPageStatus, { pageId: a, status: 'active' });
    expect(await standingOf(harness, relation._id)).not.toBeNull();
    await answer('to-is-right');
    expect((await pageOf(harness, b)).status).toBe('superseded');
    expect((await pageOf(harness, a)).status).toBe('active');
    expect(handbook.sourceId).toBe(relation.to.sourceId);
  });

  it('refuses an answer that would make a page that is not current stand in for another (W15-R6)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { finance, a, b } = await twoThatDisagree(harness);
    await measure(harness, finance, 'escalation.md');
    const [conflict] = await relations(harness);
    // The card was drawn while both pages were current; the finance page is then archived by hand.
    await asManager(harness).mutation(api.docStatus.setPageStatus, {
      pageId: b,
      status: 'archived',
    });
    await expect(
      asManager(harness).mutation(api.docRelations.decide, {
        relationId: conflict._id,
        decision: 'from-is-right',
      }),
    ).rejects.toThrow(SUCCESSOR_NOT_CURRENT);
    expect((await pageOf(harness, a)).status).toBeUndefined();
    expect((await relations(harness))[0]).toMatchObject({ status: 'proposed' });

    const versions = convexTest(schema, allConvexModules());
    const { official, v1, v2 } = await twoVersions(versions);
    await measure(versions, official, 'pipeline-runbook-v2.md');
    const [successor] = await relations(versions);
    await asManager(versions).mutation(api.docStatus.setPageStatus, {
      pageId: v2,
      status: 'draft',
    });
    await expect(
      asManager(versions).mutation(api.docRelations.decide, {
        relationId: successor._id,
        decision: 'supersedes',
      }),
    ).rejects.toThrow(SUCCESSOR_NOT_CURRENT);
    expect((await pageOf(versions, v1)).status).toBeUndefined();
    expect((await relations(versions))[0]).toMatchObject({ status: 'proposed' });
  });

  it('lets no conflict stand between pages of unequal trust, and offers no "They disagree" that would hold nothing', async (): Promise<void> => {
    // The second pass's minor 3: "They disagree" on such a pair was recorded, tagged no cite,
    // held no plan and took the card away, while the card said a step would be held.
    const harness = convexTest(schema, allConvexModules());
    const { finance, handbook } = await twoThatDisagree(harness, { finance: 'official' });
    await measure(harness, finance, 'escalation.md');
    const [relation] = await relations(harness);
    const [card] = (await asManager(harness).query(api.docRelations.listOpen, {})).cards;
    expect(card.offered).toEqual(['from-is-right', 'to-is-right', 'both-hold']);
    expect([card.from.authority, card.to.authority]).toEqual(['official', 'team']);
    await expect(
      asManager(harness).mutation(api.docRelations.decide, {
        relationId: relation._id,
        decision: 'disagree',
      }),
    ).rejects.toThrow(DECISION_NOT_OFFERED);
    expect((await relations(harness))[0].status).toBe('proposed');
    // A conflict confirmed between equals stops standing once the manager trusts one page more.
    await asManager(harness).mutation(api.docStatus.setSourceAuthority, {
      sourceId: finance.sourceId,
      authority: 'team',
    });
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: relation._id,
      decision: 'disagree',
    });
    expect(await standingOf(harness, relation._id)).not.toBeNull();
    await asManager(harness).mutation(api.docStatus.setSourceAuthority, {
      sourceId: handbook.sourceId,
      authority: 'official',
    });
    expect(await standingOf(harness, relation._id)).toBeNull();
  });

  it('takes a confirmed successor back: the older page is current again and the card asks again', async (): Promise<void> => {
    // The second pass's major 1: a wrong "supersedes" could not be undone.
    const harness = convexTest(schema, allConvexModules());
    const { official, v1 } = await twoVersions(harness);
    const agentId = await employee(harness, 'Priya');
    await measure(harness, official, 'pipeline-runbook-v2.md');
    const [relation] = await relations(harness);
    const decide = async (decision: 'supersedes' | 'undo'): Promise<unknown> =>
      await asManager(harness).mutation(api.docRelations.decide, {
        relationId: relation._id,
        decision,
      });
    // A card not yet answered has nothing to take back.
    await expect(decide('undo')).rejects.toThrow(DECISION_NOT_OFFERED);
    await decide('supersedes');
    expect((await pageOf(harness, v1)).status).toBe('superseded');
    await decide('undo');
    const [undone] = await relations(harness);
    expect([undone.kind, undone.status, undone.decidedBy, undone.decidedAt]).toEqual([
      'possible_successor',
      'proposed',
      undefined,
      undefined,
    ]);
    const older = await pageOf(harness, v1);
    expect([older.status, older.statusSource, older.supersededBy]).toEqual([
      'active',
      'default',
      undefined,
    ]);
    expect(
      (await eventsOf(harness, agentId, 'documentation.relation-decided')).map(
        (event) => event.decision,
      ),
    ).toEqual(['supersedes', 'undo']);
    expect((await asManager(harness).query(api.docRelations.listOpen, {})).cards).toMatchObject([
      {
        _id: relation._id,
        status: 'proposed',
        offered: ['supersedes', 'keep-both', 'not-the-same'],
      },
    ]);
  });

  it('takes "Keep both", "Not the same" and "Both hold" back to the card, and offers no undo on a conflict that stands', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { official } = await twoVersions(harness);
    await measure(harness, official, 'pipeline-runbook-v2.md');
    const [versions] = await relations(harness);
    const decide = async (
      relationId: Id<'docRelations'>,
      decision: 'keep-both' | 'not-the-same' | 'disagree' | 'both-hold' | 'undo',
    ): Promise<unknown> =>
      await asManager(harness).mutation(api.docRelations.decide, { relationId, decision });
    for (const decision of ['keep-both', 'not-the-same'] as const) {
      await decide(versions._id, decision);
      await decide(versions._id, 'undo');
      expect((await relations(harness))[0].status).toBe('proposed');
    }
    const { finance } = await twoThatDisagree(harness);
    await measure(harness, finance, 'escalation.md');
    const conflict = (await relations(harness)).find((row) => row.kind === 'possible_conflict')!;
    await decide(conflict._id, 'disagree');
    // A confirmed conflict stands with its own three answers; "Both hold" is how it is let go.
    await expect(decide(conflict._id, 'undo')).rejects.toThrow(DECISION_NOT_OFFERED);
    await decide(conflict._id, 'both-hold');
    await decide(conflict._id, 'undo');
    const again = (await relations(harness)).find((row) => row._id === conflict._id)!;
    expect([again.kind, again.status]).toEqual(['possible_conflict', 'proposed']);
    expect(await standingOf(harness, conflict._id)).toBeNull();
  });

  it('restores the kind the measures proposed when an answer that changed it is taken back (W15-R22)', async (): Promise<void> => {
    // The review: a duplicate answered "supersedes" and undone came back a successor, with the
    // successor's words on its card; a successor answered "Keep both", a duplicate.
    const harness = convexTest(schema, allConvexModules());
    const wiki = await syncingSource(harness, 'Team wiki');
    const copies = await syncingSource(harness, 'Copies');
    const text = '# Close checklist\n\nTick each line before the close.';
    await storedPage(harness, wiki, { ref: 'close.md', title: 'Close checklist', markdown: text });
    await storedPage(harness, copies, {
      ref: 'close-copy.md',
      title: 'My close notes',
      markdown: text.replace('# Close checklist', '# My close notes'),
      updatedAt: 2,
    });
    const { official } = await twoVersions(harness);
    await measure(harness, copies, 'close-copy.md');
    await measure(harness, official, 'pipeline-runbook-v2.md');
    const rows = await relations(harness);
    const duplicate = rows.find((row) => row.kind === 'possible_duplicate')!;
    const successor = rows.find((row) => row.kind === 'possible_successor')!;
    const decide = async (
      relationId: Id<'docRelations'>,
      decision: 'supersedes' | 'keep-both' | 'undo',
    ): Promise<unknown> =>
      await asManager(harness).mutation(api.docRelations.decide, { relationId, decision });
    const row = async (relationId: Id<'docRelations'>) =>
      (await relations(harness)).find((each) => each._id === relationId)!;
    await decide(duplicate._id, 'supersedes');
    expect([(await row(duplicate._id)).kind, (await row(duplicate._id)).proposedKind]).toEqual([
      'possible_successor',
      'possible_duplicate',
    ]);
    await decide(duplicate._id, 'undo');
    expect([(await row(duplicate._id)).kind, (await row(duplicate._id)).proposedKind]).toEqual([
      'possible_duplicate',
      undefined,
    ]);
    await decide(successor._id, 'keep-both');
    await decide(successor._id, 'undo');
    expect([(await row(successor._id)).kind, (await row(successor._id)).status]).toEqual([
      'possible_successor',
      'proposed',
    ]);
    // An answer that kept the kind writes none, and its undo changes no kind.
    await decide(successor._id, 'supersedes');
    expect((await row(successor._id)).proposedKind).toBeUndefined();
    await decide(successor._id, 'undo');
    expect((await row(successor._id)).kind).toBe('possible_successor');
  });

  it('is the owner’s alone', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { official } = await twoVersions(harness);
    await measure(harness, official, 'pipeline-runbook-v2.md');
    const [relation] = await relations(harness);
    await expect(
      harness.withIdentity(managerIdentity('stranger')).mutation(api.docRelations.decide, {
        relationId: relation._id,
        decision: 'supersedes',
      }),
    ).rejects.toThrow('forbidden');
    await expect(
      harness.mutation(api.docRelations.decide, {
        relationId: relation._id,
        decision: 'supersedes',
      }),
    ).rejects.toThrow();
    expect((await relations(harness))[0].status).toBe('proposed');
  });
});

describe('listOpen: the cards the manager has still to answer', (): void => {
  it('draws each proposed relation with its pages, its measures and the answers it offers, and a confirmed conflict while it stands', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { official } = await twoVersions(harness);
    await measure(harness, official, 'pipeline-runbook-v2.md');
    const finance = await syncingSource(harness, 'Finance wiki');
    await storedPage(harness, finance, {
      ref: 'escalation.md',
      title: 'Finance escalation',
      markdown: FINANCE,
      updatedAt: 3,
    });
    await measure(harness, finance, 'escalation.md');
    const cards = (await asManager(harness).query(api.docRelations.listOpen, {})).cards;
    expect(cards.map((card) => [card.kind, card.status, card.offered])).toEqual([
      ['possible_conflict', 'proposed', ['disagree', 'from-is-right', 'to-is-right', 'both-hold']],
      ['possible_successor', 'proposed', ['supersedes', 'keep-both', 'not-the-same']],
    ]);
    expect(cards[0]).toMatchObject({
      from: { title: 'Finance escalation', source: 'Finance wiki', updatedAt: 3 },
      disagreement: { heading: 'Thresholds', figures: { from: '10,000', to: '5,000' } },
    });
    expect(cards[1]).toMatchObject({
      from: { title: 'Pipeline runbook', source: 'Official runbooks' },
      to: { title: 'Pipeline runbook', source: 'Team wiki' },
      evidence: [{ measure: 'names-successor', value: 1 }, expect.anything()],
    });
    // Confirmed, the conflict's card stays, offering how to settle it.
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: cards[0]._id,
      decision: 'disagree',
    });
    const after = (await asManager(harness).query(api.docRelations.listOpen, {})).cards;
    expect(after.map((card) => [card.kind, card.status, card.offered])).toEqual([
      ['possible_successor', 'proposed', ['supersedes', 'keep-both', 'not-the-same']],
      ['possible_conflict', 'confirmed', ['from-is-right', 'to-is-right', 'both-hold']],
    ]);
    // Whether a page's time is its edit time is its source's kind (W15-R45): a list of URLs is
    // given none and stamps a page with when it read it, on a proposed card and a confirmed one.
    expect(after.map((card) => [card.from.edited, card.to.edited])).toEqual([
      [true, true],
      [true, true],
    ]);
    await harness.run(async (ctx) => await ctx.db.patch(finance.sourceId, { kind: 'urls' }));
    await harness.run(async (ctx) => await ctx.db.patch(official.sourceId, { kind: 'mcp' }));
    const read = (await asManager(harness).query(api.docRelations.listOpen, {})).cards;
    expect(read.map((card) => [card.kind, card.from.edited, card.to.edited])).toEqual([
      ['possible_successor', false, true],
      ['possible_conflict', false, true],
    ]);
    // A page that says which its time is overrules its kind (D-8 (a)): read from a list of URLs
    // and dated by its source, it is "edited" and says so; from a folder and dated by the time
    // Day0 read it, "last read". A page stored before it could say reads by its kind, and its
    // card makes no claim.
    const dated = async (ref: string, datedBySource: boolean): Promise<void> =>
      await harness.run(async (ctx) => {
        const page = await ctx.db
          .query('docPages')
          .filter((q) => q.eq(q.field('ref'), ref))
          .unique();
        await ctx.db.patch(page!._id, { datedBySource });
      });
    await dated('escalation.md', true);
    await dated('runbooks/pipeline-runbook.md', false);
    const said = (await asManager(harness).query(api.docRelations.listOpen, {})).cards;
    expect(
      said.map((card) => [
        card.kind,
        [card.from.edited, card.from.dated],
        [card.to.edited, card.to.dated],
      ]),
    ).toEqual([
      ['possible_successor', [false, false], [false, false]],
      ['possible_conflict', [true, true], [false, false]],
    ]);
    // Another manager sees none of them.
    // Re-pinned for W17-R9 (D-10 (a)): the read says how many proposals it did not draw; and
    // by 18-D for D-10's read-more, where the next read of the proposals goes on (none here).
    expect(
      await harness.withIdentity(managerIdentity('stranger')).query(api.docRelations.listOpen, {}),
    ).toEqual({
      cards: [],
      next: null,
      proposalsNext: null,
      notShown: { proposals: 0, atLeast: false },
    });
  });

  // W17-R9 with D-10 (a) (the review's bed 1): 58 proposed conflicts drew 21 cards and nothing said
  // 38 more were behind them.
  it('says how many proposals past the twenty it draws it did not show, and that more may stand past its read (W17-R9)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const wiki = await syncingSource(harness, 'Team wiki');
    const relate = async (count: number): Promise<void> => {
      await storedPage(harness, wiki, {
        ref: 'policy-0.md',
        title: 'Policy 0',
        markdown: '# Policy 0',
      });
      for (let pair = 1; pair <= count; pair += 1) {
        await storedPage(harness, wiki, {
          ref: `policy-${pair}.md`,
          title: `Policy ${pair}`,
          markdown: `# Policy ${pair}`,
        });
        await harness.run(async (ctx) => {
          await ctx.db.insert('docRelations', {
            userId: 'owner',
            from: { sourceId: wiki.sourceId, ref: `policy-${pair}.md` },
            to: { sourceId: wiki.sourceId, ref: 'policy-0.md' },
            kind: 'possible_duplicate',
            evidence: [{ measure: 'shared-text', value: 70 }],
            status: 'proposed',
            createdAt: pair,
          });
        });
      }
    };
    await relate(25);
    const read = await asManager(harness).query(api.docRelations.listOpen, {});
    expect(read.cards).toHaveLength(20);
    expect(read.notShown).toEqual({ proposals: 5, atLeast: false });
  }, 30_000);

  // D-10's read-more (the review's W17-R9, ruled 14 October): the tab read on for confirmed
  // conflicts only, so past twenty proposals the rest waited until the twenty were answered.
  it('`listOpen` from a proposals cursor answers the proposals past twenty, and a caller who is not the owner is refused', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const wiki = await syncingSource(harness, 'Team wiki');
    await storedPage(harness, wiki, {
      ref: 'policy-0.md',
      title: 'Policy 0',
      markdown: '# Policy 0',
    });
    for (let pair = 1; pair <= 45; pair += 1) {
      await storedPage(harness, wiki, {
        ref: `policy-${pair}.md`,
        title: `Policy ${pair}`,
        markdown: `# Policy ${pair}`,
      });
      await harness.run(async (ctx) => {
        await ctx.db.insert('docRelations', {
          userId: 'owner',
          from: { sourceId: wiki.sourceId, ref: `policy-${pair}.md` },
          to: { sourceId: wiki.sourceId, ref: 'policy-0.md' },
          kind: 'possible_duplicate',
          evidence: [{ measure: 'shared-text', value: 70 }],
          status: 'proposed',
          createdAt: pair,
        });
      });
    }
    const manager = asManager(harness);
    const titles = (read: { cards: Array<{ from: { title: string } }> }): string[] =>
      read.cards.map((card) => card.from.title);
    const first = await manager.query(api.docRelations.listOpen, {});
    expect(titles(first)).toEqual(Array.from({ length: 20 }, (_, n) => `Policy ${45 - n}`));
    expect(first.proposalsNext).not.toBeNull();
    const second = await manager.query(api.docRelations.listOpen, {
      proposalsBefore: first.proposalsNext!,
    });
    // The next twenty, newest first; no confirmed conflict is read again on the way.
    expect(titles(second)).toEqual(Array.from({ length: 20 }, (_, n) => `Policy ${25 - n}`));
    expect(second).toMatchObject({ next: null, notShown: { proposals: 5, atLeast: false } });
    const third = await manager.query(api.docRelations.listOpen, {
      proposalsBefore: second.proposalsNext!,
    });
    expect(titles(third)).toEqual(['Policy 5', 'Policy 4', 'Policy 3', 'Policy 2', 'Policy 1']);
    expect(third).toMatchObject({
      proposalsNext: null,
      notShown: { proposals: 0, atLeast: false },
    });
    // A read goes on from one place: both cursors at once are refused in the client's words.
    await expect(
      manager.query(api.docRelations.listOpen, {
        proposalsBefore: first.proposalsNext!,
        conflictsBefore: 1,
      }),
    ).rejects.toMatchObject({ data: LIST_OPEN_ONE_CURSOR });
    // A caller who is not the owner: refused signed out, and handed none of the owner's cards
    // whatever cursor they hold.
    await expect(
      harness.query(api.docRelations.listOpen, { proposalsBefore: first.proposalsNext! }),
    ).rejects.toMatchObject(await guardRefusal());
    expect(
      await harness
        .withIdentity(managerIdentity('stranger'))
        .query(api.docRelations.listOpen, { proposalsBefore: first.proposalsNext! }),
    ).toEqual({
      cards: [],
      next: null,
      proposalsNext: null,
      notShown: { proposals: 0, atLeast: false },
    });
  }, 60_000);

  it('draws a live card behind any number of proposals whose pages are no longer current', async (): Promise<void> => {
    // The second pass's minor 4: the read took the newest 20 proposals and drew the live ones
    // among them, so 20 dead rows above a live card hid it.
    const harness = convexTest(schema, allConvexModules());
    const { official } = await twoVersions(harness);
    await measure(harness, official, 'pipeline-runbook-v2.md');
    const dead = await syncingSource(harness, 'Old wiki');
    for (let pair = 0; pair < 25; pair += 1) {
      await storedPage(harness, dead, {
        ref: `old-${pair}.md`,
        title: `Old ${pair}`,
        markdown: `# Old ${pair}\n\nRetired.`,
      });
      await harness.run(async (ctx) => {
        const page = await ctx.db
          .query('docPages')
          .withIndex('by_source_ref', (q) =>
            q.eq('sourceId', dead.sourceId).eq('ref', `old-${pair}.md`),
          )
          .unique();
        await ctx.db.patch(page!._id, { status: 'archived', statusSource: 'manager' });
        await replacePageBlocks(ctx, {
          userId: 'owner',
          sourceId: dead.sourceId,
          pageRef: `old-${pair}.md`,
          generation: dead.runId,
          markdown: page!.markdown,
          status: 'archived',
        });
        await ctx.db.insert('docRelations', {
          userId: 'owner',
          from: { sourceId: official.sourceId, ref: 'pipeline-runbook-v2.md' },
          to: { sourceId: dead.sourceId, ref: `old-${pair}.md` },
          kind: 'possible_duplicate',
          evidence: [{ measure: 'shared-text', value: 70 }],
          status: 'proposed',
          createdAt: 10 + pair,
        });
      });
    }
    const cards = (await asManager(harness).query(api.docRelations.listOpen, {})).cards;
    expect(cards.map((card) => [card.kind, card.to.title])).toEqual([
      ['possible_successor', 'Pipeline runbook'],
    ]);
  });

  it('draws a confirmed conflict before the proposals spend the read on their pages (W15-R22)', async (): Promise<void> => {
    // The review: three proposals of 740,000-character pages spent the 8 MiB the cards may read,
    // and the confirmed conflict behind them, which holds plans, drew no card.
    const harness = convexTest(schema, allConvexModules());
    const { handbook, finance } = await twoThatDisagree(harness);
    await measure(harness, finance, 'escalation.md');
    const [conflict] = await relations(harness);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: conflict._id,
      decision: 'disagree',
    });
    const body = `# Long\n\n${'x'.repeat(740_000)}`;
    for (let pair = 0; pair < 3; pair += 1) {
      await harness.run(async (ctx) => {
        for (const side of ['a', 'b']) {
          await ctx.db.insert('docPages', {
            sourceId: handbook.sourceId,
            ref: `long-${pair}-${side}.md`,
            title: `Long ${pair} ${side}`,
            markdown: body,
            updatedAt: 1,
          });
        }
        await ctx.db.insert('docRelations', {
          userId: 'owner',
          from: { sourceId: handbook.sourceId, ref: `long-${pair}-b.md` },
          to: { sourceId: handbook.sourceId, ref: `long-${pair}-a.md` },
          kind: 'possible_duplicate',
          evidence: [{ measure: 'shared-text', value: 100 }],
          status: 'proposed',
          createdAt: 10 + pair,
        });
      });
    }
    const drawn = (await asManager(harness).query(api.docRelations.listOpen, {})).cards;
    expect(drawn.map((card) => [card.kind, card.status])).toContainEqual([
      'possible_conflict',
      'confirmed',
    ]);
    expect(drawn.length).toBeGreaterThan(1);
  }, 30_000);

  it('draws cards only while their pages fit one read, and the rest once those are answered', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await syncingSource(harness, 'Team wiki');
    // Four pairs of pages near the largest a page may be: all eight bodies pass one query's read.
    const body = `# Long\n\n${'x'.repeat(700 * 1024)}`;
    for (let pair = 0; pair < 4; pair += 1) {
      await harness.run(async (ctx) => {
        for (const side of ['a', 'b']) {
          await ctx.db.insert('docPages', {
            sourceId: source.sourceId,
            ref: `long-${pair}-${side}.md`,
            title: `Long ${pair} ${side}`,
            markdown: body,
            updatedAt: 1,
          });
        }
        await ctx.db.insert('docRelations', {
          userId: 'owner',
          from: { sourceId: source.sourceId, ref: `long-${pair}-b.md` },
          to: { sourceId: source.sourceId, ref: `long-${pair}-a.md` },
          kind: 'possible_duplicate',
          evidence: [{ measure: 'shared-text', value: 100 }],
          status: 'proposed',
          createdAt: pair,
        });
      });
    }
    const drawn = (await asManager(harness).query(api.docRelations.listOpen, {})).cards;
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThan(4);
    expect(drawn[0].from.title).toBe('Long 3 b');
    // Answered, a drawn card makes room for the next.
    for (const card of drawn) {
      await asManager(harness).mutation(api.docRelations.decide, {
        relationId: card._id,
        decision: 'not-the-same',
      });
    }
    const next = (await asManager(harness).query(api.docRelations.listOpen, {})).cards;
    expect(next[0].from.title).not.toBe('Long 3 b');
    expect(next.length).toBeGreaterThan(0);
  }, 30_000);
});

/** What Convex sets on a function a module exports. */
interface RegisteredFunction {
  readonly isQuery?: boolean;
  readonly isMutation?: boolean;
  readonly isAction?: boolean;
  readonly isPublic?: boolean;
  readonly exportArgs?: () => string;
}

describe('a conflict whose page’s title is renamed (W15-R21)', (): void => {
  /** Store a page's new text and split it, as the sync does for a page that changed. */
  async function restore(
    harness: Harness,
    source: Source,
    pageId: Id<'docPages'>,
    page: { title: string; markdown: string },
  ): Promise<void> {
    const { ref } = await harness.run(async (ctx) => {
      await ctx.db.patch(pageId, page);
      return (await ctx.db.get(pageId))!;
    });
    await harness.mutation(internal.docBlocks.splitStoredPage, {
      sourceId: source.sourceId,
      ref,
      generation: source.runId,
    });
  }

  const RENAMED = {
    title: 'Pipeline runbook for RevOps',
    markdown: PIPELINE_V1.replace('# Pipeline runbook', '# Pipeline runbook for RevOps'),
  };

  it('keeps the confirmed conflict standing, on its card and for the selection, when the H1 changes and the figures do not', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { handbook, finance, a } = await twoThatDisagree(harness);
    await measure(harness, finance, 'escalation.md');
    const [proposed] = await relations(harness);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: proposed._id,
      decision: 'disagree',
    });
    await restore(harness, handbook, a, RENAMED);
    const cards = (await asManager(harness).query(api.docRelations.listOpen, {})).cards;
    expect(cards).toMatchObject([
      {
        _id: proposed._id,
        kind: 'possible_conflict',
        status: 'confirmed',
        to: { title: 'Pipeline runbook for RevOps' },
        disagreement: { heading: 'Thresholds', figures: { from: '10,000', to: '5,000' } },
      },
    ]);
    // Measured again, as the sync measures a page it stored: no second row for the pair.
    expect(await measure(harness, handbook, 'runbooks/pipeline-runbook.md')).toBe(0);
    expect(await relations(harness)).toMatchObject([{ _id: proposed._id, status: 'confirmed' }]);
  });

  it('does not propose again a conflict the manager set aside, for a rename alone', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { handbook, finance, a } = await twoThatDisagree(harness);
    await measure(harness, finance, 'escalation.md');
    const [proposed] = await relations(harness);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: proposed._id,
      decision: 'both-hold',
    });
    await restore(harness, handbook, a, RENAMED);
    expect(await measure(harness, handbook, 'runbooks/pipeline-runbook.md')).toBe(0);
    expect(await relations(harness)).toMatchObject([{ _id: proposed._id, status: 'dismissed' }]);
  });

  it('asks again where the figure changed with the title: that is another disagreement', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { handbook, finance, a } = await twoThatDisagree(harness);
    await measure(harness, finance, 'escalation.md');
    const [proposed] = await relations(harness);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: proposed._id,
      decision: 'both-hold',
    });
    await restore(harness, handbook, a, {
      title: RENAMED.title,
      markdown: RENAMED.markdown.replace('5,000', '7,000'),
    });
    expect(await measure(harness, handbook, 'runbooks/pipeline-runbook.md')).toBe(1);
    expect((await relations(harness)).map((row) => row.status)).toEqual(['dismissed', 'proposed']);
  });
});

describe('the functions convex/docRelations.ts registers', (): void => {
  // The split of its helpers (wave 16, 16-s; decision S-1) moves no registered function: each
  // `api.docRelations.*` and `internal.docRelations.*` path is a string the app, the sync's
  // actions and the scheduler hold. The list as `v0.19.0` registered it.
  it('are the ones it registered at v0.19.0 but for the measure split a pair a transaction (D-12 (a)), each of the same kind and visibility', (): void => {
    const registered = Object.entries(
      docRelationsModule as unknown as Record<string, RegisteredFunction | undefined>,
    )
      .filter(([, value]) => value?.exportArgs !== undefined)
      .map(([name, value]) => {
        const kind = value?.isQuery ? 'query' : value?.isMutation ? 'mutation' : 'action';
        return `${name} ${value?.isPublic === true ? 'public' : 'internal'} ${kind}`;
      })
      .sort((left, right) => left.localeCompare(right));
    // Re-taken by 17-C for one internal mutation added, `askConfirmed`: the asking a confirmation
    // schedules out of its own transaction; and by the joins for `turnPageQuestions`, the step a
    // page's change of status schedules for its conflict questions. No function it registered at
    // v0.19.0 moved. Re-taken by 18-D for D-12 (a): `measurePage`, a mutation that read every
    // candidate, is `pageCandidates` and `measurePair`, each pair in its own transaction, called
    // by `docSyncActions.measurePage` (nothing scheduled it, so no job names it at an upgrade).
    expect(registered).toEqual([
      'askConfirmed internal mutation',
      'decide public mutation',
      'generationsToMeasure internal query',
      'listOpen public query',
      'measurePair internal mutation',
      'measuringPlan internal query',
      'pageCandidates internal query',
      'pagesWrittenBy internal query',
      'settleRelationsOwed internal mutation',
      'turnPageQuestions internal mutation',
    ]);
  });
});

// 18-D's proposals cursor beside 18-C's conflicts cursor in one owner's chain (the joins, 18-J):
// each kind goes on from its own cursor, the conflicts' `next` the last conflict drawn (C-H) and
// the proposals' `proposalsNext` the last proposal looked at, and no card is drawn twice.
describe('listOpen with confirmed conflicts and proposals past twenty (the joins)', (): void => {
  it('draws each card once: the conflict on the first read, the proposals on by their own cursor', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { handbook, finance } = await twoThatDisagree(harness);
    await measure(harness, finance, 'escalation.md');
    const [conflict] = await relations(harness);
    await asManager(harness).mutation(api.docRelations.decide, {
      relationId: conflict._id,
      decision: 'disagree',
    });
    await storedPage(harness, handbook, {
      ref: 'policy-0.md',
      title: 'Policy 0',
      markdown: '# Policy 0',
    });
    for (let pair = 1; pair <= 45; pair += 1) {
      await storedPage(harness, handbook, {
        ref: `policy-${pair}.md`,
        title: `Policy ${pair}`,
        markdown: `# Policy ${pair}`,
      });
      await harness.run(async (ctx) => {
        await ctx.db.insert('docRelations', {
          userId: 'owner',
          from: { sourceId: handbook.sourceId, ref: `policy-${pair}.md` },
          to: { sourceId: handbook.sourceId, ref: 'policy-0.md' },
          kind: 'possible_duplicate',
          evidence: [{ measure: 'shared-text', value: 70 }],
          status: 'proposed',
          createdAt: pair,
        });
      });
    }
    const manager = asManager(harness);
    const first = await manager.query(api.docRelations.listOpen, {});
    const confirmedIn = (read: { cards: Array<{ _id: string; status: string }> }): string[] =>
      read.cards.filter((card) => card.status === 'confirmed').map((card) => card._id);
    expect(confirmedIn(first)).toEqual([conflict._id]);
    // The conflicts' chain ends with the read that drew them all; the proposals' goes on.
    expect(first.next).toBeNull();
    expect(first.proposalsNext).not.toBeNull();
    const second = await manager.query(api.docRelations.listOpen, {
      proposalsBefore: first.proposalsNext!,
    });
    const third = await manager.query(api.docRelations.listOpen, {
      proposalsBefore: second.proposalsNext!,
    });
    expect(confirmedIn(second)).toEqual([]);
    expect(confirmedIn(third)).toEqual([]);
    expect(third.proposalsNext).toBeNull();
    const drawn = [first, second, third].flatMap((read) => read.cards.map((card) => card._id));
    expect(new Set(drawn).size).toBe(drawn.length);
    expect(drawn).toHaveLength(46);
  }, 60_000);
});
