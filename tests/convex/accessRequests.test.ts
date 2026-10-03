/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { ConvexError } from 'convex/values';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { NO_ACCESS_REQUEST } from '../../convex/accessRequests';
import { EMPLOYEE_NOT_YOURS } from '../../src/agent/employee-access';
import { ORGANISATION_HOLDER, ORGANISATION_OWNER_KEY } from '../../src/lib/organisation-key';
import { allConvexModules } from './all-modules';
import { managerIdentity } from './fakes/manager-identity';

const SAM = 'sam@acme.test';

beforeEach((): void => {
  vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
});

afterEach((): void => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** Maya, Sam's employee, with an approved Linear card that holds no credential. */
async function seedMaya(
  harness: TestConvex<typeof schema>,
  card: { readonly approved?: boolean } = {},
): Promise<{ agentId: Id<'agents'>; surfaceId: Id<'surfaces'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: SAM,
      name: 'Maya',
      userId: 'owner',
      state: 'active',
      zone: 'UTC',
      createdAt: 1,
    });
    const surfaceId = await ctx.db.insert('surfaces', {
      agentId,
      slug: 'linear',
      displayName: 'Linear',
      class: 'kanban',
      verdict: card.approved === false ? 'proposed' : 'approved',
      whereFound: [],
      path: 'documented-api',
      endpoint: 'https://api.linear.app/graphql',
      ...(card.approved === false ? {} : { managerApprovedAt: 2 }),
      expiresAt: Date.UTC(2026, 11, 31, 12),
      request: { scopeRequested: ['linear:read', 'linear:write'] },
      discoveryEvidence: [
        {
          kind: 'documentation',
          ref: 'onboarding.md',
          quote: 'Linear is the formal work queue',
          current: true,
          firstSeenAt: 1,
          lastSeenAt: 1,
        },
      ],
      credentialLanded: false,
      createdAt: 1,
    });
    return { agentId, surfaceId };
  });
}

/** Linear connected for the organisation, shared by every employee, from the setup verb. */
async function connectLinear(harness: TestConvex<typeof schema>): Promise<void> {
  await harness.action(internal.organisationConnections.landFromSetup, {
    system: 'linear',
    displayName: 'Linear',
    kind: 'oauth-app',
    mode: 'shared',
    scopes: ['read', 'write'],
    clientId: 'lin-client-1',
    secret: 'lin_oauth_secret_0123456789',
  });
}

/** The access request events on Maya's record. */
async function requestEvents(
  harness: TestConvex<typeof schema>,
  agentId: Id<'agents'>,
): Promise<Array<Record<string, unknown>>> {
  return await harness.run(async (ctx) =>
    (
      await ctx.db
        .query('events')
        .withIndex('by_agent_type', (index) =>
          index.eq('agentId', agentId).eq('type', 'surface.access-requested'),
        )
        .collect()
    ).map((event) => event.payload as Record<string, unknown>),
  );
}

describe('the access request a card shows (A24)', (): void => {
  it('asks IT when the card’s system has no organisation connection, and not once it is connected', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedMaya(harness);
    const owner = harness.withIdentity(managerIdentity());
    const view = await owner.query(api.accessRequests.forCard, { surfaceId });
    expect(view).toMatchObject({
      system: 'linear',
      reason: 'no-connection',
      scopes: ['linear:read', 'linear:write'],
      subject: 'Day0 access request: Linear for Maya',
    });
    expect(view?.text).toContain('Maya, a Day0 employee, needs access to Linear');
    expect(view?.text).toContain('“Linear is the formal work queue”');
    expect(view?.text).toContain('For how long: until 31 December 2026.');
    expect(view).not.toHaveProperty('draftedAt');
    await connectLinear(harness);
    await expect(owner.query(api.accessRequests.forCard, { surfaceId })).resolves.toBeNull();
  });

  it('asks IT to install a per-employee Linear card the setup verb landed, until an administrator records its app (join 2)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedMaya(harness);
    await harness.action(internal.organisationConnections.landFromSetup, {
      system: 'linear',
      displayName: 'Linear',
      kind: 'oauth-app',
      mode: 'per-employee',
      scopes: ['read', 'write', 'app:assignable'],
      redirectUrl: 'https://day0.acme.test/api/oauth/linear',
    });
    const owner = harness.withIdentity(managerIdentity());
    const view = await owner.query(api.accessRequests.forCard, { surfaceId });
    expect(view).toMatchObject({ system: 'linear', reason: 'install-needed' });
    expect(view?.text).toContain('Maya’s own app needs an administrator to install it.');
    // The setup verb already ran: the request names the card on the organisation page, where the
    // app is recorded (the wave 11 review's M4).
    expect(view?.text).not.toContain('./setup.sh');
    expect(view?.text).toContain(`/organisation?card=${surfaceId}`);

    // An administrator recorded Maya's app; its installation link has since lapsed.
    await harness.run(async (ctx) => {
      const secretId = await ctx.db.insert('credentials', {
        userId: ORGANISATION_OWNER_KEY,
        holder: ORGANISATION_HOLDER,
        kind: 'value',
        label: 'Day0 Maya client secret',
        ciphertext: 'sealed',
        iv: 'iv',
        source: 'entered',
        createdAt: 3,
      });
      await ctx.db.patch(surfaceId, {
        provisioning: {
          appId: 'maya-app',
          appName: 'Day0 Maya',
          clientId: 'maya-app',
          clientSecretCredentialId: secretId,
          installUrl: 'https://linear.app/oauth/authorize?client_id=maya-app',
          redirectUrl: 'https://day0.acme.test/api/oauth/linear',
          scopes: ['read', 'write', 'app:assignable'],
          createdAt: 3,
          stateExpiresAt: 4,
        },
      });
    });
    await expect(owner.query(api.accessRequests.forCard, { surfaceId })).resolves.toBeNull();
  });

  it('asks nothing for a card not yet approved, and refuses a manager who does not own it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedMaya(harness, { approved: false });
    await expect(
      harness.withIdentity(managerIdentity()).query(api.accessRequests.forCard, { surfaceId }),
    ).resolves.toBeNull();
    await expect(
      harness.withIdentity(managerIdentity('stranger')).query(api.accessRequests.forCard, {
        surfaceId,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof ConvexError && error.data === EMPLOYEE_NOT_YOURS,
    );
  });
});

describe('drafting and sending the access request', (): void => {
  it('records the draft and one record line in the words the card shows, once', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, surfaceId } = await seedMaya(harness);
    const owner = harness.withIdentity(managerIdentity());
    const shown = await owner.query(api.accessRequests.forCard, { surfaceId });
    const drafted = await owner.mutation(api.accessRequests.draft, { surfaceId, via: 'copied' });
    expect(drafted.text).toBe(shown?.text);
    expect(drafted.draftedAt).toEqual(expect.any(Number));
    await owner.mutation(api.accessRequests.draft, { surfaceId, via: 'copied' });
    const events = await requestEvents(harness, agentId);
    expect(events).toEqual([
      {
        surfaceId,
        system: 'linear',
        reason: 'no-connection',
        scopes: ['linear:read', 'linear:write'],
        text: shown?.text,
      },
    ]);
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface?.accessRequest).toEqual({
      reason: 'no-connection',
      scopes: ['linear:read', 'linear:write'],
      draftedAt: drafted.draftedAt,
    });
  });

  it('puts the same words in the export as on the card', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, surfaceId } = await seedMaya(harness);
    const owner = harness.withIdentity(managerIdentity());
    const drafted = await owner.mutation(api.accessRequests.draft, { surfaceId, via: 'copied' });
    const page = await owner.action(api.exportActions.exportPage, {
      agentId,
      section: 'events',
      cursor: null,
    });
    const exported = (page.rows as Array<{ type: string; payload: { text?: string } }>).find(
      (row) => row.type === 'surface.access-requested',
    );
    expect(exported?.payload.text).toBe(drafted.text);
  });

  it('records the request copied and emailed, and refuses before it is drafted', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedMaya(harness);
    const owner = harness.withIdentity(managerIdentity());
    await expect(
      owner.mutation(api.accessRequests.recordSent, { surfaceId, via: 'copied' }),
    ).rejects.toThrow(ConvexError);
    await owner.mutation(api.accessRequests.draft, { surfaceId, via: 'copied' });
    await owner.mutation(api.accessRequests.recordSent, { surfaceId, via: 'copied' });
    await owner.mutation(api.accessRequests.recordSent, { surfaceId, via: 'emailed' });
    const view = await owner.query(api.accessRequests.forCard, { surfaceId });
    expect(view).toMatchObject({ copiedAt: expect.any(Number), emailedAt: expect.any(Number) });
  });

  it('refuses to draft for a card that connects without IT, and schedules no DM in mock mode', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedMaya(harness);
    const owner = harness.withIdentity(managerIdentity());
    await owner.mutation(api.accessRequests.draft, { surfaceId, via: 'copied' });
    const jobs = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    expect(jobs).toEqual([]);
    await connectLinear(harness);
    await expect(
      owner.mutation(api.accessRequests.draft, { surfaceId, via: 'copied' }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof ConvexError && error.data === NO_ACCESS_REQUEST,
    );
  });
});

describe('a request after the system was connected and revoked again (11-AO review)', (): void => {
  it('is a new request: drafted again with its own record line, and no longer shown as sent', async (): Promise<void> => {
    // The clock moves on between the draft and the landing, as it does between two people's clicks.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 2, 9));
    const harness = convexTest(schema, allConvexModules());
    const { agentId, surfaceId } = await seedMaya(harness);
    const owner = harness.withIdentity(managerIdentity());
    await owner.mutation(api.accessRequests.draft, { surfaceId, via: 'copied' });
    await owner.mutation(api.accessRequests.recordSent, { surfaceId, via: 'copied' });
    vi.setSystemTime(Date.UTC(2026, 9, 2, 10));
    await connectLinear(harness);
    const connection = await harness.query(internal.organisationConnections.activeFor, {
      system: 'linear',
    });
    await harness.mutation(internal.organisationConnections.revokeFromSetup, {
      organisationConnectionId: connection!._id,
      reason: 'the app was removed',
    });
    const shown = await owner.query(api.accessRequests.forCard, { surfaceId });
    expect(shown).not.toHaveProperty('copiedAt');
    expect(shown).not.toHaveProperty('draftedAt');
    await owner.mutation(api.accessRequests.draft, { surfaceId, via: 'copied' });
    expect(await requestEvents(harness, agentId)).toHaveLength(2);
  });
});

describe('the card after a draft (11-AO re-review)', (): void => {
  it('shows the words the draft recorded, which the DM and the export carry, after the card changed', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedMaya(harness);
    const owner = harness.withIdentity(managerIdentity());
    const drafted = await owner.mutation(api.accessRequests.draft, { surfaceId, via: 'copied' });
    await harness.run(async (ctx) => {
      await ctx.db.patch(surfaceId, { expiresAt: Date.UTC(2027, 0, 31, 12) });
    });
    const shown = await owner.query(api.accessRequests.forCard, { surfaceId });
    expect(shown?.text).toBe(drafted.text);
    expect(shown?.mailto).toContain(encodeURIComponent(drafted.text));
  });
});
