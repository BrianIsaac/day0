/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import * as credentialsModule from '../../convex/credentials';
import { allConvexModules } from './all-modules';

const SECRET = ['ntn', 'contract-value-0123456789abcdef'].join('_');
const ROTATED = ['ntn', 'rotated-value-0123456789abcdef'].join('_');

beforeEach((): void => {
  vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
});

afterEach((): void => {
  vi.unstubAllEnvs();
});

/** Seed one owner source the page-derived credentials hang off. */
async function seedSource(
  harness: TestConvex<typeof schema>,
  userId: string,
): Promise<Id<'docSources'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('docSources', {
        userId,
        label: 'Handbook',
        kind: 'folder',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      }),
  );
}

/** Read every stored credential row verbatim, encrypted fields included. */
async function rows(harness: TestConvex<typeof schema>): Promise<Array<Record<string, unknown>>> {
  return await harness.run(async (ctx) => await ctx.db.query('credentials').collect());
}

describe('credential contract', (): void => {
  it('exposes store and decrypt only internally and revoke and summary publicly', (): void => {
    expect(credentialsModule.store.isInternal).toBe(true);
    expect(credentialsModule.decrypt.isInternal).toBe(true);
    expect(credentialsModule.revoke.isPublic).toBe(true);
    expect(credentialsModule.summaryForOwner.isPublic).toBe(true);
  });

  it('stores an entered value encrypted, returns it only through decrypt, and never in a summary', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const credentialId = await harness.action(internal.credentials.store, {
      userId: 'owner',
      kind: 'value',
      label: 'Notion connection secret',
      plaintext: SECRET,
      source: 'entered',
    });
    const stored = await rows(harness);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    expect(stored[0].ciphertext).not.toBe(SECRET);
    await expect(harness.action(internal.credentials.decrypt, { credentialId })).resolves.toBe(
      SECRET,
    );
    const summary = await harness
      .withIdentity({ subject: 'owner' })
      .query(api.credentials.summaryForOwner, {});
    expect(summary).toEqual([
      expect.objectContaining({
        _id: credentialId,
        label: 'Notion connection secret',
        kind: 'value',
        source: 'entered',
        lastUsedAt: expect.any(Number),
      }),
    ]);
    expect(JSON.stringify(summary)).not.toContain(SECRET);
    expect(summary[0]).not.toHaveProperty('ciphertext');
    expect(summary[0]).not.toHaveProperty('iv');
    await expect(
      harness.withIdentity({ subject: 'owner' }).query(api.credentials.summaryForOwner, {}),
    ).resolves.not.toContainEqual(expect.objectContaining({ iv: expect.anything() }));
    await expect(
      harness.withIdentity({ subject: 'stranger' }).query(api.credentials.summaryForOwner, {}),
    ).resolves.toEqual([]);
  });

  it('upserts a page value on (user, source, ref), keeps a revoke on re-sync and lifts it on rotation', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seedSource(harness, 'owner');
    const source = { sourceId, ref: 'linear-automation' };
    const args = { userId: 'owner', kind: 'value' as const, label: 'linear service token', source };
    const credentialId = await harness.action(internal.credentials.store, {
      ...args,
      plaintext: SECRET,
    });
    await expect(
      harness.action(internal.credentials.store, { ...args, plaintext: SECRET }),
    ).resolves.toBe(credentialId);
    expect(await rows(harness)).toHaveLength(1);
    await harness.withIdentity({ subject: 'owner' }).mutation(api.credentials.revoke, {
      credentialId,
    });
    await expect(
      harness.action(internal.credentials.store, { ...args, plaintext: SECRET }),
    ).resolves.toBe(credentialId);
    await expect(harness.action(internal.credentials.decrypt, { credentialId })).rejects.toThrow(
      'unavailable',
    );
    await expect(
      harness.action(internal.credentials.store, { ...args, plaintext: ROTATED }),
    ).resolves.toBe(credentialId);
    expect(await rows(harness)).toHaveLength(1);
    await expect(harness.action(internal.credentials.decrypt, { credentialId })).resolves.toBe(
      ROTATED,
    );
    await expect(harness.query(internal.credentials.countStored, {})).resolves.toBe(1);
  });

  it('replaces a row sealed under a rotated deployment key instead of failing the sync', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seedSource(harness, 'owner');
    const source = { sourceId, ref: 'linear-automation' };
    const staleId = await harness.mutation(internal.credentials.persistEncrypted, {
      userId: 'owner',
      kind: 'value',
      label: 'linear service token',
      ciphertext: Buffer.from('sealed-under-another-key-0123456789').toString('base64'),
      iv: Buffer.alloc(12, 1).toString('base64'),
      source,
      reactivate: false,
    });
    await expect(
      harness.action(internal.credentials.decrypt, { credentialId: staleId }),
    ).rejects.toThrow('decryption failed');
    await expect(
      harness.action(internal.credentials.store, {
        userId: 'owner',
        kind: 'value',
        label: 'linear service token',
        plaintext: SECRET,
        source,
      }),
    ).resolves.toBe(staleId);
    await expect(
      harness.action(internal.credentials.decrypt, { credentialId: staleId }),
    ).resolves.toBe(SECRET);
  });

  it('refuses a source another owner linked and a value-bearing kind without a value', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seedSource(harness, 'owner');
    await expect(
      harness.action(internal.credentials.store, {
        userId: 'intruder',
        kind: 'value',
        label: 'linear service token',
        plaintext: SECRET,
        source: { sourceId, ref: 'linear-automation' },
      }),
    ).rejects.toThrow('does not belong');
    await expect(
      harness.action(internal.credentials.store, {
        userId: 'owner',
        kind: 'value',
        label: 'linear service token',
        source: 'entered',
      }),
    ).rejects.toThrow('plaintext is required');
    expect(await rows(harness)).toEqual([]);
  });

  it('stores an unlanded location without a value and refuses to decrypt it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    for (const plaintext of [undefined, '']) {
      const credentialId = await harness.action(internal.credentials.store, {
        userId: 'owner',
        kind: 'location',
        label: 'slack bot token',
        plaintext,
        source: 'entered',
      });
      await expect(harness.action(internal.credentials.decrypt, { credentialId })).rejects.toThrow(
        'landed value',
      );
    }
  });

  it('refuses decrypt without the deployment key, with the wrong key and for a deleted row', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const credentialId = await harness.action(internal.credentials.store, {
      userId: 'owner',
      kind: 'value',
      label: 'Notion connection secret',
      plaintext: SECRET,
      source: 'entered',
    });
    vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
    await expect(harness.action(internal.credentials.decrypt, { credentialId })).rejects.toThrow(
      'decryption failed',
    );
    vi.stubEnv('DAY0_CREDENTIAL_KEY', 'not-a-key');
    await expect(harness.action(internal.credentials.decrypt, { credentialId })).rejects.toThrow(
      'decryption failed',
    );
    vi.stubEnv('DAY0_CREDENTIAL_KEY', '');
    await expect(harness.action(internal.credentials.decrypt, { credentialId })).rejects.toThrow(
      'not configured',
    );
    await harness.run(async (ctx) => await ctx.db.delete(credentialId));
    await expect(harness.action(internal.credentials.decrypt, { credentialId })).rejects.toThrow(
      'unavailable',
    );
  });

  it('allows only the owner to revoke and counts active rows', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const credentialId = await harness.action(internal.credentials.store, {
      userId: 'owner',
      kind: 'value',
      label: 'Notion connection secret',
      plaintext: SECRET,
      source: 'entered',
    });
    await expect(
      harness
        .withIdentity({ subject: 'other-owner' })
        .mutation(api.credentials.revoke, { credentialId }),
    ).rejects.toThrow('not found');
    await expect(harness.query(internal.credentials.countStored, {})).resolves.toBe(1);
    await harness.withIdentity({ subject: 'owner' }).mutation(api.credentials.revoke, {
      credentialId,
    });
    const summary = await harness
      .withIdentity({ subject: 'owner' })
      .query(api.credentials.summaryForOwner, {});
    expect(summary[0].revokedAt).toEqual(expect.any(Number));
    await expect(harness.query(internal.credentials.countStored, {})).resolves.toBe(0);
  });
});
