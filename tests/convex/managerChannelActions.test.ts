/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { transferNoticeText } from '../../convex/managerTransfers';
import { credentialOwnerBinding, encrypt } from '../../src/lib/credential-crypto';
import { fixtureAddressOf, MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

const sent = vi.hoisted(() => [] as Array<{ authorization: string; body: string; url: string }>);
const hooks = vi.hoisted(() => ({
  afterCredentialRead: undefined as (() => Promise<void>) | undefined,
}));

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
  vi.useRealTimers();
});

/** The top of an hour in UTC, the deployment's zone in the suite, and quarter past it. */
const TOP_OF_HOUR = Date.UTC(2026, 8, 28, 9, 1);
const QUARTER_PAST = Date.UTC(2026, 8, 28, 9, 16);

/** Fake only the clock, so the provider's fetch still resolves on its own. */
function clockAt(ms: number): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(ms);
}

async function seedParkedPlan(
  harness: ReturnType<typeof convexTest>,
): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
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
  it('sends the ticket and its link in the request, so the manager can open it from the DM', async (): Promise<void> => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL, init: RequestInit): Promise<Response> => {
        sent.push({ url: input.href, authorization: '', body: String(init.body) });
        return new Response(JSON.stringify({ ok: true, ts: '1787768406.604379' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seedParkedPlan(harness);
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, {
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-7',
        contentRefs: ['https://linear.app/day0/issue/REVOPS-7'],
      });
    });

    await expect(
      harness.action(internal.managerChannelActions.requestDecision, { workItemId, kind: 'plan' }),
    ).resolves.toEqual({ sent: true });
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0]!.body) as { text: string };
    expect(body.text.split('\n').slice(0, 2)).toEqual([
      'ops worker needs your decision on “Verify the runbook”.',
      'Ticket: REVOPS-7 https://linear.app/day0/issue/REVOPS-7',
    ]);
  });

  it('sends nothing through a chat surface whose access end date passed before the sweep ended it (M21)', async (): Promise<void> => {
    const fetchSpy = vi.fn(
      async (): Promise<Response> => new Response('{"ok":true}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seedParkedPlan(harness);
    // The claim reads the row as connected; the end date passes before the send.
    hooks.afterCredentialRead = async (): Promise<void> => {
      await harness.run(async (ctx) => {
        const surface = await ctx.db.query('surfaces').first();
        if (surface) await ctx.db.patch(surface._id, { expiresAt: Date.UTC(2026, 8, 1) });
      });
    };

    await expect(
      harness.action(internal.managerChannelActions.requestDecision, { workItemId, kind: 'plan' }),
    ).resolves.toEqual({
      sent: false,
      reason: 'access ended on 2026-09-01; the manager renews it on the card',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stops at the last boundary when the DM authority is gone, and audits the failed request', async (): Promise<void> => {
    const fetchSpy = vi.fn(
      async (): Promise<Response> => new Response('{"ok":true}', { status: 200 }),
    );
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
    const failures = (
      await harness.run(async (ctx) => await ctx.db.query('events').collect())
    ).filter((event) => event.type === 'work.decision-request-failed');
    expect(failures.map((event) => event.payload)).toEqual([
      {
        workItemId,
        decisionId: row?.decision?.id,
        kind: 'plan',
        reason: 'no grant (boss:message)',
      },
    ]);
    // Single-use holds even for a request that never left: no second attempt.
    hooks.afterCredentialRead = undefined;
    await expect(
      harness.action(internal.managerChannelActions.requestDecision, { workItemId, kind: 'plan' }),
    ).resolves.toEqual({ sent: false, reason: 'decision request already claimed' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends a decision immediately in digest mode and records provider evidence', async (): Promise<void> => {
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
        bossEmail: MANAGER_ADDRESS,
        name: 'ops worker',
        managerNotifications: 'digest',
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
    expect(JSON.parse(sent[0].body).text).toMatch(
      /Reply “approve [23456789abcdefghjkmnpqrstuvwxyz]{6}”/,
    );
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
    expect(requesting.map((event) => (event.payload as { decisionId: string }).decisionId)).toEqual(
      ['ab3xyz', row?.decision?.id],
    );
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
    const notice = await harness.run(
      async (ctx) =>
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
    // The acknowledgement answers the request, so it sits in the request's thread (M finding 3).
    expect(decision.ts).toBe('provider-1');
    expect(JSON.parse(sent[1].body).thread_ts).toBe('provider-1');
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

describe('a decided request in the manager DM (M finding 3)', (): void => {
  /** A Slack double that answers every call, recording it. */
  function recordSlack(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL, init: RequestInit): Promise<Response> => {
        sent.push({ url: input.href, authorization: '', body: String(init.body) });
        return new Response(JSON.stringify({ ok: true, ts: `provider-${sent.length}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
  }

  /** A request for the parked plan, sent, and the manager's approval of it in the DM. */
  async function decideInDm(
    harness: TestConvex<typeof schema>,
    allowlist: string[],
  ): Promise<{ workItemId: Id<'workItems'>; decisionId: string }> {
    const { agentId, workItemId } = await seedParkedPlan(harness);
    const surfaceId = await harness.run(async (ctx) => {
      const surface = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'team-chat'))
        .unique();
      await ctx.db.patch(surface!._id, { toolAllowlist: allowlist });
      return surface!._id;
    });
    await harness.action(internal.managerChannelActions.requestDecision, {
      workItemId,
      kind: 'plan',
    });
    const decisionId = await harness.run(
      async (ctx) => (await ctx.db.get(workItemId))!.decision!.id,
    );
    await harness.mutation(internal.work.resolveChannelDecision, {
      surfaceId,
      userId: 'UMANAGER',
      messageTs: '1787768407.000100',
      reply: { verb: 'approve', id: decisionId },
    });
    return { workItemId, decisionId };
  }

  it('edits the request once to say it was decided, keeping what it asked', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, decisionId } = await decideInDm(harness, [
      'chat.postMessage',
      'chat.update',
    ]);
    const scheduled = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    expect(scheduled.map((job) => job.name)).toContain(
      'managerChannelActions:closeDecisionRequest',
    );

    await expect(
      harness.action(internal.managerChannelActions.closeDecisionRequest, {
        workItemId,
        decisionId,
      }),
    ).resolves.toEqual({ closed: true });
    const updates = sent.filter((call) => call.url.endsWith('/chat.update'));
    expect(updates).toHaveLength(1);
    const body = JSON.parse(updates[0]!.body) as { channel: string; ts: string; text: string };
    expect(body.channel).toBe('D0MANAGER');
    expect(body.ts).toBe('provider-1');
    expect(body.text).toContain('needs your decision on “Verify the runbook”');
    expect(body.text).toContain(`Decided: approved in this DM (${decisionId}).`);

    await expect(
      harness.action(internal.managerChannelActions.closeDecisionRequest, {
        workItemId,
        decisionId,
      }),
    ).resolves.toEqual({ closed: false });
    expect(sent.filter((call) => call.url.endsWith('/chat.update'))).toHaveLength(1);
  });

  it('leaves the request as sent when the card does not allow chat.update', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, decisionId } = await decideInDm(harness, ['chat.postMessage']);
    await expect(
      harness.action(internal.managerChannelActions.closeDecisionRequest, {
        workItemId,
        decisionId,
      }),
    ).resolves.toEqual({ closed: false });
    expect(sent.filter((call) => call.url.endsWith('/chat.update'))).toEqual([]);
  });
});

it('does not transport a request superseded while its credential was being read', async () => {
  const fetchSpy = vi.fn(
    async (): Promise<Response> =>
      new Response(JSON.stringify({ ok: true, ts: '1787768500.000100' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchSpy);
  const harness = convexTest(schema, allConvexModules());
  const { workItemId } = await seedParkedPlan(harness);
  hooks.afterCredentialRead = async () => {
    hooks.afterCredentialRead = undefined;
    const row = await harness.query(internal.work.getInternal, { workItemId });
    const decisionId = row!.decision!.id;
    await harness.mutation(internal.work.recoverUndeliveredDecisionRequest, {
      workItemId,
      decisionId,
    });
    await expect(
      harness.action(internal.managerChannelActions.requestDecision, {
        workItemId,
        kind: 'plan',
        supersedes: decisionId,
      }),
    ).resolves.toEqual({ sent: true });
  };
  await expect(
    harness.action(internal.managerChannelActions.requestDecision, {
      workItemId,
      kind: 'plan',
    }),
  ).resolves.toEqual({ sent: false, reason: 'decision request is no longer current' });
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
      async (ctx) =>
        await ctx.db.insert('managerNotes', {
          agentId,
          workItemId,
          kind,
          text,
          createdAt: Date.now(),
        }),
    );
  }

  it('sends a landed note once and records the provider ts', async (): Promise<void> => {
    recordSends();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedParkedPlan(harness);
    const noteId = await keepNote(
      harness,
      agentId,
      workItemId,
      'landed',
      'ops worker finished “Verify the runbook”: 1 change landed.',
    );

    await expect(
      harness.action(internal.managerChannelActions.sendManagerNote, { noteId }),
    ).resolves.toEqual({ sent: true });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].body)).toMatchObject({ channel: 'D0MANAGER' });
    expect(JSON.parse(sent[0].body).text).toContain(
      'ops worker finished “Verify the runbook”: 1 change landed.',
    );
    expect(await harness.run(async (ctx) => await ctx.db.get(noteId))).toMatchObject({
      claimedAt: expect.any(Number),
      providerTs: 'provider-1',
    });
    await expect(
      harness.action(internal.managerChannelActions.sendManagerNote, { noteId }),
    ).resolves.toEqual({
      sent: false,
      reason: 'note already claimed',
    });
    expect(sent).toHaveLength(1);
  });

  it('sends one digest for every kept note and nothing on the next hour', async (): Promise<void> => {
    clockAt(TOP_OF_HOUR);
    recordSends();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedParkedPlan(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(agentId, { managerNotifications: 'digest' });
    });
    const first = await keepNote(
      harness,
      agentId,
      workItemId,
      'stopped',
      'ops worker stopped on “A”: no owner.',
    );
    const second = await keepNote(
      harness,
      agentId,
      workItemId,
      'landed',
      'ops worker finished “B”: 1 change landed.',
    );

    await expect(
      harness.action(internal.managerChannelActions.sendManagerDigests, {}),
    ).resolves.toEqual({ sent: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    const text = JSON.parse(sent[0].body).text as string;
    expect(text).toContain('ops worker: 2 updates since the last digest (times in UTC).');
    expect(text).toContain('28 Sep 2026, 09:01: ops worker stopped on “A”: no owner.');
    expect(text).toContain('ops worker stopped on “A”: no owner.');
    expect(text).toContain('ops worker finished “B”: 1 change landed.');
    for (const noteId of [first, second]) {
      expect(await harness.run(async (ctx) => await ctx.db.get(noteId))).toMatchObject({
        providerTs: 'provider-1',
        digestId: expect.any(String),
      });
    }
    await expect(
      harness.action(internal.managerChannelActions.sendManagerDigests, {}),
    ).resolves.toEqual({ sent: 0, failed: 0 });
    expect(sent).toHaveLength(1);
  });

  it('closes the digest with the decisions still owed, with the code the manager was sent (E-2, N-3)', async (): Promise<void> => {
    clockAt(TOP_OF_HOUR);
    recordSends();
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedParkedPlan(harness);
    const asked = await harness.run(async (ctx) => {
      await ctx.db.patch(agentId, { managerNotifications: 'digest' });
      return await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-7',
        title: 'Close REVOPS-7',
        contentSummary: 'Close it.',
        contentRefs: [],
        state: 'plan-pending',
        plan: { summary: 'Close it.' },
        decision: {
          id: 'ab3xyz',
          kind: 'plan',
          requestedAt: 1,
          channel: 'D0MANAGER',
          surfaceSlug: 'team-chat',
          surfaceName: 'Team chat',
          ts: '1787768406.604379',
        },
        observedAt: 1,
        createdAt: 1,
      });
    });
    await keepNote(harness, agentId, asked, 'landed', 'ops worker finished “B”: 1 change landed.');

    await expect(
      harness.action(internal.managerChannelActions.sendManagerDigests, {}),
    ).resolves.toEqual({ sent: 1, failed: 0 });
    const text = JSON.parse(sent[0].body).text as string;
    // The owed block closes the digest's own text; the provenance trailer follows it.
    expect(text).toContain(
      [
        'ops worker finished “B”: 1 change landed.',
        '',
        'Still waiting for your decision (2):',
        '- “Verify the runbook”: decide in day0',
        '- “Close REVOPS-7”: reply “approve ab3xyz” or “reject ab3xyz <reason>”',
      ].join('\n'),
    );
  });

  it('keeps a digest agent’s notes until the top of the hour in its own zone', async (): Promise<void> => {
    clockAt(TOP_OF_HOUR);
    recordSends();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedParkedPlan(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(agentId, { managerNotifications: 'digest', zone: 'Asia/Kolkata' });
    });
    await keepNote(
      harness,
      agentId,
      workItemId,
      'landed',
      'ops worker finished “B”: 1 change landed.',
    );
    await expect(
      harness.action(internal.managerChannelActions.sendManagerDigests, {}),
    ).resolves.toEqual({ sent: 0, failed: 0 });
    clockAt(Date.UTC(2026, 8, 28, 9, 31));
    await expect(
      harness.action(internal.managerChannelActions.sendManagerDigests, {}),
    ).resolves.toEqual({ sent: 1, failed: 0 });
    expect(JSON.parse(sent[0].body).text).toContain('28 Sep 2026, 14:31: ops worker finished');
  });

  it('sends the notes a switch to per run stranded at the next check, whatever the hour, and leaves later per-run notes to their own send', async (): Promise<void> => {
    recordSends();
    const harness = convexTest(schema, allConvexModules());
    clockAt(QUARTER_PAST);
    const { agentId, workItemId } = await seedParkedPlan(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(agentId, { managerNotifications: 'digest' });
    });
    const stranded = await keepNote(harness, agentId, workItemId, 'landed', 'kept for the digest');
    clockAt(QUARTER_PAST + 1_000);
    await harness.run(async (ctx) => {
      await ctx.db.patch(agentId, { managerNotifications: 'per-run' });
      await ctx.db.insert('events', {
        agentId,
        type: 'agent.notifications-changed',
        payload: { from: 'digest', to: 'per-run', reason: 'set by the manager' },
        createdAt: Date.now(),
      });
    });
    clockAt(QUARTER_PAST + 2_000);
    const inFlight = await harness.run(
      async (ctx) =>
        await ctx.db.insert('managerNotes', {
          agentId,
          workItemId,
          kind: 'landed',
          text: 'a per-run note',
          createdAt: Date.now(),
          keptFor: 'per-run',
        }),
    );
    // Kept in digest mode by a run that read the agent before the switch
    // committed: its stamp, not its time, makes it the digest's.
    const racing = await harness.run(
      async (ctx) =>
        await ctx.db.insert('managerNotes', {
          agentId,
          workItemId,
          kind: 'landed',
          text: 'kept as the switch landed',
          createdAt: Date.now(),
          keptFor: 'digest',
        }),
    );
    await expect(
      harness.action(internal.managerChannelActions.sendManagerDigests, {}),
    ).resolves.toEqual({ sent: 1, failed: 0 });
    expect(JSON.parse(sent[0].body).text).toContain('kept for the digest');
    expect(JSON.parse(sent[0].body).text).toContain('kept as the switch landed');
    expect((await harness.run(async (ctx) => await ctx.db.get(racing)))?.providerTs).toBe(
      'provider-1',
    );
    expect(JSON.parse(sent[0].body).text).not.toContain('a per-run note');
    expect((await harness.run(async (ctx) => await ctx.db.get(stranded)))?.providerTs).toBe(
      'provider-1',
    );
    expect(
      (await harness.run(async (ctx) => await ctx.db.get(inFlight)))?.claimedAt,
    ).toBeUndefined();
  });

  it('sends no second digest in the same quarter hour, whatever asks for one', async (): Promise<void> => {
    clockAt(TOP_OF_HOUR);
    recordSends();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedParkedPlan(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(agentId, { managerNotifications: 'digest' });
    });
    await keepNote(harness, agentId, workItemId, 'landed', 'first');
    await expect(
      harness.action(internal.managerChannelActions.sendManagerDigests, {}),
    ).resolves.toEqual({ sent: 1, failed: 0 });
    clockAt(TOP_OF_HOUR + 5 * 60_000);
    await keepNote(harness, agentId, workItemId, 'landed', 'second');
    await expect(
      harness.action(internal.managerChannelActions.sendManagerDigests, {}),
    ).resolves.toEqual({ sent: 0, failed: 0 });
    expect(sent).toHaveLength(1);
  });

  it('releases the notes of a digest that did not land for the next one', async (): Promise<void> => {
    clockAt(TOP_OF_HOUR);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (): Promise<Response> =>
          new Response('{"ok":false,"error":"channel_not_found"}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedParkedPlan(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(agentId, { managerNotifications: 'digest' });
    });
    const noteId = await keepNote(harness, agentId, workItemId, 'landed', 'x');
    await expect(
      harness.action(internal.managerChannelActions.sendManagerDigests, {}),
    ).resolves.toEqual({ sent: 0, failed: 1 });
    const note = await harness.run(async (ctx) => await ctx.db.get(noteId));
    expect(note?.providerTs).toBeUndefined();
    expect(note?.claimedAt).toBeUndefined();
    expect(note?.failure).toBeTruthy();
    expect(
      (await harness.query(internal.work.digestCandidates, { cursor: null })).agentIds,
    ).toEqual([agentId]);
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
      const runId = await ctx.db.insert('events', {
        agentId,
        type: 'work.execution-claimed',
        payload: { workItemId },
        createdAt: 1,
      });
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
    const { agentId } = await seedParkedPlan(harness);
    await harness.run(async (ctx) => {
      await ctx.db.insert('permissionGrants', { agentId, scope: 'team-chat:write', createdAt: 1 });
    });
    const first = await park(harness, agentId, 'Answer the ask in #revops');
    const second = await park(harness, agentId, 'Answer the ask in #finance');

    await expect(
      harness.action(internal.managerChannelActions.requestDecision, {
        workItemId: first,
        kind: 'actions',
      }),
    ).resolves.toEqual({ sent: true });
    const firstText = JSON.parse(sent[0].body).text as string;
    expect(firstText).not.toContain('held action sets are waiting');
    expect(
      await harness.run(async (ctx) => await ctx.db.query('decisionBatches').collect()),
    ).toEqual([]);

    await expect(
      harness.action(internal.managerChannelActions.requestDecision, {
        workItemId: second,
        kind: 'actions',
      }),
    ).resolves.toEqual({ sent: true });
    const [firstRow, secondRow] = await harness.run(async (ctx) => [
      await ctx.db.get(first),
      await ctx.db.get(second),
    ]);
    const batches = await harness.run(
      async (ctx) => await ctx.db.query('decisionBatches').collect(),
    );
    expect(batches).toHaveLength(1);
    const batch = batches[0];
    expect(batch.id).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{6}$/);
    expect(batch.members).toEqual([
      {
        workItemId: second,
        decisionId: secondRow?.decision?.id,
        pendingRunId: secondRow?.pendingRunId,
      },
      {
        workItemId: first,
        decisionId: firstRow?.decision?.id,
        pendingRunId: firstRow?.pendingRunId,
      },
    ]);
    const secondText = JSON.parse(sent[1].body).text as string;
    expect(secondText).toContain(
      `Reply “approve ${secondRow?.decision?.id}” or “reject ${secondRow?.decision?.id} <reason>”.`,
    );
    expect(secondText).toContain('2 held action sets are waiting, each shown in its own request:');
    expect(secondText).toContain(`1. Answer the ask in #finance (${secondRow?.decision?.id})`);
    expect(secondText).toContain(`2. Answer the ask in #revops (${firstRow?.decision?.id})`);
    expect(secondText).toContain(
      `Reply “approve ${batch.id}” to approve every held action in all 2, or “reject ${batch.id} <reason>” to reject them all.`,
    );

    // The poller hands the batch code to the same resolver as an item's code.
    const surfaceId = await harness.run(async (ctx) => {
      const surface = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'team-chat'))
        .unique();
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
    ).resolves.toEqual({
      status: 'decided',
      outcome: 'approve',
      decided: [secondRow?.decision?.id, firstRow?.decision?.id],
      skipped: [],
    });
    for (const workItemId of [first, second]) {
      expect(await harness.run(async (ctx) => await ctx.db.get(workItemId))).toMatchObject({
        applyPhase: 'approved',
        approvedIndexes: [0],
        decision: { outcome: 'approved', decidedVia: 'channel' },
      });
    }
  });
});

describe('the handover notice to the person a request names (D7)', (): void => {
  const PRIYA_ADDRESS = fixtureAddressOf('priya');
  const NOTICE_TS = '1790000000.000100';
  const REQUEST_TS = '1789999000.000100';

  afterEach((): void => {
    restoreSurfaceMode();
  });

  /** One Slack call the fake answered: the method, the channel it named and the text it carried. */
  interface SlackCall {
    readonly method: string;
    readonly channel?: string;
    readonly text?: string;
    readonly email?: string;
  }

  /**
   * A Slack workspace with the manager (UMANAGER), the bot (UBOT) and Priya (UPRIYA): it answers
   * the notice's calls and the decision poll's reads, and every message read back is a reply
   * that would accept the handover if a reply could.
   */
  function slackWorkspace(options: { readonly postFails?: boolean } = {}): SlackCall[] {
    const calls: SlackCall[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL, init: RequestInit = {}): Promise<Response> => {
        const method = input.pathname.split('/').pop() ?? '';
        const body =
          typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, string>) : {};
        const email = input.searchParams.get('email') ?? undefined;
        calls.push({ method, channel: body.channel, text: body.text, email });
        const answer = (payload: Record<string, unknown>): Response =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        switch (method) {
          case 'auth.test':
            return answer({ ok: true, user_id: 'UBOT', bot_id: 'BBOT', team_id: 'T1' });
          case 'users.lookupByEmail':
            return email === PRIYA_ADDRESS
              ? answer({ ok: true, user: { id: 'UPRIYA', real_name: 'Priya' } })
              : answer({ ok: false, error: 'users_not_found' });
          case 'conversations.open':
            return answer({ ok: true, channel: { id: 'D0PRIYA' } });
          case 'chat.postMessage':
            return options.postFails
              ? answer({ ok: false, error: 'channel_not_found' })
              : answer({ ok: true, ts: NOTICE_TS });
          case 'conversations.history':
          case 'conversations.replies':
            return answer({
              ok: true,
              messages: [
                { user: 'UPRIYA', text: 'Accept. I will take Maya on.', ts: '1790000100.000100' },
                {
                  user: 'UMANAGER',
                  text: 'accept the handover',
                  ts: '1790000200.000100',
                  thread_ts: REQUEST_TS,
                },
              ],
            });
          default:
            return answer({ ok: true });
        }
      }),
    );
    return calls;
  }

  /**
   * The notices among the calls: every post carrying the notice's words, wherever it went. The
   * file's earlier tests leave scheduled work that may post to the manager DM through the same
   * stubbed fetch, so a test counts the notice by its words, not every post.
   */
  function noticesIn(calls: readonly SlackCall[]): SlackCall[] {
    return calls.filter(
      (call) => call.method === 'chat.postMessage' && call.text?.includes('has asked you to take'),
    );
  }

  /** Maya, with a connected Slack card that can carry the notice, and a plan the manager was asked about. */
  async function seedMaya(
    harness: TestConvex<typeof schema>,
  ): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'> }> {
    return await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Maya',
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
        toolAllowlist: [
          'auth.test',
          'users.lookupByEmail',
          'conversations.open',
          'conversations.history',
          'conversations.replies',
          'chat.postMessage',
        ],
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
        externalId: 'handover-notice-test',
        title: 'Verify the runbook',
        contentSummary: 'Read the runbook.',
        contentRefs: [],
        state: 'plan-pending',
        plan: { summary: 'Read the runbook and report the finding.' },
        decision: {
          id: 'decision-1',
          kind: 'plan',
          requestedAt: 1,
          channel: 'D0MANAGER',
          surfaceSlug: 'team-chat',
          surfaceName: 'Team chat',
          ts: REQUEST_TS,
        },
        observedAt: 1,
        createdAt: 1,
      });
      return { agentId, workItemId };
    });
  }

  /** Ask Priya to take Maya on, as the owner, and run what the ask scheduled. */
  async function askPriya(
    harness: TestConvex<typeof schema>,
    agentId: Id<'agents'>,
  ): Promise<Id<'managerTransfers'>> {
    const transferId = await harness
      .withIdentity(managerIdentity())
      .mutation(api.managerTransfers.ask, { agentId, toAddress: PRIYA_ADDRESS });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
    return transferId;
  }

  it('sends one DM to the named person from the employee’s Slack card, saying who asks and where to answer, and records that it landed', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_PUBLIC_URL', 'https://day0.company.example');
    vi.useFakeTimers();
    const calls = slackWorkspace();
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedMaya(harness);

    const transferId = await askPriya(harness, agentId);

    expect(noticesIn(calls)).toEqual([
      {
        method: 'chat.postMessage',
        channel: 'D0PRIYA',
        text: transferNoticeText({
          employeeName: 'Maya',
          fromAddress: MANAGER_ADDRESS,
          publicUrl: 'https://day0.company.example',
        }),
      },
    ]);
    expect(calls.find((call) => call.method === 'users.lookupByEmail')?.email).toBe(PRIYA_ADDRESS);
    expect(await harness.run(async (ctx) => await ctx.db.get(transferId))).toMatchObject({
      state: 'asked',
      noticeSentAt: expect.any(Number),
      noticeProviderTs: NOTICE_TS,
    });
  });

  it('never sends it again, once sent or once it failed', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const calls = slackWorkspace({ postFails: true });
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedMaya(harness);
    vi.spyOn(console, 'log').mockImplementation((): void => undefined);

    const transferId = await askPriya(harness, agentId);
    await expect(
      harness.action(internal.managerChannelActions.sendTransferNotice, { transferId }),
    ).resolves.toEqual({ sent: false, reason: 'the notice was already sent' });

    expect(noticesIn(calls)).toHaveLength(1);
    const row = await harness.run(async (ctx) => await ctx.db.get(transferId));
    expect(row?.noticeSentAt).toEqual(expect.any(Number));
    expect(row?.noticeProviderTs).toBeUndefined();
  });

  it('sends nothing when the address is no person in the workspace', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const calls = slackWorkspace();
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedMaya(harness);
    vi.spyOn(console, 'log').mockImplementation((): void => undefined);

    const transferId = await harness
      .withIdentity(managerIdentity())
      .mutation(api.managerTransfers.ask, {
        agentId,
        toAddress: 'someone@elsewhere.example',
      });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(calls.filter((call) => call.method === 'users.lookupByEmail')).toEqual([
      { method: 'users.lookupByEmail', email: 'someone@elsewhere.example' },
    ]);
    expect(calls.filter((call) => call.method === 'conversations.open')).toEqual([]);
    expect(noticesIn(calls)).toEqual([]);
    expect((await harness.run(async (ctx) => await ctx.db.get(transferId)))?.state).toBe('asked');
  });

  it('sends nothing for an employee without a Slack card, and nothing in mock mode', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const calls = slackWorkspace();
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedMaya(harness);
    await harness.run(async (ctx): Promise<void> => {
      for (const surface of await ctx.db.query('surfaces').collect())
        await ctx.db.delete(surface._id);
    });
    await askPriya(harness, agentId);
    expect(calls.filter((call) => call.method === 'users.lookupByEmail')).toEqual([]);
    expect(noticesIn(calls)).toEqual([]);

    restoreSurfaceMode();
    useSurfaceMode('mock');
    const mock = convexTest(schema, allConvexModules());
    const maya = await seedMaya(mock);
    await askPriya(mock, maya.agentId);
    expect(calls.filter((call) => call.method === 'users.lookupByEmail')).toEqual([]);
    expect(noticesIn(calls)).toEqual([]);
  });

  it('reads no reply to it as an answer: the named person’s and the old manager’s replies decide nothing', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    // The decision poll opens the card's credential itself, under the deployment's key.
    const key = randomBytes(32).toString('base64');
    vi.stubEnv('DAY0_CREDENTIAL_KEY', key);
    const calls = slackWorkspace();
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedMaya(harness);
    await harness.run(async (ctx): Promise<void> => {
      for (const credential of await ctx.db.query('credentials').collect()) {
        await ctx.db.patch(credential._id, {
          ...encrypt('chat-secret', key, credentialOwnerBinding('owner')),
        });
      }
    });
    vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    const transferId = await askPriya(harness, agentId);
    const employeeBefore = await harness.run(async (ctx) => await ctx.db.get(agentId));

    await harness.action(internal.intakeActions.pollDecisions, {});
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    // The poll read the manager DM, where both replies sit.
    expect(calls.some((call) => call.method === 'conversations.history')).toBe(true);
    expect(await harness.run(async (ctx) => await ctx.db.get(transferId))).toMatchObject({
      state: 'asked',
    });
    expect(await harness.run(async (ctx) => await ctx.db.get(agentId))).toEqual(employeeBefore);
    const handover = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect())
        .map((event) => event.type)
        .filter((type) => type.startsWith('manager.')),
    );
    expect(handover).toEqual(['manager.transfer-asked']);
    expect(noticesIn(calls)).toHaveLength(1);
  });
});
