import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convexTest } from 'convex-test';
import { api } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { managerIdentity } from './fakes/manager-identity';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

// The mode is set here, never read from the shell that runs the suite (P11-1).
beforeEach((): void => {
  useSurfaceMode('mock');
});

afterEach((): void => {
  restoreSurfaceMode();
});

describe('public surface configuration', (): void => {
  afterEach((): void => {
    vi.unstubAllEnvs();
  });

  it('returns only the mock mode, its public label, the deployment profile and whether scheduled work is paused', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules()).withIdentity(managerIdentity());
    vi.stubEnv('DAY0_PROFILE', '');
    vi.stubEnv('DAY0_CRONS_PAUSED', '');
    await expect(harness.query(api.config.surfaceMode, {})).resolves.toEqual({
      mode: 'mock',
      label: 'mock',
      deploymentProfile: 'local-dev',
      scheduledWorkPaused: false,
    });
  });

  it("says the deployment's scheduled work is paused, without the operator's reason", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules()).withIdentity(managerIdentity());
    vi.stubEnv('DAY0_CRONS_PAUSED', 'upgrade to 0.16.0');
    const answer = await harness.query(api.config.surfaceMode, {});
    expect(answer.scheduledWorkPaused).toBe(true);
    expect(JSON.stringify(answer)).not.toContain('upgrade');
  });

  it('names the customer-local profile, so People can say which installation it is', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules()).withIdentity(managerIdentity());
    vi.stubEnv('DAY0_PROFILE', 'customer-local');
    await expect(harness.query(api.config.surfaceMode, {})).resolves.toMatchObject({
      deploymentProfile: 'customer-local',
    });
  });
});

describe('optional components', (): void => {
  afterEach((): void => {
    vi.unstubAllEnvs();
  });

  it('reports no browser component when no driver address is configured', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules()).withIdentity(managerIdentity());
    vi.stubEnv('DAY0_BROWSER_MCP_URL', '');
    await expect(harness.query(api.config.components, {})).resolves.toEqual({ browser: false });
  });

  it('reports the browser component once an address is configured', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules()).withIdentity(managerIdentity());
    vi.stubEnv('DAY0_BROWSER_MCP_URL', 'http://playwright-mcp:8931/mcp');
    await expect(harness.query(api.config.components, {})).resolves.toEqual({ browser: true });
  });

  it('never returns a component address to a page', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules()).withIdentity(managerIdentity());
    vi.stubEnv('DAY0_BROWSER_MCP_URL', 'http://playwright-mcp:8931/mcp');
    const status = await harness.query(api.config.components, {});
    expect(JSON.stringify(status)).not.toContain('playwright-mcp');
  });

  it('reads a malformed address as no component rather than throwing at the page', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules()).withIdentity(managerIdentity());
    vi.stubEnv('DAY0_BROWSER_MCP_URL', 'playwright-mcp:8931');
    await expect(harness.query(api.config.components, {})).resolves.toEqual({ browser: false });
  });
});

describe('model settings', (): void => {
  afterEach((): void => {
    vi.unstubAllEnvs();
  });

  it('reports the deployment model name and nothing else about the provider', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules()).withIdentity(managerIdentity());
    vi.stubEnv('OPENAI_MODEL', '');
    await expect(harness.query(api.config.modelSettings, {})).resolves.toEqual({
      model: 'gpt-5.6-terra',
      skillSandboxBackend: 'local',
      evaluationBed: null,
    });
    vi.stubEnv('OPENAI_MODEL', 'qwen3:8b');
    vi.stubEnv('OPENAI_API_KEY', 'sk-should-never-be-returned');
    const settings = await harness.query(api.config.modelSettings, {});
    expect(settings).toEqual({
      model: 'qwen3:8b',
      skillSandboxBackend: 'local',
      evaluationBed: null,
    });
    expect(JSON.stringify(settings)).not.toContain('sk-');
  });

  it('reports when the deployment would select Daytona without exposing its key', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules()).withIdentity(managerIdentity());
    vi.stubEnv('DAYTONA_API_KEY', 'daytona-secret');
    const settings = await harness.query(api.config.modelSettings, {});
    expect(settings).toEqual({
      model: 'gpt-5.6-terra',
      skillSandboxBackend: 'daytona',
      evaluationBed: null,
    });
    expect(JSON.stringify(settings)).not.toContain('daytona-secret');
  });

  it('names the evaluation bed the deployment is, so a harness can refuse before it spends anything', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules()).withIdentity(managerIdentity());
    vi.stubEnv('DAY0_EVALUATION_BED', 'comparison');
    expect((await harness.query(api.config.modelSettings, {})).evaluationBed).toBe('comparison');
  });
});

describe('the configuration a signed-in page reads (the anonymous-caller guard, 12-G)', (): void => {
  it('refuses a caller with no identity on every configuration query but the release', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { notAuthenticatedMessage } = await import('../../convex/devAuth');
    const refusal = { data: notAuthenticatedMessage() };
    await expect(harness.query(api.config.surfaceMode, {})).rejects.toMatchObject(refusal);
    await expect(harness.query(api.config.modelSettings, {})).rejects.toMatchObject(refusal);
    await expect(harness.query(api.config.components, {})).rejects.toMatchObject(refusal);
    await expect(harness.query(api.config.release, {})).resolves.toBeNull();
  });
});

describe('the release the deployment is stamped at', (): void => {
  it('is null on a deployment that was never stamped', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await expect(harness.query(api.config.release, {})).resolves.toBeNull();
  });

  it('is the newest release, since its first stamp, without its commit', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await harness.run(async (ctx) => {
      await ctx.db.insert('deploymentVersions', {
        release: '0.7.0',
        commit: 'aaaaaaa',
        recordedAt: 1,
      });
      await ctx.db.insert('deploymentVersions', {
        release: '0.8.0',
        commit: 'ea9ced8f014c',
        recordedAt: 2,
      });
      // The same release pushed again from a later commit.
      await ctx.db.insert('deploymentVersions', {
        release: '0.8.0',
        commit: 'b416a660aaaa',
        recordedAt: 3,
      });
    });
    await expect(harness.query(api.config.release, {})).resolves.toEqual({
      release: '0.8.0',
      since: 2,
    });
  });
});

describe('config.whoAmI, the live sign-in check', (): void => {
  const CUSTOMER = 'https://issuer.acme.test';

  afterEach((): void => {
    vi.unstubAllEnvs();
  });

  it('refuses a request with no token, as every guarded function does', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { notAuthenticatedMessage } = await import('../../convex/devAuth');
    await expect(harness.query(api.config.whoAmI, {})).rejects.toMatchObject({
      data: notAuthenticatedMessage(),
    });
  });

  it('tells a caller its own owner key, issuer, subject and verified address, and nothing else', async (): Promise<void> => {
    vi.stubEnv('DAY0_OIDC_ISSUER', CUSTOMER);
    vi.stubEnv('DAY0_OIDC_AUDIENCE', 'day0-app');
    vi.stubEnv('DAY0_OIDC_ALLOWED_DOMAINS', 'acme.test');
    const harness = convexTest(schema, allConvexModules());
    const priya = harness.withIdentity(
      managerIdentity('fake-oidc|priya', { issuer: CUSTOMER, email: 'Priya@Acme.test' }),
    );
    await expect(priya.query(api.config.whoAmI, {})).resolves.toEqual({
      ownerKey: `${CUSTOMER}|fake-oidc|priya`,
      issuer: CUSTOMER,
      subject: 'fake-oidc|priya',
      verifiedAddress: 'priya@acme.test',
    });
  });

  it('answers a caller the domain rule refuses with the refusal, as every guarded function refuses them', async (): Promise<void> => {
    vi.stubEnv('DAY0_OIDC_ISSUER', CUSTOMER);
    vi.stubEnv('DAY0_OIDC_AUDIENCE', 'day0-app');
    vi.stubEnv('DAY0_OIDC_ALLOWED_DOMAINS', 'acme.test');
    const harness = convexTest(schema, allConvexModules());
    const eve = harness.withIdentity(
      managerIdentity('fake-oidc|eve', { issuer: CUSTOMER, email: 'eve@rival.test' }),
    );
    await expect(eve.query(api.config.whoAmI, {})).resolves.toEqual({ refused: 'outside-domains' });
  });

  it('says when the address is not verified, under an issuer that controls its addresses', async (): Promise<void> => {
    const okta = 'https://acme.okta.com';
    vi.stubEnv('DAY0_OIDC_ISSUER', okta);
    vi.stubEnv('DAY0_OIDC_AUDIENCE', 'day0-app');
    vi.stubEnv('DAY0_OIDC_ALLOWED_DOMAINS', 'acme.test');
    const harness = convexTest(schema, allConvexModules());
    const nora = harness.withIdentity(
      managerIdentity('nora', { issuer: okta, email: 'nora@acme.test', emailVerified: undefined }),
    );
    await expect(nora.query(api.config.whoAmI, {})).resolves.toMatchObject({
      verifiedAddress: null,
    });
  });

  it('answers a generic issuer’s unverified caller with that refusal, refused as every guarded function refuses it (decision 7 (b))', async (): Promise<void> => {
    vi.stubEnv('DAY0_OIDC_ISSUER', CUSTOMER);
    vi.stubEnv('DAY0_OIDC_AUDIENCE', 'day0-app');
    vi.stubEnv('DAY0_OIDC_ALLOWED_DOMAINS', 'acme.test');
    const harness = convexTest(schema, allConvexModules());
    const nora = harness.withIdentity(
      managerIdentity('fake-oidc|nora', {
        issuer: CUSTOMER,
        email: 'nora@acme.test',
        emailVerified: undefined,
      }),
    );
    await expect(nora.query(api.config.whoAmI, {})).resolves.toEqual({
      refused: 'unverified-address',
    });
  });
});
