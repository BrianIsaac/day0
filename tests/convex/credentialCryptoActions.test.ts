/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import * as cryptoActions from '../../convex/credentialCryptoActions';
import * as credentialsModule from '../../convex/credentials';
import { encrypt } from '../../src/lib/credential-crypto';
import { OWNER_KNOWN_VALUE_CAP, OWNER_KNOWN_VALUES_CAP_REASON } from '../../src/redaction/known-values';
import { allConvexModules } from './all-modules';

const KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');

beforeEach((): void => {
  vi.stubEnv('DAY0_CREDENTIAL_KEY', KEY);
});

afterEach((): void => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Insert one encrypted credential row directly, bypassing the store action. */
async function insertRow(
  harness: TestConvex<typeof schema>,
  row: {
    userId: string;
    label: string;
    plaintext?: string;
    key?: string;
    revokedAt?: number;
    purged?: boolean;
    kind?: 'value' | 'location' | 'oauth';
  },
): Promise<Id<'credentials'>> {
  const sealed = row.plaintext === undefined ? undefined : encrypt(row.plaintext, row.key ?? KEY);
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('credentials', {
        userId: row.userId,
        kind: row.kind ?? 'value',
        label: row.label,
        source: 'entered',
        createdAt: 1,
        ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
        ...(sealed && !row.purged ? sealed : {}),
      }),
  );
}

describe('the owner known-value source', (): void => {
  it('is internal on both halves, with no public function beside it', (): void => {
    expect(cryptoActions.ownerValues.isInternal).toBe(true);
    expect(credentialsModule.activeValuesForOwner.isInternal).toBe(true);
    for (const exported of Object.values(cryptoActions)) {
      if (typeof exported === 'object' && exported && 'isPublic' in exported) {
        expect((exported as { isPublic?: boolean }).isPublic).not.toBe(true);
      }
    }
  });

  it('returns every active value this owner holds, and nothing of anyone else', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await insertRow(harness, { userId: 'owner', label: 'Linear service token', plaintext: 'lin-value-one' });
    await insertRow(harness, { userId: 'owner', label: 'Looker tile password', plaintext: 'tile-value-two' });
    await insertRow(harness, { userId: 'owner', label: 'Revoked', plaintext: 'revoked-value', revokedAt: 5 });
    await insertRow(harness, { userId: 'owner', label: 'Purged', plaintext: 'purged-value', purged: true });
    await insertRow(harness, { userId: 'owner', label: 'Location', plaintext: '', kind: 'location' });
    await insertRow(harness, { userId: 'owner', label: 'Rotated', plaintext: 'rotated-value', key: OTHER_KEY });
    await insertRow(harness, { userId: 'neighbour', label: 'Neighbour token', plaintext: 'neighbour-value' });
    const log = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation((): void => undefined);

    const values = await harness.action(internal.credentialCryptoActions.ownerValues, { userId: 'owner' });

    expect([...values].sort()).toEqual(['lin-value-one', 'tile-value-two']);
    const logged = JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls]);
    for (const value of ['lin-value-one', 'tile-value-two', 'revoked-value', 'rotated-value', 'neighbour-value']) {
      expect(logged).not.toContain(value);
    }
    const rows = await harness.run(async (ctx) => await ctx.db.query('credentials').collect());
    expect(rows.every((row) => row.lastUsedAt === undefined)).toBe(true);
    await expect(
      harness.action(internal.credentialCryptoActions.ownerValues, { userId: 'nobody' }),
    ).resolves.toEqual([]);
  });

  it('fails closed with a named reason above the cap, before decrypting anything', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await harness.run(async (ctx) => {
      for (let index = 0; index <= OWNER_KNOWN_VALUE_CAP; index += 1) {
        await ctx.db.insert('credentials', {
          userId: 'hoarder',
          kind: 'value',
          label: `row ${index}`,
          ciphertext: 'not-decryptable',
          iv: 'not-an-iv',
          source: 'entered',
          createdAt: index,
        });
      }
    });
    const error = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    await expect(
      harness.action(internal.credentialCryptoActions.ownerValues, { userId: 'hoarder' }),
    ).rejects.toThrow(OWNER_KNOWN_VALUES_CAP_REASON);
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).toContain(String(OWNER_KNOWN_VALUE_CAP));
  });
});
