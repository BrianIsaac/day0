/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convexTest, type TestConvex } from 'convex-test';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveSpanModel } from '../fixtures/redaction-double';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import * as credentialsModule from '../../convex/credentials';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { OWNER_KNOWN_VALUE_CAP } from '../../src/redaction/known-values';

const SECRET = ['ntn', 'contract-value-0123456789abcdef'].join('_');
const ROTATED = ['ntn', 'rotated-value-0123456789abcdef'].join('_');

beforeEach((): void => {
  vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
});

afterEach((): void => {
  vi.unstubAllEnvs();
  restoreSurfaceMode();
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

  it("revives a credential a sync superseded when the same value returns, and keeps a person's revoke (P10-1)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seedSource(harness, 'owner');
    const source = { sourceId, ref: 'linear-automation' };
    const args = { userId: 'owner', kind: 'value' as const, label: 'linear service token', source };
    const credentialId = await harness.action(internal.credentials.store, {
      ...args,
      plaintext: SECRET,
    });
    /** One sync generation that found the credential's page ref, or did not. */
    const sync = async (found: boolean): Promise<void> => {
      const runId = await harness.mutation(internal.docSources.beginSync, { sourceId });
      if (found) await harness.action(internal.credentials.store, { ...args, plaintext: SECRET });
      await harness.mutation(internal.docSources.finishSync, {
        sourceId,
        runId,
        refs: ['linear-automation'],
        credentialRefs: found ? ['linear-automation'] : [],
        pageCount: 1,
        redactionCount: found ? 1 : 0,
      });
    };

    // The page blinks: one sync does not find the value, the next finds it again.
    await sync(false);
    await expect(harness.action(internal.credentials.decrypt, { credentialId })).rejects.toThrow(
      'unavailable',
    );
    await expect(harness.query(internal.credentials.countStored, {})).resolves.toBe(0);
    await sync(true);
    await expect(harness.action(internal.credentials.decrypt, { credentialId })).resolves.toBe(
      SECRET,
    );
    await expect(harness.query(internal.credentials.countStored, {})).resolves.toBe(1);
    expect(await rows(harness)).toEqual([
      expect.not.objectContaining({ status: expect.anything(), revokedAt: expect.anything() }),
    ]);

    // A revoke the owner made survives the same blink.
    await harness.withIdentity({ subject: 'owner' }).mutation(api.credentials.revoke, {
      credentialId,
    });
    await sync(false);
    await sync(true);
    await expect(harness.action(internal.credentials.decrypt, { credentialId })).rejects.toThrow(
      'unavailable',
    );
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

describe('a page whose count of values changes (P10-1)', (): void => {
  const TWO = ['ntn', 'second-value-0123456789abcdef'].join('_');
  const pageRef = 'linear-automation.md';
  const qualified = (index: number, label: string): string =>
    `${pageRef}#credential=${index}-${encodeURIComponent(label)}`;

  it('carries a value the page already holds to its new ref instead of minting a row', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seedSource(harness, 'owner');
    const store = async (ref: string, plaintext: string, label = 'linear service token') =>
      await harness.action(internal.credentials.store, {
        userId: 'owner',
        kind: 'value',
        label,
        plaintext,
        source: { sourceId, ref },
      });
    const first = await store(pageRef, SECRET);

    // A second value appears on the page, so both take label-qualified refs.
    await expect(store(qualified(1, 'linear service token'), SECRET)).resolves.toBe(first);
    const second = await store(qualified(2, 'notion token'), TWO, 'notion token');
    expect(second).not.toBe(first);
    expect(await rows(harness)).toHaveLength(2);

    // The second value goes again: the first returns to the page's own ref.
    await expect(store(pageRef, SECRET)).resolves.toBe(first);
    expect(await rows(harness)).toHaveLength(2);
    await expect(
      harness.action(internal.credentials.decrypt, { credentialId: first }),
    ).resolves.toBe(SECRET);

    // The same value on another page is that page's own row.
    await expect(store('another-page.md', SECRET)).resolves.not.toBe(first);
  });

  it('moves a row only from the ref it was read at, so a concurrent store cannot move it twice', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seedSource(harness, 'owner');
    const credentialId = await harness.action(internal.credentials.store, {
      userId: 'owner',
      kind: 'value',
      label: 'linear service token',
      plaintext: SECRET,
      source: { sourceId, ref: pageRef },
    });
    const move = async (fromRef: string, ref: string): Promise<boolean> =>
      await harness.mutation(internal.credentials.moveToRef, {
        credentialId,
        userId: 'owner',
        fromRef,
        source: { sourceId, ref },
        kind: 'value',
        label: 'linear service token',
      });
    await expect(move(pageRef, qualified(1, 'linear service token'))).resolves.toBe(true);
    await expect(move(pageRef, qualified(2, 'linear service token'))).resolves.toBe(false);
    expect(await rows(harness)).toEqual([
      expect.objectContaining({ source: { sourceId, ref: qualified(1, 'linear service token') } }),
    ]);
  });

  it("keeps a person's revoke on a value it carries to a new ref", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seedSource(harness, 'owner');
    const args = {
      userId: 'owner',
      kind: 'value' as const,
      label: 'linear service token',
      plaintext: SECRET,
    };
    const credentialId = await harness.action(internal.credentials.store, {
      ...args,
      source: { sourceId, ref: pageRef },
    });
    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.credentials.revoke, { credentialId });
    await expect(
      harness.action(internal.credentials.store, {
        ...args,
        source: { sourceId, ref: qualified(1, 'linear service token') },
      }),
    ).resolves.toBe(credentialId);
    await expect(harness.action(internal.credentials.decrypt, { credentialId })).rejects.toThrow(
      'unavailable',
    );
  });

  describe('through a folder sync', (): void => {
    let redactor: { url: string; close: () => Promise<void> } | undefined;
    beforeAll(async (): Promise<void> => {
      redactor = await serveSpanModel();
    });
    afterAll(async (): Promise<void> => {
      await redactor?.close();
    });

    it('keeps one row per value as a runbook gains a second token and loses it again', async (): Promise<void> => {
      // Scheduled discovery never runs: the clock is fake and never advanced.
      vi.useFakeTimers();
      try {
        const root = await mkdtemp(join(tmpdir(), 'day0-credential-refs-'));
        vi.stubEnv('DAY0_DOCS_ROOT', root);
        vi.stubEnv('DAY0_REDACTOR_URL', redactor?.url ?? '');
        const linear = ['lin', 'api', 'refs-contract-0123456789abcdef'].join('_');
        const backup = ['lin', 'api', 'backup-contract-0123456789abcdef'].join('_');
        const write = async (...lines: string[]): Promise<void> =>
          await writeFile(
            join(root, 'runbook.md'),
            ['# Linear automation', '', ...lines, ''].join('\n'),
            'utf8',
          );
        useSurfaceMode('real');
        const harness = convexTest(schema, allConvexModules());
        const sourceId = await harness.mutation(internal.docSources.createSource, {
          userId: 'owner',
          label: 'Runbooks',
          kind: 'folder',
          locator: '.',
        });
        const sync = async (): Promise<void> => {
          await expect(
            harness.action(internal.docSyncActions.syncSource, { sourceId }),
          ).resolves.toMatchObject({ ok: true, complete: true });
        };

        await write(`Service token: ${linear}`);
        await sync();
        const [first] = await rows(harness);
        await write(`Service token: ${linear}`, `Backup token: ${backup}`);
        await sync();
        await write(`Service token: ${linear}`);
        await sync();

        const stored = await rows(harness);
        expect(stored).toHaveLength(2);
        const kept = stored.find((row) => row._id === first?._id);
        expect(kept).toMatchObject({ source: { sourceId, ref: 'runbook.md' } });
        expect(kept).not.toHaveProperty('status');
        await expect(
          harness.action(internal.credentials.decrypt, {
            credentialId: first!._id as Id<'credentials'>,
          }),
        ).resolves.toBe(linear);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('the known-value cap (P10-1)', (): void => {
  /** Insert `count` rows for one owner, each shaped by `extra`. */
  const insertRows = async (
    harness: TestConvex<typeof schema>,
    count: number,
    extra: Record<string, unknown>,
  ): Promise<void> => {
    await harness.run(async (ctx): Promise<void> => {
      for (let index = 0; index < count; index += 1) {
        await ctx.db.insert('credentials', {
          userId: 'owner',
          kind: 'value',
          label: `row ${index}`,
          ciphertext: 'sealed',
          iv: 'iv',
          source: 'entered',
          createdAt: index,
          ...extra,
        });
      }
    });
  };

  it('counts active rows only, so rows a sync superseded or a person revoked lock nobody out', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await insertRows(harness, OWNER_KNOWN_VALUE_CAP, { status: 'superseded' });
    await insertRows(harness, 200, { revokedAt: 1 });
    await insertRows(harness, 2, {});
    const list = await harness.query(internal.credentials.activeValuesForOwner, {
      userId: 'owner',
    });
    expect(list.overflow).toBe(false);
    expect(list.rows).toHaveLength(2);
  });

  it('still fails closed one active row past the cap', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await insertRows(harness, OWNER_KNOWN_VALUE_CAP + 1, {});
    await expect(
      harness.query(internal.credentials.activeValuesForOwner, { userId: 'owner' }),
    ).resolves.toMatchObject({ overflow: true });
  });
});

describe('credential persistence after unlink', () => {
  it.each([false, true])(
    'refuses late ciphertext after unlink (existing row: %s)',
    async (existing) => {
      useSurfaceMode('real');
      const harness = convexTest(schema, allConvexModules());
      const sourceId = await seedSource(harness, 'owner');
      const args = {
        userId: 'owner',
        kind: 'value' as const,
        label: 'linear service token',
        source: { sourceId, ref: 'page' },
        ciphertext: 'late-ciphertext',
        iv: 'late-iv',
        reactivate: true,
      };
      if (existing) await harness.mutation(internal.credentials.persistEncrypted, args);
      await harness
        .withIdentity({ subject: 'owner' })
        .mutation(api.docSources.unlink, { sourceId });
      // Encryption began while the source existed; its final transaction arrives after unlink.
      await expect(harness.mutation(internal.credentials.persistEncrypted, args)).rejects.toThrow(
        'does not belong',
      );
      const stored = await rows(harness);
      expect(stored).toHaveLength(existing ? 1 : 0);
      for (const row of stored) {
        expect(row).not.toHaveProperty('ciphertext');
        expect(row).not.toHaveProperty('iv');
        expect(row.revokedAt).toEqual(expect.any(Number));
      }
    },
  );
});
