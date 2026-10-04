/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { ORGANISATION_OWNER_KEY } from '../../src/lib/organisation-key';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

const TOKEN = 'xapp-1-A0OPS-1234567890-abcdefghij';
const calls = vi.hoisted(() => [] as Array<{ url: string; authorization: string }>);

/** Slack's answer to `apps.connections.open`: a URL, or the error it names. */
function slackOpens(error?: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL, init: RequestInit): Promise<Response> => {
      calls.push({
        url: input.href,
        authorization: new Headers(init.headers).get('authorization') ?? '',
      });
      return new Response(
        JSON.stringify(
          error === undefined
            ? { ok: true, url: 'wss://wss-primary.slack.com/link/?ticket=fake-ticket' }
            : { ok: false, error },
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
}

beforeEach((): void => {
  useSurfaceMode('real');
  vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
});

afterEach((): void => {
  calls.length = 0;
  restoreSurfaceMode();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function seedOwnApp(
  harness: TestConvex<typeof schema>,
  options: { readonly provisioned?: boolean } = {},
): Promise<{ agentId: Id<'agents'>; surfaceId: Id<'surfaces'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Mateo',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const clientSecret = await ctx.db.insert('credentials', {
      userId: ORGANISATION_OWNER_KEY,
      holder: 'organisation',
      kind: 'oauth',
      label: 'Mateo (Day0) client secret',
      ciphertext: 'ciphertext',
      iv: 'iv',
      source: 'oauth',
      createdAt: 1,
    });
    const surfaceId = await ctx.db.insert('surfaces', {
      agentId,
      slug: 'slack',
      displayName: 'Slack',
      class: 'chat',
      verdict: 'connected',
      whereFound: [],
      path: 'documented-api',
      endpoint: 'https://slack.com/api/',
      managerDmChannelId: 'D0MANAGER',
      managerUserId: 'UMANAGER',
      credentialLanded: true,
      ...(options.provisioned === false
        ? {}
        : {
            provisioning: {
              appId: 'A0MATEO',
              appName: 'Mateo (Day0)',
              clientId: '1.2',
              clientSecretCredentialId: clientSecret,
              installUrl: 'https://slack.com/oauth/v2/authorize',
              redirectUrl: 'https://day0.example/api/oauth/slack',
              scopes: ['chat:write'],
              createdAt: 1,
              installedAt: 2,
            },
          }),
      createdAt: 1,
    });
    return { agentId, surfaceId };
  });
}

describe('landing an employee app’s app-level token (wave 12, 12-M; RM3 (a))', (): void => {
  it('checks the token with Slack, holds it for the organisation and points the app at it', async (): Promise<void> => {
    slackOpens();
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId, agentId } = await seedOwnApp(harness);
    await expect(
      harness
        .withIdentity(managerIdentity())
        .action(api.slackSocketActions.landAppLevelToken, { surfaceId, token: ` ${TOKEN} ` }),
    ).resolves.toEqual({ landed: true });
    expect(calls).toEqual([
      { url: 'https://slack.com/api/apps.connections.open', authorization: `Bearer ${TOKEN}` },
    ]);
    const { surface, credential, events } = await harness.run(async (ctx) => {
      const surface = (await ctx.db.get(surfaceId))!;
      const credential = await ctx.db.get(surface.provisioning!.appLevelTokenCredentialId!);
      const events = await ctx.db
        .query('events')
        .withIndex('by_agent', (q) => q.eq('agentId', agentId))
        .collect();
      return { surface, credential, events };
    });
    expect(credential).toMatchObject({
      userId: ORGANISATION_OWNER_KEY,
      holder: 'organisation',
      kind: 'value',
      label: 'Mateo (Day0) app-level token',
      source: 'entered',
      appId: 'A0MATEO',
    });
    expect(credential?.issuedBy).toBeUndefined();
    expect(credential?.ciphertext).not.toContain(TOKEN);
    expect(events.map((event) => [event.type, event.payload])).toContainEqual([
      'surface.socket-token-landed',
      { surfaceId, appName: 'Mateo (Day0)', replaced: false },
    ]);
    expect(JSON.stringify({ surface, events })).not.toContain('xapp-');
  });

  it('replaces an earlier token and ends the earlier row in Day0', async (): Promise<void> => {
    slackOpens();
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedOwnApp(harness);
    const owner = harness.withIdentity(managerIdentity());
    await owner.action(api.slackSocketActions.landAppLevelToken, { surfaceId, token: TOKEN });
    const first = await harness.run(
      async (ctx) => (await ctx.db.get(surfaceId))!.provisioning!.appLevelTokenCredentialId!,
    );
    await owner.action(api.slackSocketActions.landAppLevelToken, {
      surfaceId,
      token: 'xapp-1-A0OPS-0987654321-jihgfedcba',
    });
    const { second, earlier } = await harness.run(async (ctx) => {
      const second = (await ctx.db.get(surfaceId))!.provisioning!.appLevelTokenCredentialId!;
      return { second, earlier: await ctx.db.get(first) };
    });
    expect(second).not.toBe(first);
    expect(earlier?.revokedAt).toEqual(expect.any(Number));
    expect(earlier?.ciphertext).toBeUndefined();
  });

  it('refuses a value that is not an app-level token, without asking Slack', async (): Promise<void> => {
    slackOpens();
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedOwnApp(harness);
    await expect(
      harness.withIdentity(managerIdentity()).action(api.slackSocketActions.landAppLevelToken, {
        surfaceId,
        token: 'xoxb-1234567890-abcdefghij',
      }),
    ).rejects.toThrow(/xapp-/);
    expect(calls).toEqual([]);
  });

  it('refuses a token Slack does not accept, keeps nothing and says why without the token', async (): Promise<void> => {
    slackOpens('invalid_auth');
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedOwnApp(harness);
    const landing = harness
      .withIdentity(managerIdentity())
      .action(api.slackSocketActions.landAppLevelToken, { surfaceId, token: TOKEN });
    await expect(landing).rejects.toThrow(/invalid_auth/);
    await expect(landing).rejects.not.toThrow(/xapp-1/);
    const { surface, rows } = await harness.run(async (ctx) => ({
      surface: await ctx.db.get(surfaceId),
      rows: await ctx.db.query('credentials').collect(),
    }));
    expect(surface?.provisioning?.appLevelTokenCredentialId).toBeUndefined();
    expect(rows.map((row) => row.label)).toEqual(['Mateo (Day0) client secret']);
  });

  it('refuses a card with no app of the employee’s own, and another manager', async (): Promise<void> => {
    slackOpens();
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedOwnApp(harness, { provisioned: false });
    await expect(
      harness
        .withIdentity(managerIdentity())
        .action(api.slackSocketActions.landAppLevelToken, { surfaceId, token: TOKEN }),
    ).rejects.toThrow(/own Slack app/);
    const owned = await seedOwnApp(harness);
    await expect(
      harness
        .withIdentity(managerIdentity('someone-else'))
        .action(api.slackSocketActions.landAppLevelToken, {
          surfaceId: owned.surfaceId,
          token: TOKEN,
        }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
