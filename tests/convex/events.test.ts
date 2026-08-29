import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';

describe('event trace export', (): void => {
  it('exports the full event list and redacted ledger with credential names only', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const id = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'Priya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const credentialId = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'value',
        label: 'Linear service token',
        ciphertext: 'TOP-SECRET-CIPHERTEXT',
        iv: 'TOP-SECRET-IV',
        source: 'entered',
        createdAt: 1,
      });
      await ctx.db.insert('surfaces', {
        agentId: id,
        slug: 'linear',
        displayName: 'Linear',
        class: 'kanban',
        verdict: 'connected',
        whereFound: [],
        path: 'mcp',
        endpoint: 'https://mcp.linear.app/mcp',
        credentialId,
        credentialLanded: true,
        lastVerifiedAt: 1,
        createdAt: 1,
      });
      const workItemId = await ctx.db.insert('workItems', {
        agentId: id,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-1',
        title: 'Close the loop',
        contentSummary: 'Synthetic evaluation work.',
        contentRefs: [],
        state: 'completed',
        observedAt: 1,
        createdAt: 1,
      });
      const output = {
        applied: [
          {
            tool: 'mcp.call',
            ok: true,
            authority: 'manager',
            effect: 'Commented on REVOPS-1',
            idempotencyKey: `${workItemId}:run-1:0`,
          },
        ],
      };
      await ctx.db.patch(workItemId, { output });
      await ctx.db.insert('events', {
        agentId: id,
        type: 'work.completed',
        payload: { workItemId, output },
        createdAt: 2,
      });
      await ctx.db.insert('events', {
        agentId: id,
        type: 'permission.revoked',
        payload: { scope: 'linear:read', by: 'manager' },
        createdAt: 3,
      });
      return id;
    });

    await expect(
      harness.withIdentity({ subject: 'intruder' }).query(api.events.exportForAgent, { agentId }),
    ).rejects.toThrow('forbidden');
    const trace = await harness
      .withIdentity({ subject: 'owner' })
      .query(api.events.exportForAgent, { agentId });
    expect(trace.agent).toEqual({ id: agentId, name: 'Priya' });
    expect(trace.events.map((event) => event.type)).toEqual([
      'work.completed',
      'permission.revoked',
    ]);
    expect(trace.credentialNames).toEqual([{ label: 'Linear service token' }]);
    expect(trace.ledger).toHaveLength(1);
    expect(trace.ledger[0]).toMatchObject({
      workItemId: expect.any(String),
      observedAt: 2,
      runId: 'run-1',
      entry: {
        tool: 'mcp.call',
        authority: 'manager',
        effect: 'Commented on REVOPS-1',
      },
    });
    const serialised = JSON.stringify(trace);
    expect(serialised).not.toContain('TOP-SECRET-CIPHERTEXT');
    expect(serialised).not.toContain('TOP-SECRET-IV');
    expect(serialised).not.toContain('boss@day0.local');
  });
});
