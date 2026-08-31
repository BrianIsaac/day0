import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

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

describe('event trace export on a deployed agent', (): void => {
  afterEach((): void => restoreSurfaceMode());

  it('carries neither the boss email the deploy event records nor a token shape a provider echoed', async (): Promise<void> => {
    useSurfaceMode('mock');
    const { api: mockApi } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity({ subject: 'owner' });
    const bossEmail = 'priya.boss@day0.local';
    const agentId = await owner.mutation(mockApi.agents.deploy, { bossEmail, name: 'Priya' });
    const token = ['xoxb', '1234567890', 'abcdefghijklmnop'].join('-');
    await harness.run(async (ctx): Promise<void> => {
      const workItemId = await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-2',
        title: 'Close the loop',
        contentSummary: 'Synthetic evaluation work.',
        contentRefs: [],
        state: 'failed',
        observedAt: 1,
        createdAt: 1,
      });
      const output = {
        applied: [
          {
            tool: 'http.request',
            ok: false,
            reason: `provider said: invalid_auth for Bearer ${token}`,
            idempotencyKey: `${workItemId}:run-2:0`,
          },
        ],
      };
      await ctx.db.patch(workItemId, { output });
      await ctx.db.insert('events', {
        agentId,
        type: 'work.failed',
        payload: { workItemId, reason: `transport refused ${token}`, output },
        createdAt: 5,
      });
    });
    const trace = await owner.query(mockApi.events.exportForAgent, { agentId });
    const serialised = JSON.stringify(trace);
    expect(trace.events.map((event) => event.type)).toContain('agent.deployed');
    expect(serialised).not.toContain(bossEmail);
    expect(serialised).not.toContain(token);
    expect(serialised).toContain('<redacted>');
    expect(trace.ledger).toHaveLength(1);
  });
});
