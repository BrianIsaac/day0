/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  assembleOwnerExport,
  employeeTracesOf,
  OWNER_SECTIONS,
  readOwnerExport,
  type OwnerExport,
} from '../../src/export/trace';
import { personNameKey } from '../../src/people/vocabulary';
import { allConvexModules } from './all-modules';
import { fixtureAddressOf, MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';
import { guardRefusal } from './fakes/anonymous-caller';

describe('the export redacts by its own policy row (review M9)', (): void => {
  it("removes an e-mail, a phone number and a labelled address from a work item's text", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const id = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Priya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      await ctx.db.insert('workItems', {
        agentId: id,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-1',
        title: 'Send the close summary',
        contentSummary:
          'cc jane.doe@acme.com, or call +65 9123 4567.\nHome address: 1 Raffles Place, Singapore',
        contentRefs: [],
        state: 'completed',
        observedAt: 1,
        createdAt: 1,
      });
      return id;
    });
    const page = await harness
      .withIdentity(managerIdentity())
      .action(api.exportActions.exportPage, { agentId, section: 'workItems', cursor: null });
    const exported = JSON.stringify(page.rows);
    expect(exported).toContain(
      'cc <redacted: email>, or call <redacted: phone>.\\nHome address: <redacted: address>',
    );
    for (const value of ['jane.doe@acme.com', '9123 4567', 'Raffles Place']) {
      expect(exported).not.toContain(value);
    }
    // The ticket's own words stay: the export keeps working material.
    expect(exported).toContain('Send the close summary');
  });
});

describe("the export drops a person a provider's answer names (the real-Linear walk's m4)", (): void => {
  it("drops the branch name and the author a Linear read's answer carries, from the work item and its event", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const read =
      'get_issue on linear · {"id":"FIN-5","title":"Close the duplicate accruals query",' +
      '"gitBranchName":"aiko/fin-5-close-the-duplicate-accruals-query",' +
      '"createdBy":"Aiko Tanaka","project":"September close"}';
    const output = { applied: [{ tool: 'mcp.call', ok: true, effect: read, providerId: 'FIN-5' }] };
    const agentId = await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const id = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Mateo',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      await ctx.db.insert('workItems', {
        agentId: id,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'FIN-5',
        title: 'Close the duplicate accruals query',
        contentSummary: 'Add an audit note, then move it to Done.',
        contentRefs: [],
        state: 'completed',
        output,
        observedAt: 1,
        createdAt: 1,
      });
      await ctx.db.insert('events', {
        agentId: id,
        type: 'work.completed',
        payload: { output },
        createdAt: 2,
      });
      return id;
    });
    const owner = harness.withIdentity(managerIdentity());
    const exported = JSON.stringify(
      await Promise.all(
        (['workItems', 'events'] as const).map(
          async (section) =>
            (await owner.action(api.exportActions.exportPage, { agentId, section, cursor: null }))
              .rows,
        ),
      ),
    );
    for (const value of ['aiko/fin-5', 'Aiko Tanaka']) expect(exported).not.toContain(value);
    // The answer's working material stays: the ticket, its title and its project.
    for (const value of ['FIN-5', 'Close the duplicate accruals query', 'September close']) {
      expect(exported).toContain(value);
    }
  });
});

/*
 * The owner export (wave 16, 16-F; the wave file's 5.4, decision F-1): every employee's trace and
 * the owner's own rows in one file, read only under the caller's own owner key.
 */

type Harness = TestConvex<typeof schema>;

/** What one owner's seeded rows are called, so a test can look for them in another's file. */
interface Seeded {
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
async function seedOwner(harness: Harness, owner: string, tag: string): Promise<Seeded> {
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
async function ownerExportOf(harness: Harness, owner: string): Promise<OwnerExport> {
  const caller = harness.withIdentity(managerIdentity(owner));
  return await assembleOwnerExport({
    head: async () => await caller.action(api.exportActions.exportForOwner, {}),
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

describe('the owner export (wave 16, 16-F)', (): void => {
  it('holds every employee’s trace and the owner’s rows, and no other owner’s row (two identities)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const a = await seedOwner(harness, 'owner-a', 'Alpha');
    const b = await seedOwner(harness, 'owner-b', 'Bravo');

    const file = await ownerExportOf(harness, 'owner-a');

    const text = JSON.stringify(file);
    for (const mark of a.marks) expect(text, mark).toContain(mark);
    for (const mark of b.marks) expect(text, mark).not.toContain(mark);
    for (const id of [b.agentId, b.evaluationId]) expect(text).not.toContain(id);
    expect(text).not.toContain('owner-b');
    expect(file.manifest).toMatchObject({
      format: 'day0-owner-export',
      version: 8,
      ownerKey: 'owner-a',
      counts: {
        retirements: 1,
        departures: 0,
        docSources: 1,
        docPages: 2,
        docRelations: 1,
        skillVersions: 1,
        people: 1,
        personIdentities: 1,
        relationships: 1,
        workingAgreements: 1,
        employees: 1,
      },
    });
    expect(file.employees.map((trace) => trace.agent.id)).toEqual([a.agentId]);
    expect(file.employees[0]?.sections.reorientations).toHaveLength(1);
    expect(readOwnerExport(JSON.parse(text))).toBeDefined();
  });

  it('carries a page’s place and status, never its text, its hash, a marker’s words or who decided it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const a = await seedOwner(harness, 'owner-a', 'Alpha');

    const file = await ownerExportOf(harness, 'owner-a');

    expect(JSON.stringify(file)).not.toContain(a.pageText);
    const [first] = file.owner.docPages;
    // Re-pinned by W16-R18: a page's ref and address leave the file; its row id names it.
    expect(first).toMatchObject({
      title: 'Alpha refunds page',
      status: 'superseded',
      statusSource: 'manager',
      decidedAt: 3,
      marker: { status: 'superseded', judgedAt: 2 },
    });
    for (const field of ['markdown', 'contentHash', 'decidedBy'])
      expect(first).not.toHaveProperty(field);
    expect(first?.marker).not.toHaveProperty('quote');
    // Who decided a relation is the manager's address, left out as a page's is (the second pass).
    expect(file.owner.docRelations[0]).not.toHaveProperty('decidedBy');
    expect(file.owner.docRelations[0]).toMatchObject({ decidedAt: 4 });
    expect(file.owner.docSources[0]).not.toHaveProperty('locator');
    expect(file.owner.docSources[0]).toMatchObject({ label: 'Alpha handbook', kind: 'folder' });
  });

  it('leaves out every page’s address and ref, naming pages and relation ends by the page’s row (W16-R18)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await seedOwner(harness, 'owner-a', 'Alpha');
    // Reader 5's red.ts: for a list of URLs the ref is the address itself, query string and all.
    const token = 'sig=AbCdEf0123456789xyz&e=Q9vG2k';
    const address = `https://docs.example.com/guide?${token}`;
    await harness.run(async (ctx) => {
      const sourceId = await ctx.db.insert('docSources', {
        userId: 'owner-a',
        label: 'Guides',
        kind: 'urls',
        locator: address,
        status: 'synced',
        createdAt: 2,
        updatedAt: 2,
      });
      await ctx.db.insert('docPages', {
        sourceId,
        ref: address,
        url: address,
        title: 'Guide',
        markdown: 'Text.',
        updatedAt: 1,
        status: 'superseded',
        supersededBy: { sourceId, ref: `${address}&v=2` },
      });
      await ctx.db.insert('docPages', {
        sourceId,
        ref: `${address}&v=2`,
        url: `${address}&v=2`,
        title: 'Guide, version 2',
        markdown: 'Text.',
        updatedAt: 2,
      });
      await ctx.db.insert('docRelations', {
        userId: 'owner-a',
        from: { sourceId, ref: `${address}&v=2` },
        to: { sourceId, ref: address },
        kind: 'possible_successor',
        evidence: [{ measure: 'title-version', value: 1 }],
        status: 'confirmed',
        createdAt: 3,
      });
    });

    const file = await ownerExportOf(harness, 'owner-a');

    expect(JSON.stringify(file)).not.toContain('sig=AbCdEf0123456789xyz');
    for (const page of file.owner.docPages) {
      expect(page).not.toHaveProperty('ref');
      expect(page).not.toHaveProperty('url');
    }
    const guide = file.owner.docPages.find((page) => page.title === 'Guide')!;
    const second = file.owner.docPages.find((page) => page.title === 'Guide, version 2')!;
    // Each page carries an opaque key of its own, which a relation's ends and the page that
    // superseded it name: nothing is read to make it, and it says nothing of the address.
    expect(guide.page).toMatch(/^[0-9a-f]{24}$/);
    expect(guide.page).not.toBe(second.page);
    expect(guide.supersededBy).toEqual({ sourceId: guide.sourceId, page: second.page });
    const successor = file.owner.docRelations.find(
      (relation) => relation.kind === 'possible_successor',
    )!;
    expect(successor.from).toEqual({ sourceId: second.sourceId, page: second.page });
    expect(successor.to).toEqual({ sourceId: guide.sourceId, page: guide.page });
  });

  it('carries the people graph once, among the owner’s rows, and fills it back into each trace', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await seedOwner(harness, 'owner-a', 'Alpha');

    const file = await ownerExportOf(harness, 'owner-a');

    expect(file.employees[0]?.sections.people).toEqual([]);
    const [trace] = employeeTracesOf(file);
    expect(trace?.sections.people.map((person) => person.displayName)).toEqual(['Alpha Person']);
  });

  it('names the evaluation agents it sets aside without their traces', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const a = await seedOwner(harness, 'owner-a', 'Alpha');

    const file = await ownerExportOf(harness, 'owner-a');

    expect(file.setAside.map((agent) => [agent.id, agent.evaluation])).toEqual([
      [a.evaluationId, true],
    ]);
    expect(file.employees.map((trace) => trace.agent.id)).not.toContain(a.evaluationId);
  });

  it('names an employee handed to another manager, and none of its records or either manager', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const a = await seedOwner(harness, 'owner-a', 'Alpha');
    await harness.run(async (ctx) => {
      await ctx.db.patch(a.agentId, { userId: 'owner-b', bossEmail: fixtureAddressOf('owner-b') });
      await ctx.db.insert('managerTransfers', {
        agentId: a.agentId,
        agentName: 'Alpha Employee',
        fromOwnerKey: 'owner-a',
        fromAddress: fixtureAddressOf('owner-a'),
        toAddress: fixtureAddressOf('owner-b'),
        toOwnerKey: 'owner-b',
        state: 'accepted',
        requestedAt: 100,
        expiresAt: 1_000_000,
        decidedAt: 200,
      });
    });

    const file = await ownerExportOf(harness, 'owner-a');

    expect(file.owner.departures).toEqual([
      expect.objectContaining({ agentId: a.agentId, agentName: 'Alpha Employee', decidedAt: 200 }),
    ]);
    expect(file.employees).toEqual([]);
    const text = JSON.stringify(file);
    expect(text).not.toContain('owner-b');
    expect(text).not.toContain(fixtureAddressOf('owner-b'));
    expect(text).not.toContain('Alpha ticket');
  });

  it('pages every owner section, so a section past one page is read whole', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await seedOwner(harness, 'owner-a', 'Alpha');
    await harness.run(async (ctx) => {
      const [source] = await ctx.db.query('docSources').collect();
      for (let index = 0; index < 60; index += 1) {
        await ctx.db.insert('docPages', {
          sourceId: source!._id,
          ref: `extra-${index}.md`,
          title: `Extra ${index}`,
          markdown: 'Synthetic.',
          updatedAt: 1,
        });
      }
    });

    const file = await ownerExportOf(harness, 'owner-a');

    expect(file.owner.docPages).toHaveLength(62);
    expect(Object.keys(file.manifest.counts)).toEqual([...OWNER_SECTIONS, 'employees']);
  });

  it('refuses a caller with no identity', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const refusal = await guardRefusal();
    await expect(harness.action(api.exportActions.exportForOwner, {})).rejects.toMatchObject(
      refusal,
    );
    await expect(
      harness.action(api.exportActions.exportOwnerPage, { section: 'people', cursor: null }),
    ).rejects.toMatchObject(refusal);
  });
});

describe('the owner export’s walk of stored pages (the second pass’s finding 4)', (): void => {
  it('goes on to the next source when the one it is in is unlinked between two pages', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const [first, second] = await harness.run(async (ctx) => {
      const source = async (label: string, pages: number) => {
        const sourceId = await ctx.db.insert('docSources', {
          userId: 'owner-a',
          label,
          kind: 'folder',
          locator: `/srv/${label}`,
          status: 'synced',
          createdAt: 1,
          updatedAt: 1,
        });
        for (let index = 0; index < pages; index += 1) {
          await ctx.db.insert('docPages', {
            sourceId,
            ref: `${label}-${index}.md`,
            title: `${label} ${index}`,
            markdown: 'Synthetic.',
            updatedAt: 1,
          });
        }
        return sourceId;
      };
      return [await source('first', 30), await source('second', 2)];
    });
    const caller = harness.withIdentity(managerIdentity('owner-a'));
    const page = await caller.action(api.exportActions.exportOwnerPage, {
      section: 'docPages',
      cursor: null,
    });
    expect(page.next?.section).toBe('docPages');
    await harness.run(async (ctx) => {
      for (const row of await ctx.db
        .query('docPages')
        .withIndex('by_source', (q) => q.eq('sourceId', first))
        .collect()) {
        await ctx.db.delete(row._id);
      }
      await ctx.db.delete(first);
    });

    const after = await caller.action(api.exportActions.exportOwnerPage, {
      section: 'docPages',
      cursor: page.next?.cursor ?? null,
    });

    expect(after.rows.map((row) => (row as { sourceId: string }).sourceId)).toEqual([
      second,
      second,
    ]);
  });

  it('refuses a cursor that is not one of its own, in words a client reads', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await expect(
      harness
        .withIdentity(managerIdentity('owner-a'))
        .action(api.exportActions.exportOwnerPage, { section: 'docPages', cursor: 'not json' }),
    ).rejects.toThrow('not a cursor of the owner export’s stored pages');
  });
});
