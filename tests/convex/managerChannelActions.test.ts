/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';

const sent = vi.hoisted(() => [] as Array<{ authorization: string; body: string; url: string }>);

vi.mock('../../src/surfaces/credentials', () => ({
  decryptCredentialRef: { name: 'credentials:decrypt' },
  decryptCredential: async (): Promise<string> => 'chat-secret',
}));

afterEach((): void => {
  sent.length = 0;
  vi.unstubAllGlobals();
});

describe('the outbound manager-channel action', (): void => {
  it('sends once through the connected adapter and records provider evidence', async (): Promise<void> => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL, init: RequestInit): Promise<Response> => {
        sent.push({
          url: input.href,
          authorization: new Headers(init.headers).get('authorization') ?? '',
          body: String(init.body),
        });
        return new Response(JSON.stringify({ ok: true, ts: '1787768406.604379' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const harness = convexTest(schema, allConvexModules());
    const workItemId = await harness.run(async (ctx): Promise<Id<'workItems'>> => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'ops worker',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      await ctx.db.insert('permissionGrants', { agentId, scope: 'boss:message', createdAt: 1 });
      const credentialId = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'value',
        label: 'team chat token',
        ciphertext: 'ciphertext',
        iv: 'iv',
        source: 'entered',
        createdAt: 1,
      });
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'team-chat',
        displayName: 'Team chat',
        class: 'chat',
        verdict: 'connected',
        whereFound: [],
        path: 'documented-api',
        endpoint: 'https://slack.com/api/',
        toolAllowlist: ['chat.postMessage'],
        toolArguments: [{ tool: 'chat.postMessage', arguments: ['channel', 'text'] }],
        managerDmChannelId: 'D0MANAGER',
        credentialId,
        credentialKind: 'value',
        credentialLanded: true,
        lastVerifiedAt: Date.now(),
        createdAt: 1,
      });
      return await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'live-document',
        sourceSystem: 'docs',
        externalId: 'decision-action-test',
        title: 'Verify the runbook',
        contentSummary: 'Read the runbook.',
        contentRefs: [],
        state: 'plan-pending',
        plan: { summary: 'Read the runbook and report the finding.' },
        observedAt: 1,
        createdAt: 1,
      });
    });

    await expect(
      harness.action(internal.managerChannelActions.requestDecision, {
        workItemId,
        kind: 'plan',
      }),
    ).resolves.toEqual({ sent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      url: 'https://slack.com/api/chat.postMessage',
      authorization: 'Bearer chat-secret',
    });
    expect(JSON.parse(sent[0].body)).toMatchObject({ channel: 'D0MANAGER' });
    expect(JSON.parse(sent[0].body).text).toMatch(/Reply “approve [23456789abcdefghjkmnpqrstuvwxyz]{6}”/);
    expect(JSON.parse(sent[0].body).text).toContain('-- ops worker (Day0) · run ');

    const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
    expect(row?.decision).toMatchObject({
      kind: 'plan',
      surfaceSlug: 'team-chat',
      ts: '1787768406.604379',
    });
    await expect(
      harness.action(internal.managerChannelActions.requestDecision, {
        workItemId,
        kind: 'plan',
      }),
    ).resolves.toEqual({ sent: false, reason: 'decision request already claimed' });
    expect(sent).toHaveLength(1);

    await harness.run(async (ctx) => {
      const current = await ctx.db.get(workItemId);
      if (!current?.decision) throw new Error('decision missing');
      await ctx.db.patch(workItemId, {
        decision: {
          ...current.decision,
          decidedAt: 2,
          outcome: 'approved',
          decidedVia: 'dashboard',
          duplicateNotifiedAt: 3,
        },
      });
    });
    await expect(
      harness.action(internal.managerChannelActions.sendDecisionNotice, {
        workItemId,
        decisionId: row?.decision?.id ?? '',
      }),
    ).resolves.toEqual({ sent: true });
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[1].body).text).toContain(
      'was already approved from the day0 dashboard.',
    );
    await expect(
      harness.action(internal.managerChannelActions.sendDecisionNotice, {
        workItemId,
        decisionId: row?.decision?.id ?? '',
      }),
    ).resolves.toEqual({ sent: false, reason: 'notice already claimed' });
    expect(sent).toHaveLength(2);
  });
});
