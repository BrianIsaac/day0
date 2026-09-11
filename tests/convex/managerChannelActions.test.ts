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

  it('resends with a fresh code after a send that died before recording, and only once', async (): Promise<void> => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL, init: RequestInit): Promise<Response> => {
        sent.push({
          url: input.href,
          authorization: new Headers(init.headers).get('authorization') ?? '',
          body: String(init.body),
        });
        return new Response(JSON.stringify({ ok: true, ts: '1787768500.000100' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedParkedPlan(harness);
    // The claim committed and the process died before the DM was recorded.
    await harness.mutation(internal.work.prepareDecisionRequest, {
      workItemId,
      kind: 'plan',
      decisionId: 'ab3xyz',
    });
    await expect(
      harness.mutation(internal.work.recoverUndeliveredDecisionRequest, {
        workItemId,
        decisionId: 'ab3xyz',
      }),
    ).resolves.toEqual({ recovered: 'resent' });

    // The recovery's resend, run by hand instead of by the scheduler.
    await expect(
      harness.action(internal.managerChannelActions.requestDecision, {
        workItemId,
        kind: 'plan',
        supersedes: 'ab3xyz',
      }),
    ).resolves.toEqual({ sent: true });
    expect(sent).toHaveLength(1);
    const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
    expect(row?.decision).toMatchObject({ kind: 'plan', ts: '1787768500.000100' });
    expect(row?.decision?.id).not.toBe('ab3xyz');
    expect(row?.decision).not.toHaveProperty('requestFailedAt');
    expect(sent[0]?.body).toContain(row?.decision?.id ?? 'missing');

    // The same resend delivered twice records one request and sends one DM.
    await expect(
      harness.action(internal.managerChannelActions.requestDecision, {
        workItemId,
        kind: 'plan',
        supersedes: 'ab3xyz',
      }),
    ).resolves.toEqual({ sent: false, reason: 'decision request already claimed' });
    expect(sent).toHaveLength(1);
    const requesting = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .filter((q) => q.eq(q.field('type'), 'work.decision-requesting'))
          .collect(),
    );
    expect(requesting.map((event) => (event.payload as { decisionId: string }).decisionId)).toEqual([
      'ab3xyz',
      row?.decision?.id,
    ]);
  });

  it('delivers a receipt acknowledgement once and records its provider timestamp', async (): Promise<void> => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL, init: RequestInit): Promise<Response> => {
        sent.push({
          url: input.href,
          authorization: new Headers(init.headers).get('authorization') ?? '',
          body: String(init.body),
        });
        return new Response(JSON.stringify({ ok: true, ts: `provider-${sent.length}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedParkedPlan(harness);
    await harness.action(internal.managerChannelActions.requestDecision, {
      workItemId,
      kind: 'plan',
    });
    const { decision, surfaceId } = await harness.run(async (ctx) => {
      const workItem = await ctx.db.get(workItemId);
      const surface = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'team-chat'))
        .unique();
      if (!workItem?.decision || !surface) throw new Error('decision fixture missing');
      return { decision: workItem.decision, surfaceId: surface._id };
    });
    await harness.mutation(internal.work.resolveChannelDecision, {
      surfaceId,
      userId: 'UMANAGER',
      messageTs: '1787768407.000100',
      reply: { verb: 'approve', id: decision.id },
    });
    const notice = await harness.run(async (ctx) =>
      await ctx.db
        .query('managerDecisionNotices')
        .withIndex('by_surface_message', (q) =>
          q.eq('surfaceId', surfaceId).eq('messageTs', '1787768407.000100'),
        )
        .unique(),
    );
    if (!notice) throw new Error('receipt notice missing');

    await expect(
      harness.action(internal.managerChannelActions.sendManagerReplyNotice, {
        noticeId: notice._id,
      }),
    ).resolves.toEqual({ sent: true });
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[1].body).text).toContain(
      `Approval ${decision.id} received. I’m starting the approved plan now.`,
    );
    expect(JSON.parse(sent[1].body).text).toContain('-- ops worker (Day0) · run ');
    expect(await harness.run(async (ctx) => await ctx.db.get(notice._id))).toMatchObject({
      claimedAt: expect.any(Number),
      providerTs: 'provider-2',
    });
    await expect(
      harness.action(internal.managerChannelActions.sendManagerReplyNotice, {
        noticeId: notice._id,
      }),
    ).resolves.toEqual({ sent: false, reason: 'notice already claimed' });
    expect(sent).toHaveLength(2);
  });
});


it('does not transport a request superseded while its credential was being read', async () => {
  const fetchSpy = vi.fn(async (): Promise<Response> =>
    new Response(JSON.stringify({ ok: true, ts: '1787768500.000100' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
  vi.stubGlobal('fetch', fetchSpy);
  const harness = convexTest(schema, allConvexModules());
  const { workItemId } = await seedParkedPlan(harness);
  hooks.afterCredentialRead = async () => {
    hooks.afterCredentialRead = undefined;
    const row = await harness.query(internal.work.getInternal, { workItemId });
    const decisionId = row!.decision!.id;
    await harness.mutation(internal.work.recoverUndeliveredDecisionRequest, { workItemId, decisionId });
    await expect(harness.action(internal.managerChannelActions.requestDecision, {
      workItemId, kind: 'plan', supersedes: decisionId,
    })).resolves.toEqual({ sent: true });
  };
  await expect(harness.action(internal.managerChannelActions.requestDecision, {
    workItemId, kind: 'plan',
  })).resolves.toEqual({ sent: false, reason: 'decision request is no longer current' });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const row = await harness.query(internal.work.getInternal, { workItemId });
  expect(row?.decision?.ts).toBe('1787768500.000100');
  expect(row?.decision?.requestFailedAt).toBeUndefined();
});
