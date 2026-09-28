/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';

describe('the export redacts by its own policy row (review M9)', (): void => {
  it("removes an e-mail, a phone number and a labelled address from a work item's text", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const id = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
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
      .withIdentity({ subject: 'owner' })
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
