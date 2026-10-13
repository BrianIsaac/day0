/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import * as ownerExportModule from '../../convex/ownerExport';
import { OWNER_SECTION_PAGES, withoutOwner } from '../../convex/ownerExport';
import { OWNER_SECTIONS } from '../../src/export/trace';
import { allConvexModules } from './all-modules';
import { fixtureAddressOf, managerIdentity } from './fakes/manager-identity';
import { ownerExportOf, seedOwner } from './fakes/owner-export';
import { registeredIn } from './registered-functions';

/*
 * The owner export's helpers (`convex/ownerExport.ts`; wave 17, 17-s): what a row of each section
 * carries and leaves out, the walk of stored pages, and the readers of one page of a section. The
 * first two regions are `tests/convex/exportActions.test.ts`'s own, moved as they stood: they read
 * the file a signed-in owner's browser assembles. The readers' cases read the module directly.
 */

describe('the owner export’s rows (wave 16, 16-F)', (): void => {
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

describe('the readers of the owner export’s sections', (): void => {
  it('are one for every section the export names, in the export’s order', (): void => {
    expect(Object.keys(OWNER_SECTION_PAGES)).toEqual([...OWNER_SECTIONS]);
  });

  it('read one page of a section under the owner’s key only, with a cursor while rows stand', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await seedOwner(harness, 'owner-a', 'Alpha');
    await seedOwner(harness, 'owner-b', 'Bravo');
    await harness.run(async (ctx) => {
      await ctx.db.insert('docSources', {
        userId: 'owner-a',
        label: 'Alpha guides',
        kind: 'folder',
        locator: '/srv/Alpha/guides',
        status: 'synced',
        createdAt: 2,
        updatedAt: 2,
      });
    });

    const first = await harness.run(
      async (ctx) =>
        await OWNER_SECTION_PAGES.docSources(ctx, 'owner-a', { cursor: null, numItems: 1 }),
    );
    expect(first.rows).toEqual([expect.objectContaining({ label: 'Alpha handbook' })]);
    expect(first.next).not.toBeNull();
    const second = await harness.run(
      async (ctx) =>
        await OWNER_SECTION_PAGES.docSources(ctx, 'owner-a', { cursor: first.next, numItems: 5 }),
    );
    expect(second.rows).toEqual([expect.objectContaining({ label: 'Alpha guides' })]);
    expect(second.next).toBeNull();
    // A source leaves its locator and its owner key behind, as the file's test reads it.
    for (const row of [...first.rows, ...second.rows]) {
      expect(row).not.toHaveProperty('locator');
      expect(row).not.toHaveProperty('userId');
    }
  });

  it('give a retirement without its owner key and with every other field', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await seedOwner(harness, 'owner-a', 'Alpha');
    const [row] = await harness.run(async (ctx) => await ctx.db.query('retirements').collect());
    const { userId, ...rest } = row!;

    expect(userId).toBe('owner-a');
    expect(withoutOwner(row!)).toEqual(rest);
    const page = await harness.run(
      async (ctx) =>
        await OWNER_SECTION_PAGES.retirements(ctx, 'owner-a', { cursor: null, numItems: 5 }),
    );
    expect(page).toEqual({ rows: [rest], next: null });
  });
});

describe('the functions convex/ownerExport.ts registers', (): void => {
  // Helpers only (17-s; decision S-1): `exportOwnerHead` and `exportOwnerPage` stay registered in
  // `convex/events.ts`, where `exportActions` reaches them by name.
  it('are none', (): void => {
    expect(registeredIn(ownerExportModule)).toEqual([]);
  });
});
