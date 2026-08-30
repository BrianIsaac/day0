import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { parseManifestCreate, parseOauthAccess } from '../../convex/slackProvisionActions';
import { signOauthState } from '../../src/lib/oauth-state';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

const POLICY = readFileSync(
  resolve(__dirname, '../fixtures/notion-pages/slack-day0-app.md'),
  'utf8',
);

const PUBLIC_URL = 'https://day0.example.test';
const CONFIG_TOKEN = 'xoxe.xoxp-configuration-token-value';
const CLIENT_SECRET = 'client-secret-value';
const BOT_TOKEN = 'xoxb-dedicated-bot-token-value';

let credentialKey: string;

beforeEach((): void => {
  credentialKey = randomBytes(32).toString('base64');
  useSurfaceMode('real');
  vi.stubEnv('DAY0_CREDENTIAL_KEY', credentialKey);
  vi.stubEnv('DAY0_PUBLIC_URL', PUBLIC_URL);
});

afterEach((): void => {
  restoreSurfaceMode();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function slackResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface SeedOptions {
  approved?: boolean;
  className?: string;
  withSharedCredential?: boolean;
}

interface Seeded {
  agentId: Id<'agents'>;
  sharedCredentialId?: Id<'credentials'>;
  surfaceId: Id<'surfaces'>;
}

/**
 * Seed an owned, twice-approved Slack surface whose docs carry the manifest.
 *
 * Args:
 *   harness: Convex test harness.
 *   options: Whether the surface is approved, its class, and whether a shared
 *     bot token is already attached to it.
 *
 * Returns:
 *   The agent, surface and (optionally) shared credential ids.
 */
async function seedSlackSurface(
  harness: TestConvex<typeof schema>,
  options: SeedOptions = {},
): Promise<Seeded> {
  return await harness.run(async (ctx): Promise<Seeded> => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: 'ops worker',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const sourceId = await ctx.db.insert('docSources', {
      userId: 'owner',
      label: 'RevOps handbook',
      kind: 'folder',
      locator: '.',
      status: 'synced',
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert('docPages', {
      sourceId,
      ref: 'slack-day0-app.md',
      title: 'Slack automation policy',
      markdown: POLICY,
      updatedAt: 1,
    });
    let sharedCredentialId: Id<'credentials'> | undefined;
    if (options.withSharedCredential) {
      sharedCredentialId = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'value',
        label: 'Slack OAuth access',
        ciphertext: 'ciphertext',
        iv: 'iv',
        source: 'entered',
        createdAt: 1,
      });
    }
    const approved = options.approved ?? true;
    const surfaceId = await ctx.db.insert('surfaces', {
      agentId,
      slug: 'slack',
      displayName: 'Slack',
      class: options.className ?? 'chat',
      verdict: approved ? 'approved' : 'proposed',
      whereFound: [],
      path: 'documented-api',
      endpoint: 'https://slack.com/api/',
      request: { credential: { found: 'none', method: 'oauth', label: 'Slack bot token' } },
      ...(approved ? { managerApprovedAt: 2, itApprovedAt: 3 } : {}),
      ...(sharedCredentialId
        ? { credentialId: sharedCredentialId, credentialKind: 'value' as const }
        : {}),
      credentialLanded: false,
      createdAt: 1,
    });
    return { agentId, sharedCredentialId, surfaceId };
  });
}

describe('reading what the provider returned', (): void => {
  it('takes the app id and both client credentials from a manifest create', (): void => {
    expect(
      parseManifestCreate({
        ok: true,
        app_id: 'A123',
        credentials: { client_id: '1.2', client_secret: 'sec', verification_token: 'v' },
      }),
    ).toEqual({ appId: 'A123', clientId: '1.2', clientSecret: 'sec' });
  });

  it('refuses a create that returned no client secret to exchange with', (): void => {
    expect(() =>
      parseManifestCreate({ ok: true, app_id: 'A123', credentials: { client_id: '1.2' } }),
    ).toThrow('returned no app credentials');
  });

  it('takes the bot token, bot user and workspace from an access exchange', (): void => {
    expect(
      parseOauthAccess({
        ok: true,
        access_token: BOT_TOKEN,
        bot_user_id: 'UBOT',
        team: { id: 'TWORK' },
      }),
    ).toEqual({ botToken: BOT_TOKEN, botUserId: 'UBOT', teamId: 'TWORK' });
  });

  it('refuses an exchange that returned no bot token', (): void => {
    expect(() => parseOauthAccess({ ok: true, access_token: '' })).toThrow('returned no bot token');
  });
});

describe('registering a dedicated app', (): void => {
  it('sends the documented manifest and files an install link', async (): Promise<void> => {
    const calls: Array<{ body: string; url: string; authorization?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({
          url: String(input),
          body: String(init?.body ?? ''),
          authorization: headers.Authorization,
        });
        return slackResponse({
          ok: true,
          app_id: 'A123',
          credentials: { client_id: '111.222', client_secret: CLIENT_SECRET },
        });
      }),
    );
    const { api: liveApi } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedSlackSurface(harness);

    const outcome = await harness
      .withIdentity({ subject: 'owner' })
      .action(liveApi.slackProvisionActions.provisionApp, {
        surfaceId,
        configurationToken: CONFIG_TOKEN,
      });

    expect(outcome.appId).toBe('A123');
    expect(outcome.appName).toBe('ops worker (Day0)');
    const install = new URL(outcome.installUrl);
    expect(install.origin + install.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(install.searchParams.get('client_id')).toBe('111.222');
    expect(install.searchParams.get('redirect_uri')).toBe(`${PUBLIC_URL}/api/oauth/slack`);
    expect(install.searchParams.get('scope')?.split(',')).toHaveLength(8);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://slack.com/api/apps.manifest.create');
    expect(calls[0].authorization).toBe(`Bearer ${CONFIG_TOKEN}`);
    const manifest = JSON.parse(new URLSearchParams(calls[0].body).get('manifest') ?? '{}');
    expect(manifest.display_information.name).toBe('ops worker (Day0)');
    expect(manifest.oauth_config.redirect_urls).toEqual([`${PUBLIC_URL}/api/oauth/slack`]);

    const stored = await harness.run(async (ctx) => ({
      credentials: await ctx.db.query('credentials').collect(),
      events: await ctx.db.query('events').collect(),
      surface: await ctx.db.get(surfaceId),
    }));
    const configuration = stored.credentials.find((row) => row.label.startsWith('Slack app conf'));
    expect(configuration?.revokedAt).toBeGreaterThan(0);
    const secret = stored.credentials.find((row) => row.label.endsWith('client secret'));
    expect(secret).toMatchObject({ kind: 'oauth', source: 'oauth', appId: 'A123' });
    expect(stored.surface?.provisioning).toMatchObject({
      appId: 'A123',
      appName: 'ops worker (Day0)',
      clientId: '111.222',
      redirectUrl: `${PUBLIC_URL}/api/oauth/slack`,
    });
    expect(stored.surface?.provisioning?.stateNonce).toBeTruthy();
    expect(stored.events.map((event) => event.type)).toContain('surface.app-provisioned');
    expect(JSON.stringify(stored.surface)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(stored.surface)).not.toContain(CONFIG_TOKEN);
  });

  it('revokes the configuration token even when the provider refuses', async (): Promise<void> => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => slackResponse({ ok: false, error: 'invalid_auth' })),
    );
    const { api: liveApi } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedSlackSurface(harness);

    await expect(
      harness.withIdentity({ subject: 'owner' }).action(liveApi.slackProvisionActions.provisionApp, {
        surfaceId,
        configurationToken: CONFIG_TOKEN,
      }),
    ).rejects.toThrow('invalid_auth');

    const credentials = await harness.run(async (ctx) => await ctx.db.query('credentials').collect());
    expect(credentials).toHaveLength(1);
    expect(credentials[0].revokedAt).toBeGreaterThan(0);
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface?.provisioning).toBeUndefined();
  });

  it('refuses a surface that has not been approved twice', async (): Promise<void> => {
    vi.stubGlobal('fetch', vi.fn());
    const { api: liveApi } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedSlackSurface(harness, { approved: false });
    await expect(
      harness.withIdentity({ subject: 'owner' }).action(liveApi.slackProvisionActions.provisionApp, {
        surfaceId,
        configurationToken: CONFIG_TOKEN,
      }),
    ).rejects.toThrow('needs both approvals');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refuses to replace an already-connected dedicated identity', async (): Promise<void> => {
    vi.stubGlobal('fetch', vi.fn());
    const { api: liveApi } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedSlackSurface(harness);
    await harness.run(async (ctx): Promise<void> => {
      const credentialId = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'oauth',
        label: 'Slack dedicated bot token',
        ciphertext: 'ciphertext',
        iv: 'iv',
        source: 'oauth',
        createdAt: 4,
      });
      await ctx.db.patch(surfaceId, {
        credentialId,
        credentialKind: 'oauth',
        credentialLanded: true,
        verdict: 'connected',
      });
    });

    await expect(
      harness.withIdentity({ subject: 'owner' }).action(liveApi.slackProvisionActions.provisionApp, {
        surfaceId,
        configurationToken: CONFIG_TOKEN,
      }),
    ).rejects.toThrow('already has a connected dedicated identity');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refuses a caller who does not own the agent', async (): Promise<void> => {
    vi.stubGlobal('fetch', vi.fn());
    const { api: liveApi } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedSlackSurface(harness);
    await expect(
      harness
        .withIdentity({ subject: 'intruder' })
        .action(liveApi.slackProvisionActions.provisionApp, {
          surfaceId,
          configurationToken: CONFIG_TOKEN,
        }),
    ).rejects.toThrow();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refuses when the deployment has no address the install could return to', async (): Promise<void> => {
    vi.stubEnv('DAY0_PUBLIC_URL', '');
    vi.stubGlobal('fetch', vi.fn());
    const { api: liveApi } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedSlackSurface(harness);
    await expect(
      harness.withIdentity({ subject: 'owner' }).action(liveApi.slackProvisionActions.provisionApp, {
        surfaceId,
        configurationToken: CONFIG_TOKEN,
      }),
    ).rejects.toThrow('DAY0_PUBLIC_URL');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refuses when the documentation carries no manifest template', async (): Promise<void> => {
    vi.stubGlobal('fetch', vi.fn());
    const { api: liveApi } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedSlackSurface(harness);
    await harness.run(async (ctx): Promise<void> => {
      const page = await ctx.db.query('docPages').first();
      if (page) await ctx.db.patch(page._id, { markdown: '# Slack automation policy\n\nNo template.' });
    });
    await expect(
      harness.withIdentity({ subject: 'owner' }).action(liveApi.slackProvisionActions.provisionApp, {
        surfaceId,
        configurationToken: CONFIG_TOKEN,
      }),
    ).rejects.toThrow('no app manifest template');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('completing the install', (): void => {
  /** Register an app and return the state its install link carries. */
  async function provision(
    harness: TestConvex<typeof schema>,
    surfaceId: Id<'surfaces'>,
  ): Promise<string> {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (): Promise<Response> =>
          slackResponse({
            ok: true,
            app_id: 'A123',
            credentials: { client_id: '111.222', client_secret: CLIENT_SECRET },
          }),
      ),
    );
    const { api: liveApi } = await import('../../convex/_generated/api');
    const outcome = await harness
      .withIdentity({ subject: 'owner' })
      .action(liveApi.slackProvisionActions.provisionApp, {
        surfaceId,
        configurationToken: CONFIG_TOKEN,
      });
    return new URL(outcome.installUrl).searchParams.get('state') ?? '';
  }

  it('exchanges the code, attaches the dedicated identity and retires the shared token', async (): Promise<void> => {
    const { internal: liveInternal } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const { sharedCredentialId, surfaceId } = await seedSlackSurface(harness, {
      withSharedCredential: true,
    });
    const state = await provision(harness, surfaceId);

    const exchange: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
        exchange.push(String(init?.body ?? ''));
        return slackResponse({
          ok: true,
          access_token: BOT_TOKEN,
          bot_user_id: 'UNEWBOT',
          team: { id: 'TWORK' },
        });
      }),
    );

    await expect(
      harness.action(liveInternal.slackProvisionActions.completeInstallInternal, {
        state,
        code: 'the-code',
      }),
    ).resolves.toMatchObject({ ok: true, surfaceSlug: 'slack' });

    const sent = new URLSearchParams(exchange[0]);
    expect(sent.get('client_id')).toBe('111.222');
    expect(sent.get('client_secret')).toBe(CLIENT_SECRET);
    expect(sent.get('code')).toBe('the-code');
    expect(sent.get('redirect_uri')).toBe(`${PUBLIC_URL}/api/oauth/slack`);

    const after = await harness.run(async (ctx) => ({
      credentials: await ctx.db.query('credentials').collect(),
      events: await ctx.db.query('events').collect(),
      shared: sharedCredentialId ? await ctx.db.get(sharedCredentialId) : null,
      surface: await ctx.db.get(surfaceId),
    }));
    expect(after.surface?.credentialKind).toBe('oauth');
    expect(after.surface?.credentialId).not.toBe(sharedCredentialId);
    expect(after.surface?.provisioning?.installedAt).toBeGreaterThan(0);
    expect(after.surface?.provisioning?.stateNonce).toBeUndefined();
    expect(after.shared?.revokedAt).toBeGreaterThan(0);
    const bot = after.credentials.find((row) => row._id === after.surface?.credentialId);
    expect(bot).toMatchObject({ kind: 'oauth', source: 'oauth', appId: 'A123' });
    expect(after.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['surface.shared-credential-retired', 'surface.app-installed']),
    );
    expect(JSON.stringify(after.surface)).not.toContain(BOT_TOKEN);
  });

  it('refuses a state this deployment never signed, without calling the provider', async (): Promise<void> => {
    const { internal: liveInternal } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedSlackSurface(harness);
    await provision(harness, surfaceId);
    vi.stubGlobal('fetch', vi.fn());

    const forged = signOauthState(
      { expiresAt: Date.now() + 60_000, nonce: 'made-up', surfaceId: String(surfaceId) },
      randomBytes(32).toString('base64'),
    );
    await expect(
      harness.action(liveInternal.slackProvisionActions.completeInstallInternal, {
        state: forged,
        code: 'the-code',
      }),
    ).resolves.toEqual({ ok: false, reason: 'That install link is not one this deployment issued.' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refuses an expired link, without calling the provider', async (): Promise<void> => {
    const { internal: liveInternal } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedSlackSurface(harness);
    await provision(harness, surfaceId);
    vi.stubGlobal('fetch', vi.fn());

    const expired = signOauthState(
      { expiresAt: Date.now() - 1, nonce: 'made-up', surfaceId: String(surfaceId) },
      credentialKey,
    );
    await expect(
      harness.action(liveInternal.slackProvisionActions.completeInstallInternal, {
        state: expired,
        code: 'the-code',
      }),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('has expired') });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('spends the link exactly once, so a replay exchanges nothing', async (): Promise<void> => {
    const { internal: liveInternal } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedSlackSurface(harness);
    const state = await provision(harness, surfaceId);

    const exchanges = vi.fn(
      async (): Promise<Response> => slackResponse({ ok: true, access_token: BOT_TOKEN }),
    );
    vi.stubGlobal('fetch', exchanges);
    await expect(
      harness.action(liveInternal.slackProvisionActions.completeInstallInternal, {
        state,
        code: 'the-code',
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      harness.action(liveInternal.slackProvisionActions.completeInstallInternal, {
        state,
        code: 'the-code',
      }),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('already been used') });
    expect(exchanges).toHaveBeenCalledTimes(1);
  });

  it('records a failed exchange on the card and attaches nothing', async (): Promise<void> => {
    const { internal: liveInternal } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const { sharedCredentialId, surfaceId } = await seedSlackSurface(harness, {
      withSharedCredential: true,
    });
    const state = await provision(harness, surfaceId);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => slackResponse({ ok: false, error: 'invalid_code' })),
    );
    await expect(
      harness.action(liveInternal.slackProvisionActions.completeInstallInternal, {
        state,
        code: 'stale-code',
      }),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('invalid_code') });

    const after = await harness.run(async (ctx) => ({
      events: await ctx.db.query('events').collect(),
      shared: sharedCredentialId ? await ctx.db.get(sharedCredentialId) : null,
      surface: await ctx.db.get(surfaceId),
    }));
    expect(after.surface?.credentialId).toBe(sharedCredentialId);
    expect(after.surface?.credentialKind).toBe('value');
    expect(after.shared?.revokedAt).toBeUndefined();
    expect(after.surface?.provisioning?.installedAt).toBeUndefined();
    expect(after.surface?.provisioning?.lastError).toContain('invalid_code');
    expect(after.events.map((event) => event.type)).toContain('surface.install-failed');
  });

  it('refuses a redirect that carries no code at all', async (): Promise<void> => {
    const { internal: liveInternal } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedSlackSurface(harness);
    const state = await provision(harness, surfaceId);
    vi.stubGlobal('fetch', vi.fn());
    await expect(
      harness.action(liveInternal.slackProvisionActions.completeInstallInternal, {
        state,
        code: '  ',
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'Slack returned no authorisation code.' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface?.provisioning?.stateNonce).toBeTruthy();
  });
});
