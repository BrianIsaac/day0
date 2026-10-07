/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import type { MutationCtx } from '../../convex/_generated/server';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { redraftPlansDraftedWithout } from '../../convex/work';
import { MANAGER_CLAIM_LAPSED_REASON, MANAGER_CLAIM_LEASE_MS } from '../../convex/workLoop';
import {
  NOTICE_TO_A_GUEST,
  NOTICE_CARD_NOT_APPROVED,
  NOTICE_CARD_NOT_CONNECTED,
  NOTICE_TO_THE_MANAGER,
  NOTICE_WITHOUT_READ,
  NOTICE_WITHOUT_SLACK,
  NOTICE_WITHOUT_WRITE,
  transferNoticeText,
} from '../../convex/transferNotice';
import { sendTransferNotice as sendTransferNoticeFunction } from '../../convex/managerChannelActions';
import { credentialOwnerBinding, encrypt } from '../../src/lib/credential-crypto';
import { fixtureAddressOf, MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';
import { reportBridgeOn } from './fakes/socket-heartbeat';
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

/** A Slack double that refuses every message edit and answers every other call, recording each. */
function refuseSlackEdits(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL, init: RequestInit): Promise<Response> => {
      sent.push({ url: input.href, authorization: '', body: String(init.body) });
      const refused = input.href.endsWith('/chat.update');
      return new Response(
        JSON.stringify(
          refused ? { ok: false, error: 'cant_update_message' } : { ok: true, ts: 'provider-1' },
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
}

/**
 * Move the clock a minute past the manager-channel claims' lease (12-W's N-3 sweep), keeping the
 * scheduler's timers fake, so a claim made before the move reads as one an action died holding.
 */
function pastTheClaimLease(): void {
  const now = Date.now();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(now + MANAGER_CLAIM_LEASE_MS + 60_000);
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
      await ctx.db.insert('permissionGrants', { agentId, scope: 'team-chat:read', createdAt: 1 });
      await ctx.db.insert('permissionGrants', { agentId, scope: 'team-chat:write', createdAt: 1 });
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

  it('says a request was already decided only after the acknowledgement of the decision it names (W12V-10)', async (): Promise<void> => {
    // The walk on real Slack, row 9: two presses 54 ms apart, and "Decision v9pwwd was already
    // approved from Slack." landed 0.1 s before "Approval v9pwwd received. ...".
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL, init: RequestInit): Promise<Response> => {
        sent.push({ url: input.href, authorization: '', body: String(init.body) });
        return new Response(JSON.stringify({ ok: true, ts: `1791149347.${sent.length}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seedParkedPlan(harness);
    await harness.action(internal.managerChannelActions.requestDecision, {
      workItemId,
      kind: 'plan',
    });
    const surfaceId = await harness.run(
      async (ctx) => (await ctx.db.query('surfaces').first())!._id,
    );
    const decisionId = (await harness.run(async (ctx) => await ctx.db.get(workItemId)))!.decision!
      .id;
    for (const messageTs of ['1791149347.500000', '1791149347.554000']) {
      await harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs,
        reply: { verb: 'approve', id: decisionId },
      });
    }
    sent.length = 0;

    // The duplicate's notice runs first, as the walk's did: it waits for the acknowledgement.
    await expect(
      harness.action(internal.managerChannelActions.sendDecisionNotice, {
        workItemId,
        decisionId,
      }),
    ).resolves.toEqual({ sent: false, reason: 'waits for the acknowledgement it follows' });
    expect(sent).toEqual([]);

    vi.runAllTimers();
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
    const texts = sent.map((call) => (JSON.parse(call.body) as { text: string }).text);
    expect(texts.findIndex((text) => text.startsWith(`Approval ${decisionId} received.`))).toBe(0);
    expect(texts.filter((text) => text.includes('was already approved'))).toHaveLength(1);
    expect(texts.at(-1)).toContain(`Decision ${decisionId} was already approved from`);
    vi.useRealTimers();
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
    // The decision schedules this acknowledgement, which the test sends itself: on fake timers the
    // scheduled copy never runs, and the file's afterEach discards it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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

/**
 * Give the seeded Slack card its own app with an app-level token landed (RM3 (a)), the deployment
 * its Socket Mode bridge's secret, and the bridge's live report on the app, so its requests can
 * carry buttons (re-pinned for D-6 (b): a request reads the bridge's heartbeat, not the secret).
 */
async function landAppLevelToken(
  harness: TestConvex<typeof schema>,
  agentId: Id<'agents'>,
  options: { readonly takesMessages?: boolean } = {},
): Promise<void> {
  vi.stubEnv('DAY0_SOCKET_BRIDGE_SECRET', 'bridge-secret-for-tests');
  await harness.run(async (ctx): Promise<void> => {
    const surface = await ctx.db
      .query('surfaces')
      .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'team-chat'))
      .unique();
    const secret = await ctx.db.insert('credentials', {
      userId: 'organisation',
      kind: 'oauth',
      label: 'Ops (Day0) client secret',
      ciphertext: 'ciphertext',
      iv: 'iv',
      source: 'oauth',
      createdAt: 1,
    });
    const appLevel = await ctx.db.insert('credentials', {
      userId: 'organisation',
      kind: 'value',
      label: 'Ops (Day0) app-level token',
      ciphertext: 'ciphertext',
      iv: 'iv',
      source: 'entered',
      createdAt: 1,
    });
    // The employee's own app, installed: it posts as itself, so no trailer is added.
    await ctx.db.patch(surface!._id, {
      credentialKind: 'oauth',
      toolAllowlist: ['chat.postMessage', 'chat.update'],
      provisioning: {
        appId: 'A0OPS',
        appName: 'Ops (Day0)',
        clientId: '1.2',
        clientSecretCredentialId: secret,
        installUrl: 'https://slack.com/oauth/v2/authorize',
        redirectUrl: 'https://day0.example/api/oauth/slack',
        scopes: ['chat:write'],
        createdAt: 1,
        installedAt: 2,
        appLevelTokenCredentialId: appLevel,
        // Re-pinned for 13-FS: the reach reads the card's own field, written beside the event.
        ...(options.takesMessages !== false
          ? { messagesTab: { state: 'open' as const, how: 'created' as const, at: 2 } }
          : {}),
      },
    });
    // An app this release creates takes messages from the start (W12V-7); one an earlier release
    // created does not until its messages tab is opened.
    if (options.takesMessages !== false) {
      await ctx.db.insert('events', {
        agentId,
        type: 'surface.app-messages-open',
        payload: { surfaceId: surface!._id, appId: 'A0OPS', appName: 'Ops (Day0)', how: 'created' },
        createdAt: 2,
      });
    }
  });
  const surfaceId = await harness.run(
    async (ctx) =>
      (await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'team-chat'))
        .unique())!._id,
  );
  await reportBridgeOn(harness, surfaceId);
}

describe('Approve and Reject buttons on a decision request (wave 12, 12-M; RM3)', (): void => {
  afterEach((): void => {
    vi.unstubAllEnvs();
  });

  function recordSlack(): void {
    // Scheduled acknowledgements stay on fake timers, so none posts through a later test's stub.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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

  it('sends Approve and Reject buttons with the typed code where the app has its app-level token', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedParkedPlan(harness);
    await landAppLevelToken(harness, agentId);
    await expect(
      harness.action(internal.managerChannelActions.requestDecision, { workItemId, kind: 'plan' }),
    ).resolves.toEqual({ sent: true });
    const decision = (await harness.run(async (ctx) => await ctx.db.get(workItemId)))!.decision!;
    const body = JSON.parse(sent[0]!.body) as {
      text: string;
      blocks: Array<{ type: string; elements?: Array<{ action_id: string; value: string }> }>;
    };
    expect(body.text).toContain(`reply “approve ${decision.id}”`);
    const actions = body.blocks.find((block) => block.type === 'actions');
    expect(actions?.elements?.map((button) => [button.action_id, button.value])).toEqual([
      ['day0.decision.approve', decision.id],
      ['day0.decision.reject', decision.id],
    ]);
    expect(decision.withButtons).toBe(true);
  });

  it('sends the typed code only where the app has no app-level token', async (): Promise<void> => {
    recordSlack();
    vi.stubEnv('DAY0_SOCKET_BRIDGE_SECRET', 'bridge-secret-for-tests');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seedParkedPlan(harness);
    await harness.action(internal.managerChannelActions.requestDecision, {
      workItemId,
      kind: 'plan',
    });
    const body = JSON.parse(sent[0]!.body) as { text: string; blocks?: unknown };
    expect(body.blocks).toBeUndefined();
    expect(body.text).toMatch(/Reply “approve [a-z0-9]{6}”/);
    expect(
      (await harness.run(async (ctx) => await ctx.db.get(workItemId)))!.decision!.withButtons,
    ).toBeUndefined();
  });

  it('sends the typed code only where the deployment runs no Socket Mode bridge', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedParkedPlan(harness);
    await landAppLevelToken(harness, agentId);
    vi.stubEnv('DAY0_SOCKET_BRIDGE_SECRET', '');
    await harness.action(internal.managerChannelActions.requestDecision, {
      workItemId,
      kind: 'plan',
    });
    expect((JSON.parse(sent[0]!.body) as { blocks?: unknown }).blocks).toBeUndefined();
  });

  it('asks for no typed reply from an app that takes no messages, its buttons and day0 the only ways (W12V-7)', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedParkedPlan(harness);
    await landAppLevelToken(harness, agentId, { takesMessages: false });
    await harness.action(internal.managerChannelActions.requestDecision, {
      workItemId,
      kind: 'plan',
    });
    const body = JSON.parse(sent[0]!.body) as {
      text: string;
      blocks: Array<{
        type: string;
        elements?: Array<{ action_id: string; confirm?: { text: { text: string } } }>;
      }>;
    };
    expect(body.text).not.toMatch(/reply “|“approve|“reject/i);
    expect(body.text.split('\n').at(-1)).toBe(
      'Press Approve or Reject below, or decide in day0. Slack does not let you message this app yet, so a typed reply cannot reach it.',
    );
    const reject = body.blocks
      .find((block) => block.type === 'actions')
      ?.elements?.find((button) => button.action_id === 'day0.decision.reject');
    expect(reject?.confirm?.text.text).toBe(
      'Day0 will not do it. To say why, reject it in day0 instead.',
    );
  });

  it('asks for no typed reply from an app that takes no messages and has no buttons: day0 alone (W12V-7)', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedParkedPlan(harness);
    await landAppLevelToken(harness, agentId, { takesMessages: false });
    vi.stubEnv('DAY0_SOCKET_BRIDGE_SECRET', '');
    await harness.action(internal.managerChannelActions.requestDecision, {
      workItemId,
      kind: 'plan',
    });
    const body = JSON.parse(sent[0]!.body) as { text: string; blocks?: unknown };
    expect(body.blocks).toBeUndefined();
    expect(body.text.split('\n').at(-1)).toBe(
      'Decide in day0. Slack does not let you message this app yet, so a typed reply cannot reach it.',
    );
  });

  it('closes a request that had buttons with its text as blocks and no buttons', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedParkedPlan(harness);
    await landAppLevelToken(harness, agentId);
    await harness.action(internal.managerChannelActions.requestDecision, {
      workItemId,
      kind: 'plan',
    });
    const surfaceId = await harness.run(
      async (ctx) => (await ctx.db.query('surfaces').first())!._id,
    );
    const decisionId = (await harness.run(async (ctx) => await ctx.db.get(workItemId)))!.decision!
      .id;
    await harness.mutation(internal.work.resolveChannelDecision, {
      surfaceId,
      userId: 'UMANAGER',
      messageTs: '1787768407.000100',
      reply: { verb: 'approve', id: decisionId },
    });
    await harness.action(internal.managerChannelActions.closeDecisionRequest, {
      workItemId,
      decisionId,
    });
    const update = sent.find((call) => call.url.endsWith('/chat.update'));
    const body = JSON.parse(update!.body) as {
      text: string;
      blocks: Array<{ type: string; text?: { text: string } }>;
    };
    expect(body.blocks.map((block) => block.type)).toEqual(['section']);
    expect(body.blocks[0]!.text!.text).toBe(body.text);
    expect(body.text).toContain(`Decided: approved in this DM (${decisionId}).`);
    // The buttons are gone, so the message no longer asks for a press.
    expect(body.text).not.toContain('Press Approve or Reject below');
    expect(body.text).toContain(`Reply “approve ${decisionId}”`);
  });
});

describe('a replaced decision request (wave 12, 12-M; F2 D14)', (): void => {
  afterEach((): void => {
    vi.unstubAllEnvs();
  });

  function recordSlack(): void {
    // Scheduled acknowledgements stay on fake timers, so none posts through a later test's stub.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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

  /** A delivered plan request, then replaced by a fresh one under a new code. */
  async function replaceDeliveredRequest(harness: TestConvex<typeof schema>): Promise<{
    agentId: Id<'agents'>;
    workItemId: Id<'workItems'>;
    surfaceId: Id<'surfaces'>;
    oldCode: string;
    newCode: string;
  }> {
    const { agentId, workItemId } = await seedParkedPlan(harness);
    await landAppLevelToken(harness, agentId);
    await harness.action(internal.managerChannelActions.requestDecision, {
      workItemId,
      kind: 'plan',
    });
    const oldCode = (await harness.run(async (ctx) => await ctx.db.get(workItemId)))!.decision!.id;
    const surfaceId = await harness.run(
      async (ctx) => (await ctx.db.query('surfaces').first())!._id,
    );
    await harness.mutation(internal.work.closeDecisionThread, { surfaceId, decisionId: oldCode });
    await harness.action(internal.managerChannelActions.requestDecision, {
      workItemId,
      kind: 'plan',
      supersedes: oldCode,
    });
    const newCode = (await harness.run(async (ctx) => await ctx.db.get(workItemId)))!.decision!.id;
    return { agentId, workItemId, surfaceId, oldCode, newCode };
  }

  it('remembers the replaced code with the code that replaced it', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, oldCode, newCode } = await replaceDeliveredRequest(harness);
    expect(newCode).not.toBe(oldCode);
    const remembered = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('replacedDecisionRequests')
          .withIndex('by_agent_decision', (q) => q.eq('agentId', agentId).eq('decisionId', oldCode))
          .unique(),
    );
    expect(remembered).toMatchObject({
      workItemId,
      decisionId: oldCode,
      replacedBy: newCode,
      kind: 'plan',
      ts: 'provider-1',
      withButtons: true,
      requestText: expect.stringContaining('needs your decision'),
    });
  });

  it('answers a reply to the replaced code with the request that replaced it, and decides nothing', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, surfaceId, oldCode, newCode } = await replaceDeliveredRequest(harness);
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs: '1787768409.000100',
        reply: { verb: 'approve', id: oldCode },
      }),
    ).resolves.toMatchObject({ status: 'replaced', replacedBy: newCode });
    const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
    expect(row?.state).toBe('plan-pending');
    expect(row?.decision?.decidedAt).toBeUndefined();
    const notice = await harness.run(
      async (ctx) => await ctx.db.query('managerDecisionNotices').first(),
    );
    expect(notice).toMatchObject({
      kind: 'replaced',
      decisionId: oldCode,
      text: `That request (${oldCode}) was replaced by ${newCode}. Decide on ${newCode} instead.`,
    });
  });

  it('answers with the replacement’s own decision once it was decided', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId, oldCode, newCode } = await replaceDeliveredRequest(harness);
    await harness.mutation(internal.work.resolveChannelDecision, {
      surfaceId,
      userId: 'UMANAGER',
      messageTs: '1787768410.000100',
      reply: { verb: 'approve', id: newCode },
    });
    await harness.mutation(internal.work.resolveChannelDecision, {
      surfaceId,
      userId: 'UMANAGER',
      messageTs: '1787768411.000100',
      reply: { verb: 'reject', id: oldCode, reason: '' },
    });
    const notice = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('managerDecisionNotices')
          .filter((q) => q.eq(q.field('kind'), 'replaced'))
          .first(),
    );
    expect(notice?.text).toBe(
      `That request (${oldCode}) was replaced by ${newCode}, which was already approved.`,
    );
  });

  it('answers a replaced request once, whatever further replies or presses name it (W12-R19)', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, surfaceId, oldCode, newCode } = await replaceDeliveredRequest(harness);
    const reply = async (messageTs: string): Promise<unknown> =>
      await harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs,
        reply: { verb: 'approve', id: oldCode },
      });
    await expect(reply('1787768409.000100')).resolves.toMatchObject({
      status: 'replaced',
      replacedBy: newCode,
      notified: true,
    });
    await expect(reply('1787768409.000200')).resolves.toMatchObject({
      status: 'replaced',
      replacedBy: newCode,
      notified: false,
    });
    const notices = await harness.run(
      async (ctx) => await ctx.db.query('managerDecisionNotices').collect(),
    );
    expect(notices.filter((notice) => notice.kind === 'replaced')).toHaveLength(1);
    const replaced = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('replacedDecisionRequests')
          .withIndex('by_agent_decision', (q) => q.eq('agentId', agentId).eq('decisionId', oldCode))
          .unique(),
    );
    expect(replaced?.answeredAt).toEqual(expect.any(Number));
  });

  it('answers the oldest code of a request replaced six times with the newest (W12-R20)', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, surfaceId, oldCode } = await replaceDeliveredRequest(harness);
    let current = (await harness.run(async (ctx) => await ctx.db.get(workItemId)))!.decision!.id;
    for (let replacement = 2; replacement <= 6; replacement += 1) {
      await harness.mutation(internal.work.closeDecisionThread, { surfaceId, decisionId: current });
      await harness.action(internal.managerChannelActions.requestDecision, {
        workItemId,
        kind: 'plan',
        supersedes: current,
      });
      current = (await harness.run(async (ctx) => await ctx.db.get(workItemId)))!.decision!.id;
    }
    const rows = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('replacedDecisionRequests')
          .withIndex('by_work_item', (q) => q.eq('workItemId', workItemId))
          .collect(),
    );
    expect(rows).toHaveLength(6);
    // Every earlier request points at the newest, so its answer takes one step.
    expect(new Set(rows.map((row) => row.replacedBy))).toEqual(new Set([current]));
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs: '1787768420.000100',
        reply: { verb: 'approve', id: oldCode },
      }),
    ).resolves.toMatchObject({ status: 'replaced', replacedBy: current });
  });

  it('names a new request on the newest of an item’s replaced requests when it holds more than it reads (13-FS second pass)', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, surfaceId } = await replaceDeliveredRequest(harness);
    const standing = (await harness.run(async (ctx) => await ctx.db.get(workItemId)))!.decision!.id;
    await harness.run(async (ctx): Promise<void> => {
      for (let index = 0; index < 55; index += 1) {
        await ctx.db.insert('replacedDecisionRequests', {
          agentId,
          workItemId,
          decisionId: `seed${String(index).padStart(2, '0')}`,
          kind: 'plan',
          surfaceSlug: 'team-chat',
          channel: 'D0MANAGER',
          replacedAt: index + 1,
        });
      }
    });
    await harness.mutation(internal.work.closeDecisionThread, { surfaceId, decisionId: standing });
    await harness.action(internal.managerChannelActions.requestDecision, {
      workItemId,
      kind: 'plan',
      supersedes: standing,
    });
    const newest = (await harness.run(async (ctx) => await ctx.db.get(workItemId)))!.decision!.id;
    const last = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('replacedDecisionRequests')
          .withIndex('by_agent_decision', (q) =>
            q.eq('agentId', agentId).eq('decisionId', 'seed54'),
          )
          .unique(),
    );
    expect(last?.replacedBy).toBe(newest);
  });

  it('answers the oldest code of a chain an earlier release left longer than its walk with the item’s standing request (W12-R20)', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, surfaceId } = await replaceDeliveredRequest(harness);
    const standing = (await harness.run(async (ctx) => await ctx.db.get(workItemId)))!.decision!.id;
    // Seven links, each pointing at the next, as nameReplacement wrote them before 0.17.0.
    const codes = ['old0aa', 'old1bb', 'old2cc', 'old3dd', 'old4ee', 'old5ff', 'old6gg'];
    await harness.run(async (ctx): Promise<void> => {
      for (const [index, code] of codes.entries()) {
        await ctx.db.insert('replacedDecisionRequests', {
          agentId,
          workItemId,
          decisionId: code,
          replacedBy: codes[index + 1] ?? standing,
          kind: 'plan',
          surfaceSlug: 'team-chat',
          channel: 'D0MANAGER',
          replacedAt: index + 1,
        });
      }
    });
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'UMANAGER',
        messageTs: '1787768421.000100',
        reply: { verb: 'approve', id: 'old0aa' },
      }),
    ).resolves.toMatchObject({ status: 'replaced', replacedBy: standing });
  });

  it('answers another Slack user’s reply to a replaced code with nothing', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId, oldCode } = await replaceDeliveredRequest(harness);
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId,
        userId: 'USOMEONE',
        messageTs: '1787768412.000100',
        reply: { verb: 'approve', id: oldCode },
      }),
    ).resolves.toMatchObject({ status: 'ignored', reason: 'manager identity mismatch' });
    expect(
      await harness.run(async (ctx) => await ctx.db.query('managerDecisionNotices').collect()),
    ).toEqual([]);
  });

  it('edits the replaced message once to say so, without its buttons, and records the edit', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, oldCode } = await replaceDeliveredRequest(harness);
    const replacedId = await harness.run(
      async (ctx) =>
        (await ctx.db
          .query('replacedDecisionRequests')
          .withIndex('by_agent_decision', (q) => q.eq('agentId', agentId).eq('decisionId', oldCode))
          .unique())!._id,
    );
    const scheduled = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    expect(scheduled.map((job) => job.name)).toContain('managerChannelActions:markRequestReplaced');
    await expect(
      harness.action(internal.managerChannelActions.markRequestReplaced, { replacedId }),
    ).resolves.toEqual({ edited: true });
    const updates = sent.filter((call) => call.url.endsWith('/chat.update'));
    expect(updates).toHaveLength(1);
    const body = JSON.parse(updates[0]!.body) as {
      ts: string;
      text: string;
      blocks: Array<{ type: string }>;
    };
    expect(body.ts).toBe('provider-1');
    expect(body.text).toContain('needs your decision');
    expect(body.text).toContain(`Replaced (${oldCode}): this request no longer decides anything.`);
    expect(body.text).not.toContain('Press Approve or Reject below');
    expect(body.blocks.map((block) => block.type)).toEqual(['section']);
    expect(await harness.run(async (ctx) => await ctx.db.get(replacedId))).toMatchObject({
      editClaimedAt: expect.any(Number),
      editedAt: expect.any(Number),
    });
    await expect(
      harness.action(internal.managerChannelActions.markRequestReplaced, { replacedId }),
    ).resolves.toEqual({ edited: false });
    expect(sent.filter((call) => call.url.endsWith('/chat.update'))).toHaveLength(1);
  });

  /** The replaced row 12-M remembered for the old code. */
  async function replacedRowId(
    harness: TestConvex<typeof schema>,
    agentId: Id<'agents'>,
    oldCode: string,
  ): Promise<Id<'replacedDecisionRequests'>> {
    return await harness.run(
      async (ctx) =>
        (await ctx.db
          .query('replacedDecisionRequests')
          .withIndex('by_agent_decision', (q) => q.eq('agentId', agentId).eq('decisionId', oldCode))
          .unique())!._id,
    );
  }

  it('keeps an edit it recorded as landed when the lease sweep runs past the lease (the 12-W seam)', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, oldCode } = await replaceDeliveredRequest(harness);
    const replacedId = await replacedRowId(harness, agentId, oldCode);
    await expect(
      harness.action(internal.managerChannelActions.markRequestReplaced, { replacedId }),
    ).resolves.toEqual({ edited: true });
    const edited = await harness.run(async (ctx) => await ctx.db.get(replacedId));
    expect(edited?.editClaimedAt).toEqual(expect.any(Number));
    expect(edited?.editedAt).toEqual(expect.any(Number));

    pastTheClaimLease();
    await expect(harness.mutation(internal.workLoop.settleLapsedClaims, {})).resolves.toEqual({
      settled: 0,
    });
    const after = await harness.run(async (ctx) => await ctx.db.get(replacedId));
    expect(after?.editFailure).toBeUndefined();
    expect(after?.editedAt).toBe(edited?.editedAt);
    expect(after?.editClaimedAt).toBe(edited?.editClaimedAt);
  });

  it('keeps an edit failure it recorded as written when the lease sweep runs past the lease (the 12-W seam)', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, oldCode } = await replaceDeliveredRequest(harness);
    const replacedId = await replacedRowId(harness, agentId, oldCode);
    refuseSlackEdits();
    await expect(
      harness.action(internal.managerChannelActions.markRequestReplaced, { replacedId }),
    ).resolves.toEqual({ edited: false });
    const refused = await harness.run(async (ctx) => await ctx.db.get(replacedId));
    expect(refused?.editClaimedAt).toEqual(expect.any(Number));
    expect(refused?.editFailure).toContain('cant_update_message');

    pastTheClaimLease();
    await expect(harness.mutation(internal.workLoop.settleLapsedClaims, {})).resolves.toEqual({
      settled: 0,
    });
    const after = await harness.run(async (ctx) => await ctx.db.get(replacedId));
    expect(after?.editFailure).toBe(refused?.editFailure);
    expect(after?.editedAt).toBeUndefined();
  });

  it('has an edit claim that died with no result settled once by the lease sweep, and never re-sent (the 12-W seam)', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, oldCode } = await replaceDeliveredRequest(harness);
    const replacedId = await replacedRowId(harness, agentId, oldCode);
    // The edit's action claimed the edit and died before its provider call returned.
    const claim = await harness.mutation(internal.work.prepareReplacedEdit, { replacedId });
    expect(claim.prepared).toBe(true);
    const claimedAt = claim.prepared ? claim.claimedAt : 0;

    pastTheClaimLease();
    await expect(harness.mutation(internal.workLoop.settleLapsedClaims, {})).resolves.toEqual({
      settled: 1,
    });
    await expect(harness.mutation(internal.workLoop.settleLapsedClaims, {})).resolves.toEqual({
      settled: 0,
    });
    expect(await harness.run(async (ctx) => await ctx.db.get(replacedId))).toMatchObject({
      editClaimedAt: claimedAt,
      editFailure: MANAGER_CLAIM_LAPSED_REASON,
    });

    // A result that arrives after the sweep writes nothing, and the edit is not sent again.
    await expect(
      harness.mutation(internal.work.recordReplacedEdit, {
        replacedId,
        claimedAt,
        editedAt: Date.now(),
      }),
    ).resolves.toBe(false);
    await expect(
      harness.action(internal.managerChannelActions.markRequestReplaced, { replacedId }),
    ).resolves.toEqual({ edited: false });
    expect(sent.filter((call) => call.url.endsWith('/chat.update'))).toEqual([]);
    const after = await harness.run(async (ctx) => await ctx.db.get(replacedId));
    expect(after?.editedAt).toBeUndefined();
    expect(after?.editFailure).toBe(MANAGER_CLAIM_LAPSED_REASON);
  });

  it('remembers a request a re-draft took back, with nothing replacing it yet', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedParkedPlan(harness);
    await harness.action(internal.managerChannelActions.requestDecision, {
      workItemId,
      kind: 'plan',
    });
    const oldCode = (await harness.run(async (ctx) => await ctx.db.get(workItemId)))!.decision!.id;
    const surfaceId = await harness.run(async (ctx): Promise<Id<'surfaces'>> => {
      await ctx.db.patch(workItemId, {
        planDraftedWithout: { surfaceSlug: 'team-chat', subject: 'thread', cause: 'not-connected' },
      });
      const surface = (await ctx.db.query('surfaces').first())!;
      await redraftPlansDraftedWithout(ctx, surface, Date.now());
      return surface._id;
    });
    expect((await harness.run(async (ctx) => await ctx.db.get(workItemId)))?.decision).toBe(
      undefined,
    );
    await harness.mutation(internal.work.resolveChannelDecision, {
      surfaceId,
      userId: 'UMANAGER',
      messageTs: '1787768413.000100',
      reply: { verb: 'approve', id: oldCode },
    });
    const notice = await harness.run(
      async (ctx) => await ctx.db.query('managerDecisionNotices').first(),
    );
    expect(notice).toMatchObject({ agentId, kind: 'replaced' });
    expect(notice?.text).toBe(
      `That request (${oldCode}) was replaced and no longer decides anything. Day0 asks again in a new message when the work is ready for your decision.`,
    );
  });
});

describe('a decided request in the manager DM (M finding 3)', (): void => {
  /**
   * A Slack double that answers every call, recording it. The decision schedules its
   * acknowledgement and the close, which these tests drive themselves: on fake timers neither runs
   * on its own, and the file's afterEach discards both, so neither posts through a later test's
   * fetch.
   */
  function recordSlack(): void {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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
    options: { readonly ownApp?: boolean } = {},
  ): Promise<{ workItemId: Id<'workItems'>; decisionId: string }> {
    const { agentId, workItemId } = await seedParkedPlan(harness);
    const surfaceId = await harness.run(async (ctx) => {
      const surface = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'team-chat'))
        .unique();
      await ctx.db.patch(surface!._id, { toolAllowlist: allowlist });
      if (options.ownApp === true) {
        // The employee's own app, installed: Day0 created it, and the card holds its bot token.
        const secret = await ctx.db.insert('credentials', {
          userId: 'organisation',
          kind: 'oauth',
          label: 'Ops (Day0) client secret',
          ciphertext: 'ciphertext',
          iv: 'iv',
          source: 'oauth',
          createdAt: 1,
        });
        await ctx.db.patch(surface!._id, {
          credentialKind: 'oauth',
          provisioning: {
            appId: 'A0OPS',
            appName: 'Ops (Day0)',
            clientId: '1.2',
            clientSecretCredentialId: secret,
            installUrl: 'https://slack.com/oauth/v2/authorize',
            redirectUrl: 'https://day0.example/api/oauth/slack',
            scopes: ['chat:write'],
            createdAt: 1,
            installedAt: 2,
          },
        });
      }
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

  it('records when the edit landed, so the lease sweep never reads the claim as open', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, decisionId } = await decideInDm(harness, [
      'chat.postMessage',
      'chat.update',
    ]);
    await harness.action(internal.managerChannelActions.closeDecisionRequest, {
      workItemId,
      decisionId,
    });
    const decision = (await harness.run(async (ctx) => await ctx.db.get(workItemId)))?.decision;
    expect(decision?.closeClaimedAt).toEqual(expect.any(Number));
    expect(decision?.closedAt).toEqual(expect.any(Number));
    expect(decision?.closeFailure).toBeUndefined();
  });

  it('records why the edit failed, once, and does not try it again', async (): Promise<void> => {
    // This double refuses the edit, so it is not recordSlack's; the scheduled acknowledgement and
    // close stay on fake timers all the same, so neither posts through a later test's fetch.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL, init: RequestInit): Promise<Response> => {
        sent.push({ url: input.href, authorization: '', body: String(init.body) });
        const refused = input.href.endsWith('/chat.update');
        return new Response(
          JSON.stringify(
            refused ? { ok: false, error: 'cant_update_message' } : { ok: true, ts: 'provider-1' },
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, decisionId } = await decideInDm(harness, [
      'chat.postMessage',
      'chat.update',
    ]);
    await expect(
      harness.action(internal.managerChannelActions.closeDecisionRequest, {
        workItemId,
        decisionId,
      }),
    ).resolves.toEqual({ closed: false });
    const decision = (await harness.run(async (ctx) => await ctx.db.get(workItemId)))?.decision;
    expect(decision?.closedAt).toBeUndefined();
    expect(decision?.closeFailure).toContain('cant_update_message');
    expect(decision?.closeFailure?.length).toBeLessThanOrEqual(240);
  });

  it('writes no result for a claim the lease sweep already settled', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, decisionId } = await decideInDm(harness, [
      'chat.postMessage',
      'chat.update',
    ]);
    const claim = await harness.mutation(internal.work.prepareRequestClose, {
      workItemId,
      decisionId,
    });
    expect(claim.prepared).toBe(true);
    const claimedAt = claim.prepared ? claim.claimedAt : 0;
    await harness.run(async (ctx): Promise<void> => {
      const row = await ctx.db.get(workItemId);
      await ctx.db.patch(workItemId, {
        decision: { ...row!.decision!, closeFailure: "the edit's claim lapsed with no result" },
      });
    });
    await expect(
      harness.mutation(internal.work.recordRequestClose, {
        workItemId,
        decisionId,
        claimedAt,
        closedAt: Date.now(),
      }),
    ).resolves.toBe(false);
    await expect(
      harness.mutation(internal.work.recordRequestClose, {
        workItemId,
        decisionId,
        claimedAt: claimedAt - 1,
        failure: 'late',
      }),
    ).resolves.toBe(false);
    const decision = (await harness.run(async (ctx) => await ctx.db.get(workItemId)))?.decision;
    expect(decision?.closedAt).toBeUndefined();
    expect(decision?.closeFailure).toBe("the edit's claim lapsed with no result");
  });

  it('sends and closes the request on an app Day0 created though its page names neither method (W12V-3, design 1 (b))', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, decisionId } = await decideInDm(harness, ['conversations.history'], {
      ownApp: true,
    });
    expect(sent.filter((call) => call.url.endsWith('/chat.postMessage'))).toHaveLength(1);
    await expect(
      harness.action(internal.managerChannelActions.closeDecisionRequest, {
        workItemId,
        decisionId,
      }),
    ).resolves.toEqual({ closed: true });
    expect(sent.filter((call) => call.url.endsWith('/chat.update'))).toHaveLength(1);
    // The stored allowlist stays the page's: the work never gains the channel's methods.
    const surface = await harness.run(async (ctx) => {
      const agentId = (await ctx.db.get(workItemId))!.agentId;
      return await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'team-chat'))
        .unique();
    });
    expect(surface?.toolAllowlist).toEqual(['conversations.history']);
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

  it('keeps a close it recorded as landed when the lease sweep runs past the lease (the 12-W seam)', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, decisionId } = await decideInDm(harness, [
      'chat.postMessage',
      'chat.update',
    ]);
    await expect(
      harness.action(internal.managerChannelActions.closeDecisionRequest, {
        workItemId,
        decisionId,
      }),
    ).resolves.toEqual({ closed: true });
    const closed = (await harness.run(async (ctx) => await ctx.db.get(workItemId)))?.decision;
    expect(closed?.closedAt).toEqual(expect.any(Number));
    expect(closed?.closeClaimedAt).toEqual(expect.any(Number));

    pastTheClaimLease();
    await expect(harness.mutation(internal.workLoop.settleLapsedClaims, {})).resolves.toEqual({
      settled: 0,
    });
    const after = (await harness.run(async (ctx) => await ctx.db.get(workItemId)))?.decision;
    expect(after?.closeFailure).toBeUndefined();
    expect(after?.closedAt).toBe(closed?.closedAt);
    expect(after?.closeClaimedAt).toBe(closed?.closeClaimedAt);
  });

  it('keeps a close failure it recorded as written when the lease sweep runs past the lease (the 12-W seam)', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    refuseSlackEdits();
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, decisionId } = await decideInDm(harness, [
      'chat.postMessage',
      'chat.update',
    ]);
    await expect(
      harness.action(internal.managerChannelActions.closeDecisionRequest, {
        workItemId,
        decisionId,
      }),
    ).resolves.toEqual({ closed: false });
    const refused = (await harness.run(async (ctx) => await ctx.db.get(workItemId)))?.decision;
    expect(refused?.closeClaimedAt).toEqual(expect.any(Number));
    expect(refused?.closeFailure).toContain('cant_update_message');

    pastTheClaimLease();
    await expect(harness.mutation(internal.workLoop.settleLapsedClaims, {})).resolves.toEqual({
      settled: 0,
    });
    const after = (await harness.run(async (ctx) => await ctx.db.get(workItemId)))?.decision;
    expect(after?.closeFailure).toBe(refused?.closeFailure);
    expect(after?.closedAt).toBeUndefined();
  });

  it('has a close claim that died with no result settled once by the lease sweep, and never re-sent (the 12-W seam)', async (): Promise<void> => {
    recordSlack();
    const harness = convexTest(schema, allConvexModules());
    const { workItemId, decisionId } = await decideInDm(harness, [
      'chat.postMessage',
      'chat.update',
    ]);
    // The close's action claimed the edit and died before its provider call returned.
    const claim = await harness.mutation(internal.work.prepareRequestClose, {
      workItemId,
      decisionId,
    });
    expect(claim.prepared).toBe(true);
    const claimedAt = claim.prepared ? claim.claimedAt : 0;

    pastTheClaimLease();
    await expect(harness.mutation(internal.workLoop.settleLapsedClaims, {})).resolves.toEqual({
      settled: 1,
    });
    await expect(harness.mutation(internal.workLoop.settleLapsedClaims, {})).resolves.toEqual({
      settled: 0,
    });
    expect(
      (await harness.run(async (ctx) => await ctx.db.get(workItemId)))?.decision,
    ).toMatchObject({
      id: decisionId,
      closeClaimedAt: claimedAt,
      closeFailure: MANAGER_CLAIM_LAPSED_REASON,
    });

    // A result that arrives after the sweep writes nothing, and the edit is not sent again.
    await expect(
      harness.mutation(internal.work.recordRequestClose, {
        workItemId,
        decisionId,
        claimedAt,
        closedAt: Date.now(),
      }),
    ).resolves.toBe(false);
    await expect(
      harness.action(internal.managerChannelActions.closeDecisionRequest, {
        workItemId,
        decisionId,
      }),
    ).resolves.toEqual({ closed: false });
    expect(sent.filter((call) => call.url.endsWith('/chat.update'))).toEqual([]);
    const after = (await harness.run(async (ctx) => await ctx.db.get(workItemId)))?.decision;
    expect(after?.closedAt).toBeUndefined();
    expect(after?.closeFailure).toBe(MANAGER_CLAIM_LAPSED_REASON);
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
    await harness.mutation(internal.workRuns.setActionsPending, {
      ...ids,
      output: { draft: 'Reply drafted.', notes: '', actions: [publicPost] },
    });
    return ids.workItemId;
  }

  it('is offered from the second open request on, names every member, and decides them all from one reply', async (): Promise<void> => {
    // The approval schedules each apply, which this test does not exercise: on fake timers it never
    // runs, and the file's afterEach discards it, so no apply posts through a later test's fetch.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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

  /**
   * Run what the ask scheduled that is due now: the notice and the scrub. The request's own
   * expiry, fourteen days on, is not (U2-m7).
   */
  const runDueNow = (): void => {
    vi.advanceTimersByTime(0);
  };

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
            if (email === PRIYA_ADDRESS) {
              return answer({ ok: true, user: { id: 'UPRIYA', real_name: 'Priya' } });
            }
            if (email === 'bot@day0.local') return answer({ ok: true, user: { id: 'UBOT' } });
            if (email === 'app@day0.local') {
              return answer({ ok: true, user: { id: 'UAPP', is_bot: true } });
            }
            if (email === 'gone@day0.local') {
              return answer({ ok: true, user: { id: 'UGONE', deleted: true } });
            }
            if (email === 'manager-alias@day0.local') {
              return answer({ ok: true, user: { id: 'UMANAGER' } });
            }
            if (email === 'guest@day0.local') {
              return answer({ ok: true, user: { id: 'UGUEST', is_restricted: true } });
            }
            if (email === 'single-guest@day0.local') {
              return answer({ ok: true, user: { id: 'UGUEST1', is_ultra_restricted: true } });
            }
            return answer({ ok: false, error: 'users_not_found' });
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
      await ctx.db.insert('permissionGrants', { agentId, scope: 'team-chat:read', createdAt: 1 });
      await ctx.db.insert('permissionGrants', { agentId, scope: 'team-chat:write', createdAt: 1 });
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
    await harness.finishAllScheduledFunctions(runDueNow);
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
          transferId,
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

  it('names an employee stored before the deploy bounded names by the request’s clipped name (B2)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const calls = slackWorkspace();
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedMaya(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(agentId, { name: `Maya ${'y'.repeat(100_000)}` });
    });

    const transferId = await askPriya(harness, agentId);

    expect(noticesIn(calls).map((notice) => notice.text)).toEqual([
      transferNoticeText({
        transferId,
        employeeName: `Maya ${'y'.repeat(75)}`,
        fromAddress: MANAGER_ADDRESS,
      }),
    ]);
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
    await harness.finishAllScheduledFunctions(runDueNow);

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

  it('names no bot, app, deactivated member or the employee’s own bot as the person to tell', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const calls = slackWorkspace();
    vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    for (const toAddress of ['bot@day0.local', 'app@day0.local', 'gone@day0.local']) {
      const harness = convexTest(schema, allConvexModules());
      const { agentId } = await seedMaya(harness);
      await harness
        .withIdentity(managerIdentity())
        .mutation(api.managerTransfers.ask, { agentId, toAddress });
      await harness.finishAllScheduledFunctions(runDueNow);
    }
    expect(calls.filter((call) => call.method === 'conversations.open')).toEqual([]);
    expect(noticesIn(calls)).toEqual([]);
  });

  /** The notice events on Maya's record. */
  async function noticeEvents(
    harness: TestConvex<typeof schema>,
    agentId: Id<'agents'>,
  ): Promise<unknown[]> {
    return await harness.run(async (ctx) =>
      (
        await ctx.db
          .query('events')
          .withIndex('by_agent_type', (q) =>
            q.eq('agentId', agentId).eq('type', 'manager.transfer-notice'),
          )
          .collect()
      ).map((event) => event.payload),
    );
  }

  it('names neither the card’s own manager nor a guest as the person to tell, and records why (U2-m8)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const calls = slackWorkspace();
    vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    const recorded: unknown[] = [];
    for (const toAddress of [
      'manager-alias@day0.local',
      'guest@day0.local',
      'single-guest@day0.local',
    ]) {
      const harness = convexTest(schema, allConvexModules());
      const { agentId } = await seedMaya(harness);
      const transferId = await harness
        .withIdentity(managerIdentity())
        .mutation(api.managerTransfers.ask, { agentId, toAddress });
      await harness.finishAllScheduledFunctions(runDueNow);
      recorded.push(...(await noticeEvents(harness, agentId)));
      expect(await noticeEvents(harness, agentId)).toEqual([
        expect.objectContaining({ transferId, toAddress, delivered: false }),
      ]);
    }
    expect(calls.filter((call) => call.method === 'conversations.open')).toEqual([]);
    expect(noticesIn(calls)).toEqual([]);
    expect(recorded.map((payload) => (payload as { reason: string }).reason)).toEqual([
      NOTICE_TO_THE_MANAGER,
      NOTICE_TO_A_GUEST,
      NOTICE_TO_A_GUEST,
    ]);
  });

  it('records a delivered notice on the employee’s record', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    slackWorkspace();
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedMaya(harness);

    const transferId = await askPriya(harness, agentId);

    expect(await noticeEvents(harness, agentId)).toEqual([
      {
        transferId,
        fromAddress: MANAGER_ADDRESS,
        toAddress: PRIYA_ADDRESS,
        delivered: true,
      },
    ]);
  });

  it('records a notice that failed, with its reason, once', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    slackWorkspace({ postFails: true });
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedMaya(harness);
    vi.spyOn(console, 'log').mockImplementation((): void => undefined);

    const transferId = await askPriya(harness, agentId);
    await harness.action(internal.managerChannelActions.sendTransferNotice, { transferId });

    expect(await noticeEvents(harness, agentId)).toEqual([
      expect.objectContaining({
        transferId,
        delivered: false,
        reason: expect.stringContaining('channel_not_found'),
      }),
    ]);
  });

  it('declares what the notice answers, so the backend checks it', (): void => {
    // Convex's registration attaches the export the push sends; the public type does not name it.
    const registered = sendTransferNoticeFunction as unknown as { exportReturns: () => string };
    expect(JSON.parse(registered.exportReturns())).toMatchObject({ type: 'object' });
  });

  it('sends nothing without the manager’s standing authority to write on the card: no write grant, or the write scope revoked under autonomous actions', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const calls = slackWorkspace();
    const withoutWrite = async (autonomousActions: boolean, revoked: boolean): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const { agentId } = await seedMaya(harness);
      await harness.run(async (ctx): Promise<void> => {
        await ctx.db.patch(agentId, { autonomousActions });
        for (const grant of await ctx.db.query('permissionGrants').collect()) {
          if (grant.scope !== 'team-chat:write') continue;
          if (revoked) await ctx.db.patch(grant._id, { revokedAt: 2 });
          else await ctx.db.delete(grant._id);
        }
      });
      await askPriya(harness, agentId);
    };
    await withoutWrite(false, false);
    await withoutWrite(true, true);
    expect(calls.filter((call) => call.method === 'users.lookupByEmail')).toEqual([]);
    expect(noticesIn(calls)).toEqual([]);
  });

  it('records that the named manager was not told in Slack, and why, when no card can carry the notice (m10)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const calls = slackWorkspace();
    const withheld = async (change: (ctx: MutationCtx) => Promise<void>): Promise<unknown[]> => {
      const harness = convexTest(schema, allConvexModules());
      const { agentId } = await seedMaya(harness);
      await harness.run(async (ctx): Promise<void> => await change(ctx));
      const transferId = await askPriya(harness, agentId);
      const recorded = await noticeEvents(harness, agentId);
      expect(recorded).toEqual([
        {
          transferId,
          fromAddress: MANAGER_ADDRESS,
          toAddress: PRIYA_ADDRESS,
          delivered: false,
          reason: expect.any(String),
        },
      ]);
      return recorded;
    };
    const surfacesOf = async (ctx: MutationCtx): Promise<Doc<'surfaces'>[]> =>
      await ctx.db.query('surfaces').collect();
    const withoutGrant = async (ctx: MutationCtx, scope: string): Promise<void> => {
      for (const row of await ctx.db.query('permissionGrants').collect()) {
        if (row.scope === scope) await ctx.db.delete(row._id);
      }
    };
    const reasons = [
      await withheld(async (ctx) => {
        for (const surface of await surfacesOf(ctx)) await ctx.db.delete(surface._id);
      }),
      await withheld(async (ctx) => {
        for (const surface of await surfacesOf(ctx)) {
          await ctx.db.patch(surface._id, { expiresAt: Date.now() - 1 });
        }
      }),
      await withheld(async (ctx) => {
        for (const surface of await surfacesOf(ctx)) {
          await ctx.db.patch(surface._id, { toolAllowlist: ['conversations.history'] });
        }
      }),
      await withheld(async (ctx) => await withoutGrant(ctx, 'team-chat:read')),
      // Juno on the real-Linear walk: Slack connected and readable, no write, autonomy off.
      await withheld(async (ctx) => await withoutGrant(ctx, 'team-chat:write')),
    ].map((recorded) => (recorded[0] as { reason: string }).reason);
    expect(reasons).toEqual([
      NOTICE_WITHOUT_SLACK,
      NOTICE_CARD_NOT_CONNECTED,
      NOTICE_CARD_NOT_APPROVED,
      NOTICE_WITHOUT_READ,
      NOTICE_WITHOUT_WRITE,
    ]);
    expect(noticesIn(calls)).toEqual([]);
  });

  it('sends under autonomous actions when the write scope was never revoked', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const calls = slackWorkspace();
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedMaya(harness);
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(agentId, { autonomousActions: true });
      for (const grant of await ctx.db.query('permissionGrants').collect()) {
        if (grant.scope === 'team-chat:write') await ctx.db.delete(grant._id);
      }
    });
    await askPriya(harness, agentId);
    expect(noticesIn(calls)).toHaveLength(1);
  });

  it('sends through an app Day0 created though its page names none of the notice’s methods (design 1 (b))', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const calls = slackWorkspace();
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedMaya(harness);
    await harness.run(async (ctx): Promise<void> => {
      for (const surface of await ctx.db.query('surfaces').collect()) {
        await ctx.db.patch(surface._id, {
          toolAllowlist: ['conversations.history'],
          credentialKind: 'oauth',
          provisioning: {
            appId: 'A0MAYA',
            appName: 'Maya (Day0)',
            clientId: '1.2',
            clientSecretCredentialId: surface.credentialId!,
            installUrl: 'https://slack.com/oauth/v2/authorize',
            redirectUrl: 'https://day0.example/api/oauth/slack',
            scopes: ['chat:write'],
            createdAt: 1,
            installedAt: 2,
          },
        });
      }
    });
    await askPriya(harness, agentId);
    expect(noticesIn(calls)).toHaveLength(1);
  });

  it('sends nothing through a card whose access has ended', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const calls = slackWorkspace();
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedMaya(harness);
    await harness.run(async (ctx): Promise<void> => {
      for (const surface of await ctx.db.query('surfaces').collect()) {
        await ctx.db.patch(surface._id, { expiresAt: Date.now() - 1 });
      }
    });
    await askPriya(harness, agentId);
    expect(noticesIn(calls)).toEqual([]);
  });

  it('re-reads the request at the claim: one cancelled before the notice runs is never told', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const calls = slackWorkspace();
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedMaya(harness);
    const owner = harness.withIdentity(managerIdentity());
    const transferId = await owner.mutation(api.managerTransfers.ask, {
      agentId,
      toAddress: PRIYA_ADDRESS,
    });
    await owner.mutation(api.managerTransfers.cancel, { transferId });
    await harness.finishAllScheduledFunctions(runDueNow);
    expect(noticesIn(calls)).toEqual([]);
    expect((await harness.run(async (ctx) => await ctx.db.get(transferId)))?.noticeSentAt).toBe(
      undefined,
    );
  });

  it('claims nothing in mock mode, whoever schedules it', async (): Promise<void> => {
    useSurfaceMode('mock');
    const calls = slackWorkspace();
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedMaya(harness);
    const transferId = await harness
      .withIdentity(managerIdentity())
      .mutation(api.managerTransfers.ask, { agentId, toAddress: PRIYA_ADDRESS });
    await expect(
      harness.action(internal.managerChannelActions.sendTransferNotice, { transferId }),
    ).resolves.toEqual({ sent: false, reason: 'the notice is sent in real mode only' });
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
    await harness.finishAllScheduledFunctions(runDueNow);

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
    // The ask and the notice's own record; no reply answered the request.
    expect(handover).toEqual(['manager.transfer-asked', 'manager.transfer-notice']);
    expect(noticesIn(calls)).toHaveLength(1);
  });
});

describe('the access request in the manager’s DM (11-AO, A24)', (): void => {
  const POSTED_TS = '1790000300.000100';

  afterEach((): void => {
    restoreSurfaceMode();
  });

  /** Every Slack call, answering the post as `postFails` says. */
  function slackDm(options: { readonly postFails?: boolean } = {}): Array<{
    method: string;
    channel?: string;
    text?: string;
  }> {
    const calls: Array<{ method: string; channel?: string; text?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL, init: RequestInit = {}): Promise<Response> => {
        const method = input.pathname.split('/').pop() ?? '';
        const body =
          typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, string>) : {};
        calls.push({ method, channel: body.channel, text: body.text });
        const payload =
          method === 'chat.postMessage' && options.postFails
            ? { ok: false, error: 'channel_not_found' }
            : { ok: true, ts: POSTED_TS };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    return calls;
  }

  /** Maya with a connected Slack card that DMs her manager and an approved Linear card that asks IT. */
  async function seedMaya(
    harness: TestConvex<typeof schema>,
    grants: readonly string[] = ['boss:message'],
    chat: { readonly ownApp?: boolean; readonly toolAllowlist?: string[] } = {},
  ): Promise<{ agentId: Id<'agents'>; linearId: Id<'surfaces'> }> {
    return await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Maya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      for (const scope of grants) {
        await ctx.db.insert('permissionGrants', { agentId, scope, createdAt: 1 });
      }
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
        toolAllowlist: chat.toolAllowlist ?? ['auth.test', 'chat.postMessage'],
        managerDmChannelId: 'D0MANAGER',
        managerUserId: 'UMANAGER',
        credentialId,
        credentialKind: chat.ownApp === true ? 'oauth' : 'value',
        credentialLanded: true,
        lastVerifiedAt: Date.now(),
        createdAt: 1,
        ...(chat.ownApp === true
          ? {
              provisioning: {
                appId: 'A0MAYA',
                appName: 'Maya (Day0)',
                clientId: '1.2',
                clientSecretCredentialId: credentialId,
                installUrl: 'https://slack.com/oauth/v2/authorize',
                redirectUrl: 'https://day0.example/api/oauth/slack',
                scopes: ['chat:write'],
                createdAt: 1,
                installedAt: 2,
              },
            }
          : {}),
      });
      const linearId = await ctx.db.insert('surfaces', {
        agentId,
        slug: 'linear',
        displayName: 'Linear',
        class: 'kanban',
        verdict: 'approved',
        whereFound: [],
        path: 'documented-api',
        endpoint: 'https://api.linear.app/graphql',
        managerApprovedAt: 2,
        request: { scopeRequested: ['linear:read'] },
        credentialLanded: false,
        createdAt: 1,
      });
      return { agentId, linearId };
    });
  }

  /** Slack's escaping undone: what the manager reads in the DM. */
  function asRead(text: string | undefined): string | undefined {
    return text?.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  it('posts the card’s words to the manager’s DM once, and records Slack’s timestamp', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const calls = slackDm();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, linearId } = await seedMaya(harness);
    const owner = harness.withIdentity(managerIdentity());
    const drafted = await owner.mutation(api.accessRequests.draft, {
      surfaceId: linearId,
      via: 'messaged',
    });
    await harness.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0));

    const posts = calls.filter((call) => call.method === 'chat.postMessage');
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe('D0MANAGER');
    expect(asRead(posts[0].text)).toBe(drafted.text);
    const exported = await harness.run(async (ctx) =>
      (
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .collect()
      )
        .filter((event) => event.type === 'surface.access-requested')
        .map((event) => (event.payload as { text: string }).text),
    );
    expect(exported).toEqual([drafted.text]);
    const surface = await harness.run(async (ctx) => await ctx.db.get(linearId));
    expect(surface?.accessRequest).toMatchObject({
      messagedAt: expect.any(Number),
      messageProviderTs: POSTED_TS,
    });
    await expect(
      harness.action(internal.managerChannelActions.sendAccessRequest, {
        surfaceId: linearId,
        draftedAt: drafted.draftedAt ?? 0,
      }),
    ).resolves.toEqual({ sent: false, reason: 'the request was already sent to the manager' });
    expect(calls.filter((call) => call.method === 'chat.postMessage')).toHaveLength(1);
  });

  it('posts it through an app Day0 created though the card’s page never names chat.postMessage (design 1 (b))', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const calls = slackDm();
    const harness = convexTest(schema, allConvexModules());
    const { linearId } = await seedMaya(harness, ['boss:message'], {
      ownApp: true,
      toolAllowlist: ['conversations.history'],
    });
    const owner = harness.withIdentity(managerIdentity());
    const drafted = await owner.mutation(api.accessRequests.draft, {
      surfaceId: linearId,
      via: 'messaged',
    });
    await harness.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0));
    const posts = calls.filter((call) => call.method === 'chat.postMessage');
    expect(posts.map((post) => asRead(post.text))).toEqual([drafted.text]);
  });

  it("sends no DM when the manager copied or emailed the request, and one when they ask for it after (11-AC's item 2)", async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const calls = slackDm();
    const harness = convexTest(schema, allConvexModules());
    const { linearId } = await seedMaya(harness);
    const owner = harness.withIdentity(managerIdentity());

    const drafted = await owner.mutation(api.accessRequests.draft, {
      surfaceId: linearId,
      via: 'copied',
    });
    await owner.mutation(api.accessRequests.draft, { surfaceId: linearId, via: 'emailed' });
    await harness.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0));
    expect(calls.filter((call) => call.method === 'chat.postMessage')).toEqual([]);

    await owner.mutation(api.accessRequests.draft, { surfaceId: linearId, via: 'messaged' });
    await owner.mutation(api.accessRequests.draft, { surfaceId: linearId, via: 'messaged' });
    await harness.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0));

    const posts = calls.filter((call) => call.method === 'chat.postMessage');
    expect(posts.map((post) => asRead(post.text))).toEqual([drafted.text]);
    const view = await owner.query(api.accessRequests.forCard, { surfaceId: linearId });
    expect(view).toMatchObject({ draftedAt: drafted.draftedAt, messagedAt: expect.any(Number) });
  });

  it("lets the manager ask again once a claimed DM never reached Slack within its bound (the code pass's M2)", async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const calls = slackDm();
    const harness = convexTest(schema, allConvexModules());
    const { linearId } = await seedMaya(harness);
    const owner = harness.withIdentity(managerIdentity());
    const drafted = await owner.mutation(api.accessRequests.draft, {
      surfaceId: linearId,
      via: 'copied',
    });
    // A send that claimed the DM and never came back: the action died between the claim and Slack.
    await harness.mutation(internal.accessRequests.claimMessage, {
      surfaceId: linearId,
      draftedAt: drafted.draftedAt ?? 0,
    });
    expect(await owner.query(api.accessRequests.forCard, { surfaceId: linearId })).toMatchObject({
      messaging: true,
    });

    // The release scheduled at the claim runs at its bound (the round review's m9).
    await harness.finishAllScheduledFunctions(() => vi.advanceTimersByTime(11 * 60 * 1000));
    expect(
      await owner.query(api.accessRequests.forCard, { surfaceId: linearId }),
    ).not.toHaveProperty('messaging');
    await owner.mutation(api.accessRequests.draft, { surfaceId: linearId, via: 'messaged' });
    await harness.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0));

    expect(calls.filter((call) => call.method === 'chat.postMessage')).toHaveLength(1);
  });

  it("releases a claimed DM that never reached Slack at its bound by a write, so an open card stops saying it is being sent (the round review's m9)", async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    slackDm();
    const harness = convexTest(schema, allConvexModules());
    const { linearId } = await seedMaya(harness);
    const owner = harness.withIdentity(managerIdentity());
    const drafted = await owner.mutation(api.accessRequests.draft, {
      surfaceId: linearId,
      via: 'copied',
    });
    await harness.mutation(internal.accessRequests.claimMessage, {
      surfaceId: linearId,
      draftedAt: drafted.draftedAt ?? 0,
    });

    await harness.finishAllScheduledFunctions(() => vi.advanceTimersByTime(10 * 60 * 1000));

    const surface = await harness.run(async (ctx) => await ctx.db.get(linearId));
    expect(surface?.accessRequest).not.toHaveProperty('messagedAt');
  });

  it('offers the DM again for a claim made before the upgrade, which no release was scheduled for (the second pass)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    slackDm();
    const harness = convexTest(schema, allConvexModules());
    const { linearId } = await seedMaya(harness);
    const owner = harness.withIdentity(managerIdentity());
    await owner.mutation(api.accessRequests.draft, { surfaceId: linearId, via: 'copied' });
    // As v0.14.0 left a claim whose action died: `messagedAt` eleven minutes old, nothing queued.
    await harness.run(async (ctx) => {
      const card = await ctx.db.get(linearId);
      if (card?.accessRequest === undefined) throw new Error('no drafted request');
      await ctx.db.patch(linearId, {
        accessRequest: { ...card.accessRequest, messagedAt: Date.now() - 11 * 60 * 1000 },
      });
    });

    expect(
      await owner.query(api.accessRequests.forCard, { surfaceId: linearId }),
    ).not.toHaveProperty('messaging');
  });

  it("never lets the release scheduled at one claim end a later claim (the round review's m9)", async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    slackDm();
    const harness = convexTest(schema, allConvexModules());
    const { linearId } = await seedMaya(harness);
    const owner = harness.withIdentity(managerIdentity());
    const drafted = await owner.mutation(api.accessRequests.draft, {
      surfaceId: linearId,
      via: 'copied',
    });
    const claim = { surfaceId: linearId, draftedAt: drafted.draftedAt ?? 0 };
    await harness.mutation(internal.accessRequests.claimMessage, claim);
    // Slack refused the first send at once, and the manager asked again two minutes later.
    await harness.mutation(internal.accessRequests.releaseMessage, claim);
    vi.advanceTimersByTime(2 * 60 * 1000);
    await harness.mutation(internal.accessRequests.claimMessage, claim);
    const second = (await harness.run(async (ctx) => await ctx.db.get(linearId)))?.accessRequest
      ?.messagedAt;

    // Past the first claim's bound, and inside the second's.
    vi.advanceTimersByTime(8 * 60 * 1000 + 1);
    await harness.finishInProgressScheduledFunctions();

    const surface = await harness.run(async (ctx) => await ctx.db.get(linearId));
    expect(surface?.accessRequest?.messagedAt).toBe(second);
  });

  it('lets the manager ask again once a DM Slack refused is released', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    slackDm({ postFails: true });
    const harness = convexTest(schema, allConvexModules());
    const { linearId } = await seedMaya(harness);
    const owner = harness.withIdentity(managerIdentity());
    await owner.mutation(api.accessRequests.draft, { surfaceId: linearId, via: 'messaged' });
    await harness.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0));

    const calls = slackDm();
    await owner.mutation(api.accessRequests.draft, { surfaceId: linearId, via: 'messaged' });
    await harness.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0));

    expect(calls.filter((call) => call.method === 'chat.postMessage')).toHaveLength(1);
  });

  it('sends the words the draft recorded, even when the card changed before the DM went out', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const calls = slackDm();
    const harness = convexTest(schema, allConvexModules());
    const { linearId } = await seedMaya(harness);
    const drafted = await harness
      .withIdentity(managerIdentity())
      .mutation(api.accessRequests.draft, { surfaceId: linearId, via: 'messaged' });
    await harness.run(async (ctx) => {
      await ctx.db.patch(linearId, { expiresAt: Date.UTC(2027, 0, 31, 12) });
    });
    await harness.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0));
    const posts = calls.filter((call) => call.method === 'chat.postMessage');
    expect(posts.map((post) => asRead(post.text))).toEqual([drafted.text]);
  });

  it('records no DM Slack refused, and sends none without the manager DM’s grant', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    slackDm({ postFails: true });
    const refused = convexTest(schema, allConvexModules());
    const { linearId } = await seedMaya(refused);
    await refused.withIdentity(managerIdentity()).mutation(api.accessRequests.draft, {
      surfaceId: linearId,
      via: 'messaged',
    });
    await refused.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0));
    const kept = await refused.run(async (ctx) => await ctx.db.get(linearId));
    expect(kept?.accessRequest?.messagedAt).toBeUndefined();

    const calls = slackDm();
    const ungranted = convexTest(schema, allConvexModules());
    const seeded = await seedMaya(ungranted, []);
    await ungranted.withIdentity(managerIdentity()).mutation(api.accessRequests.draft, {
      surfaceId: seeded.linearId,
      via: 'messaged',
    });
    await ungranted.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0));
    expect(calls).toEqual([]);
  });
});
