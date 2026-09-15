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

describe('the notes the gate sends for the manager', (): void => {
  function recordSends(): void {
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
  }

  async function keepNote(
    harness: ReturnType<typeof convexTest>,
    agentId: Id<'agents'>,
    workItemId: Id<'workItems'>,
    kind: 'landed' | 'stopped',
    text: string,
  ): Promise<Id<'managerNotes'>> {
    return await harness.run(
      async (ctx) => await ctx.db.insert('managerNotes', { agentId, workItemId, kind, text, createdAt: Date.now() }),
    );
  }

  it('sends a landed note once and records the provider ts', async (): Promise<void> => {
    recordSends();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedParkedPlan(harness);
    const noteId = await keepNote(harness, agentId, workItemId, 'landed', 'ops worker finished “Verify the runbook”: 1 change landed.');

    await expect(harness.action(internal.managerChannelActions.sendManagerNote, { noteId })).resolves.toEqual({ sent: true });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].body)).toMatchObject({ channel: 'D0MANAGER' });
    expect(JSON.parse(sent[0].body).text).toContain('ops worker finished “Verify the runbook”: 1 change landed.');
    expect(await harness.run(async (ctx) => await ctx.db.get(noteId))).toMatchObject({
      claimedAt: expect.any(Number),
      providerTs: 'provider-1',
    });
    await expect(harness.action(internal.managerChannelActions.sendManagerNote, { noteId })).resolves.toEqual({
      sent: false,
      reason: 'note already claimed',
    });
    expect(sent).toHaveLength(1);
  });

  it('sends one digest for every kept note and nothing on the next hour', async (): Promise<void> => {
    recordSends();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedParkedPlan(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(agentId, { managerNotifications: 'digest' });
    });
    const first = await keepNote(harness, agentId, workItemId, 'stopped', 'ops worker stopped on “A”: no owner.');
    const second = await keepNote(harness, agentId, workItemId, 'landed', 'ops worker finished “B”: 1 change landed.');

    await expect(harness.action(internal.managerChannelActions.sendManagerDigests, {})).resolves.toEqual({ sent: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    const text = JSON.parse(sent[0].body).text as string;
    expect(text).toContain('ops worker: 2 updates since the last digest.');
    expect(text).toContain('ops worker stopped on “A”: no owner.');
    expect(text).toContain('ops worker finished “B”: 1 change landed.');
    for (const noteId of [first, second]) {
      expect(await harness.run(async (ctx) => await ctx.db.get(noteId))).toMatchObject({
        providerTs: 'provider-1',
        digestId: expect.any(String),
      });
    }
    await expect(harness.action(internal.managerChannelActions.sendManagerDigests, {})).resolves.toEqual({ sent: 0, failed: 0 });
    expect(sent).toHaveLength(1);
  });

  it('releases the notes of a digest that did not land for the next one', async (): Promise<void> => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => new Response('{"ok":false,"error":"channel_not_found"}', { status: 200, headers: { 'content-type': 'application/json' } })));
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedParkedPlan(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(agentId, { managerNotifications: 'digest' });
    });
    const noteId = await keepNote(harness, agentId, workItemId, 'landed', 'x');
    await expect(harness.action(internal.managerChannelActions.sendManagerDigests, {})).resolves.toEqual({ sent: 0, failed: 1 });
    const note = await harness.run(async (ctx) => await ctx.db.get(noteId));
    expect(note?.providerTs).toBeUndefined();
    expect(note?.claimedAt).toBeUndefined();
    expect(note?.failure).toBeTruthy();
    expect(await harness.query(internal.work.digestCandidates, {})).toEqual([agentId]);
  });
});

describe('one code for every open action decision', (): void => {
  const publicPost = {
    tool: 'http.request',
    args: {
      surface: 'team-chat',
      method: 'POST',
      path: '/chat.postMessage',
      headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
      body: JSON.stringify({ channel: 'C0PUBLIC', text: 'The figure is 74%.' }),
    },
  };

  async function park(
    harness: ReturnType<typeof convexTest>,
    agentId: Id<'agents'>,
    title: string,
  ): Promise<Id<'workItems'>> {
    const ids = await harness.run(async (ctx) => {
      const workItemId = await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'event-stream',
        sourceSystem: 'team-chat',
        externalId: title,
        title,
        contentSummary: 'Answer the ask.',
        contentRefs: [],
        state: 'executing',
        observedAt: 1,
        createdAt: 1,
      });
      const runId = await ctx.db.insert('events', { agentId, type: 'work.execution-claimed', payload: { workItemId }, createdAt: 1 });
      await ctx.db.patch(workItemId, { executionRunId: runId });
      return { workItemId, runId };
    });
    await harness.mutation(internal.work.setActionsPending, {
      ...ids,
      output: { draft: 'Reply drafted.', notes: '', actions: [publicPost] },
    });
    return ids.workItemId;
  }

  it('is offered from the second open request on, names every member, and decides them all from one reply', async (): Promise<void> => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL, init: RequestInit): Promise<Response> => {
        sent.push({ url: input.href, authorization: new Headers(init.headers).get('authorization') ?? '', body: String(init.body) });
        return new Response(JSON.stringify({ ok: true, ts: `provider-${sent.length}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedParkedPlan(harness);
    await harness.run(async (ctx) => {
      await ctx.db.insert('permissionGrants', { agentId, scope: 'team-chat:write', createdAt: 1 });
    });
    const first = await park(harness, agentId, 'Answer the ask in #revops');
    const second = await park(harness, agentId, 'Answer the ask in #finance');

    await expect(harness.action(internal.managerChannelActions.requestDecision, { workItemId: first, kind: 'actions' })).resolves.toEqual({ sent: true });
    const firstText = JSON.parse(sent[0].body).text as string;
    expect(firstText).not.toContain('held action sets are waiting');
    expect(await harness.run(async (ctx) => await ctx.db.query('decisionBatches').collect())).toEqual([]);

    await expect(harness.action(internal.managerChannelActions.requestDecision, { workItemId: second, kind: 'actions' })).resolves.toEqual({ sent: true });
    const [firstRow, secondRow] = await harness.run(async (ctx) => [await ctx.db.get(first), await ctx.db.get(second)]);
    const batches = await harness.run(async (ctx) => await ctx.db.query('decisionBatches').collect());
    expect(batches).toHaveLength(1);
    const batch = batches[0];
    expect(batch.id).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{6}$/);
    expect(batch.members).toEqual([
      { workItemId: second, decisionId: secondRow?.decision?.id, pendingRunId: secondRow?.pendingRunId },
      { workItemId: first, decisionId: firstRow?.decision?.id, pendingRunId: firstRow?.pendingRunId },
    ]);
    const secondText = JSON.parse(sent[1].body).text as string;
    expect(secondText).toContain(`Reply “approve ${secondRow?.decision?.id}” or “reject ${secondRow?.decision?.id} <reason>”.`);
    expect(secondText).toContain('2 held action sets are waiting, each shown in its own request:');
    expect(secondText).toContain(`1. Answer the ask in #finance (${secondRow?.decision?.id})`);
    expect(secondText).toContain(`2. Answer the ask in #revops (${firstRow?.decision?.id})`);
    expect(secondText).toContain(`Reply “approve ${batch.id}” to approve every held action in all 2, or “reject ${batch.id} <reason>” to reject them all.`);

    // The poller hands the batch code to the same resolver as an item's code.
    const surfaceId = await harness.run(async (ctx) => {
      const surface = await ctx.db.query('surfaces').withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'team-chat')).unique();
      if (!surface) throw new Error('surface missing');
      return surface._id;
    });
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs: '1787768407.000200',
        reply: { verb: 'approve', id: batch.id },
      }),
    ).resolves.toEqual({ status: 'decided', outcome: 'approve', decided: [secondRow?.decision?.id, firstRow?.decision?.id], skipped: [] });
    for (const workItemId of [first, second]) {
      expect(await harness.run(async (ctx) => await ctx.db.get(workItemId))).toMatchObject({
        applyPhase: 'approved',
        approvedIndexes: [0],
        decision: { outcome: 'approved', decidedVia: 'channel' },
      });
    }
  });
});
