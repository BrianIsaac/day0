/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { ORGANISATION_OWNER_KEY } from '../../src/lib/organisation-key';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';

const sent = vi.hoisted(() => [] as Array<{ authorization: string; body: string; url: string }>);

vi.mock('../../src/surfaces/credentials', () => ({
  decryptCredentialRef: { name: 'credentials:decrypt' },
  decryptCredential: async (_ctx: unknown, credentialId: string): Promise<string> =>
    credentialId.length > 0 ? 'xapp-1-A0OPS-1234567890-abcdefghij' : 'chat-secret',
}));

const SECRET = 'bridge-secret-for-tests';

beforeEach((): void => {
  vi.stubEnv('DAY0_SOCKET_BRIDGE_SECRET', SECRET);
  // Scheduled acknowledgements and edits stay on fake timers, so none posts through a later stub.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL, init: RequestInit): Promise<Response> => {
      sent.push({
        url: input.href,
        authorization: new Headers(init.headers).get('authorization') ?? '',
        body: String(init.body),
      });
      const reply = input.href.endsWith('/apps.connections.open')
        ? { ok: true, url: 'wss://wss-primary.slack.com/link/?ticket=fake-ticket' }
        : { ok: true, ts: `provider-${sent.length}` };
      return new Response(JSON.stringify(reply), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach((): void => {
  sent.length = 0;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

interface Seeded {
  readonly agentId: Id<'agents'>;
  readonly surfaceId: Id<'surfaces'>;
  readonly workItemId: Id<'workItems'>;
  readonly code: string;
  readonly ts: string;
}

/**
 * An employee whose own Slack app has its app-level token, a parked plan, and its request sent
 * with buttons to the manager's DM.
 */
async function seedButtonedRequest(
  harness: TestConvex<typeof schema>,
  options: { readonly appLevelToken?: boolean } = {},
): Promise<Seeded> {
  const { agentId, surfaceId, workItemId } = await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'ops worker',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    await ctx.db.insert('permissionGrants', { agentId, scope: 'boss:message', createdAt: 1 });
    const credential = async (label: string): Promise<Id<'credentials'>> =>
      await ctx.db.insert('credentials', {
        userId: ORGANISATION_OWNER_KEY,
        holder: 'organisation',
        kind: 'oauth',
        label,
        ciphertext: 'ciphertext',
        iv: 'iv',
        source: 'oauth',
        createdAt: 1,
      });
    const botToken = await credential('Ops (Day0) bot token');
    const clientSecret = await credential('Ops (Day0) client secret');
    const appLevel = options.appLevelToken === false ? undefined : await credential('app-level');
    const surfaceId = await ctx.db.insert('surfaces', {
      agentId,
      slug: 'team-chat',
      displayName: 'Slack',
      class: 'chat',
      verdict: 'connected',
      whereFound: [],
      path: 'documented-api',
      endpoint: 'https://slack.com/api/',
      toolAllowlist: ['chat.postMessage', 'chat.update'],
      toolArguments: [{ tool: 'chat.postMessage', arguments: ['channel', 'text'] }],
      managerDmChannelId: 'D0MANAGER',
      managerUserId: 'UMANAGER',
      providerWorkspaceId: 'T0DAY0',
      credentialId: botToken,
      credentialKind: 'oauth',
      credentialLanded: true,
      lastVerifiedAt: Date.now(),
      provisioning: {
        appId: 'A0OPS',
        appName: 'Ops (Day0)',
        clientId: '1.2',
        clientSecretCredentialId: clientSecret,
        installUrl: 'https://slack.com/oauth/v2/authorize',
        redirectUrl: 'https://day0.example/api/oauth/slack',
        scopes: ['chat:write'],
        createdAt: 1,
        installedAt: 2,
        ...(appLevel === undefined ? {} : { appLevelTokenCredentialId: appLevel }),
      },
      createdAt: 1,
    });
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'live-document',
      sourceSystem: 'docs',
      externalId: 'press-test',
      title: 'Verify the runbook',
      contentSummary: 'Read the runbook.',
      contentRefs: [],
      state: 'plan-pending',
      plan: { summary: 'Read the runbook and report the finding.' },
      observedAt: 1,
      createdAt: 1,
    });
    return { agentId, surfaceId, workItemId };
  });
  await harness.action(internal.managerChannelActions.requestDecision, {
    workItemId,
    kind: 'plan',
  });
  const decision = (await harness.run(async (ctx) => await ctx.db.get(workItemId)))!.decision!;
  return { agentId, surfaceId, workItemId, code: decision.id, ts: decision.ts! };
}

function blockActions(
  seeded: Seeded,
  overrides: {
    readonly user?: string;
    readonly appId?: string;
    readonly messageTs?: string;
    readonly actionId?: string;
    readonly code?: string;
    readonly actionTs?: string;
  } = {},
): unknown {
  return {
    type: 'block_actions',
    user: { id: overrides.user ?? 'UMANAGER' },
    team: { id: 'T0DAY0' },
    api_app_id: overrides.appId ?? 'A0OPS',
    container: {
      type: 'message',
      message_ts: overrides.messageTs ?? seeded.ts,
      channel_id: 'D0MANAGER',
    },
    actions: [
      {
        action_id: overrides.actionId ?? 'day0.decision.approve',
        block_id: `day0-decision-${seeded.code}`,
        value: overrides.code ?? seeded.code,
        type: 'button',
        action_ts: overrides.actionTs ?? '1787768500.000200',
      },
    ],
  };
}

async function press(
  harness: TestConvex<typeof schema>,
  seeded: Seeded,
  payload: unknown,
  authorization = `Bearer ${SECRET}`,
): Promise<Response> {
  return await harness.fetch('/slack-socket/press', {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ surfaceId: seeded.surfaceId, payload }),
  });
}

describe('the Socket Mode bridge routes (wave 12, 12-M; RM7)', (): void => {
  it('refuses a call without the deployment secret, and every call where the deployment holds none', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const seeded = await seedButtonedRequest(harness);
    for (const path of ['/slack-socket/apps', '/slack-socket/connection', '/slack-socket/press']) {
      const bare = await harness.fetch(path, { method: 'POST', body: '{}' });
      expect(bare.status).toBe(401);
      const wrong = await harness.fetch(path, {
        method: 'POST',
        headers: { authorization: 'Bearer not-the-secret' },
        body: '{}',
      });
      expect(wrong.status).toBe(401);
    }
    vi.stubEnv('DAY0_SOCKET_BRIDGE_SECRET', '');
    expect((await press(harness, seeded, blockActions(seeded))).status).toBe(503);
    const row = await harness.run(async (ctx) => await ctx.db.get(seeded.workItemId));
    expect(row?.state).toBe('plan-pending');
  });

  it('lists the apps whose presses it carries, with no token', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const seeded = await seedButtonedRequest(harness);
    await seedButtonedRequest(harness, { appLevelToken: false });
    const response = await harness.fetch('/slack-socket/apps', {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
      body: '{}',
    });
    expect(response.status).toBe(200);
    const listed = (await response.json()) as { apps: unknown[] };
    expect(listed).toEqual({ apps: [{ surfaceId: seeded.surfaceId, appId: 'A0OPS' }] });
    expect(JSON.stringify(listed)).not.toContain('xapp-');
  });

  it('lists an app however many chat cards the deployment holds before it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await harness.run(async (ctx): Promise<void> => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'many',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      for (let index = 0; index < 520; index += 1) {
        await ctx.db.insert('surfaces', {
          agentId,
          slug: `chat-${index}`,
          displayName: 'Chat',
          class: 'chat',
          verdict: 'declared',
          whereFound: [],
          credentialLanded: false,
          createdAt: 1,
        });
      }
    });
    const seeded = await seedButtonedRequest(harness);
    const response = await harness.fetch('/slack-socket/apps', {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
      body: '{}',
    });
    expect(await response.json()).toEqual({
      apps: [{ surfaceId: seeded.surfaceId, appId: 'A0OPS' }],
    });
  });

  it('opens one app’s connection with its app-level token and answers the URL alone', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const seeded = await seedButtonedRequest(harness);
    const response = await harness.fetch('/slack-socket/connection', {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ surfaceId: seeded.surfaceId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ url: 'wss://wss-primary.slack.com/link/?ticket=fake-ticket' });
    const open = sent.find((call) => call.url.endsWith('/apps.connections.open'));
    expect(open?.authorization).toBe('Bearer xapp-1-A0OPS-1234567890-abcdefghij');
  });

  it('opens no connection for an app without its app-level token', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const seeded = await seedButtonedRequest(harness, { appLevelToken: false });
    const response = await harness.fetch('/slack-socket/connection', {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ surfaceId: seeded.surfaceId }),
    });
    expect(response.status).toBe(404);
    expect(sent.filter((call) => call.url.endsWith('/apps.connections.open'))).toEqual([]);
  });

  it('decides a press by the surface’s manager exactly as the typed code does', async (): Promise<void> => {
    const pressed = convexTest(schema, allConvexModules());
    const byPress = await seedButtonedRequest(pressed);
    const response = await press(pressed, byPress, blockActions(byPress));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'decided', outcome: 'approve' });

    const typed = convexTest(schema, allConvexModules());
    const byReply = await seedButtonedRequest(typed);
    await typed.mutation(internal.work.resolveChannelDecision, {
      surfaceId: byReply.surfaceId,
      userId: 'UMANAGER',
      messageTs: '1787768500.000200',
      reply: { verb: 'approve', id: byReply.code },
    });

    const read = async (
      harness: TestConvex<typeof schema>,
      seeded: Seeded,
    ): Promise<{ state: string; decision: Record<string, unknown>; events: string[] }> =>
      await harness.run(async (ctx) => {
        const row = (await ctx.db.get(seeded.workItemId))!;
        const events = await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', seeded.agentId))
          .collect();
        return {
          state: row.state,
          decision: {
            outcome: row.decision?.outcome,
            decidedVia: row.decision?.decidedVia,
            decidedTs: row.decision?.decidedTs,
          },
          events: events.map((event) => event.type),
        };
      });
    const left = await read(pressed, byPress);
    const right = await read(typed, byReply);
    expect(left.state).toBe('plan-approved');
    expect(left).toEqual(right);
    expect(left.decision).toEqual({
      outcome: 'approved',
      decidedVia: 'channel',
      decidedTs: '1787768500.000200',
    });
  });

  it('decides nothing on a press by another Slack user', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const seeded = await seedButtonedRequest(harness);
    const response = await press(harness, seeded, blockActions(seeded, { user: 'USOMEONE' }));
    expect(await response.json()).toMatchObject({
      status: 'ignored',
      reason: 'manager identity mismatch',
    });
    expect((await harness.run(async (ctx) => await ctx.db.get(seeded.workItemId)))?.state).toBe(
      'plan-pending',
    );
  });

  it('decides nothing on a press from another app, on another message or of another button', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const seeded = await seedButtonedRequest(harness);
    for (const [payload, reason] of [
      [blockActions(seeded, { appId: 'A0OTHER' }), 'pressed in another app'],
      [blockActions(seeded, { messageTs: '1787768999.000100' }), 'pressed on another message'],
      [blockActions(seeded, { actionId: 'somebody.else' }), 'not a decision button'],
    ] as const) {
      const response = await press(harness, seeded, payload);
      expect(await response.json()).toMatchObject({ status: 'ignored', reason });
    }
    expect((await harness.run(async (ctx) => await ctx.db.get(seeded.workItemId)))?.state).toBe(
      'plan-pending',
    );
  });

  it('decides nothing on a press outside the manager DM or from another workspace', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const seeded = await seedButtonedRequest(harness);
    const elsewhere = blockActions(seeded) as {
      container: Record<string, string>;
      team: Record<string, string>;
    };
    await expect(
      (
        await press(harness, seeded, {
          ...elsewhere,
          container: { ...elsewhere.container, channel_id: 'C0PUBLIC' },
        })
      ).json(),
    ).resolves.toMatchObject({ status: 'ignored', reason: 'pressed outside the manager DM' });
    await expect(
      (await press(harness, seeded, { ...elsewhere, team: { id: 'T0OTHER' } })).json(),
    ).resolves.toMatchObject({ status: 'ignored', reason: 'pressed in another workspace' });
    expect((await harness.run(async (ctx) => await ctx.db.get(seeded.workItemId)))?.state).toBe(
      'plan-pending',
    );
  });

  it('decides nothing on a press of a batch code, which no Day0 button carries', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const seeded = await seedButtonedRequest(harness);
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.insert('decisionBatches', {
        agentId: seeded.agentId,
        id: 'bt7xyz',
        surfaceSlug: 'team-chat',
        channel: 'D0MANAGER',
        members: [],
        requestedAt: 1,
      });
    });
    // A message another writer put in the DM, with a button naming the batch's code.
    const forged = await press(
      harness,
      seeded,
      blockActions(seeded, { code: 'bt7xyz', messageTs: '1787768888.000100' }),
    );
    expect(await forged.json()).toMatchObject({
      status: 'ignored',
      reason: 'pressed on another message',
    });
    const batch = await harness.run(async (ctx) => await ctx.db.query('decisionBatches').first());
    expect(batch?.decidedAt).toBeUndefined();
  });

  it('decides nothing on a press through a card that can no longer take decisions, as the poll would not read it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const seeded = await seedButtonedRequest(harness);
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(seeded.surfaceId, { expiresAt: Date.now() - 1_000 });
    });
    expect(await (await press(harness, seeded, blockActions(seeded))).json()).toMatchObject({
      status: 'ignored',
      reason: 'the card takes no decisions now',
    });
    expect((await harness.run(async (ctx) => await ctx.db.get(seeded.workItemId)))?.state).toBe(
      'plan-pending',
    );
  });

  it('answers a press on a decided request with its decision, and decides nothing twice', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const seeded = await seedButtonedRequest(harness);
    await press(harness, seeded, blockActions(seeded));
    // The same press redelivered is the same press.
    expect(await (await press(harness, seeded, blockActions(seeded))).json()).toMatchObject({
      status: 'already-decided',
      notified: false,
    });
    const second = await press(
      harness,
      seeded,
      blockActions(seeded, { actionId: 'day0.decision.reject', actionTs: '1787768600.000300' }),
    );
    expect(await second.json()).toMatchObject({ status: 'already-decided', notified: true });
    const row = await harness.run(async (ctx) => await ctx.db.get(seeded.workItemId));
    expect(row?.decision?.outcome).toBe('approved');
  });

  it('answers a press on a replaced request with the request that replaced it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const seeded = await seedButtonedRequest(harness);
    await harness.mutation(internal.work.closeDecisionThread, {
      surfaceId: seeded.surfaceId,
      decisionId: seeded.code,
    });
    await harness.action(internal.managerChannelActions.requestDecision, {
      workItemId: seeded.workItemId,
      kind: 'plan',
      supersedes: seeded.code,
    });
    const newCode = (await harness.run(async (ctx) => await ctx.db.get(seeded.workItemId)))!
      .decision!.id;
    const response = await press(harness, seeded, blockActions(seeded));
    expect(await response.json()).toMatchObject({ status: 'replaced', replacedBy: newCode });
    expect((await harness.run(async (ctx) => await ctx.db.get(seeded.workItemId)))?.state).toBe(
      'plan-pending',
    );
  });

  it('still decides by the typed code on a request that carries buttons', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const seeded = await seedButtonedRequest(harness);
    await expect(
      harness.mutation(internal.work.resolveChannelDecision, {
        surfaceId: seeded.surfaceId,
        userId: 'UMANAGER',
        messageTs: '1787768500.000400',
        reply: { verb: 'reject', id: seeded.code, reason: 'not this week' },
      }),
    ).resolves.toMatchObject({ status: 'decided', outcome: 'reject' });
  });
});
