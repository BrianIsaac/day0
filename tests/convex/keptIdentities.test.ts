/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import type schemaModule from '../../convex/schema';
import { HANDOVER_REAPPROVE_REASON } from '../../convex/surfaces';
import { KEPT_IDENTITY_WAIT_MS } from '../../src/agent/manager-transfer';
import { ORGANISATION_HOLDER, ORGANISATION_OWNER_KEY } from '../../src/lib/organisation-key';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { MANAGER_ADDRESS } from './fakes/manager-identity';

/*
 * The identity a handover kept for the new manager's re-approval (A25) ends when that manager has
 * not approved the card again within the wait (the wave 11 review's m8): until then its scheduled
 * refresh keeps it current, so the re-approval stays one click; after it, what Day0 obtained is
 * revoked at the vendor and the card waits like a cut one.
 */

type Schema = typeof schemaModule;

/** When the handover's move sent the card back to `proposed`. */
const MOVED_AT = Date.UTC(2026, 9, 3, 9, 0);

const SEALED = { ciphertext: 'sealed', iv: 'iv', keyId: 'key' };

const ISSUED_BY = {
  system: 'mcp:auth.acme.test',
  grant: 'authorisation-code' as const,
  clientId: 'day0-mcp',
};

beforeEach((): void => {
  useSurfaceMode('real');
  vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
});

afterEach((): void => {
  restoreSurfaceMode();
  vi.unstubAllEnvs();
});

/** A real-mode harness, its modules loaded after the mode is set. */
async function realHarness(): Promise<TestConvex<Schema>> {
  const [{ default: schema }, { allConvexModules }] = await Promise.all([
    import('../../convex/schema'),
    import('./all-modules'),
  ]);
  return convexTest(schema, allConvexModules());
}

async function liveApi(): Promise<typeof import('../../convex/_generated/api')> {
  return await import('../../convex/_generated/api');
}

interface Seeded {
  readonly surfaceId: Id<'surfaces'>;
  readonly accessId: Id<'credentials'>;
  readonly refreshId: Id<'credentials'>;
}

/**
 * An employee handed over at {@link MOVED_AT}, its MCP card back at `proposed` with the identity
 * Day0 obtained kept (organisation-held, as the issuers store it), and the move's event.
 */
async function seedKept(
  harness: TestConvex<Schema>,
  card: { readonly heldKey?: 'issued' | 'pasted'; readonly reason?: string } = {},
): Promise<Seeded> {
  return await harness.run(async (ctx): Promise<Seeded> => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Leo',
      userId: 'new-owner',
      state: 'active',
      createdAt: 1,
    });
    const issued = (card.heldKey ?? 'issued') === 'issued';
    const refreshId = await ctx.db.insert('credentials', {
      userId: ORGANISATION_OWNER_KEY,
      holder: ORGANISATION_HOLDER,
      kind: 'oauth',
      label: 'Acme docs refresh token',
      ...SEALED,
      source: 'oauth',
      createdAt: 1,
      issuedBy: ISSUED_BY,
    });
    const accessId = issued
      ? await ctx.db.insert('credentials', {
          userId: ORGANISATION_OWNER_KEY,
          holder: ORGANISATION_HOLDER,
          kind: 'oauth',
          label: 'Acme docs access token',
          ...SEALED,
          source: 'oauth',
          createdAt: 1,
          issuedBy: ISSUED_BY,
          refreshCredentialId: refreshId,
          generation: 2,
          expiresAt: MOVED_AT + 60 * 60 * 1000,
        })
      : await ctx.db.insert('credentials', {
          userId: 'new-owner',
          kind: 'value',
          label: 'Docs key someone pasted',
          ...SEALED,
          source: 'entered',
          createdAt: 1,
        });
    const surfaceId = await ctx.db.insert('surfaces', {
      agentId,
      slug: 'docs',
      displayName: 'Acme docs',
      class: 'docs',
      verdict: 'proposed',
      whereFound: [],
      path: 'mcp',
      endpoint: 'https://auth.acme.test/mcp',
      credentialLanded: false,
      // The handover's re-approval says why the card is back at proposed (A25).
      reason: card.reason ?? HANDOVER_REAPPROVE_REASON,
      credentialId: accessId,
      credentialKind: issued ? 'oauth' : 'value',
      ...(issued ? { actsAs: { kind: 'delegated' as const, label: MANAGER_ADDRESS } } : {}),
      createdAt: 1,
    });
    await ctx.db.insert('events', {
      agentId,
      type: 'surface.proposed',
      payload: { surfaceId },
      createdAt: MOVED_AT,
    });
    return { surfaceId, accessId, refreshId };
  });
}

/** Every page of the sweep at one instant, as the hourly sweep pages through them. */
async function sweep(harness: TestConvex<Schema>, now: number): Promise<number> {
  const { internal } = await liveApi();
  let ended = 0;
  let cursor: string | null = null;
  for (;;) {
    const page: { ended: number; continueCursor: string; isDone: boolean } = await harness.mutation(
      internal.keptIdentities.endUnapproved,
      { now, cursor },
    );
    ended += page.ended;
    if (page.isDone) return ended;
    cursor = page.continueCursor;
  }
}

async function rows(
  harness: TestConvex<Schema>,
  seeded: Seeded,
): Promise<{
  surface: Doc<'surfaces'> | null;
  access: Doc<'credentials'> | null;
  refresh: Doc<'credentials'> | null;
}> {
  return await harness.run(async (ctx) => ({
    surface: await ctx.db.get(seeded.surfaceId),
    access: await ctx.db.get(seeded.accessId),
    refresh: await ctx.db.get(seeded.refreshId),
  }));
}

describe('a kept identity its new manager has not approved again (the review’s m8)', (): void => {
  it('stays, renewed, while the card waits within the wait', async (): Promise<void> => {
    const harness = await realHarness();
    const seeded = await seedKept(harness);

    expect(await sweep(harness, MOVED_AT + KEPT_IDENTITY_WAIT_MS - 1)).toBe(0);

    const { surface, access } = await rows(harness, seeded);
    expect(surface?.credentialId).toBe(seeded.accessId);
    expect(access?.revokedAt).toBeUndefined();
  });

  it('is ended at the vendor once the wait has passed, and the card waits like a cut one', async (): Promise<void> => {
    const harness = await realHarness();
    const seeded = await seedKept(harness);
    const now = MOVED_AT + KEPT_IDENTITY_WAIT_MS;

    expect(await sweep(harness, now)).toBe(1);

    const { surface, access, refresh } = await rows(harness, seeded);
    expect(surface).toMatchObject({ verdict: 'proposed', credentialLanded: false });
    expect(surface?.credentialId).toBeUndefined();
    expect(surface?.actsAs).toBeUndefined();
    expect(surface?.reason).toBe(
      'Handed over and not approved again within 14 days, so the identity it kept was ended: approve this connection, then connect it again.',
    );
    for (const row of [access, refresh]) {
      expect(row).toMatchObject({
        revokedAt: now,
        sourceRevocation: { state: 'pending', end: 'transfer' },
      });
    }
  });

  it('leaves a proposed card holding a key Day0 did not obtain alone', async (): Promise<void> => {
    const harness = await realHarness();
    const seeded = await seedKept(harness, { heldKey: 'pasted' });

    expect(await sweep(harness, MOVED_AT + KEPT_IDENTITY_WAIT_MS * 2)).toBe(0);

    const { surface, access } = await rows(harness, seeded);
    expect(surface?.credentialId).toBe(seeded.accessId);
    expect(access?.revokedAt).toBeUndefined();
  });

  it("leaves a card a changed intake queue sent back to proposed, whose identity no handover kept (the code pass's B1)", async (): Promise<void> => {
    const harness = await realHarness();
    const seeded = await seedKept(harness, {
      reason:
        'A documented intake queue changed. Reject this card and re-run orientation before approval.',
    });

    expect(await sweep(harness, MOVED_AT + KEPT_IDENTITY_WAIT_MS * 2)).toBe(0);

    const { surface, access } = await rows(harness, seeded);
    expect(surface?.credentialId).toBe(seeded.accessId);
    expect(access?.revokedAt).toBeUndefined();
  });

  it('is ended by the hourly sweep, which pages through every proposed card', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(MOVED_AT + KEPT_IDENTITY_WAIT_MS + 1);
    try {
      const harness = await realHarness();
      const seeded = await seedKept(harness);
      const { internal } = await liveApi();

      const swept = await harness.action(internal.surfaceActions.reprobeAll, {});

      expect(swept).toMatchObject({ keptEnded: 1 });
      expect((await rows(harness, seeded)).surface?.credentialId).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
