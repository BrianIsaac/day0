import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { openCards } from '../../convex/reorientation';
import { proposalFingerprint } from '../../src/agent/reorientation-words';
import { allConvexModules } from './all-modules';
import { OWNER_SUBJECT, managerIdentity } from './fakes/manager-identity';
import {
  basisOf,
  cardOf,
  fieldsOf,
  cardsOf,
  eventTypesOf,
  openTestCard,
  scheduledAs,
  seedEmployee,
  seedWork,
  warnedBy,
  type Harness,
} from './fakes/reorientation';

/*
 * A reorientation card's decisions (16-O; section 5.2): Approve applies the proposal through the
 * target's own transaction helper and writes its event; Dismiss and Defer change nothing; a
 * high-risk card holds its plans at the plan's decision and lets them go on Approve or Dismiss.
 */

const OWNER = managerIdentity();

beforeEach((): void => {
  vi.useFakeTimers();
});
afterEach((): void => {
  vi.useRealTimers();
});

/** Open a card and put a proposal on it, as the judgement would. */
async function proposedCard(
  harness: Harness,
  agentId: Id<'agents'>,
  proposed: Exclude<Doc<'reorientations'>['proposed'], { kind: 'pending' }>,
  fields: Parameters<typeof openTestCard>[1] extends infer T ? Partial<T> : never = {},
): Promise<Id<'reorientations'>> {
  const cardId = await openTestCard(harness, {
    agentId,
    trigger: 'relationship-changed',
    triggerKey: `event-${Math.round(Date.now())}-${proposed.kind}`,
    summary: 'Priya, its approver, changed',
    ...fields,
  });
  if (cardId === null) throw new Error('no card opened');
  await harness.mutation(internal.reorientation.writeProposal, {
    reorientationId: cardId,
    proposed,
    basis: await basisOf(harness, cardId),
  });
  return cardId;
}

/** The events of one type on the employee's record, by payload. */
async function payloadsOf(
  harness: Harness,
  agentId: Id<'agents'>,
  type: string,
): Promise<unknown[]> {
  return await harness.run(async (ctx) =>
    (await ctx.db.query('events').collect())
      .filter((event) => event.agentId === agentId && event.type === type)
      .map((event) => event.payload),
  );
}

describe('approve: the proposal applied through its target', (): void => {
  it('amends the charter with via reorientation, and records what it did on the card', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const cardId = await proposedCard(harness, agentId, {
      kind: 'charter-change',
      changes: [
        {
          kind: 'edit-clause',
          field: 'escalationTriggers',
          index: 0,
          text: 'Surface tier-2 drafts about committee-deck numbers to Priya first',
        },
      ],
      rationale: 'Priya approves those now.',
      before: 'Surface tier-2 answer drafts to the manager for review',
      after: 'Surface tier-2 drafts about committee-deck numbers to Priya first',
    });
    await expect(
      harness.withIdentity(OWNER).mutation(api.reorientationDecisions.approve, {
        reorientationId: cardId,
      }),
    ).resolves.toEqual({ result: 'the charter was amended to version 0.2' });
    const card = await cardOf(harness, cardId);
    expect(card).toMatchObject({
      status: 'applied',
      outcome: { summary: 'the charter was amended to version 0.2' },
    });
    expect(card.outcome?.charterId).toBeDefined();
    // The card's own summary is the amendment's reason; `via` says it came from a card (the
    // joins: the record read "by you: reorientation: ...").
    expect(await payloadsOf(harness, agentId, 'charter.amended')).toEqual([
      expect.objectContaining({ via: 'reorientation', reason: card.triggerSummary }),
    ]);
    expect(await payloadsOf(harness, agentId, 'reorientation.approved')).toEqual([
      expect.objectContaining({ kind: 'charter-change', charterId: card.outcome?.charterId }),
    ]);
  });

  it('confirms a card that proposes nothing, changing nothing', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const cardId = await proposedCard(harness, agentId, { kind: 'none', rationale: 'Nothing.' });
    const before = await harness.run(async (ctx) => await ctx.db.query('charters').collect());
    await harness
      .withIdentity(OWNER)
      .mutation(api.reorientationDecisions.approve, { reorientationId: cardId });
    expect(await harness.run(async (ctx) => await ctx.db.query('charters').collect())).toEqual(
      before,
    );
    expect((await cardOf(harness, cardId)).outcome).toEqual({
      summary: 'nothing needed to change',
    });
  });

  it('retires an agreement, and edits another to a statement its check then takes', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const agreement = async (statement: string): Promise<Id<'workingAgreements'>> =>
      await harness.run(
        async (ctx) =>
          await ctx.db.insert('workingAgreements', {
            userId: OWNER_SUBJECT,
            agentId,
            kind: 'preference',
            statement,
            scope: 'global',
            sourceType: 'manager-card',
            status: 'active',
            approvedAt: 1,
            createdAt: 1,
            appliedTo: [],
          }),
      );
    const retired = await agreement('Copy Priya on tier-2 answers.');
    const edited = await agreement('Answer within a day.');
    const owner = harness.withIdentity(OWNER);
    await owner.mutation(api.reorientationDecisions.approve, {
      reorientationId: await proposedCard(harness, agentId, {
        kind: 'agreement',
        agreementId: retired,
        action: 'retire',
        rationale: 'The correction says otherwise.',
      }),
    });
    await owner.mutation(api.reorientationDecisions.approve, {
      reorientationId: await proposedCard(harness, agentId, {
        kind: 'agreement',
        agreementId: edited,
        action: 'edit',
        statement: 'Answer within two days.',
        rationale: 'The manager allows longer.',
      }),
    });
    const rows = await harness.run(
      async (ctx) => await ctx.db.query('workingAgreements').collect(),
    );
    expect(rows.find((row) => row._id === retired)?.status).toBe('retired');
    expect(rows.map((row) => row.statement)).toContain('Answer within two days.');
    // The edit a card's Approve made says so on its row (O-15): it was recorded as the
    // Agreements card's until 0.21.0.
    expect(rows.find((row) => row.statement === 'Answer within two days.')?.approvedVia).toBe(
      'reorientation',
    );
  });

  it('keeps an active agreement, checks an approved one again, and sets a proposed one aside', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const agreement = async (
      statement: string,
      fields: Partial<Doc<'workingAgreements'>>,
    ): Promise<Id<'workingAgreements'>> =>
      await harness.run(
        async (ctx) =>
          await ctx.db.insert('workingAgreements', {
            userId: OWNER_SUBJECT,
            agentId,
            kind: 'preference',
            statement,
            scope: 'global',
            sourceType: 'manager-card',
            status: 'active',
            createdAt: 1,
            appliedTo: [],
            ...fields,
          }),
      );
    const kept = await agreement('Copy Priya on tier-2 answers.', { approvedAt: 1 });
    const checked = await agreement('Answer within a day.', { status: 'proposed', approvedAt: 1 });
    const setAside = await agreement('Sign off as the team.', { status: 'proposed' });
    const owner = harness.withIdentity(OWNER);
    const approve = async (
      agreementId: Id<'workingAgreements'>,
      action: 'keep' | 'recheck' | 'dismiss',
      trigger: 'agreement-corrected' | 'person-dismissed' | 'relationship-changed',
    ) =>
      await owner.mutation(api.reorientationDecisions.approve, {
        reorientationId: await proposedCard(
          harness,
          agentId,
          { kind: 'agreement', agreementId, action, rationale: 'As the change says.' },
          { trigger, triggerKey: `${trigger}-${action}` },
        ),
      });
    await expect(approve(kept, 'keep', 'agreement-corrected')).resolves.toEqual({
      result: 'the working agreement was kept as it is',
    });
    await expect(approve(checked, 'recheck', 'person-dismissed')).resolves.toEqual({
      result: 'the working agreement is being checked again',
    });
    await expect(approve(setAside, 'dismiss', 'relationship-changed')).resolves.toEqual({
      result: 'the proposed working agreement was set aside',
    });
    const rows = await harness.run(
      async (ctx) => await ctx.db.query('workingAgreements').collect(),
    );
    expect(rows.find((row) => row._id === kept)?.status).toBe('active');
    expect(rows.find((row) => row._id === setAside)?.status).toBe('dismissed');
    const scheduled = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    expect(scheduled.map((job) => job.name)).toContain('workingAgreementActions:settleKept');
  });

  it('edits and retires an edge, opening no second card about itself on the employee', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const { edge, other } = await harness.run(async (ctx) => {
      const person = await ctx.db.insert('people', {
        userId: OWNER_SUBJECT,
        displayName: 'Priya',
        nameKey: 'priya',
        status: 'active',
        source: 'manager',
        evidence: [],
        confirmedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      const row = (type: 'escalation-contact' | 'collaborator') => ({
        userId: OWNER_SUBJECT,
        fromAgentId: agentId,
        toPersonId: person,
        type,
        effectiveFrom: 1,
        status: 'active' as const,
        source: 'manager' as const,
        confirmedAt: 1,
        createdAt: 1,
      });
      return {
        edge: await ctx.db.insert('relationships', row('escalation-contact')),
        other: await ctx.db.insert('relationships', row('collaborator')),
      };
    });
    const owner = harness.withIdentity(OWNER);
    await owner.mutation(api.reorientationDecisions.approve, {
      reorientationId: await proposedCard(harness, agentId, {
        kind: 'relationship',
        relationshipId: edge,
        action: 'edit',
        type: 'escalation-contact',
        scope: 'renewals only',
        rationale: 'Priya covers renewals only now.',
      }),
    });
    await owner.mutation(api.reorientationDecisions.approve, {
      reorientationId: await proposedCard(harness, agentId, {
        kind: 'relationship',
        relationshipId: other,
        action: 'retire',
        rationale: 'They no longer work together.',
      }),
    });
    const edges = await harness.run(async (ctx) => await ctx.db.query('relationships').collect());
    expect(edges.find((row) => row._id === edge)?.status).toBe('superseded');
    expect(edges.find((row) => row.supersedes === edge)?.scope).toBe('renewals only');
    expect(edges.find((row) => row._id === other)?.status).toBe('retired');
    // The edge's own change opened no card about itself on the employee whose card it was.
    expect((await cardsOf(harness, agentId)).map((card) => card.status)).toEqual([
      'applied',
      'applied',
    ]);
  });

  it('opens no card on any employee when Approve edits an edge for everyone (W16-R2)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priya = await seedEmployee(harness);
    const mateo = await seedEmployee(harness, { name: 'Mateo' });
    const edge = await harness.run(async (ctx) => {
      const person = await ctx.db.insert('people', {
        userId: OWNER_SUBJECT,
        displayName: 'Ines Duarte',
        nameKey: 'ines duarte',
        status: 'active',
        source: 'manager',
        evidence: [],
        confirmedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      // An approver for everyone: no employee or person it is from (bed 1's edge).
      return await ctx.db.insert('relationships', {
        userId: OWNER_SUBJECT,
        toPersonId: person,
        type: 'approval-authority',
        scope: 'NetLedger journal changes',
        effectiveFrom: 1,
        status: 'active',
        source: 'manager',
        confirmedAt: 1,
        createdAt: 1,
      });
    });
    const owner = harness.withIdentity(OWNER);
    const opened = async (): Promise<number> =>
      (
        await harness.run(
          async (ctx) =>
            await ctx.db
              .query('events')
              .filter((q) => q.eq(q.field('type'), 'reorientation.opened'))
              .collect(),
        )
      ).length;
    const reorientationId = await proposedCard(
      harness,
      priya,
      {
        kind: 'relationship',
        relationshipId: edge,
        action: 'edit',
        type: 'approval-authority',
        scope: 'NetLedger journal changes and REVOPS close plans',
        rationale: 'Ines approves REVOPS close plans too now.',
      },
      { evidence: { relationshipIds: [edge] }, affected: { relationships: [edge] } },
    );
    const before = await opened();
    await owner.mutation(api.reorientationDecisions.approve, { reorientationId });
    await harness.finishInProgressScheduledFunctions();
    // Bed 1: 50 joined events on one Approve. The change the manager approved opens or joins no
    // card on the employee it was approved for, nor on any other the same edge reaches.
    expect(await opened()).toBe(before);
    expect(await cardsOf(harness, mateo)).toEqual([]);
    expect((await cardsOf(harness, priya)).map((card) => card.status)).toEqual(['applied']);
  });

  it('closes the other employees’ cards about an edge for everyone when one card’s Approve decides it (the pre-tag’s row 6)', async (): Promise<void> => {
    // `row6-sibling-approve.txt`: after Approve on Priya's card superseded the edge, Aiko's and
    // Mateo's cards still stood, naming the ended edge: Approve on Aiko's was refused "This
    // relationship has already ended." (convex/people.ts, retireRelationshipInTransaction), and
    // the only way out was Dismiss, one card an employee.
    const harness = convexTest(schema, allConvexModules());
    const priya = await seedEmployee(harness, { name: 'Priya' });
    const mateo = await seedEmployee(harness, { name: 'Mateo' });
    const aiko = await seedEmployee(harness, { name: 'Aiko' });
    const held = await seedWork(harness, mateo, 'plan-pending', { externalId: 'REVOPS-1' });
    const edge = await harness.run(async (ctx) => {
      const person = await ctx.db.insert('people', {
        userId: OWNER_SUBJECT,
        displayName: 'Ines Duarte',
        nameKey: 'ines duarte',
        status: 'active',
        source: 'manager',
        evidence: [],
        confirmedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      return await ctx.db.insert('relationships', {
        userId: OWNER_SUBJECT,
        toPersonId: person,
        type: 'approval-authority',
        scope: 'NetLedger journal changes and the Q3 close sign-off',
        effectiveFrom: 1,
        status: 'active',
        source: 'manager',
        confirmedAt: 1,
        createdAt: 1,
      });
    });
    const about = { evidence: { relationshipIds: [edge] }, affected: { relationships: [edge] } };
    const retire = {
      kind: 'relationship' as const,
      relationshipId: edge,
      action: 'retire' as const,
      rationale: 'Ines Duarte has changed, so this approval relationship no longer holds.',
    };
    const priyas = await proposedCard(
      harness,
      priya,
      {
        kind: 'relationship',
        relationshipId: edge,
        action: 'edit',
        type: 'approval-authority',
        scope: 'NetLedger journal changes',
        rationale: 'The Q3 close sign-off is not hers.',
      },
      about,
    );
    const mateos = await proposedCard(harness, mateo, retire, {
      ...about,
      reach: { kind: 'open-work' },
    });
    const aikos = await proposedCard(harness, aiko, retire, about);
    // Aiko's card also has a talk under way, which the close ends.
    await harness.run(async (ctx) => {
      await ctx.db.patch(aikos, { status: 'discussing' });
      await ctx.db.insert('reorientationTalks', {
        reorientationId: aikos,
        agentId: aiko,
        state: 'active',
        turns: [],
        replyDraft: 'Ines has not left',
        conversation: 1,
        startedAt: 1,
      });
    });
    expect((await cardOf(harness, mateos)).blockingWork).toEqual([held]);
    const owner = harness.withIdentity(OWNER);
    vi.setSystemTime(Date.UTC(2026, 9, 13, 2, 4));
    expect(
      await owner.mutation(api.reorientationDecisions.approve, { reorientationId: priyas }),
    ).toEqual({ result: 'the relationship was changed' });
    for (const sibling of [mateos, aikos]) {
      expect(await cardOf(harness, sibling)).toMatchObject({
        status: 'dismissed',
        decidedAt: Date.UTC(2026, 9, 13, 2, 4),
        outcome: { summary: 'decided on Priya’s card: the relationship was changed' },
      });
    }
    // Each sibling's own record says how its card closed (17-O's F6: the record held only the
    // card opened, and the pilot figure counted a deferred one as still deferred).
    for (const [agentId, cardId] of [
      [mateo, mateos],
      [aiko, aikos],
    ] as const) {
      expect(await payloadsOf(harness, agentId, 'reorientation.dismissed')).toEqual([
        {
          reorientationId: cardId,
          summary: 'Priya, its approver, changed',
          outcome: 'decided on Priya’s card: the relationship was changed',
        },
      ]);
    }
    // The red input's own press: Approve on Aiko's card is refused as decided, and no longer
    // reaches the ended edge.
    await expect(
      owner.mutation(api.reorientationDecisions.approve, { reorientationId: aikos }),
    ).rejects.toThrow('That card has already been decided.');
    const talk = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('reorientationTalks')
          .withIndex('by_reorientation', (q) => q.eq('reorientationId', aikos))
          .first(),
    );
    expect([talk?.state, talk?.replyDraft]).toEqual(['closed', undefined]);
    // The plan Mateo's card held was drafted under the edge Priya's Approve changed, so it is
    // drafted again rather than asked for its decision (re-pinned by the joins for V17-9 (a)).
    expect((await harness.run(async (ctx) => await ctx.db.get(held)))?.state).toBe('claimed');
    expect(
      (await scheduledAs(harness, 'work:decidePlan')).map((job) => job.args[0]),
    ).not.toContainEqual({ workItemId: held, recovery: true });
  });

  it('leaves a sibling card that also names something else standing, and asks again for a proposal that named the ended edge', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priya = await seedEmployee(harness, { name: 'Priya' });
    const mateo = await seedEmployee(harness, { name: 'Mateo' });
    const { edge, other } = await harness.run(async (ctx) => {
      const person = await ctx.db.insert('people', {
        userId: OWNER_SUBJECT,
        displayName: 'Ines Duarte',
        nameKey: 'ines duarte',
        status: 'active',
        source: 'manager',
        evidence: [],
        confirmedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      const row = {
        userId: OWNER_SUBJECT,
        toPersonId: person,
        effectiveFrom: 1,
        status: 'active' as const,
        source: 'manager' as const,
        confirmedAt: 1,
        createdAt: 1,
      };
      return {
        edge: await ctx.db.insert('relationships', { ...row, type: 'approval-authority' }),
        other: await ctx.db.insert('relationships', {
          ...row,
          fromAgentId: mateo,
          type: 'escalation-contact',
        }),
      };
    });
    const retire = {
      kind: 'relationship' as const,
      relationshipId: edge,
      action: 'retire' as const,
      rationale: 'Ines has left.',
    };
    const priyas = await proposedCard(harness, priya, retire, {
      evidence: { relationshipIds: [edge] },
      affected: { relationships: [edge] },
    });
    const mateos = await proposedCard(harness, mateo, retire, {
      evidence: { relationshipIds: [edge, other] },
      affected: { relationships: [edge, other] },
    });
    await harness
      .withIdentity(OWNER)
      .mutation(api.reorientationDecisions.approve, { reorientationId: priyas });
    const card = await cardOf(harness, mateos);
    expect([card.status, card.proposed]).toEqual(['open', { kind: 'pending' }]);
    expect(
      (await scheduledAs(harness, 'reorientationActions:propose')).map((job) => job.args[0]),
    ).toContainEqual({ reorientationId: mateos });
  });

  it('closes the sibling cards of fifty-one employees by a chain of single functions', async (): Promise<void> => {
    const harness = convexTest({ schema, modules: allConvexModules(), transactionLimits: true });
    const agents: Id<'agents'>[] = [];
    for (let at = 0; at < 51; at += 1) {
      agents.push(await seedEmployee(harness, { name: `Employee ${at}` }));
    }
    const edge = await harness.run(async (ctx) => {
      const person = await ctx.db.insert('people', {
        userId: OWNER_SUBJECT,
        displayName: 'Ines Duarte',
        nameKey: 'ines duarte',
        status: 'active',
        source: 'manager',
        evidence: [],
        confirmedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      return await ctx.db.insert('relationships', {
        userId: OWNER_SUBJECT,
        toPersonId: person,
        type: 'approval-authority',
        effectiveFrom: 1,
        status: 'active',
        source: 'manager',
        confirmedAt: 1,
        createdAt: 1,
      });
    });
    const retire = {
      kind: 'relationship' as const,
      relationshipId: edge,
      action: 'retire' as const,
      rationale: 'Ines has left.',
    };
    const cards: Id<'reorientations'>[] = [];
    for (const agentId of agents) {
      cards.push(
        await proposedCard(harness, agentId, retire, {
          evidence: { relationshipIds: [edge] },
          affected: { relationships: [edge] },
        }),
      );
    }
    await harness
      .withIdentity(OWNER)
      .mutation(api.reorientationDecisions.approve, { reorientationId: cards[0] });
    const closed = async (): Promise<number> =>
      (await harness.run(async (ctx) => await ctx.db.query('reorientations').collect())).filter(
        (card) => card.status === 'dismissed',
      ).length;
    // The first eight in Approve's own transaction, the rest twenty-five a link.
    expect(await closed()).toBe(8);
    const ran = new Set<string>();
    for (;;) {
      const waiting = (
        await scheduledAs(harness, 'reorientationDecisions:closeSiblingCardsLater')
      ).filter((job) => !ran.has(job._id));
      expect(waiting.length).toBeLessThanOrEqual(1);
      const [next] = waiting;
      if (next === undefined) break;
      ran.add(next._id);
      await harness.mutation(
        internal.reorientationDecisions.closeSiblingCardsLater,
        next.args[0] as { agentIds: Id<'agents'>[]; decision: never },
      );
    }
    expect(ran.size).toBe(2);
    expect(await closed()).toBe(50);
  });

  it('sets a page superseded by its named successor, and hands another back to its source', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const { sourceId, oldPage } = await harness.run(async (ctx) => {
      const sourceId = await ctx.db.insert('docSources', {
        userId: OWNER_SUBJECT,
        kind: 'folder',
        label: 'Company handbook',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      const page = (ref: string, title: string, fields: Partial<Doc<'docPages'>> = {}) => ({
        sourceId,
        ref,
        title,
        markdown: `# ${title}`,
        updatedAt: 1,
        ...fields,
      });
      const oldPage = await ctx.db.insert('docPages', page('runbook.md', 'Runbook'));
      await ctx.db.insert('docPages', page('runbook-v2.md', 'Runbook, version 2'));
      await ctx.db.insert(
        'docPages',
        page('glossary.md', 'Glossary', { status: 'archived', statusSource: 'manager' }),
      );
      return { sourceId, oldPage };
    });
    const owner = harness.withIdentity(OWNER);
    await expect(
      owner.mutation(api.reorientationDecisions.approve, {
        reorientationId: await proposedCard(harness, agentId, {
          kind: 'page-status',
          page: { sourceId, ref: 'runbook.md' },
          status: 'superseded',
          supersededBy: { sourceId, ref: 'runbook-v2.md' },
          rationale: 'Version 2 replaces it.',
        }),
      }),
    ).resolves.toEqual({ result: '“Runbook” was marked superseded' });
    await owner.mutation(api.reorientationDecisions.approve, {
      reorientationId: await proposedCard(harness, agentId, {
        kind: 'page-status',
        page: { sourceId, ref: 'glossary.md' },
        status: 'clear',
        rationale: 'The source says it is current.',
      }),
    });
    const pages = await harness.run(async (ctx) => await ctx.db.query('docPages').collect());
    expect(pages.find((page) => page._id === oldPage)).toMatchObject({
      status: 'superseded',
      statusSource: 'manager',
      supersededBy: { sourceId, ref: 'runbook-v2.md' },
    });
    // Handed back: the page reads its source's own status again, no longer the manager's.
    expect(pages.find((page) => page.ref === 'glossary.md')).toMatchObject({
      status: 'active',
      statusSource: 'default',
    });
  });

  it('refuses to hand back to its source a page whose status is already its source’s (the second pass’s M2)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const sourceId = await harness.run(async (ctx) => {
      const sourceId = await ctx.db.insert('docSources', {
        userId: OWNER_SUBJECT,
        kind: 'folder',
        label: 'Company handbook',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert('docPages', {
        sourceId,
        ref: 'runbook.md',
        title: 'Runbook',
        markdown: '# Runbook',
        updatedAt: 1,
        status: 'archived',
        statusSource: 'source-native',
      });
      return sourceId;
    });
    const card = await proposedCard(harness, agentId, {
      kind: 'page-status',
      page: { sourceId, ref: 'runbook.md' },
      status: 'clear',
      rationale: 'Let the source decide.',
    });
    await expect(
      harness.withIdentity(OWNER).mutation(api.reorientationDecisions.approve, {
        reorientationId: card,
      }),
    ).rejects.toThrow('What this card proposes to change has moved on since: dismiss it.');
    expect((await cardOf(harness, card)).status).toBe('open');
  });

  it('refuses a status the page already holds from its source, which would pin it to the manager and change nothing (W17-R2, D-1 (a))', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const sourceId = await harness.run(async (ctx) => {
      const sourceId = await ctx.db.insert('docSources', {
        userId: OWNER_SUBJECT,
        kind: 'folder',
        label: 'Company handbook',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert('docPages', {
        sourceId,
        ref: 'runbook.md',
        title: 'Runbook',
        markdown: '# Runbook',
        updatedAt: 1,
        status: 'archived',
        statusSource: 'source-native',
      });
      return sourceId;
    });
    const card = await proposedCard(harness, agentId, {
      kind: 'page-status',
      page: { sourceId, ref: 'runbook.md' },
      status: 'archived',
      rationale: 'The source archived it.',
    });
    await expect(
      harness.withIdentity(OWNER).mutation(api.reorientationDecisions.approve, {
        reorientationId: card,
      }),
    ).rejects.toThrow(
      'The page already has this status from its source, so approving would change nothing: dismiss the card.',
    );
    expect((await cardOf(harness, card)).status).toBe('open');
    const [page] = await harness.run(async (ctx) => await ctx.db.query('docPages').collect());
    expect(page).toMatchObject({ status: 'archived', statusSource: 'source-native' });
  });

  it('says a charter change the charter no longer takes in the card’s words (the second pass’s m15)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const card = await proposedCard(harness, agentId, {
      kind: 'charter-change',
      changes: [{ kind: 'edit-clause', field: 'willDo', index: 0, text: 'Triage every ask.' }],
      rationale: 'The role widened.',
    });
    // The charter went back to a draft awaiting approval since the proposal.
    await harness.run(async (ctx) => {
      const [charter] = await ctx.db.query('charters').collect();
      await ctx.db.patch(charter._id, { approved: false });
    });
    // Re-taken (17-O; W16-R24): every plain refusal of the amendment read "has moved on since",
    // and a charter not approved yet is not a change that moved.
    await expect(
      harness.withIdentity(OWNER).mutation(api.reorientationDecisions.approve, {
        reorientationId: card,
      }),
    ).rejects.toThrow(
      'The charter is not approved yet, so this card cannot amend it: approve the charter, or dismiss the card.',
    );
    expect((await cardOf(harness, card)).status).toBe('open');
  });

  it('says a charter change that changes nothing as the charter already saying it (W16-R24)', async (): Promise<void> => {
    // The review's W16-R24: "the amendment changes nothing" was reworded "has moved on since:
    // dismiss it", which is untrue of a clause the charter already holds word for word.
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const card = await proposedCard(harness, agentId, {
      kind: 'charter-change',
      changes: [
        {
          kind: 'edit-clause',
          field: 'willDo',
          index: 0,
          text: 'Triage tier-2 asks in #revops-asks',
        },
      ],
      rationale: 'Say it as it is.',
    });
    await expect(
      harness.withIdentity(OWNER).mutation(api.reorientationDecisions.approve, {
        reorientationId: card,
      }),
    ).rejects.toThrow('The charter already says this. Dismiss the card.');
    expect((await cardOf(harness, card)).status).toBe('open');
  });

  it('grants and revokes a scope', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    await harness.run(async (ctx) => {
      await ctx.db.insert('permissionGrants', { agentId, scope: 'linear:write', createdAt: 1 });
    });
    const owner = harness.withIdentity(OWNER);
    await owner.mutation(api.reorientationDecisions.approve, {
      reorientationId: await proposedCard(harness, agentId, {
        kind: 'scope',
        scope: 'notion:read',
        action: 'grant',
        rationale: 'It needs the runbooks.',
      }),
    });
    await owner.mutation(api.reorientationDecisions.approve, {
      reorientationId: await proposedCard(harness, agentId, {
        kind: 'scope',
        scope: 'linear:write',
        action: 'revoke',
        rationale: 'It should only read Linear now.',
      }),
    });
    const grants = await harness.run(
      async (ctx) => await ctx.db.query('permissionGrants').collect(),
    );
    expect(
      grants.filter((grant) => grant.revokedAt === undefined).map((grant) => grant.scope),
    ).toEqual(['notion:read']);
  });

  it('opens no card about its own change however many cards the employee has decided since (the second pass’s minor)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    await harness.run(async (ctx) => {
      await ctx.db.insert('permissionGrants', { agentId, scope: 'linear:write', createdAt: 1 });
    });
    const old = await proposedCard(harness, agentId, {
      kind: 'scope',
      scope: 'linear:write',
      action: 'revoke',
      rationale: 'It should only read Linear now.',
    });
    // Fifty-one cards opened and approved after it, newer than it in the store.
    await harness.run(async (ctx) => {
      const [card] = await ctx.db.query('reorientations').collect();
      for (let at = 0; at < 51; at += 1) {
        await ctx.db.insert('reorientations', {
          ...fieldsOf(card),
          triggerKey: `decided-${at}`,
          status: 'applied',
          decidedAt: 1,
          outcome: { summary: 'nothing needed to change' },
        });
      }
    });
    await harness
      .withIdentity(OWNER)
      .mutation(api.reorientationDecisions.approve, { reorientationId: old });
    const cards = await cardsOf(harness, agentId);
    expect(cards.filter((card) => card.trigger === 'access-revoked')).toEqual([]);
  });

  it('retires a skill, and schedules a re-check of another', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const skill = async (name: string, fields: Partial<Doc<'skills'>> = {}) =>
      await harness.run(
        async (ctx) =>
          await ctx.db.insert('skills', {
            agentId,
            ownerKey: OWNER_SUBJECT,
            name,
            description: 'Ticket comment-and-close.',
            body: '# Body',
            sourceType: 'agent-authored',
            state: 'registered',
            registeredAt: 1,
            createdAt: 1,
            ...fields,
          }),
      );
    const versionId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('skillVersions', {
          userId: OWNER_SUBJECT,
          name: 'notion-append-note',
          description: 'Append a note.',
          surfaceClass: 'wiki',
          operation: 'append',
          version: 1,
          body: '# Body',
          smokeTest: 'print("ok")',
          bodyHash: 'hash',
          requiredScopes: [],
          harnessTools: [],
          authorAgentId: agentId,
          authorName: 'Mira',
          readRefs: [],
          verifiedAt: 1,
          createdAt: 1,
        }),
    );
    const retired = await skill('kanban-comment-and-close');
    const rechecked = await skill('notion-append-note', { versionId });
    const owner = harness.withIdentity(OWNER);
    await owner.mutation(api.reorientationDecisions.approve, {
      reorientationId: await proposedCard(harness, agentId, {
        kind: 'skill-action',
        skillId: retired,
        action: 'retire',
        rationale: 'The page it read is gone.',
      }),
    });
    await owner.mutation(api.reorientationDecisions.approve, {
      reorientationId: await proposedCard(harness, agentId, {
        kind: 'skill-action',
        skillId: rechecked,
        action: 'recheck',
        rationale: 'Its page changed.',
      }),
    });
    expect((await harness.run(async (ctx) => await ctx.db.get(retired)))?.state).toBe('retired');
    const scheduled = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    expect(scheduled.map((job) => job.name)).toContain('storedVerification:verifyStoredSkill');
  });

  it('withdraws a skill’s library version from every employee', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const { skillId, versionId } = await harness.run(async (ctx) => {
      const versionId = await ctx.db.insert('skillVersions', {
        userId: OWNER_SUBJECT,
        name: 'notion-append-note',
        description: 'Append a note.',
        surfaceClass: 'wiki',
        operation: 'append',
        version: 1,
        body: '# Body',
        smokeTest: 'print("ok")',
        bodyHash: 'hash',
        requiredScopes: [],
        harnessTools: [],
        authorAgentId: agentId,
        authorName: 'Mira',
        readRefs: [],
        verifiedAt: 1,
        createdAt: 1,
      });
      const skillId = await ctx.db.insert('skills', {
        agentId,
        ownerKey: OWNER_SUBJECT,
        name: 'notion-append-note',
        description: 'Append a note.',
        body: '# Body',
        sourceType: 'agent-authored',
        state: 'registered',
        registeredAt: 1,
        createdAt: 1,
        versionId,
      });
      return { skillId, versionId };
    });
    await expect(
      harness.withIdentity(OWNER).mutation(api.reorientationDecisions.approve, {
        reorientationId: await proposedCard(harness, agentId, {
          kind: 'skill-action',
          skillId,
          action: 'withdraw',
          rationale: 'It writes to a page that is gone.',
        }),
      }),
    ).resolves.toEqual({
      result: 'the skill “notion-append-note” was withdrawn from every employee',
    });
    const version = await harness.run(async (ctx) => await ctx.db.get(versionId));
    expect(version?.revokedAt).toBeDefined();
  });

  it('refuses a charter change whose clause moved since it was proposed, and a target of another owner (second pass M2)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const moved = await proposedCard(harness, agentId, {
      kind: 'charter-change',
      changes: [
        {
          kind: 'edit-clause',
          field: 'escalationTriggers',
          index: 0,
          text: 'Send drafts to Priya first.',
        },
      ],
      rationale: 'Priya approves those now.',
      before: 'Surface tier-2 answer drafts to the manager for review',
      after: 'Send drafts to Priya first.',
    });
    // The clause changed by another amendment meanwhile.
    await harness.run(async (ctx) => {
      const [charter] = await ctx.db.query('charters').collect();
      const body = charter.body as { proposedBoundaries: { escalationTriggers: string[] } };
      await ctx.db.patch(charter._id, {
        body: {
          ...body,
          proposedBoundaries: {
            ...body.proposedBoundaries,
            escalationTriggers: ['Escalate everything.'],
          },
        },
      });
    });
    const owner = harness.withIdentity(OWNER);
    await expect(
      owner.mutation(api.reorientationDecisions.approve, { reorientationId: moved }),
    ).rejects.toThrow('What this card proposes to change has moved on since: dismiss it.');
    expect((await cardOf(harness, moved)).status).toBe('open');
    const foreign = await harness.run(
      async (ctx) =>
        await ctx.db.insert('workingAgreements', {
          userId: 'someone-else',
          kind: 'preference',
          statement: 'Not yours.',
          scope: 'global',
          sourceType: 'manager-card',
          status: 'active',
          createdAt: 1,
          appliedTo: [],
        }),
    );
    const card = await proposedCard(
      harness,
      agentId,
      { kind: 'agreement', agreementId: foreign, action: 'retire', rationale: 'Retire it.' },
      { trigger: 'agreement-corrected' },
    );
    await expect(
      owner.mutation(api.reorientationDecisions.approve, { reorientationId: card }),
    ).rejects.toThrow('What this card proposes to change is no longer there: dismiss it.');
    expect((await harness.run(async (ctx) => await ctx.db.get(foreign)))?.status).toBe('active');
    // An edge and a page of another owner are refused the same way.
    const { edge, sourceId } = await harness.run(async (ctx) => {
      const person = await ctx.db.insert('people', {
        userId: 'someone-else',
        displayName: 'Priya',
        nameKey: 'priya',
        status: 'active',
        source: 'manager',
        evidence: [],
        confirmedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      const edge = await ctx.db.insert('relationships', {
        userId: 'someone-else',
        fromAgentId: agentId,
        toPersonId: person,
        type: 'collaborator',
        effectiveFrom: 1,
        status: 'active',
        source: 'manager',
        confirmedAt: 1,
        createdAt: 1,
      });
      const sourceId = await ctx.db.insert('docSources', {
        userId: 'someone-else',
        kind: 'folder',
        label: 'Their handbook',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert('docPages', {
        sourceId,
        ref: 'runbook.md',
        title: 'Runbook',
        markdown: '# Runbook',
        updatedAt: 1,
      });
      return { edge, sourceId };
    });
    const edgeCard = await proposedCard(
      harness,
      agentId,
      { kind: 'relationship', relationshipId: edge, action: 'retire', rationale: 'Retire it.' },
      { trigger: 'person-dismissed' },
    );
    await expect(
      owner.mutation(api.reorientationDecisions.approve, { reorientationId: edgeCard }),
    ).rejects.toThrow('What this card proposes to change is no longer there: dismiss it.');
    expect((await harness.run(async (ctx) => await ctx.db.get(edge)))?.status).toBe('active');
    const pageCard = await proposedCard(
      harness,
      agentId,
      {
        kind: 'page-status',
        page: { sourceId, ref: 'runbook.md' },
        status: 'archived',
        rationale: 'Archive it.',
      },
      { trigger: 'page-status-changed' },
    );
    await expect(
      owner.mutation(api.reorientationDecisions.approve, { reorientationId: pageCard }),
    ).rejects.toThrow('What this card proposes to change is no longer there: dismiss it.');
    const page = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('docPages')
          .withIndex('by_source_ref', (q) => q.eq('sourceId', sourceId).eq('ref', 'runbook.md'))
          .first(),
    );
    expect(page?.status).toBeUndefined();
  });

  it('refuses Approve on a proposal that moved since the page drew it, and approves what was shown (W16-R24)', async (): Promise<void> => {
    // The review's W16-R24: `approve` took only the card's id, so a Discuss finish in another tab
    // swapped the proposal under an Approve.
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const shown = { kind: 'none' as const, rationale: 'Nothing needs to change.' };
    const reorientationId = await proposedCard(harness, agentId, shown);
    // Another tab's talk finishes: the card now proposes a scope.
    await harness.run(async (ctx) => {
      await ctx.db.patch(reorientationId, {
        proposed: {
          kind: 'scope',
          scope: 'linear:write',
          action: 'grant',
          rationale: 'The manager said to grant it.',
        },
      });
    });
    const owner = harness.withIdentity(OWNER);
    await expect(
      owner.mutation(api.reorientationDecisions.approve, {
        reorientationId,
        shown: proposalFingerprint(shown),
      }),
    ).rejects.toThrow(
      'The proposal changed while this card was open. Read it again, then approve.',
    );
    expect((await cardOf(harness, reorientationId)).status).toBe('open');
    expect(await payloadsOf(harness, agentId, 'permission.granted')).toEqual([]);
    const now = (await cardOf(harness, reorientationId)).proposed;
    await expect(
      owner.mutation(api.reorientationDecisions.approve, {
        reorientationId,
        shown: proposalFingerprint(now),
      }),
    ).resolves.toEqual({ result: 'access “linear:write” was granted' });
  });

  it('refuses a card with nothing proposed yet, a decided card, and a stranger', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const pending = (await openTestCard(harness, {
      agentId,
      trigger: 'access-ended',
      triggerKey: 'event-1',
      summary: 'Its access to Linear ended',
    }))!;
    const owner = harness.withIdentity(OWNER);
    await expect(
      owner.mutation(api.reorientationDecisions.approve, { reorientationId: pending }),
    ).rejects.toThrow('Nothing is proposed on this card yet');
    // A stranger is told what a card that is not stored is told (W16-R35): the refusal said the
    // employee was not theirs, which told a card that exists from one that does not.
    const stranger = harness.withIdentity(managerIdentity('stranger'));
    const gone = await harness.run(async (ctx) => {
      const { _id, _creationTime, ...fields } = (await ctx.db.get(pending))!;
      void _id;
      void _creationTime;
      const copy = await ctx.db.insert('reorientations', { ...fields, triggerKey: 'copy' });
      await ctx.db.delete(copy);
      return copy;
    });
    for (const decide of [
      api.reorientationDecisions.approve,
      api.reorientationDecisions.dismiss,
      api.reorientationDecisions.defer,
    ]) {
      const foreign = await stranger
        .mutation(decide, { reorientationId: pending })
        .catch((error: unknown) => String(error));
      const missing = await owner
        .mutation(decide, { reorientationId: gone })
        .catch((error: unknown) => String(error));
      expect(foreign).toContain('That card is no longer stored.');
      expect(foreign).toBe(missing);
    }
    expect((await cardOf(harness, pending)).status).toBe('open');
    await owner.mutation(api.reorientationDecisions.dismiss, { reorientationId: pending });
    await expect(
      owner.mutation(api.reorientationDecisions.dismiss, { reorientationId: pending }),
    ).rejects.toThrow('That card has already been decided.');
  });
});

describe('dismiss and defer: nothing changes', (): void => {
  it('dismisses a card, which changes nothing and says so', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const cardId = await proposedCard(harness, agentId, {
      kind: 'charter-change',
      changes: [{ kind: 'edit-function', text: 'Something else.' }],
      rationale: 'Because.',
    });
    const charters = await harness.run(async (ctx) => await ctx.db.query('charters').collect());
    await harness
      .withIdentity(OWNER)
      .mutation(api.reorientationDecisions.dismiss, { reorientationId: cardId });
    expect(await harness.run(async (ctx) => await ctx.db.query('charters').collect())).toEqual(
      charters,
    );
    expect(await cardOf(harness, cardId)).toMatchObject({
      status: 'dismissed',
      outcome: { summary: 'nothing changed' },
    });
    expect((await eventTypesOf(harness, agentId)).at(-1)).toBe('reorientation.dismissed');
  });

  it('closes the card’s talk with Approve and with Dismiss, its reply being typed set aside (16-D’s m8)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const talkOn = async (reorientationId: Id<'reorientations'>) =>
      await harness.run(
        async (ctx) =>
          await ctx.db.insert('reorientationTalks', {
            agentId,
            reorientationId,
            state: 'active',
            turns: [],
            replyDraft: 'And for the Friday note',
            conversation: 0,
            startedAt: 1,
          }),
      );
    const talkOf = async (talkId: Id<'reorientationTalks'>) =>
      await harness.run(async (ctx) => await ctx.db.get(talkId));
    const approved = await proposedCard(harness, agentId, { kind: 'none', rationale: 'Fine.' });
    const approvedTalk = await talkOn(approved);
    await harness
      .withIdentity(OWNER)
      .mutation(api.reorientationDecisions.approve, { reorientationId: approved });
    expect(await talkOf(approvedTalk)).toMatchObject({ state: 'closed', endedAt: Date.now() });
    expect((await talkOf(approvedTalk))?.replyDraft).toBeUndefined();
    const dismissed = await proposedCard(harness, agentId, { kind: 'none', rationale: 'Fine.' });
    const dismissedTalk = await talkOn(dismissed);
    await harness
      .withIdentity(OWNER)
      .mutation(api.reorientationDecisions.dismiss, { reorientationId: dismissed });
    expect(await talkOf(dismissedTalk)).toMatchObject({ state: 'closed', endedAt: Date.now() });
    expect((await talkOf(dismissedTalk))?.replyDraft).toBeUndefined();
  });

  it('refuses a date that is not a number (the second pass’s m1)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const card = await proposedCard(harness, agentId, { kind: 'none', rationale: 'Nothing.' });
    await expect(
      harness.withIdentity(OWNER).mutation(api.reorientationDecisions.defer, {
        reorientationId: card,
        revisitAt: Number.NaN,
      }),
    ).rejects.toThrow('Pick a date after today and within a year.');
    expect((await cardOf(harness, card)).status).toBe('open');
  });

  it('defers a card a week by default, refuses a past date, and the sweep opens it again on its date', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const cardId = await proposedCard(harness, agentId, { kind: 'none', rationale: 'Nothing.' });
    const owner = harness.withIdentity(OWNER);
    await expect(
      owner.mutation(api.reorientationDecisions.defer, {
        reorientationId: cardId,
        revisitAt: Date.now() - 1,
      }),
    ).rejects.toThrow('Pick a date after today and within a year.');
    const { revisitAt } = await owner.mutation(api.reorientationDecisions.defer, {
      reorientationId: cardId,
    });
    expect(revisitAt).toBe(Date.now() + 7 * 86_400_000);
    await harness.mutation(internal.reorientation.reopenDeferred, {});
    expect((await cardOf(harness, cardId)).status).toBe('deferred');
    vi.setSystemTime(revisitAt + 1);
    await harness.mutation(internal.reorientation.reopenDeferred, {});
    expect((await cardOf(harness, cardId)).status).toBe('open');
  });
});

describe('the hold: the seventh reason at the plan’s decision', (): void => {
  /** A plan-pending row of an employee whose switch is on. */
  async function autonomous(harness: Harness): Promise<{
    agentId: Id<'agents'>;
    workItemId: Id<'workItems'>;
  }> {
    const agentId = await seedEmployee(harness, { autonomousActions: true });
    const workItemId = await seedWork(harness, agentId, 'plan-pending', {
      plan: { summary: 'Reply.', steps: ['Reply'] },
    });
    return { agentId, workItemId };
  }

  it('lets a plan a low-risk card reaches go on', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await autonomous(harness);
    await openTestCard(harness, {
      agentId,
      trigger: 'skill-recheck-due',
      triggerKey: 'event-1',
      summary: 'A skill is due a re-check',
    });
    await expect(harness.mutation(internal.work.decidePlan, { workItemId })).resolves.toEqual({
      approved: true,
    });
  });

  it('holds a plan a high-risk card names, and lets it go on Approve', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await autonomous(harness);
    const cardId = await proposedCard(
      harness,
      agentId,
      { kind: 'none', rationale: 'Nothing.' },
      { affected: { workItems: [workItemId] } },
    );
    await expect(harness.mutation(internal.work.decidePlan, { workItemId })).resolves.toEqual({
      approved: false,
    });
    expect(await payloadsOf(harness, agentId, 'work.plan-held')).toEqual([
      {
        workItemId,
        reason: 'reorientation-pending',
        reorientationId: cardId,
        summary: 'Priya, its approver, changed',
      },
    ]);
    await harness
      .withIdentity(OWNER)
      .mutation(api.reorientationDecisions.approve, { reorientationId: cardId });
    await harness.finishInProgressScheduledFunctions();
    const scheduled = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    expect(
      scheduled.filter((job) => job.name === 'work:decidePlan').map((job) => job.args[0]),
    ).toEqual([{ workItemId, recovery: true }]);
    await expect(harness.mutation(internal.work.decidePlan, { workItemId })).resolves.toEqual({
      approved: true,
    });
  });

  it('sends a plan it held back to drafting when Approve changed what the plan was drafted under, so Day0 never approves it on its own (V17-9, (a))', async (): Promise<void> => {
    // 17-O's trace (F5): under the autonomy switch, the plan a card held was approved by Day0
    // itself once Approve had amended the charter it was drafted under. Its words reach the clause
    // the Approve edits (D-2 (b), wave 18: a plan that does not is asked again, below).
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await autonomous(harness);
    await harness.run(
      async (ctx) =>
        await ctx.db.patch(workItemId, {
          plan: { summary: 'Reply to the tier-2 ask.', steps: ['Reply in the ask’s thread'] },
        }),
    );
    const cardId = await proposedCard(
      harness,
      agentId,
      {
        kind: 'charter-change',
        changes: [
          {
            kind: 'edit-clause',
            field: 'willNotDo',
            index: 0,
            text: 'Reply to a tier-2 ask without the manager',
          },
        ],
        rationale: 'The manager now answers tier-2 asks.',
      },
      { affected: { workItems: [workItemId] } },
    );
    await harness
      .withIdentity(OWNER)
      .mutation(api.reorientationDecisions.approve, { reorientationId: cardId });
    // The work loop's recovery asks the decision again, as the scheduler runs it: nothing to
    // decide, for the plan is being drafted again under the amended charter.
    await expect(
      harness.mutation(internal.work.decidePlan, { workItemId, recovery: true }),
    ).resolves.toEqual({ approved: false });
    const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
    expect([row?.state, row?.plan, row?.decision]).toEqual(['claimed', undefined, undefined]);
    expect(await payloadsOf(harness, agentId, 'work.plan-redrafting')).toEqual([
      expect.objectContaining({ workItemId, reorientationId: cardId }),
    ]);
  });

  it('asks a plan it held again when Approve changed a clause the plan’s words do not reach, and the switch does not approve it (D-2 (b), RM43 (a))', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await autonomous(harness);
    vi.setSystemTime(Date.UTC(2026, 9, 14, 4, 0));
    const cardId = await proposedCard(
      harness,
      agentId,
      {
        kind: 'charter-change',
        changes: [
          {
            kind: 'edit-clause',
            field: 'willNotDo',
            index: 0,
            text: 'Change committee-deck numbers or the board pack',
          },
        ],
        rationale: 'The board pack is the committee deck’s twin.',
      },
      { affected: { workItems: [workItemId] } },
    );
    await harness
      .withIdentity(OWNER)
      .mutation(api.reorientationDecisions.approve, { reorientationId: cardId });
    await expect(
      harness.mutation(internal.work.decidePlan, { workItemId, recovery: true }),
    ).resolves.toEqual({ approved: false });
    const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
    expect([row?.state, row?.plan, row?.heldThroughChangeAt]).toEqual([
      'plan-pending',
      { summary: 'Reply.', steps: ['Reply'] },
      Date.UTC(2026, 9, 14, 4, 0),
    ]);
    expect(await payloadsOf(harness, agentId, 'work.plan-redrafting')).toEqual([]);
    expect(await payloadsOf(harness, agentId, 'work.plan-held')).toContainEqual({
      workItemId,
      reason: 'held-through-change',
      reorientationId: cardId,
      summary: 'Priya, its approver, changed',
    });
  });

  it('releases a plan it held to its decision when Approve changed nothing', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await autonomous(harness);
    const cardId = await proposedCard(
      harness,
      agentId,
      { kind: 'none', rationale: 'Nothing.' },
      { affected: { workItems: [workItemId] } },
    );
    await harness
      .withIdentity(OWNER)
      .mutation(api.reorientationDecisions.approve, { reorientationId: cardId });
    expect(await payloadsOf(harness, agentId, 'work.plan-redrafting')).toEqual([]);
    await expect(harness.mutation(internal.work.decidePlan, { workItemId })).resolves.toEqual({
      approved: true,
    });
  });

  it('lets the plan go on Dismiss, and keeps the hold while the card is deferred', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await autonomous(harness);
    const cardId = await proposedCard(
      harness,
      agentId,
      { kind: 'none', rationale: 'Nothing.' },
      { affected: { workItems: [workItemId] } },
    );
    const owner = harness.withIdentity(OWNER);
    await owner.mutation(api.reorientationDecisions.defer, { reorientationId: cardId });
    await expect(harness.mutation(internal.work.decidePlan, { workItemId })).resolves.toEqual({
      approved: false,
    });
    await owner.mutation(api.reorientationDecisions.dismiss, { reorientationId: cardId });
    await expect(harness.mutation(internal.work.decidePlan, { workItemId })).resolves.toEqual({
      approved: true,
    });
  });
});

describe('openByHand and listForAgent', (): void => {
  it('opens three cards by hand for an employee in a day, and refuses the fourth in the page’s words (W16-R35)', async (): Promise<void> => {
    // The review's W16-R35: a hosted visitor could open a by-hand card, dismiss it and open
    // another without end, each one a call of the hosted model.
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const owner = harness.withIdentity(OWNER);
    vi.setSystemTime(Date.UTC(2026, 9, 13, 2, 0));
    for (const summary of ['Covers renewals too', 'Covers refunds too', 'Covers dunning too']) {
      const { reorientationId } = await owner.mutation(api.reorientationDecisions.openByHand, {
        agentId,
        summary,
      });
      await owner.mutation(api.reorientationDecisions.dismiss, {
        reorientationId: reorientationId!,
      });
    }
    await expect(
      owner.mutation(api.reorientationDecisions.openByHand, {
        agentId,
        summary: 'Covers churn too',
      }),
    ).rejects.toThrow(
      'You have opened three cards for Mira today. Decide one, or come back tomorrow.',
    );
    expect(await cardsOf(harness, agentId)).toHaveLength(3);
    // The next day in the employee's zone opens again.
    vi.setSystemTime(Date.UTC(2026, 9, 14, 2, 0));
    await expect(
      owner.mutation(api.reorientationDecisions.openByHand, {
        agentId,
        summary: 'Covers churn too',
      }),
    ).resolves.toMatchObject({ joined: false });
  });

  it('joins a second change to the day’s standing by-hand card whatever the day’s count', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const owner = harness.withIdentity(OWNER);
    vi.setSystemTime(Date.UTC(2026, 9, 13, 2, 0));
    for (const summary of ['Covers renewals too', 'Covers refunds too']) {
      const { reorientationId } = await owner.mutation(api.reorientationDecisions.openByHand, {
        agentId,
        summary,
      });
      await owner.mutation(api.reorientationDecisions.dismiss, {
        reorientationId: reorientationId!,
      });
    }
    await owner.mutation(api.reorientationDecisions.openByHand, { agentId, summary: 'Third' });
    // A minute on: a by-hand change is keyed by its instant, and two of one instant are one change.
    vi.setSystemTime(Date.now() + 60_000);
    await expect(
      owner.mutation(api.reorientationDecisions.openByHand, { agentId, summary: 'Fourth' }),
    ).resolves.toMatchObject({ joined: true });
  });

  it('opens a card about a change of role, reaching the whole charter', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const owner = harness.withIdentity(OWNER);
    await expect(
      owner.mutation(api.reorientationDecisions.openByHand, { agentId, summary: '   ' }),
    ).rejects.toThrow('Say what changed in up to 300 characters.');
    const { reorientationId } = await owner.mutation(api.reorientationDecisions.openByHand, {
      agentId,
      summary: 'Mira now covers renewals too',
    });
    const card = await cardOf(harness, reorientationId!);
    expect(card).toMatchObject({ trigger: 'role-changed', risk: 'medium', status: 'open' });
    expect(card.affected.charterClauses).toHaveLength(3);
  });

  it('says a second by-hand change the same day joined the standing card, whose summary then holds both (W16-R24)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const owner = harness.withIdentity(OWNER);
    const first = await owner.mutation(api.reorientationDecisions.openByHand, {
      agentId,
      summary: 'Mira now covers renewals too',
    });
    expect(first).toMatchObject({ joined: false });
    // The judgement answered the first change before the second was typed.
    await harness.mutation(internal.reorientation.writeProposal, {
      reorientationId: first.reorientationId!,
      proposed: { kind: 'none', rationale: 'Renewals are within the charter.' },
      basis: await basisOf(harness, first.reorientationId!),
    });
    vi.setSystemTime(Date.now() + 60_000);
    const second = await owner.mutation(api.reorientationDecisions.openByHand, {
      agentId,
      summary: 'It no longer triages tier-2 asks.',
    });
    expect(second).toEqual({
      reorientationId: first.reorientationId,
      joined: true,
      asked: true,
      onCard: true,
    });
    const cards = await cardsOf(harness, agentId);
    expect(cards).toHaveLength(1);
    // The typed words are on the card, not only in the record, and the proposal is asked again.
    expect(cards[0]).toMatchObject({
      triggerSummary: 'Mira now covers renewals too; It no longer triages tier-2 asks.',
      proposed: { kind: 'pending' },
    });
  });

  it('keeps a proposal the manager’s own talk put on the card, a repeated change once, and the summary bounded (the second pass)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const owner = harness.withIdentity(OWNER);
    const { reorientationId } = await owner.mutation(api.reorientationDecisions.openByHand, {
      agentId,
      summary: 'Mira now covers renewals too',
    });
    // A finished talk put the manager's own proposal on the card.
    const talked = {
      kind: 'none' as const,
      rationale: 'You said renewals are within the charter.',
    };
    await harness.run(async (ctx) => {
      await ctx.db.patch(reorientationId!, { proposed: talked });
      await ctx.db.insert('reorientationTalks', {
        agentId,
        reorientationId: reorientationId!,
        state: 'finished',
        turns: [],
        conversation: 1,
        outcome: { proposed: talked, quotes: ['renewals are within the charter'] },
        startedAt: 1,
        endedAt: 2,
      });
    });
    const again = async (summary: string) => {
      // Each by-hand change is its own report, keyed by when it was typed.
      vi.setSystemTime(Date.now() + 60_000);
      return await owner.mutation(api.reorientationDecisions.openByHand, { agentId, summary });
    };
    await expect(again('It no longer triages tier-2 asks')).resolves.toEqual({
      reorientationId,
      joined: true,
      asked: false,
      onCard: true,
    });
    // The same words typed again are on the card already.
    await expect(again('It no longer triages tier-2 asks')).resolves.toMatchObject({
      onCard: true,
    });
    const [card] = await cardsOf(harness, agentId);
    expect(card.proposed).toEqual(talked);
    expect(card.triggerSummary).toBe(
      'Mira now covers renewals too; It no longer triages tier-2 asks',
    );
    // Past the bound the words stay in the record's joined events, and the card's summary as it is.
    // The answer says so, so the page never says the words were added (W16-R24).
    const answers = [];
    for (const index of [1, 2, 3]) {
      answers.push(await again(`${'A long change of role. '.repeat(12)}${index}`));
    }
    const summary = (await cardsOf(harness, agentId))[0].triggerSummary;
    expect(summary.length).toBeLessThanOrEqual(600);
    expect(answers.map((answer) => answer.onCard)).toEqual([true, false, false]);
    expect(summary).toContain('A long change of role. 1');
    expect(summary).not.toContain('A long change of role. 2');
    expect(answers.at(-1)).toMatchObject({ joined: true, asked: false });
  });

  it('lists the standing cards first, with the names their ids stand for, and only to the owner', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const workItemId = await seedWork(harness, agentId, 'plan-pending');
    const decided = await proposedCard(harness, agentId, { kind: 'none', rationale: 'Nothing.' });
    await harness
      .withIdentity(OWNER)
      .mutation(api.reorientationDecisions.dismiss, { reorientationId: decided });
    const standing = await proposedCard(
      harness,
      agentId,
      { kind: 'none', rationale: 'Nothing.' },
      {
        trigger: 'access-ended',
        summary: 'Its access to Linear ended',
        affected: { workItems: [workItemId] },
      },
    );
    const views = await harness
      .withIdentity(OWNER)
      .query(api.reorientationDecisions.listForAgent, { agentId });
    expect(views.map((view) => view.card._id)).toEqual([standing, decided]);
    expect(views[0].workItems).toEqual([
      {
        _id: workItemId,
        title: 'Answer the tier-2 ask about the committee deck',
        state: 'plan-pending',
      },
    ]);
    expect(views[0].charterVersion).toBe('0.1');
    await expect(
      harness
        .withIdentity(managerIdentity('stranger'))
        .query(api.reorientationDecisions.listForAgent, { agentId }),
    ).rejects.toThrow();
  });

  it('lists every standing card the hold reads, not only the newest twenty (the second pass’s m11)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    for (let day = 0; day < 25; day += 1) {
      await openTestCard(harness, {
        agentId,
        trigger: 'access-ended',
        triggerKey: `ended-${day}`,
        summary: `Access ended, day ${day}`,
        now: Date.UTC(2026, 8, 1 + day, 12),
      });
    }
    const views = await harness
      .withIdentity(OWNER)
      .query(api.reorientationDecisions.listForAgent, { agentId });
    expect(views.filter((view) => view.card.status === 'open')).toHaveLength(25);
  });

  it('names what an employee’s cards reach within a budget of rows, and says in the log when cards past it are drawn bare (W16-R24)', async (): Promise<void> => {
    // The review's W16-R24: "`listForAgent` reads up to about 60 documents a card across up to
    // about 170 cards (near 4,096 ranges at the extreme)". Seventy cards of ten plans each.
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const first = (await openTestCard(harness, {
      agentId,
      trigger: 'access-ended',
      triggerKey: 'event-0',
      summary: 'Its access to Linear ended',
      now: Date.UTC(2026, 8, 1, 12),
    }))!;
    await harness.run(async (ctx) => {
      const base = fieldsOf((await ctx.db.get(first))!);
      await ctx.db.delete(first);
      for (let card = 0; card < 70; card += 1) {
        const workItems: Id<'workItems'>[] = [];
        for (let item = 0; item < 10; item += 1) {
          workItems.push(
            await ctx.db.insert('workItems', {
              agentId,
              sourceCategory: 'ticket-queue',
              sourceSystem: 'linear',
              externalId: `REVOPS-${card}-${item}`,
              title: `Item ${card}-${item}`,
              contentSummary: 'Synthetic.',
              contentRefs: [],
              state: 'plan-pending',
              observedAt: 1,
              createdAt: 1,
            }),
          );
        }
        await ctx.db.insert('reorientations', {
          ...base,
          triggerKey: `event-${card}`,
          status: card < 50 ? 'open' : 'deferred',
          affected: { ...base.affected, workItems },
          // The newest first: card 0 is the newest.
          createdAt: 1_000 - card,
        });
      }
    });
    const { result: views, warnings } = await warnedBy(
      async () =>
        await harness
          .withIdentity(OWNER)
          .query(api.reorientationDecisions.listForAgent, { agentId }),
    );
    expect(views).toHaveLength(70);
    expect(views.filter((view) => view.workItems.length === 10)).toHaveLength(60);
    expect(views.slice(60).every((view) => view.workItems.length === 0)).toBe(true);
    expect(warnings).toEqual([
      expect.objectContaining({ bound: 'CARD_NAMES_READ', limit: 600, leftBare: 10 }),
    ]);
  });

  it('counts what a standing card holds as the hold stops it, and nothing on a decided card (second pass M3)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    // A plan waits at its approval; a run stops before its closing steps; a run whose closing set
    // is already written, and a plan already done, are past what the hold stops.
    const plan = await seedWork(harness, agentId, 'plan-pending');
    const approved = await seedWork(harness, agentId, 'plan-approved');
    const running = await seedWork(harness, agentId, 'executing');
    const firstWrites = await seedWork(harness, agentId, 'actions-pending', {
      output: { phase: 'auto' },
    });
    const closingWrites = await seedWork(harness, agentId, 'actions-pending', {
      output: { phase: 'dependent' },
    });
    const done = await seedWork(harness, agentId, 'completed');
    const holding = await proposedCard(harness, agentId, { kind: 'none', rationale: 'Nothing.' });
    await harness.run(async (ctx) => {
      await ctx.db.patch(holding, {
        risk: 'high',
        blockingWork: [plan, approved, running, firstWrites, closingWrites, done],
      });
    });
    const decided = await proposedCard(
      harness,
      agentId,
      { kind: 'none', rationale: 'Nothing.' },
      { trigger: 'access-ended', triggerKey: 'access-ended-linear' },
    );
    await harness.run(async (ctx) => {
      await ctx.db.patch(decided, { risk: 'high', blockingWork: [plan] });
    });
    await harness
      .withIdentity(OWNER)
      .mutation(api.reorientationDecisions.dismiss, { reorientationId: decided });
    const views = await harness
      .withIdentity(OWNER)
      .query(api.reorientationDecisions.listForAgent, { agentId });
    expect(views.find((view) => view.card._id === holding)?.held).toEqual({ plans: 1, runs: 3 });
    expect(views.find((view) => view.card._id === decided)?.held).toEqual({ plans: 0, runs: 0 });
  });

  it('holds ten of a hundred open plans and says the ninety it does not hold (W16-R22)', async (): Promise<void> => {
    // The review's W16-R22: a high-risk card for an employee with a hundred open plans holds ten
    // and said "10 plans held", nothing of the rest.
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    for (let at = 0; at < 100; at += 1) {
      await seedWork(harness, agentId, 'plan-pending', { externalId: `REVOPS-${at}` });
    }
    const few = await seedEmployee(harness, { name: 'Pip' });
    await seedWork(harness, few, 'plan-pending');
    await harness.run(async (ctx) => {
      await openCards(
        ctx,
        [agentId, few].map((employee) => ({
          agentId: employee,
          trigger: 'relationship-changed' as const,
          triggerKey: 'edge-change-1',
          summary: 'Priya is now its approver',
          reach: { kind: 'open-work' as const },
        })),
      );
    });
    const owner = harness.withIdentity(OWNER);
    const [busy] = await owner.query(api.reorientationDecisions.listForAgent, { agentId });
    expect(busy.card.affected.workItems).toHaveLength(100);
    expect(busy.card.blockingWork).toHaveLength(10);
    expect(busy.held).toEqual({ plans: 10, runs: 0, notHeld: 90 });
    // A card that holds everything it reached says nothing of a rest.
    const [quiet] = await owner.query(api.reorientationDecisions.listForAgent, { agentId: few });
    expect(quiet.held).toEqual({ plans: 1, runs: 0 });
  });
});

describe('the narrow redraft: one Approve for everyone at fifty-one (D-2 (b), RM43 (a))', (): void => {
  /** Bed 1's Priya's card, as the hosted model proposed it (`bed1/rows/listForAgent-priya.json`). */
  const BED_ONE_SUMMARY =
    'Ines Duarte, its approver: now for “NetLedger journal changes and REVOPS close plans”, where it was “NetLedger journal changes”';

  /** The bed's plan (`kit1/seed.py`): one drafted plan an employee, none naming Ines. */
  const BED_ONE_PLAN = {
    summary: 'Review the close ticket within the window the policy sets.',
    steps: ['Read the review window.', 'Review the ticket.', 'Post the review note.'],
    riskNotes: '',
  };

  /** The three plans of the fifty-one whose own words reach what the Approve moved. */
  const NAMING: Readonly<Record<number, Partial<typeof BED_ONE_PLAN>>> = {
    2: { steps: ['Read the review window.', 'Ask Ines Duarte to approve the journal entry.'] },
    3: { summary: 'Review the REVOPS close plans within the window the policy sets.' },
    4: { riskNotes: 'Ines Duarte signs off the close before the note is posted.' },
  };

  /**
   * Bed 1's fifty-one employees (Priya, Mateo, Aiko and forty-eight in Priya's shape), each with
   * one drafted plan held by its own high-risk card about the approver for everyone, every card
   * proposing the widened scope the hosted model proposed on the bed.
   */
  async function bedOne(
    harness: Harness,
    autonomousActions: boolean,
  ): Promise<{
    edge: Id<'relationships'>;
    rows: Array<{
      agentId: Id<'agents'>;
      workItemId: Id<'workItems'>;
      cardId: Id<'reorientations'>;
    }>;
  }> {
    const edge = await harness.run(async (ctx) => {
      const person = await ctx.db.insert('people', {
        userId: OWNER_SUBJECT,
        displayName: 'Ines Duarte',
        nameKey: 'ines duarte',
        status: 'active',
        source: 'manager',
        evidence: [],
        confirmedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      return await ctx.db.insert('relationships', {
        userId: OWNER_SUBJECT,
        toPersonId: person,
        type: 'approval-authority',
        scope: 'NetLedger journal changes',
        effectiveFrom: 1,
        status: 'active',
        source: 'manager',
        confirmedAt: 1,
        createdAt: 1,
      });
    });
    const widen = {
      kind: 'relationship' as const,
      relationshipId: edge,
      action: 'edit' as const,
      type: 'approval-authority' as const,
      scope: 'NetLedger journal changes and REVOPS close plans',
      rationale:
        "Ines Duarte's approver scope now covers REVOPS close plans as well as NetLedger journal changes.",
    };
    const rows = [];
    for (let index = 1; index <= 51; index += 1) {
      const name =
        { 1: 'Priya', 2: 'Mateo', 3: 'Aiko' }[index] ??
        `Employee ${String(index).padStart(2, '0')}`;
      const agentId = await seedEmployee(harness, { name, autonomousActions });
      const workItemId = await seedWork(harness, agentId, 'plan-pending', {
        externalId: `W17RV-${String(index).padStart(2, '0')}`,
        title: `${name}: review the Q3 close ticket`,
        contentSummary:
          'Review the Q3 close ticket within the review window once its audit comment is posted.',
        planPendingAt: 1,
        plan: { ...BED_ONE_PLAN, ...NAMING[index] },
      });
      const cardId = await proposedCard(harness, agentId, widen, {
        summary: BED_ONE_SUMMARY,
        evidence: { relationshipIds: [edge] },
        affected: { relationships: [edge], workItems: [workItemId] },
      });
      rows.push({ agentId, workItemId, cardId });
    }
    return { edge, rows };
  }

  /** Run the sibling chain an Approve for everyone schedules to its end, as the scheduler would. */
  async function runSiblingChain(harness: Harness): Promise<void> {
    const ran = new Set<string>();
    for (;;) {
      const [next] = (
        await scheduledAs(harness, 'reorientationDecisions:closeSiblingCardsLater')
      ).filter((job) => !ran.has(job._id));
      if (next === undefined) return;
      ran.add(next._id);
      await harness.mutation(
        internal.reorientationDecisions.closeSiblingCardsLater,
        next.args[0] as { agentIds: Id<'agents'>[]; decision: never },
      );
    }
  }

  /** Every work item of the fifty-one, by its state. */
  async function statesOf(
    harness: Harness,
    rows: ReadonlyArray<{ workItemId: Id<'workItems'> }>,
  ): Promise<Array<Doc<'workItems'> | null>> {
    return await harness.run(
      async (ctx) => await Promise.all(rows.map(async (row) => await ctx.db.get(row.workItemId))),
    );
  }

  it('redrafts only the held plans that name the edge’s person or scope, and asks the rest again (bed 1’s rows; red at the tag: 51 redrafted)', async (): Promise<void> => {
    const harness = convexTest({ schema, modules: allConvexModules(), transactionLimits: true });
    const { rows } = await bedOne(harness, false);
    const approvedAt = Date.UTC(2026, 9, 14, 3, 0);
    vi.setSystemTime(approvedAt);
    await harness
      .withIdentity(OWNER)
      .mutation(api.reorientationDecisions.approve, { reorientationId: rows[0].cardId });
    await runSiblingChain(harness);
    const after = await statesOf(harness, rows);
    // Mateo's, Aiko's and Employee 04's plans name Ines Duarte or the REVOPS close plans.
    expect(after.flatMap((row, at) => (row?.state === 'claimed' ? [at + 1] : []))).toEqual([
      2, 3, 4,
    ]);
    const asked = after.filter((row) => row?.state === 'plan-pending');
    expect(asked).toHaveLength(48);
    for (const row of asked) {
      expect([row?.heldThroughChangeAt, row?.plan]).toEqual([approvedAt, BED_ONE_PLAN]);
    }
    const redrafting = (
      await Promise.all(
        rows.map(async (row) => await payloadsOf(harness, row.agentId, 'work.plan-redrafting')),
      )
    ).flat();
    expect(redrafting).toHaveLength(3);
    // Each plan asked again says so on its own record, naming the card that held it.
    for (const row of rows.filter((_row, at) => after[at]?.state === 'plan-pending')) {
      expect(await payloadsOf(harness, row.agentId, 'work.plan-held')).toEqual([
        {
          workItemId: row.workItemId,
          reason: 'held-through-change',
          reorientationId: row.cardId,
          summary: BED_ONE_SUMMARY,
        },
      ]);
    }
    expect((await scheduledAs(harness, 'work:decidePlan')).map((job) => job.args[0])).toHaveLength(
      48,
    );
  });

  it('asks the forty-eight of the manager under the autonomy switch, and Day0 approves none of them, the recovery neither (red at the tag: 51 redrafted)', async (): Promise<void> => {
    const harness = convexTest({ schema, modules: allConvexModules(), transactionLimits: true });
    const { rows } = await bedOne(harness, true);
    await harness
      .withIdentity(OWNER)
      .mutation(api.reorientationDecisions.approve, { reorientationId: rows[0].cardId });
    await runSiblingChain(harness);
    // The work loop's look at each released plan, as the scheduler runs it, then the stalled-step
    // sweep's own look.
    for (const job of await scheduledAs(harness, 'work:decidePlan')) {
      expect(
        await harness.mutation(
          internal.work.decidePlan,
          job.args[0] as { workItemId: Id<'workItems'>; recovery?: boolean },
        ),
      ).toEqual({ approved: false });
    }
    const after = await statesOf(harness, rows);
    for (const row of after.filter((row) => row?.state === 'plan-pending')) {
      expect(
        await harness.mutation(internal.work.decidePlan, {
          workItemId: row!._id,
          recovery: true,
        }),
      ).toEqual({ approved: false });
    }
    expect(after.filter((row) => row?.state === 'plan-pending')).toHaveLength(48);
    const approvedByDay0 = (
      await Promise.all(
        rows.map(async (row) => await payloadsOf(harness, row.agentId, 'work.plan-approved')),
      )
    ).flat();
    expect(approvedByDay0).toEqual([]);
  });
});

describe('a plan approved while its card stood (V17-9’s remainder, W17-R8)', (): void => {
  it('sends back a plan the manager approved in Slack while the card stood when Approve changed what it rests on, and leaves one it does not rest on or whose apply is claimed', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const edge = await harness.run(async (ctx) => {
      const person = await ctx.db.insert('people', {
        userId: OWNER_SUBJECT,
        displayName: 'Ines Duarte',
        nameKey: 'ines duarte',
        status: 'active',
        source: 'manager',
        evidence: [],
        confirmedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      return await ctx.db.insert('relationships', {
        userId: OWNER_SUBJECT,
        toPersonId: person,
        type: 'approval-authority',
        scope: 'NetLedger journal changes',
        effectiveFrom: 1,
        status: 'active',
        source: 'manager',
        confirmedAt: 1,
        createdAt: 1,
      });
    });
    const inSlack = {
      id: 'decision-1',
      kind: 'plan' as const,
      requestedAt: 2,
      channel: 'D0MANAGER',
      surfaceSlug: 'slack',
      surfaceName: 'Slack',
      decidedAt: 3,
      outcome: 'approved' as const,
    };
    const naming = { summary: 'Ask Ines Duarte to approve the journal entry.', steps: ['Ask'] };
    const approved = await seedWork(harness, agentId, 'plan-approved', {
      externalId: 'REVOPS-1',
      plan: naming,
      decision: inSlack,
    });
    const waiting = await seedWork(harness, agentId, 'actions-pending', {
      externalId: 'REVOPS-2',
      plan: naming,
      decision: { ...inSlack, id: 'decision-2', kind: 'actions' },
      approvedIndexes: [0],
      applyPhase: 'approved',
    });
    const applying = await seedWork(harness, agentId, 'actions-pending', {
      externalId: 'REVOPS-3',
      plan: naming,
      applyClaimedAt: 4,
    });
    const elsewhere = await seedWork(harness, agentId, 'plan-approved', {
      externalId: 'REVOPS-4',
      plan: { summary: 'Close the renewal with a note.', steps: ['Close'] },
      decision: { ...inSlack, id: 'decision-4' },
    });
    const cardId = await proposedCard(
      harness,
      agentId,
      {
        kind: 'relationship',
        relationshipId: edge,
        action: 'edit',
        type: 'approval-authority',
        scope: 'NetLedger journal changes and REVOPS close plans',
        rationale: 'Widened.',
      },
      {
        evidence: { relationshipIds: [edge] },
        affected: { relationships: [edge], workItems: [approved, waiting, applying, elsewhere] },
      },
    );
    expect((await cardOf(harness, cardId)).blockingWork).toHaveLength(4);
    await harness
      .withIdentity(OWNER)
      .mutation(api.reorientationDecisions.approve, { reorientationId: cardId });
    const rows = await harness.run(
      async (ctx) =>
        await Promise.all(
          [approved, waiting, applying, elsewhere].map(async (id) => await ctx.db.get(id)),
        ),
    );
    expect(rows.map((row) => row?.state)).toEqual([
      'claimed',
      'claimed',
      'actions-pending',
      'plan-approved',
    ]);
    for (const row of rows.slice(0, 2)) {
      expect([row?.plan, row?.decision, row?.approvedIndexes, row?.applyPhase]).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
    }
    expect(
      (await payloadsOf(harness, agentId, 'work.plan-redrafting')).map(
        (payload) => (payload as { workItemId: string }).workItemId,
      ),
    ).toEqual([approved, waiting]);
  });
});

describe('the mark’s clear: a plan drafted again is decided as any other (RM43 (a))', (): void => {
  /** A row of an employee whose switch is on, in a state, held through a change at 5. */
  async function marked(
    harness: Harness,
    state: Doc<'workItems'>['state'],
    fields: Partial<Doc<'workItems'>> = {},
  ): Promise<{ agentId: Id<'agents'>; row: Doc<'workItems'> }> {
    const agentId = await seedEmployee(harness, { autonomousActions: true });
    const workItemId = await seedWork(harness, agentId, state, {
      plan: { summary: 'Reply.', steps: ['Reply'] },
      heldThroughChangeAt: 5,
      ...fields,
    });
    const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
    if (row === null) throw new Error('no row');
    return { agentId, row };
  }

  /** The row's mark, as stored. */
  async function markOf(harness: Harness, workItemId: Id<'workItems'>): Promise<unknown> {
    return (await harness.run(async (ctx) => await ctx.db.get(workItemId)))?.heldThroughChangeAt;
  }

  it('clears the mark where a card’s Approve sends the plan back to drafting, and Day0 approves the new plan under the switch', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, row } = await marked(harness, 'plan-pending', {
      plan: { summary: 'Reply in the thread.', steps: ['Reply in the thread'] },
    });
    const cardId = await proposedCard(
      harness,
      agentId,
      {
        kind: 'charter-change',
        changes: [
          { kind: 'edit-clause', field: 'willDo', index: 0, text: 'Reply in the ask’s thread' },
        ],
        rationale: 'Every ask.',
      },
      { affected: { workItems: [row._id] } },
    );
    await harness
      .withIdentity(OWNER)
      .mutation(api.reorientationDecisions.approve, { reorientationId: cardId });
    expect((await harness.run(async (ctx) => await ctx.db.get(row._id)))?.state).toBe('claimed');
    expect(await markOf(harness, row._id)).toBeUndefined();
    await harness.mutation(internal.planApproval.setPlan, {
      workItemId: row._id,
      plan: { summary: 'Reply to the ask.', steps: ['Reply'] },
    });
    await expect(
      harness.mutation(internal.work.decidePlan, { workItemId: row._id }),
    ).resolves.toEqual({ approved: true });
  });

  it('clears the mark where an approved set is parked on a connection, and where an approved plan is parked for a skill', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { parkOnConnection } = await import('../../convex/workApply');
    const { row: waiting } = await marked(harness, 'actions-pending');
    await harness.run(async (ctx) => {
      await parkOnConnection(ctx, waiting, 'linear');
    });
    expect(await markOf(harness, waiting._id)).toBeUndefined();
    const { row: unskilled } = await marked(harness, 'plan-approved');
    await expect(
      harness.mutation(internal.skillControls.parkForMissingSkill, {
        workItemId: unskilled._id,
        name: 'kanban-comment-and-close',
        reason: 'its skill is not callable',
        rationale: 'No callable skill.',
        shape: { surfaceClass: 'kanban', operation: 'comment-and-close' },
      }),
    ).resolves.toMatchObject({ parked: true });
    expect(await markOf(harness, unskilled._id)).toBeUndefined();
  });

  it('clears the mark where Retry drafts a turned-down plan again', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { row } = await marked(harness, 'cancelled');
    await harness.withIdentity(OWNER).mutation(api.workRuns.retryFailed, { workItemId: row._id });
    expect((await harness.run(async (ctx) => await ctx.db.get(row._id)))?.plan).toBeUndefined();
    expect(await markOf(harness, row._id)).toBeUndefined();
  });
});
