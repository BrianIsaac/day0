/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { CONFIRM_NOT_NEEDED, typedCodeReachOf } from '../../convex/slackMessagesTab';
import { SLACK_KIT_BOT_SCOPES } from '../../src/surfaces/access-kit/slack';
import { manifestTakesMessages } from '../../src/surfaces/slack-messages-tab';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';
import {
  LANDED_CONFIGURATION_TOKEN,
  LANDED_REFRESH_TOKEN,
  callsOf,
  slackDouble,
  type SlackDouble,
} from './fakes/slack-api';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/*
 * An employee's own Slack app takes the manager's typed code (W12V-7, the walk on real Slack):
 * an app the kit creates now opens its messages tab from the start; one Day0 created before this
 * release through a connection still active is opened at its probe with `apps.manifest.update`,
 * changing nothing else; one Day0 cannot update waits on a person's toggle and the manager's word.
 * Slack is the in-memory double at the network seam.
 */

type Harness = TestConvex<typeof schema>;

const PUBLIC_URL = 'https://day0.example.test';

/** The team's Slack policy page: its manifest template and the methods the card may call. */
const POLICY = readFileSync(
  resolve(__dirname, '../fixtures/notion-pages/slack-day0-app.md'),
  'utf8',
);

let slack: SlackDouble;

beforeEach((): void => {
  vi.useFakeTimers();
  useSurfaceMode('real');
  vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('DAY0_PUBLIC_URL', PUBLIC_URL);
  slack = slackDouble();
  vi.stubGlobal('fetch', vi.fn(slack.fetch));
});

afterEach((): void => {
  restoreSurfaceMode();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function landSlack(harness: Harness): Promise<Id<'organisationConnections'>> {
  return await harness.action(internal.organisationConnections.landFromSetup, {
    system: 'slack',
    displayName: 'Slack',
    kind: 'slack-configuration',
    mode: 'per-employee',
    scopes: [...SLACK_KIT_BOT_SCOPES],
    redirectUrl: `${PUBLIC_URL}/api/oauth/slack`,
    secret: LANDED_CONFIGURATION_TOKEN,
    refreshToken: LANDED_REFRESH_TOKEN,
  });
}

/** An approved Slack card of one of the owner's employees, documented by the team's policy page. */
async function employee(harness: Harness, name: string): Promise<Id<'surfaces'>> {
  return await harness.run(async (ctx): Promise<Id<'surfaces'>> => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name,
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const sourceId = await ctx.db.insert('docSources', {
      userId: 'owner',
      label: `${name} handbook`,
      kind: 'folder',
      locator: '.',
      status: 'synced',
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert('docPages', {
      sourceId,
      ref: 'slack.md',
      title: 'Slack automation policy',
      markdown: POLICY,
      updatedAt: 1,
    });
    return await ctx.db.insert('surfaces', {
      agentId,
      slug: 'slack',
      displayName: 'Slack',
      class: 'chat',
      verdict: 'approved',
      whereFound: [
        { sourceId: String(sourceId), ref: 'slack.md', quote: 'Slack automation policy' },
      ],
      path: 'documented-api',
      endpoint: 'https://slack.com/api/',
      request: { credential: { found: 'none', method: 'oauth', label: 'Slack bot token' } },
      managerApprovedAt: 2,
      credentialLanded: false,
      createdAt: 1,
    });
  });
}

/** The manager's Connect, then the administrator's install click, then what that schedules. */
async function connect(
  harness: Harness,
  surfaceId: Id<'surfaces'>,
  configurationToken?: string,
): Promise<string> {
  const provisioned = await harness
    .withIdentity(managerIdentity())
    .action(api.slackProvisionActions.provisionApp, {
      surfaceId,
      ...(configurationToken === undefined ? {} : { configurationToken }),
    });
  const state = new URL(provisioned.installUrl).searchParams.get('state') ?? '';
  const app = slack.apps.find((candidate) => candidate.appId === provisioned.appId);
  await harness.action(internal.slackProvisionActions.completeInstallInternal, {
    state,
    code: app?.code ?? 'no-such-app',
  });
  vi.advanceTimersByTime(0);
  await harness.finishInProgressScheduledFunctions();
  return provisioned.appId;
}

/**
 * Make the card's app one an earlier release created: Slack holds the manifest without an App
 * Home, as Iris's export on the walk did, and the employee's record says nothing of messages.
 */
async function asCreatedBeforeThisRelease(
  harness: Harness,
  surfaceId: Id<'surfaces'>,
  appId: string,
): Promise<void> {
  const app = slack.apps.find((candidate) => candidate.appId === appId);
  if (!app) throw new Error('no such app in the double');
  const features = { ...(app.manifest.features as Record<string, unknown>) };
  delete features.app_home;
  app.manifest = { ...app.manifest, features };
  await harness.run(async (ctx): Promise<void> => {
    const surface = await ctx.db.get(surfaceId);
    if (surface === null) throw new Error('the card is gone');
    const events = await ctx.db
      .query('events')
      .withIndex('by_agent_type', (q) =>
        q.eq('agentId', surface.agentId).eq('type', 'surface.app-messages-open'),
      )
      .collect();
    await Promise.all(events.map(async (event) => await ctx.db.delete(event._id)));
    // Re-pinned for 13-FS: an earlier release's app has no field on its card either.
    await ctx.db.patch(surfaceId, {
      provisioning: { ...surface.provisioning!, messagesTab: undefined },
    });
  });
}

/** The card's own record of whether its app takes messages. */
async function messagesTabOf(harness: Harness, surfaceId: Id<'surfaces'>): Promise<unknown> {
  return (await harness.run(async (ctx) => await ctx.db.get(surfaceId)))?.provisioning?.messagesTab;
}

async function reach(harness: Harness, surfaceId: Id<'surfaces'>) {
  return await harness.run(async (ctx) => {
    const surface = await ctx.db.get(surfaceId);
    if (surface === null) throw new Error('the card is gone');
    return await typedCodeReachOf(ctx, surface);
  });
}

async function openEvents(
  harness: Harness,
  surfaceId: Id<'surfaces'>,
): Promise<Array<Doc<'events'>['payload']>> {
  return await harness.run(async (ctx) => {
    const surface = await ctx.db.get(surfaceId);
    if (surface === null) throw new Error('the card is gone');
    const events = await ctx.db
      .query('events')
      .withIndex('by_agent_type', (q) =>
        q.eq('agentId', surface.agentId).eq('type', 'surface.app-messages-open'),
      )
      .collect();
    return events.map((event) => event.payload);
  });
}

async function ledgerMethods(harness: Harness): Promise<Array<[string, string]>> {
  const rows = await harness.run(async (ctx) => await ctx.db.query('connectionEvents').collect());
  return rows
    .filter((row) => row.type === 'organisation.configuration-used')
    .map((row) => [String(row.payload.method), String(row.payload.outcome)]);
}

describe('an app the kit creates now', (): void => {
  it('takes messages from the start, so its probe asks Slack nothing more', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await landSlack(harness);
    const surfaceId = await employee(harness, 'Maya');
    const appId = await connect(harness, surfaceId);

    const app = slack.apps.find((candidate) => candidate.appId === appId);
    expect(manifestTakesMessages(app?.manifest)).toBe(true);
    expect(await openEvents(harness, surfaceId)).toEqual([
      { surfaceId, appId, appName: 'Maya (Day0)', how: 'created' },
    ]);
    expect(await reach(harness, surfaceId)).toEqual({ state: 'open' });
    expect(await messagesTabOf(harness, surfaceId)).toMatchObject({
      state: 'open',
      how: 'created',
    });
    expect(callsOf(slack, 'apps.manifest.export')).toEqual([]);
    expect(callsOf(slack, 'apps.manifest.update')).toEqual([]);
  });
});

describe('an app Day0 created before this release', (): void => {
  it('has its messages tab opened at its probe, nothing else changed, each call on the ledger', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await landSlack(harness);
    const surfaceId = await employee(harness, 'Iris');
    const appId = await connect(harness, surfaceId);
    await asCreatedBeforeThisRelease(harness, surfaceId, appId);
    const before = slack.apps.find((candidate) => candidate.appId === appId)?.manifest;
    expect(await reach(harness, surfaceId)).toEqual({
      state: 'day0-opens',
      appName: 'Iris (Day0)',
    });
    // The card reads the same.
    const agentId = (await harness.run(async (ctx) => await ctx.db.get(surfaceId)))!.agentId;
    const [listed] = await harness
      .withIdentity(managerIdentity())
      .query(api.surfaces.listForAgent, { agentId });
    expect(listed?.typedCode).toEqual({ state: 'day0-opens', appName: 'Iris (Day0)' });

    await harness.action(internal.surfaceActions.probeInternal, { surfaceId });

    const after = slack.apps.find((candidate) => candidate.appId === appId)?.manifest;
    expect(manifestTakesMessages(after)).toBe(true);
    expect({ ...after, features: undefined }).toEqual({ ...before, features: undefined });
    expect((after?.features as Record<string, unknown>).bot_user).toEqual(
      (before?.features as Record<string, unknown>).bot_user,
    );
    expect(callsOf(slack, 'apps.manifest.update').map((call) => call.form.app_id)).toEqual([appId]);
    expect(await openEvents(harness, surfaceId)).toEqual([
      { surfaceId, appId, appName: 'Iris (Day0)', how: 'opened' },
    ]);
    expect(await reach(harness, surfaceId)).toEqual({ state: 'open' });
    expect(await messagesTabOf(harness, surfaceId)).toMatchObject({ state: 'open', how: 'opened' });
    expect((await ledgerMethods(harness)).slice(-2)).toEqual([
      ['apps.manifest.export', 'done'],
      ['apps.manifest.update', 'done'],
    ]);

    // Once the record says it takes messages, the next probe reads nothing of the app.
    await harness.action(internal.surfaceActions.probeInternal, { surfaceId });
    expect(callsOf(slack, 'apps.manifest.export')).toHaveLength(1);
  });

  it('is recorded as found open when someone turned the tab on by hand, with no update', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await landSlack(harness);
    const surfaceId = await employee(harness, 'Iris');
    const appId = await connect(harness, surfaceId);
    await asCreatedBeforeThisRelease(harness, surfaceId, appId);
    const app = slack.apps.find((candidate) => candidate.appId === appId);
    if (!app) throw new Error('no app');
    app.manifest = {
      ...app.manifest,
      features: {
        ...(app.manifest.features as Record<string, unknown>),
        app_home: {
          home_tab_enabled: false,
          messages_tab_enabled: true,
          messages_tab_read_only_enabled: false,
        },
      },
    };

    const outcome = await harness.action(internal.slackMessagesTabActions.openMessagesTab, {
      surfaceId,
    });

    expect(outcome).toEqual({ kind: 'found-open' });
    expect(callsOf(slack, 'apps.manifest.update')).toEqual([]);
    expect(await openEvents(harness, surfaceId)).toEqual([
      { surfaceId, appId, appName: 'Iris (Day0)', how: 'found-open' },
    ]);
  });

  // Re-pinned for 13-FS (W12V-7's second pass): the refusal is recorded on the card with its
  // attempts, so the probe stops trying until a person asks.
  it('keeps its probe connected when Slack refuses the read, the refusal on the ledger and on the card', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await landSlack(harness);
    const surfaceId = await employee(harness, 'Iris');
    const appId = await connect(harness, surfaceId);
    await asCreatedBeforeThisRelease(harness, surfaceId, appId);
    slack.refusals.set('apps.manifest.export', 'not_allowed_token_type');

    const outcome = await harness.action(internal.surfaceActions.probeInternal, { surfaceId });

    expect(outcome).toMatchObject({ verdict: 'connected' });
    expect(callsOf(slack, 'apps.manifest.update')).toEqual([]);
    expect(await openEvents(harness, surfaceId)).toEqual([]);
    expect((await ledgerMethods(harness)).at(-1)).toEqual(['apps.manifest.export', 'failed']);
    expect(await messagesTabOf(harness, surfaceId)).toMatchObject({
      state: 'refused',
      reason: expect.stringContaining('not_allowed_token_type'),
      attempts: 1,
    });
    expect(await reach(harness, surfaceId)).toMatchObject({
      state: 'refused',
      appName: 'Iris (Day0)',
    });
  });

  it('records no refusal for a failure Slack may not repeat, so the next check asks again (13-FS second pass)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await landSlack(harness);
    const surfaceId = await employee(harness, 'Iris');
    const appId = await connect(harness, surfaceId);
    await asCreatedBeforeThisRelease(harness, surfaceId, appId);
    for (const transient of ['ratelimited', 'internal_error', 'service_unavailable']) {
      slack.refusals.set('apps.manifest.export', transient);
      await harness.action(internal.surfaceActions.probeInternal, { surfaceId, routine: true });
      expect(await messagesTabOf(harness, surfaceId), transient).toBeUndefined();
    }
    expect(callsOf(slack, 'apps.manifest.export')).toHaveLength(3);
    expect(await reach(harness, surfaceId)).toEqual({
      state: 'day0-opens',
      appName: 'Iris (Day0)',
    });
  });

  it('asks Slack again after a refusal only when a person presses Check the connection', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await landSlack(harness);
    const surfaceId = await employee(harness, 'Iris');
    const appId = await connect(harness, surfaceId);
    await asCreatedBeforeThisRelease(harness, surfaceId, appId);
    slack.refusals.set('apps.manifest.export', 'not_allowed_token_type');
    await harness.action(internal.surfaceActions.probeInternal, { surfaceId });
    expect(callsOf(slack, 'apps.manifest.export')).toHaveLength(1);

    // The hourly re-probe and every probe nobody asked for leave the refusal alone.
    await harness.action(internal.surfaceActions.probeInternal, { surfaceId, routine: true });
    await harness.action(internal.surfaceActions.probeInternal, { surfaceId });
    expect(callsOf(slack, 'apps.manifest.export')).toHaveLength(1);

    // Check the connection asks again, and counts a second refusal.
    const manager = harness.withIdentity(managerIdentity());
    await manager.action(api.surfaceActions.probe, { surfaceId });
    expect(callsOf(slack, 'apps.manifest.export')).toHaveLength(2);
    expect(await messagesTabOf(harness, surfaceId)).toMatchObject({
      state: 'refused',
      attempts: 2,
    });

    // Once Slack takes it, the card says the app takes messages.
    slack.refusals.delete('apps.manifest.export');
    await manager.action(api.surfaceActions.probe, { surfaceId });
    expect(await messagesTabOf(harness, surfaceId)).toMatchObject({ state: 'open', how: 'opened' });
    expect(await reach(harness, surfaceId)).toEqual({ state: 'open' });
  });

  it('waits on a person’s toggle once the connection that created it is revoked, and takes the manager’s word for it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    const surfaceId = await employee(harness, 'Otto');
    const appId = await connect(harness, surfaceId);
    await asCreatedBeforeThisRelease(harness, surfaceId, appId);
    await harness.mutation(internal.organisationConnections.revokeFromSetup, {
      organisationConnectionId: connectionId,
      reason: 'IT is moving workspaces',
    });
    expect(await reach(harness, surfaceId)).toEqual({
      state: 'needs-toggle',
      appName: 'Otto (Day0)',
    });
    expect(
      await harness.action(internal.slackMessagesTabActions.openMessagesTab, { surfaceId }),
    ).toEqual({ kind: 'not-needed' });
    expect(callsOf(slack, 'apps.manifest.export')).toEqual([]);

    await harness
      .withIdentity(managerIdentity())
      .mutation(api.slackMessagesTab.confirmMessagesTab, { surfaceId });

    expect(await reach(harness, surfaceId)).toEqual({ state: 'open' });
    expect(await openEvents(harness, surfaceId)).toEqual([
      { surfaceId, appId, appName: 'Otto (Day0)', how: 'confirmed' },
    ]);
    await expect(
      harness
        .withIdentity(managerIdentity())
        .mutation(api.slackMessagesTab.confirmMessagesTab, { surfaceId }),
    ).rejects.toThrow(CONFIRM_NOT_NEEDED);
  });
});
