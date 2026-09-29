import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { BROWSER_DRIVER_ABSENT } from '../../src/surfaces/browser';
import { allConvexModules } from './all-modules';

/**
 * What `surfaces.listForAgent` hands the Surfaces tab's cards beyond the stored row: the reason
 * a proposed card cannot be approved now (E-63), so the card disables Approve with the reason
 * rather than meeting it as a thrown refusal on the click.
 */

afterEach((): void => {
  vi.unstubAllEnvs();
});

const QUEUE_CHANGED =
  'A documented intake queue changed; reject this card and re-run orientation before approval.';

/** An owned agent, a linked source with one handbook page, and the harness they live in. */
async function seedOffice(handbook: string): Promise<{
  harness: TestConvex<typeof schema>;
  agentId: Id<'agents'>;
  sourceId: Id<'docSources'>;
}> {
  const harness = convexTest(schema, allConvexModules());
  const ids = await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: 'Mira',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const sourceId = await ctx.db.insert('docSources', {
      userId: 'owner',
      label: 'Runbooks',
      kind: 'folder',
      locator: '.',
      status: 'synced',
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert('docPages', {
      sourceId,
      ref: 'handbook.md',
      title: 'Handbook',
      markdown: handbook,
      updatedAt: 1,
    });
    return { agentId, sourceId };
  });
  return { harness, ...ids };
}

/** Insert one surface card for the agent with the fields a test needs. */
async function card(
  harness: TestConvex<typeof schema>,
  agentId: Id<'agents'>,
  fields: Partial<Doc<'surfaces'>> & Pick<Doc<'surfaces'>, 'slug'>,
): Promise<Id<'surfaces'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('surfaces', {
        agentId,
        displayName: fields.slug,
        class: 'kanban',
        verdict: 'proposed',
        path: 'mcp',
        whereFound: [],
        credentialLanded: false,
        createdAt: 1,
        ...fields,
      }),
  );
}

describe('the approval refusal on a listed card (E-63)', (): void => {
  it('names why a proposed card whose documented queue changed cannot be approved', async (): Promise<void> => {
    const { harness, agentId, sourceId } = await seedOffice('Team: FINANCE');
    await card(harness, agentId, {
      slug: 'linear',
      intakeScope: {
        team: { value: 'REVOPS', sourceId, ref: 'handbook.md', quote: 'Team: REVOPS' },
      },
    });

    const listed = await harness
      .withIdentity({ subject: 'owner' })
      .query(api.surfaces.listForAgent, { agentId });

    expect(listed).toMatchObject([{ slug: 'linear', approvalRefusal: QUEUE_CHANGED }]);
  });

  it('names the absent browser component on a proposed browser-driven card', async (): Promise<void> => {
    vi.stubEnv('DAY0_BROWSER_MCP_URL', '');
    const { harness, agentId } = await seedOffice('Team: REVOPS');
    await card(harness, agentId, { slug: 'looker', class: 'analytics', path: 'browser-driven' });

    const [looker] = await harness
      .withIdentity({ subject: 'owner' })
      .query(api.surfaces.listForAgent, { agentId });

    expect(looker?.approvalRefusal).toContain(BROWSER_DRIVER_ABSENT);
  });

  it('leaves the refusal off a card that can be approved, and off every card past proposal', async (): Promise<void> => {
    const { harness, agentId, sourceId } = await seedOffice('Team: REVOPS');
    const scope = {
      team: { value: 'REVOPS', sourceId, ref: 'handbook.md', quote: 'Team: REVOPS' },
    };
    await card(harness, agentId, { slug: 'linear', intakeScope: scope });
    await card(harness, agentId, {
      slug: 'jira',
      verdict: 'connected',
      intakeScope: { team: { ...scope.team, quote: 'Team: GONE' } },
    });

    const listed = await harness
      .withIdentity({ subject: 'owner' })
      .query(api.surfaces.listForAgent, { agentId });

    expect(listed.map((row) => [row.slug, row.approvalRefusal])).toEqual([
      ['linear', undefined],
      ['jira', undefined],
    ]);
  });
});
