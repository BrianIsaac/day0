import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';

/** Seed encrypted bytes through the internal persistence boundary. */
async function seedCredential(userId: string): Promise<{
  harness: TestConvex<typeof schema>;
  credentialId: Id<'credentials'>;
  sourceId: Id<'docSources'>;
}> {
  const harness = convexTest(schema, allConvexModules());
  const sourceId = await harness.run(
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
  const credentialId = await harness.mutation(internal.credentials.persistEncrypted, {
    userId,
    kind: 'value',
    label: 'linear service token',
    ciphertext: 'ciphertext-one',
    iv: 'iv-one',
    source: { sourceId, ref: 'linear-automation.md' },
    reactivate: false,
  });
  return { harness, credentialId, sourceId };
}

describe('credential metadata contract', (): void => {
  it('upserts page credentials and returns summaries without encrypted fields', async (): Promise<void> => {
    const { harness, credentialId, sourceId } = await seedCredential('owner');
    const rotatedId = await harness.mutation(internal.credentials.persistEncrypted, {
      userId: 'owner',
      kind: 'value',
      label: 'linear service token',
      ciphertext: 'ciphertext-two',
      iv: 'iv-two',
      source: { sourceId, ref: 'linear-automation.md' },
      reactivate: true,
    });
    expect(rotatedId).toBe(credentialId);
    const summary = await harness
      .withIdentity({ subject: 'owner' })
      .query(api.credentials.summaryForOwner, {});
    expect(summary).toEqual([
      expect.objectContaining({
        _id: credentialId,
        label: 'linear service token',
        kind: 'value',
        source: { sourceId, ref: 'linear-automation.md' },
      }),
    ]);
    expect(summary[0]).not.toHaveProperty('ciphertext');
    expect(summary[0]).not.toHaveProperty('iv');
  });

  it('allows only the owner to revoke and counts active rows', async (): Promise<void> => {
    const { harness, credentialId } = await seedCredential('owner');
    await expect(
      harness
        .withIdentity({ subject: 'other-owner' })
        .mutation(api.credentials.revoke, { credentialId }),
    ).rejects.toThrow('not found');
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
