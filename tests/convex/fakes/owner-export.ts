import type { TestConvex } from 'convex-test';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import type schema from '../../../convex/schema';
import { assembleOwnerExport, type OwnerExport } from '../../../src/export/trace';
import { personNameKey } from '../../../src/people/vocabulary';
import { fixtureAddressOf, managerIdentity } from './manager-identity';

/*
 * The owner export tests' shared seeds (wave 16, 16-F): one owner's company with a row in every
 * table the export reads, and the file a signed-in owner's browser assembles through the public
 * actions. Read by the export action's tests and the owner export's own.
 */

/** A harness over the tree's schema. */
export type Harness = TestConvex<typeof schema>;

/** What one owner's seeded rows are called, so a test can look for them in another's file. */
export interface Seeded {
  readonly agentId: Id<'agents'>;
  readonly evaluationId: Id<'agents'>;
  readonly marks: readonly string[];
  readonly pageText: string;
}

/**
 * One owner's company: an employee with a finished item and a reorientation card, an evaluation
 * agent, a documentation source with a stored page and a relation, a person with an identity and
 * an edge, a skill version, a working agreement, a retired employee and one handed elsewhere.
 * Every name carries the tag, so another owner's file can be searched for it.
 */
export async function seedOwner(harness: Harness, owner: string, tag: string): Promise<Seeded> {
  const pageText = `${tag} PAGE TEXT that never leaves the deployment`;
  return await harness.run(async (ctx): Promise<Seeded> => {
    const bossEmail = fixtureAddressOf(owner);
    const agentId = await ctx.db.insert('agents', {
      bossEmail,
      name: `${tag} Employee`,
      userId: owner,
      state: 'active',
      createdAt: 1,
    });
    const evaluationId = await ctx.db.insert('agents', {
      bossEmail: `eval-day0-r1-${String(1_760_000_000_000 + tag.length)}@day0.local`,
      name: 'Day0 evaluation 1',
      userId: owner,
      state: 'active',
      createdAt: 2,
    });
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: `${tag}-1`,
      title: `${tag} ticket`,
      contentSummary: 'Synthetic.',
      contentRefs: [],
      state: 'completed',
      observedAt: 1,
      createdAt: 1,
    });
    await ctx.db.insert('events', {
      agentId,
      type: 'work.completed',
      payload: { workItemId, output: { workDone: 'done', workDoneWhy: 'Posted.', draft: '' } },
      createdAt: 60_000,
    });
    await ctx.db.insert('reorientations', {
      agentId,
      userId: owner,
      trigger: 'relationship-changed',
      triggerKey: `${tag}:edge`,
      triggerSummary: `${tag} card`,
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
      day: '2026-10-12',
      createdAt: 1,
    });
    const sourceId = await ctx.db.insert('docSources', {
      userId: owner,
      label: `${tag} handbook`,
      kind: 'folder',
      locator: `/srv/${tag}/handbook`,
      status: 'synced',
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert('docPages', {
      sourceId,
      ref: 'refunds.md',
      title: `${tag} refunds page`,
      markdown: pageText,
      contentHash: `${tag}-hash`,
      updatedAt: 1,
      status: 'superseded',
      statusSource: 'manager',
      decidedBy: bossEmail,
      decidedAt: 3,
      marker: { status: 'superseded', quote: `${tag} marker words`, judgedAt: 2 },
    });
    await ctx.db.insert('docPages', {
      sourceId,
      ref: 'refunds-2.md',
      title: `${tag} refunds page 2`,
      markdown: pageText,
      updatedAt: 2,
    });
    await ctx.db.insert('docRelations', {
      userId: owner,
      from: { sourceId, ref: 'refunds.md' },
      to: { sourceId, ref: 'refunds-2.md' },
      kind: 'possible_duplicate',
      evidence: [{ measure: 'text-overlap', value: 0.9 }],
      decidedBy: bossEmail,
      decidedAt: 4,
      status: 'proposed',
      createdAt: 1,
    });
    const personId = await ctx.db.insert('people', {
      userId: owner,
      displayName: `${tag} Person`,
      nameKey: personNameKey(`${tag} Person`),
      status: 'active',
      source: 'manager',
      evidence: [],
      confirmedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert('personIdentities', {
      userId: owner,
      personId,
      provider: 'slack',
      externalId: `${tag}-U1`,
      source: 'provider-lookup',
      verifiedAt: 1,
      createdAt: 1,
    });
    await ctx.db.insert('relationships', {
      userId: owner,
      toPersonId: personId,
      type: 'approval-authority',
      effectiveFrom: 1,
      status: 'active',
      source: 'manager',
      confirmedAt: 1,
      createdAt: 1,
    });
    await ctx.db.insert('skillVersions', {
      userId: owner,
      name: `${tag}-skill`,
      description: 'Comment on a ticket, then close it.',
      surfaceClass: 'kanban',
      operation: 'comment-and-close',
      version: 1,
      body: '# Comment and close',
      smokeTest: 'def run(inputs): return {"actions": []}',
      bodyHash: 'sha256:00',
      requiredScopes: ['linear:write'],
      harnessTools: ['save_comment'],
      harnessToolsBySurface: [{ slug: 'linear', surfaceClass: 'kanban', tools: ['save_comment'] }],
      targetSurface: 'linear',
      authorAgentId: agentId,
      authorName: `${tag} Employee`,
      readRefs: [],
      verifiedAt: 2,
      createdAt: 2,
    });
    await ctx.db.insert('workingAgreements', {
      userId: owner,
      kind: 'preference',
      statement: `${tag} agreement`,
      scope: 'person',
      personId,
      sourceType: 'plan-approval',
      workItemId,
      status: 'proposed',
      createdAt: 6,
      appliedTo: [],
    });
    await ctx.db.insert('retirements', {
      userId: owner,
      agentId: evaluationId,
      agentName: `${tag} Retired`,
      retiredAt: 7,
      rowCounts: { events: 3 },
      revokedCredentials: 0,
      keptCredentials: 0,
      claims: [],
      rejections: [],
    });
    return {
      agentId,
      evaluationId,
      marks: [
        `${tag} Employee`,
        `${tag} card`,
        `${tag} handbook`,
        `${tag} refunds page`,
        `${tag} Person`,
        `${tag}-U1`,
        `${tag}-skill`,
        `${tag} agreement`,
        `${tag} Retired`,
        `${tag} ticket`,
      ],
      pageText,
    };
  });
}

/** The owner export a signed-in owner's browser assembles, through the public actions. */
export async function ownerExportOf(harness: Harness, owner: string): Promise<OwnerExport> {
  const caller = harness.withIdentity(managerIdentity(owner));
  return await assembleOwnerExport({
    head: async () => await caller.action(api.exportActions.exportForOwner, {}),
    agents: async (cursor) => await caller.action(api.exportActions.exportOwnerAgents, { cursor }),
    page: async (cursor) => await caller.action(api.exportActions.exportOwnerPage, cursor),
    employee: {
      head: async ({ agentId }) =>
        await caller.action(api.exportActions.exportForAgent, {
          agentId: agentId as Id<'agents'>,
        }),
      page: async ({ agentId, page }) =>
        await caller.action(api.exportActions.exportPage, {
          agentId: agentId as Id<'agents'>,
          ...page,
        }),
    },
  });
}
