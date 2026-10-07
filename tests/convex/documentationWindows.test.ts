import { convexTest } from 'convex-test';
import type { FunctionReference } from 'convex/server';
import { describe, expect, it } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import type { ActionCtx } from '../../convex/_generated/server';
import { PAGED_READ } from '../../convex/docSources';
import { forEachDocumentationWindow } from '../../convex/documentationWindows';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';

type Harness = ReturnType<typeof convexTest>;

/** An action context whose queries are the harness's, which is all the walk uses. */
function actionContext(harness: Harness): ActionCtx {
  return {
    runQuery: async (query: FunctionReference<'query', 'internal'>, args: unknown) =>
      await harness.query(query, args as never),
  } as unknown as ActionCtx;
}

/** An employee of `owner` reading two sources, the first with `firstPages` pages. */
async function seed(
  harness: Harness,
  firstPages: number,
): Promise<{ agentId: Id<'agents'>; first: Id<'docSources'>; second: Id<'docSources'> }> {
  return await harness.run(async (ctx) => {
    const source = async (label: string): Promise<Id<'docSources'>> =>
      await ctx.db.insert('docSources', {
        userId: 'owner',
        label,
        kind: 'folder',
        locator: label,
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
    const first = await source('first');
    const second = await source('second');
    for (let index = 0; index < firstPages; index += 1) {
      await ctx.db.insert('docPages', {
        sourceId: first,
        ref: `first-${String(index).padStart(3, '0')}.md`,
        title: `First ${index}`,
        markdown: `# First ${index}`,
        updatedAt: 1,
      });
    }
    await ctx.db.insert('docPages', {
      sourceId: second,
      ref: 'second-000.md',
      title: 'Second 0',
      markdown: '# Second 0',
      updatedAt: 1,
    });
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Priya',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    return { agentId, first, second };
  });
}

describe('forEachDocumentationWindow', (): void => {
  it('walks every page an employee reads, source by source, no window past one paged read', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seed(harness, PAGED_READ.numItems + 20);
    const windows: Array<readonly Doc<'docPages'>[]> = [];
    await forEachDocumentationWindow(actionContext(harness), agentId, 'test', (pages) => {
      windows.push(pages);
      return 'continue';
    });
    expect(windows.map((pages) => pages.length)).toEqual([PAGED_READ.numItems, 20, 1]);
    expect(windows.flat().map((page) => page.ref)).toEqual([
      ...Array.from(
        { length: PAGED_READ.numItems + 20 },
        (_value, index) => `first-${String(index).padStart(3, '0')}.md`,
      ),
      'second-000.md',
    ]);
  });

  it('reads nothing after the window its caller stops at', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seed(harness, PAGED_READ.numItems + 20);
    let visited = 0;
    await forEachDocumentationWindow(actionContext(harness), agentId, 'test', () => {
      visited += 1;
      return 'stop';
    });
    expect(visited).toBe(1);
  });

  it('skips a source the employee was deployed without', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, first } = await seed(harness, 2);
    await harness.run(
      async (ctx) => await ctx.db.patch(agentId, { excludedDocSourceIds: [first] }),
    );
    const refs: string[] = [];
    await forEachDocumentationWindow(actionContext(harness), agentId, 'test', (pages) => {
      refs.push(...pages.map((page) => page.ref));
      return 'continue';
    });
    expect(refs).toEqual(['second-000.md']);
  });

  it("walks only its owner's sources, and nothing for an employee with no owner", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seed(harness, 1);
    const { foreign, ownerless } = await harness.run(async (ctx) => {
      const foreign = await ctx.db.insert('docSources', {
        userId: 'other-owner',
        label: 'Foreign',
        kind: 'folder',
        locator: 'foreign',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert('docPages', {
        sourceId: foreign,
        ref: 'foreign.md',
        title: 'Foreign',
        markdown: '# Foreign',
        updatedAt: 1,
      });
      const ownerless = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'legacy agent',
        state: 'active',
        createdAt: 1,
      });
      return { foreign, ownerless };
    });
    const read = async (id: Id<'agents'>): Promise<Doc<'docPages'>[]> => {
      const pages: Doc<'docPages'>[] = [];
      await forEachDocumentationWindow(actionContext(harness), id, 'test', (window) => {
        pages.push(...window);
        return 'continue';
      });
      return pages;
    };
    expect((await read(agentId)).map((page) => page.sourceId)).not.toContain(foreign);
    expect(await read(ownerless)).toEqual([]);
  });
});
