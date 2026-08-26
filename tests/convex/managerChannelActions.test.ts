/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';

const sent = vi.hoisted(() => [] as Array<{ authorization: string; body: string; url: string }>);
const hooks = vi.hoisted(() => ({ afterCredentialRead: undefined as (() => Promise<void>) | undefined }));

vi.mock('../../src/surfaces/credentials', () => ({
  decryptCredentialRef: { name: 'credentials:decrypt' },
  decryptCredential: async (): Promise<string> => {
    await hooks.afterCredentialRead?.();
    return 'chat-secret';
  },
}));

afterEach((): void => {
  sent.length = 0;
  hooks.afterCredentialRead = undefined;
  vi.unstubAllGlobals();
});

async function seedParkedPlan(harness: ReturnType<typeof convexTest>): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'> }> {
  return await harness.run(async (ctx) => {
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
      managerUserId: 'UMANAGER',
      credentialId,
      credentialKind: 'value',
      credentialLanded: true,
      lastVerifiedAt: Date.now(),
      createdAt: 1,
    });
    const workItemId = await ctx.db.insert('workItems', {
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
    return { agentId, workItemId };
  });
}

describe('the outbound manager-channel action', (): void => {
  it('stops at the last boundary when the DM authority is gone, and audits the failed request', async (): Promise<void> => {
    const fetchSpy = vi.fn(async (): Promise<Response> => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedParkedPlan(harness);
    // The credential is read after the claim and before transport; revoking the DM grant
    // there is the narrowest window a real revocation could land in.
    hooks.afterCredentialRead = async (): Promise<void> => {
      await harness.run(async (ctx) => {
        const grants = await ctx.db
          .query('permissionGrants')
          .withIndex('by_agent_scope', (q) => q.eq('agentId', agentId))
          .collect();
        for (const grant of grants) await ctx.db.patch(grant._id, { revokedAt: 2 });
      });
    };

    await expect(
      harness.action(internal.managerChannelActions.requestDecision, { workItemId, kind: 'plan' }),
    ).resolves.toEqual({ sent: false, reason: 'no grant (boss:message)' });
    expect(fetchSpy).not.toHaveBeenCalled();
    const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
    expect(row?.decision).toMatchObject({
      kind: 'plan',
      requestFailure: 'no grant (boss:message)',
      requestFailedAt: expect.any(Number),
    });
    expect(row?.decision?.ts).toBeUndefined();
    const failures = (await harness.run(async (ctx) => await ctx.db.query('events').collect())).filter(
      (event) => event.type === 'work.decision-request-failed',
    );
    expect(failures.map((event) => event.payload)).toEqual([
      { workItemId, decisionId: row?.decision?.id, kind: 'plan', reason: 'no grant (boss:message)' },
    ]);
    // Single-use holds even for a request that never left: no second attempt.
    hooks.afterCredentialRead = undefined;
    await expect(
      harness.action(internal.managerChannelActions.requestDecision, { workItemId, kind: 'plan' }),
    ).resolves.toEqual({ sent: false, reason: 'decision request already claimed' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

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
        managerUserId: 'UMANAGER',
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
