/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { typedCodeReachOf } from '../../convex/slackMessagesTab';
import { SLACK_KIT_BOT_SCOPES } from '../../src/surfaces/access-kit/slack';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';
import { LANDED_CONFIGURATION_TOKEN, LANDED_REFRESH_TOKEN } from './fakes/slack-api';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/*
 * Whether the manager's typed code reaches an employee's own Slack app, as the employee's record
 * says it (W12V-7): the reach every reader goes through, the manager's word for an app Day0
 * cannot read, and `check:access`'s report.
 */

type Harness = TestConvex<typeof schema>;

beforeEach((): void => {
  useSurfaceMode('real');
  vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('DAY0_PUBLIC_URL', 'https://day0.example.test');
});

afterEach((): void => {
  restoreSurfaceMode();
  vi.unstubAllEnvs();
});

async function landSlack(harness: Harness): Promise<Id<'organisationConnections'>> {
  return await harness.action(internal.organisationConnections.landFromSetup, {
    system: 'slack',
    displayName: 'Slack',
    kind: 'slack-configuration',
    mode: 'per-employee',
    scopes: [...SLACK_KIT_BOT_SCOPES],
    redirectUrl: 'https://day0.example.test/api/oauth/slack',
    secret: LANDED_CONFIGURATION_TOKEN,
    refreshToken: LANDED_REFRESH_TOKEN,
  });
}

/** An installed own-app Slack card of one of the owner's employees, created as given. */
async function card(
  harness: Harness,
  options: {
    readonly name: string;
    readonly createdBy?: Id<'organisationConnections'>;
    readonly takesMessages?: boolean;
    readonly ownApp?: boolean;
  },
): Promise<Id<'surfaces'>> {
  return await harness.run(async (ctx): Promise<Id<'surfaces'>> => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: options.name,
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const secret = await ctx.db.insert('credentials', {
      userId: 'organisation',
      kind: 'oauth',
      label: `${options.name} (Day0) client secret`,
      ciphertext: 'ciphertext',
      iv: 'iv',
      source: 'oauth',
      createdAt: 1,
    });
    const appId = `A0${options.name.toUpperCase()}`;
    const surfaceId = await ctx.db.insert('surfaces', {
      agentId,
      slug: 'slack',
      displayName: 'Slack',
      class: 'chat',
      verdict: 'connected',
      whereFound: [],
      path: 'documented-api',
      endpoint: 'https://slack.com/api/',
      credentialLanded: true,
      managerDmChannelId: 'D0MANAGER',
      createdAt: 1,
      ...(options.ownApp === false
        ? {}
        : {
            provisioning: {
              appId,
              appName: `${options.name} (Day0)`,
              clientId: '1.2',
              clientSecretCredentialId: secret,
              installUrl: 'https://slack.com/oauth/v2/authorize',
              redirectUrl: 'https://day0.example.test/api/oauth/slack',
              scopes: ['chat:write'],
              createdAt: 1,
              installedAt: 2,
              ...(options.createdBy === undefined
                ? {}
                : { organisationConnectionId: options.createdBy }),
            },
          }),
    });
    if (options.takesMessages === true) {
      await ctx.db.insert('events', {
        agentId,
        type: 'surface.app-messages-open',
        payload: { surfaceId, appId, appName: `${options.name} (Day0)`, how: 'created' },
        createdAt: 2,
      });
    }
    return surfaceId;
  });
}

async function reach(harness: Harness, surfaceId: Id<'surfaces'>) {
  return await harness.run(async (ctx) => {
    const surface = await ctx.db.get(surfaceId);
    if (surface === null) throw new Error('the card is gone');
    return await typedCodeReachOf(ctx, surface);
  });
}

describe('typedCodeReachOf', (): void => {
  it('reads each card by its app: open, Day0’s to open, a person’s toggle, or a card Day0 cannot read', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    const made = await card(harness, {
      name: 'Maya',
      createdBy: connectionId,
      takesMessages: true,
    });
    const older = await card(harness, { name: 'Iris', createdBy: connectionId });
    const pasted = await card(harness, { name: 'Otto' });
    const foreign = await card(harness, { name: 'Leo', ownApp: false });

    expect(await reach(harness, made)).toEqual({ state: 'open' });
    expect(await reach(harness, older)).toEqual({ state: 'day0-opens', appName: 'Iris (Day0)' });
    expect(await reach(harness, pasted)).toEqual({
      state: 'needs-toggle',
      appName: 'Otto (Day0)',
    });
    expect(await reach(harness, foreign)).toEqual({ state: 'open' });
  });
});

describe('confirmMessagesTab', (): void => {
  it('records the manager’s word for an app Day0 cannot read, once', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const pasted = await card(harness, { name: 'Otto' });
    await harness
      .withIdentity(managerIdentity())
      .mutation(api.slackMessagesTab.confirmMessagesTab, { surfaceId: pasted });
    expect(await reach(harness, pasted)).toEqual({ state: 'open' });
  });

  it('refuses a signed-out caller before it reads the card', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const pasted = await card(harness, { name: 'Otto' });
    await expect(
      harness.mutation(api.slackMessagesTab.confirmMessagesTab, { surfaceId: pasted }),
    ).rejects.toThrow();
    expect(await reach(harness, pasted)).toEqual({
      state: 'needs-toggle',
      appName: 'Otto (Day0)',
    });
  });
});

describe('messagesTabReport', (): void => {
  it('lists each installed employee app with whether the typed code reaches it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    await card(harness, { name: 'Maya', createdBy: connectionId, takesMessages: true });
    await card(harness, { name: 'Otto' });
    await card(harness, { name: 'Leo', ownApp: false });
    const report = await harness.query(internal.slackMessagesTab.messagesTabReport, {
      cursor: null,
    });
    expect(report.cursor).toBeNull();
    expect(report.apps).toEqual([
      { appName: 'Maya (Day0)', reach: 'open' },
      { appName: 'Otto (Day0)', reach: 'needs-toggle' },
    ]);
  });
});
