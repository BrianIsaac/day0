/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';

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
