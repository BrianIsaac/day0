/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeSpanModelFetch, SPAN_MODEL_TEST_URL } from '../fixtures/redaction-double';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import * as credentialsModule from '../../convex/credentials';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { OWNER_KNOWN_VALUE_CAP } from '../../src/redaction/known-values';
import {
  credentialKeyId,
  credentialValueFingerprint,
  decrypt as decryptCredential,
  openOwnedCredential,
} from '../../src/lib/credential-crypto';
import { credentialSourceRef } from '../../src/docs/credential-ref';
import { ORGANISATION_HOLDER, ORGANISATION_OWNER_KEY } from '../../src/lib/organisation-key';
import { FAKE_BOT_TOKEN, startFakeSlack } from '../fake-slack/spawn';
import { temporaryDirectories } from '../setup/temporary-directories';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';

const temporary = temporaryDirectories();

/** The Linear writes the MCP transport received, with the bearer it was opened with. */
const mcpCalls = vi.hoisted(() => [] as Array<{ bearer?: string; tool: string }>);

// The transport is the seam: the apply above it, the decrypt included, is the product's.
vi.mock('../../src/surfaces/mcp', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/surfaces/mcp')>();
  return {
    ...original,
    createMastraMcpClient: (options: { serverName: string; bearer?: string }) => {
      const tool = (name: string, reply: unknown) => ({
        execute: async (): Promise<unknown> => {
          mcpCalls.push({ bearer: options.bearer, tool: name });
          return { content: [{ type: 'text', text: JSON.stringify(reply) }] };
        },
      });
      return {
        listTools: async () => ({
          [`${options.serverName}_get_issue`]: tool('get_issue', {
            id: 'REVOPS-1',
            status: 'In Progress',
            statusType: 'started',
          }),
          [`${options.serverName}_save_comment`]: tool('save_comment', { id: 'comment-1' }),
        }),
        disconnect: async (): Promise<void> => {},
      };
    },
  };
});

const SECRET = ['ntn', 'contract-value-0123456789abcdef'].join('_');
const ROTATED = ['ntn', 'rotated-value-0123456789abcdef'].join('_');

beforeEach((): void => {
  vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
});

afterEach((): void => {
  vi.unstubAllEnvs();
  restoreSurfaceMode();
});

/**
 * The source ref the sync gives a value on a page under the key the test
 * stubbed for the deployment.
 */
function valueRef(pageRef: string, value: string, userId: string): string {
  const key = process.env.DAY0_CREDENTIAL_KEY;
  if (key === undefined) throw new Error('The test stubs no DAY0_CREDENTIAL_KEY.');
  return credentialSourceRef(pageRef, credentialValueFingerprint(value, key, userId));
}

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
      .withIdentity(managerIdentity())
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
      harness.withIdentity(managerIdentity()).query(api.credentials.summaryForOwner, {}),
    ).resolves.not.toContainEqual(expect.objectContaining({ iv: expect.anything() }));
    await expect(
      harness.withIdentity(managerIdentity('stranger')).query(api.credentials.summaryForOwner, {}),
    ).resolves.toEqual([]);
  });

  it("upserts a page value on (user, source, ref) and keeps a person's revoke on re-sync and on rotation", async (): Promise<void> => {
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
    await harness.withIdentity(managerIdentity()).mutation(api.credentials.revoke, {
      credentialId,
    });
    const [revoked] = await rows(harness);
    await expect(
      harness.action(internal.credentials.store, { ...args, plaintext: SECRET }),
    ).resolves.toBe(credentialId);
    await expect(harness.action(internal.credentials.decrypt, { credentialId })).rejects.toThrow(
      'unavailable',
    );

    // The page now holds another value: the row is re-synced to it, and the
    // person's revoke stands until a person lands or approves a value.
    await expect(
      harness.action(internal.credentials.store, { ...args, plaintext: ROTATED }),
    ).resolves.toBe(credentialId);
    const [rotated] = await rows(harness);
    expect(await rows(harness)).toHaveLength(1);
    expect(rotated.ciphertext).not.toBe(revoked.ciphertext);
    expect(rotated.revokedAt).toBe(revoked.revokedAt);
    await expect(harness.action(internal.credentials.decrypt, { credentialId })).rejects.toThrow(
      'unavailable',
    );
    await expect(harness.query(internal.credentials.countStored, {})).resolves.toBe(0);
    const reason = async (): Promise<string | undefined> => {
      const [summary] = await harness
        .withIdentity(managerIdentity())
        .query(api.credentials.summaryForOwner, {});
      return summary.statusReason;
    };
    expect(await reason()).toBe(
      'Revoked by a person. The page now holds a different value; it stays revoked until a person lands or approves one.',
    );

    // The next sync finds the rotated value unchanged: still revoked, and still said.
    await harness.action(internal.credentials.store, { ...args, plaintext: ROTATED });
    await expect(harness.action(internal.credentials.decrypt, { credentialId })).rejects.toThrow(
      'unavailable',
    );
    expect(await reason()).toMatch(/stays revoked until a person lands or approves one/);
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
    // Revived, it no longer ages towards the prune of superseded rows (C2 D2 (a)).
    expect((await rows(harness))[0]).not.toHaveProperty('supersededAt');

    // A revoke the owner made survives the same blink.
    await harness.withIdentity(managerIdentity()).mutation(api.credentials.revoke, {
      credentialId,
    });
    await sync(false);
    await sync(true);
    await expect(harness.action(internal.credentials.decrypt, { credentialId })).rejects.toThrow(
      'unavailable',
    );
  });

  it("seals a stored value to its owner, so its ciphertext moved to another owner's row no longer opens", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const credentialId = await harness.action(internal.credentials.store, {
      userId: 'owner',
      kind: 'value',
      label: 'Notion connection secret',
      plaintext: SECRET,
      source: 'entered',
    });
    const sealed = await harness.run(async (ctx) => await ctx.db.get(credentialId));
    const key = process.env.DAY0_CREDENTIAL_KEY ?? '';
    const material = {
      ciphertext: sealed?.ciphertext ?? '',
      iv: sealed?.iv ?? '',
      keyId: sealed?.keyId ?? '',
    };
    expect(material.keyId).toBe(credentialKeyId(key));
    expect(() => decryptCredential(material, key)).toThrow();
    expect(
      openOwnedCredential(
        { ...material, userId: 'owner' },
        { current: key },
        { allowUnbound: false },
      ),
    ).toBe(SECRET);
    await expect(harness.action(internal.credentials.decrypt, { credentialId })).resolves.toBe(
      SECRET,
    );

    const moved = await harness.mutation(internal.credentials.persistEncrypted, {
      userId: 'neighbour',
      kind: 'value',
      label: 'Notion connection secret',
      ...material,
      source: 'entered',
      rotated: false,
    });
    await expect(
      harness.action(internal.credentials.decrypt, { credentialId: moved }),
    ).rejects.toThrow();
  });

  it("does not take a value moved onto another owner's page row as that owner's own", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const ownerId = await harness.action(internal.credentials.store, {
      userId: 'owner',
      kind: 'value',
      label: 'linear service token',
      plaintext: SECRET,
      source: 'entered',
    });
    const sealed = await harness.run(async (ctx) => await ctx.db.get(ownerId));
    const sourceId = await seedSource(harness, 'neighbour');
    const source = { sourceId, ref: 'linear-automation' };
    const movedId = await harness.mutation(internal.credentials.persistEncrypted, {
      userId: 'neighbour',
      kind: 'value',
      label: 'linear service token',
      ciphertext: sealed?.ciphertext ?? '',
      iv: sealed?.iv ?? '',
      keyId: sealed?.keyId ?? '',
      source,
      rotated: false,
    });
    // The page names the same value: the moved row is unreadable to its owner, so the value is sealed again for them.
    await expect(
      harness.action(internal.credentials.store, {
        userId: 'neighbour',
        kind: 'value',
        label: 'linear service token',
        plaintext: SECRET,
        source,
      }),
    ).resolves.toBe(movedId);
    const resealed = await harness.run(async (ctx) => await ctx.db.get(movedId));
    expect(resealed?.ciphertext).not.toBe(sealed?.ciphertext);
    await expect(
      harness.action(internal.credentials.decrypt, { credentialId: movedId }),
    ).resolves.toBe(SECRET);
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
      keyId: '0000000000000000',
      source,
      rotated: false,
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

  it('refuses decrypt without the deployment key, with the wrong key, with a malformed key named as such and for a deleted row', async (): Promise<void> => {
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
      'must be a base64-encoded 32-byte key',
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
        .withIdentity(managerIdentity('other-owner'))
        .mutation(api.credentials.revoke, { credentialId }),
    ).rejects.toThrow('not found');
    await expect(harness.query(internal.credentials.countStored, {})).resolves.toBe(1);
    await harness.withIdentity(managerIdentity()).mutation(api.credentials.revoke, {
      credentialId,
    });
    const summary = await harness
      .withIdentity(managerIdentity())
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
      .withIdentity(managerIdentity())
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
    // The sync's redaction calls are answered in-process at the reserved test address, never
    // over a socket: the clock below is fake, and from undici 6.28 (Node 22.23) a request on a
    // pooled socket waits for a zero-delay timer a faked clock never fires (12-N, 5 October 2026).
    const redactorFetch = routeSpanModelFetch(globalThis.fetch);
    beforeEach((): void => {
      vi.stubGlobal('fetch', redactorFetch);
    });
    afterEach((): void => {
      vi.unstubAllGlobals();
    });

    it('keeps one row per value as a runbook gains a second token and loses it again', async (): Promise<void> => {
      // Scheduled discovery never runs: the clock is fake and never advanced.
      vi.useFakeTimers();
      try {
        const root = temporary('day0-credential-refs-');
        vi.stubEnv('DAY0_DOCS_ROOT', root);
        vi.stubEnv('DAY0_REDACTOR_URL', SPAN_MODEL_TEST_URL);
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
        expect(kept).toMatchObject({
          source: {
            sourceId,
            ref: valueRef('runbook.md', linear, 'owner'),
          },
        });
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

describe('the rows of one page, read by label for orientation', (): void => {
  const pageRef = 'runbook.md';

  /** Insert one page-derived row directly, with no value, under a ref and label. */
  async function pageRow(
    harness: TestConvex<typeof schema>,
    row: {
      userId?: string;
      sourceId: Id<'docSources'>;
      ref: string;
      label: string;
      revokedAt?: number;
      status?: 'suspect' | 'superseded';
    },
  ): Promise<Id<'credentials'>> {
    return await harness.run(
      async (ctx) =>
        await ctx.db.insert('credentials', {
          userId: row.userId ?? 'owner',
          kind: 'value',
          label: row.label,
          source: { sourceId: row.sourceId, ref: row.ref },
          createdAt: 1,
          ...(row.revokedAt !== undefined ? { revokedAt: row.revokedAt } : {}),
          ...(row.status !== undefined ? { status: row.status } : {}),
        }),
    );
  }

  it("binds by label over the page's live rows, oldest first, whatever shape of ref each carries", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seedSource(harness, 'owner');
    const otherSourceId = await seedSource(harness, 'owner');
    const label = 'linear service token';
    const legacy = await pageRow(harness, { sourceId, ref: `${pageRef}#credential=1-x`, label });
    const keyed = await pageRow(harness, {
      sourceId,
      ref: `${pageRef}#credential=${'a'.repeat(32)}`,
      label: '  Linear Service Token ',
    });
    const pageOnly = await pageRow(harness, { sourceId, ref: pageRef, label });
    await pageRow(harness, {
      sourceId,
      ref: `${pageRef}#credential=${'b'.repeat(32)}`,
      label,
      revokedAt: 5,
    });
    for (const status of ['suspect', 'superseded'] as const) {
      await pageRow(harness, { sourceId, ref: `${pageRef}#credential=${status}`, label, status });
    }
    await pageRow(harness, {
      sourceId,
      ref: `${pageRef}#credential=${'c'.repeat(32)}`,
      label: 'slack bot token',
    });
    // A page whose ref extends this one's sorts inside its index range.
    await pageRow(harness, {
      sourceId,
      ref: `${pageRef} copy#credential=${'d'.repeat(32)}`,
      label,
    });
    await pageRow(harness, { sourceId: otherSourceId, ref: pageRef, label });
    await pageRow(harness, { userId: 'someone else', sourceId, ref: pageRef, label });

    const bound = await harness.query(internal.credentials.pageRowsByLabel, {
      userId: 'owner',
      sourceId,
      pageRef,
      label: 'Linear service token',
    });
    expect(bound.map((row) => row._id)).toEqual([legacy, keyed, pageOnly]);
  });

  it('reads every row of a page past the old 64-row read, where rows used to be left out unnoticed', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seedSource(harness, 'owner');
    for (let index = 0; index < 100; index += 1) {
      await pageRow(harness, {
        sourceId,
        ref: `${pageRef}#credential=${index.toString(16).padStart(32, '0')}`,
        label: 'swapped token',
        status: 'superseded',
      });
    }
    const live = await pageRow(harness, {
      sourceId,
      ref: `${pageRef}#credential=${'f'.repeat(32)}`,
      label: 'swapped token',
    });
    await expect(
      harness.query(internal.credentials.pageRowsForStore, { userId: 'owner', sourceId, pageRef }),
    ).resolves.toHaveLength(101);
    await expect(
      harness.query(internal.credentials.pageRowsByLabel, {
        userId: 'owner',
        sourceId,
        pageRef,
        label: 'swapped token',
      }),
    ).resolves.toEqual([expect.objectContaining({ _id: live })]);
  });

  it('refuses a page with more rows than one read returns, rather than leaving some out', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seedSource(harness, 'owner');
    await harness.run(async (ctx) => {
      for (let index = 0; index <= 512; index += 1) {
        await ctx.db.insert('credentials', {
          userId: 'owner',
          kind: 'value',
          label: 'swapped token',
          source: {
            sourceId,
            ref: `${pageRef}#credential=${index.toString(16).padStart(32, '0')}`,
          },
          createdAt: 1,
          status: 'superseded',
        });
      }
    });
    await expect(
      harness.query(internal.credentials.pageRowsForStore, { userId: 'owner', sourceId, pageRef }),
    ).rejects.toThrow('A documentation page holds more than 512 stored credentials');
  });

  it('is internal', (): void => {
    expect(credentialsModule.pageRowsByLabel.isInternal).toBe(true);
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
        keyId: '0000000000000000',
        rotated: true,
      };
      if (existing) await harness.mutation(internal.credentials.persistEncrypted, args);
      await harness.withIdentity(managerIdentity()).mutation(api.docSources.unlink, { sourceId });
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

describe('an apply decrypts the stored row, and a revoked row stops it (P10-9)', (): void => {
  const TOKEN = ['xoxb', 'apply-seam-0123456789abcdef'].join('-');

  afterEach((): void => {
    vi.unstubAllGlobals();
    mcpCalls.length = 0;
  });

  /**
   * An owned employee, one connected surface carrying a stored credential, and
   * one work item whose single action the manager approved.
   *
   * Args:
   *   harness: Convex test harness.
   *   surface: Which provider the action writes to.
   *   credentialId: The stored credential the surface carries.
   *
   * Returns:
   *   The work item, ready for the apply.
   */
  async function approvedWrite(
    harness: TestConvex<typeof schema>,
    surface: 'slack' | 'linear',
    credentialId: Id<'credentials'>,
    slack: { managerDm: string; channel: string; contentType?: string | null } = {
      managerDm: 'D0MANAGER',
      channel: 'D0MANAGER',
    },
  ): Promise<Id<'workItems'>> {
    const { workItemId, runId } = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Priya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      for (const scope of ['boss:message', `${surface}:read`, `${surface}:write`]) {
        await ctx.db.insert('permissionGrants', { agentId, scope, createdAt: 1 });
      }
      const live = {
        credentialLanded: true,
        lastVerifiedAt: Date.now(),
        whereFound: [],
        createdAt: 1,
      };
      await ctx.db.insert(
        'surfaces',
        surface === 'slack'
          ? {
              agentId,
              slug: 'slack',
              displayName: 'Slack',
              class: 'chat',
              verdict: 'connected',
              endpoint: 'https://slack.com/api/',
              path: 'documented-api',
              toolAllowlist: ['chat.postMessage'],
              toolArguments: [{ tool: 'chat.postMessage', arguments: ['channel', 'text'] }],
              managerDmChannelId: slack.managerDm,
              managerUserId: 'UMANAGER',
              credentialId,
              ...live,
            }
          : {
              agentId,
              slug: 'linear',
              displayName: 'Linear',
              class: 'kanban',
              verdict: 'connected',
              endpoint: 'https://mcp.linear.app/mcp',
              path: 'mcp',
              toolAllowlist: ['get_issue', 'save_comment'],
              toolArguments: [
                { tool: 'get_issue', arguments: ['id'] },
                { tool: 'save_comment', arguments: ['issueId', 'body'] },
              ],
              credentialId,
              ...live,
            },
      );
      const workItemId = await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-1',
        title: 'Note the close summary',
        contentSummary: 'Note the close summary.',
        contentRefs: [],
        state: 'executing',
        observedAt: 1,
        createdAt: 1,
      });
      const runId = await ctx.db.insert('events', {
        agentId,
        type: 'work.execution-claimed',
        payload: { workItemId },
        createdAt: 1,
      });
      await ctx.db.patch(workItemId, { executionRunId: runId });
      return { workItemId, runId };
    });
    const action =
      surface === 'slack'
        ? {
            tool: 'http.request',
            args: {
              surface: 'slack',
              method: 'POST',
              path: '/chat.postMessage',
              // Re-pinned for 13-FS: the write carries the JSON content type Slack requires (the first
              // walk's row 19), which fake Slack now holds a post to; null leaves it out.
              headersJson: JSON.stringify({
                Authorization: 'Bearer {{secret}}',
                ...(slack.contentType === null
                  ? {}
                  : { 'Content-Type': slack.contentType ?? 'application/json; charset=utf-8' }),
              }),
              body: JSON.stringify({ channel: slack.channel, text: 'The close summary is ready.' }),
            },
          }
        : {
            tool: 'mcp.call',
            args: {
              surface: 'linear',
              tool: 'save_comment',
              toolArgsJson: JSON.stringify({ issueId: 'REVOPS-1', body: 'Close summary noted.' }),
            },
          };
    await harness.mutation(internal.workRuns.setActionsPending, {
      workItemId,
      runId,
      output: { draft: 'Close summary.', notes: '', actions: [action] },
    });
    // The manager's own DM is automatic and already applying; a Linear write waits for approval.
    const pending = await harness.run(async (ctx) => await ctx.db.get(workItemId));
    if (pending?.state === 'actions-pending') {
      await harness.withIdentity(managerIdentity()).mutation(api.work.approveActions, {
        workItemId,
        pendingRunId: runId,
        approvedIndexes: [0],
      });
    }
    return workItemId;
  }

  /** The ledger row the apply wrote for the one action. */
  async function landed(
    harness: TestConvex<typeof schema>,
    workItemId: Id<'workItems'>,
  ): Promise<{ state: string; applied: { ok: boolean; held?: boolean; reason?: string } }> {
    const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
    const applied = (
      row?.output as { applied?: Array<{ ok: boolean; held?: boolean; reason?: string }> }
    ).applied;
    return { state: row?.state ?? 'missing', applied: applied?.[0] ?? { ok: false } };
  }

  it('posts to Slack with the value the row decrypts to, and sends nothing once the row is revoked', async (): Promise<void> => {
    useSurfaceMode('real');
    const { api: liveApi, internal: liveInternal } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const posts: string[] = [];
    vi.stubGlobal('fetch', async (_input: URL | string, init?: RequestInit): Promise<Response> => {
      posts.push(new Headers(init?.headers).get('authorization') ?? '');
      return new Response(JSON.stringify({ ok: true, ts: '1789000000.000100' }), { status: 200 });
    });
    const credentialId = await harness.action(liveInternal.credentials.store, {
      userId: 'owner',
      kind: 'value',
      label: 'Slack bot token',
      plaintext: TOKEN,
      source: 'entered',
    });

    const first = await approvedWrite(harness, 'slack', credentialId);
    await harness.action(liveInternal.workActions.applyApprovedActions, { workItemId: first });
    expect(await landed(harness, first)).toMatchObject({
      state: 'completed',
      applied: { ok: true },
    });
    expect(posts).toEqual([`Bearer ${TOKEN}`]);

    await harness
      .withIdentity(managerIdentity())
      .mutation(liveApi.credentials.revoke, { credentialId });
    const second = await approvedWrite(harness, 'slack', credentialId);
    await harness.action(liveInternal.workActions.applyApprovedActions, { workItemId: second });
    const refused = await landed(harness, second);
    expect(refused.applied.ok).toBe(false);
    expect(refused.applied.reason).toContain('Credential is unavailable');
    expect(posts).toHaveLength(1);
  });

  it("records the fake Slack's own refusal, and lands what it accepts", async (): Promise<void> => {
    useSurfaceMode('real');
    const { internal: liveInternal } = await import('../../convex/_generated/api');
    const fake = await startFakeSlack();
    try {
      // The transport resolves Slack to the compose alias; the alias is this spawned service.
      vi.stubEnv('DAY0_TEST_SLACK_API_URL', 'http://fake-slack/api/');
      const network = globalThis.fetch;
      vi.stubGlobal(
        'fetch',
        async (input: URL | string, init?: RequestInit): Promise<Response> =>
          await network(String(input).replace('http://fake-slack', fake.base), init),
      );
      const harness = convexTest(schema, allConvexModules());
      const credentialId = await harness.action(liveInternal.credentials.store, {
        userId: 'owner',
        kind: 'value',
        label: 'Slack bot token',
        plaintext: FAKE_BOT_TOKEN,
        source: 'entered',
      });

      const dm = await approvedWrite(harness, 'slack', credentialId, {
        managerDm: 'D_DAY0_MANAGER',
        channel: 'D_DAY0_MANAGER',
      });
      await harness.action(liveInternal.workActions.applyApprovedActions, { workItemId: dm });
      expect(await landed(harness, dm)).toMatchObject({
        state: 'completed',
        applied: { ok: true },
      });

      const elsewhere = await approvedWrite(harness, 'slack', credentialId, {
        managerDm: 'D_DAY0_MANAGER',
        channel: 'C_ELSEWHERE',
      });
      await harness.action(liveInternal.workActions.applyApprovedActions, {
        workItemId: elsewhere,
      });
      const refused = await landed(harness, elsewhere);
      expect(refused.applied.ok).toBe(false);
      expect(refused.applied.reason).toContain('not_in_channel');

      // Re-pinned for 13-S: a write whose headers name no content type went as text, which Slack
      // refuses with invalid_arguments (13-FS); the transport now labels a JSON body JSON when the
      // action names no type, so the same write lands (the fake's own refusal stays pinned in
      // tests/fake-slack/server.test.ts).
      const untyped = await approvedWrite(harness, 'slack', credentialId, {
        managerDm: 'D_DAY0_MANAGER',
        channel: 'D_DAY0_MANAGER',
        contentType: null,
      });
      await harness.action(liveInternal.workActions.applyApprovedActions, { workItemId: untyped });
      const untypedLanded = await landed(harness, untyped);
      expect(untypedLanded.applied.ok).toBe(true);
      expect(untypedLanded.applied.reason).toBeUndefined();
    } finally {
      fake.stop();
    }
  });

  it('opens the Linear client with the value the row decrypts to, and opens none once the row is revoked', async (): Promise<void> => {
    useSurfaceMode('real');
    const { api: liveApi, internal: liveInternal } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const credentialId = await harness.action(liveInternal.credentials.store, {
      userId: 'owner',
      kind: 'value',
      label: 'Linear API key',
      plaintext: TOKEN,
      source: 'entered',
    });

    const first = await approvedWrite(harness, 'linear', credentialId);
    await harness.action(liveInternal.workActions.applyApprovedActions, { workItemId: first });
    expect((await landed(harness, first)).applied.ok).toBe(true);
    expect(mcpCalls).toEqual([
      { bearer: TOKEN, tool: 'get_issue' },
      { bearer: TOKEN, tool: 'save_comment' },
    ]);

    await harness
      .withIdentity(managerIdentity())
      .mutation(liveApi.credentials.revoke, { credentialId });
    const second = await approvedWrite(harness, 'linear', credentialId);
    await harness.action(liveInternal.workActions.applyApprovedActions, { workItemId: second });
    // The re-read before the first write cannot open the client, so the write is withheld.
    const refused = await landed(harness, second);
    expect(refused).toMatchObject({ state: 'failed', applied: { held: true } });
    expect(refused.applied.reason).toContain('Credential is unavailable');
    expect(mcpCalls).toHaveLength(2);
  });
});

describe('the sync generation fence on the credential store (step 14)', (): void => {
  it('refuses a superseded sync the revival of a credential the newer sync retired, and lets the running one store', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seedSource(harness, 'owner');
    const source = { sourceId, ref: 'linear-automation#credential=1' };
    const args = { userId: 'owner', kind: 'value' as const, label: 'linear service token', source };
    const stale = await harness.mutation(internal.docSources.beginSync, { sourceId });
    const credentialId = await harness.action(internal.credentials.store, {
      ...args,
      plaintext: SECRET,
      syncRunId: stale,
    });
    // A newer sync starts, no longer finds the value and retires the row.
    const newer = await harness.mutation(internal.docSources.beginSync, { sourceId });
    await harness.mutation(internal.docSources.finishSync, {
      sourceId,
      runId: newer,
      refs: [],
      credentialRefs: [],
      pageCount: 0,
      redactionCount: 0,
    });
    expect((await rows(harness))[0]).toMatchObject({ status: 'superseded' });

    // The older action, still on its last batch, finds the value again.
    await expect(
      harness.action(internal.credentials.store, { ...args, plaintext: SECRET, syncRunId: stale }),
    ).rejects.toThrow('superseded by a newer one');
    await expect(
      harness.action(internal.credentials.store, { ...args, plaintext: ROTATED, syncRunId: stale }),
    ).rejects.toThrow('superseded by a newer one');
    expect(await rows(harness)).toEqual([
      expect.objectContaining({ _id: credentialId, status: 'superseded' }),
    ]);

    const current = await harness.mutation(internal.docSources.beginSync, { sourceId });
    await expect(
      harness.action(internal.credentials.store, {
        ...args,
        plaintext: SECRET,
        syncRunId: current,
      }),
    ).resolves.toBe(credentialId);
    expect((await rows(harness))[0]?.status).toBeUndefined();
  });
});

describe("the organisation's rows and the owner-keyed reads (11-AK, AC12)", (): void => {
  it('never returns an organisation row from an owner-keyed read: the summary, nor the exact-value list', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sealed = { ciphertext: 'sealed', iv: 'iv', createdAt: 1 } as const;
    const { ownerRow } = await harness.run(async (ctx) => {
      const ownerRow = await ctx.db.insert('credentials', {
        ...sealed,
        userId: 'owner',
        kind: 'value',
        label: 'Linear access',
        source: 'entered',
      });
      await ctx.db.insert('credentials', {
        ...sealed,
        userId: ORGANISATION_OWNER_KEY,
        holder: ORGANISATION_HOLDER,
        kind: 'value',
        label: 'Slack configuration refresh token',
        source: 'entered',
      });
      await ctx.db.insert('credentials', {
        ...sealed,
        userId: ORGANISATION_OWNER_KEY,
        holder: ORGANISATION_HOLDER,
        kind: 'oauth',
        label: 'Linear app actor token',
        source: 'oauth',
        issuedBy: { system: 'linear', grant: 'client-credentials' },
      });
      return { ownerRow };
    });

    const summary = await harness
      .withIdentity(managerIdentity())
      .query(api.credentials.summaryForOwner, {});
    expect(summary.map((row) => row._id)).toEqual([ownerRow]);
    const values = await harness.query(internal.credentials.activeValuesForOwner, {
      userId: 'owner',
    });
    expect(values.rows.map((row) => row._id)).toEqual([ownerRow]);
    // A manager signed in under another key reads none of them either.
    await expect(
      harness.withIdentity(managerIdentity('stranger')).query(api.credentials.summaryForOwner, {}),
    ).resolves.toEqual([]);
  });
});

describe('the organisation holder through the store (11-AO, AC12)', (): void => {
  const ORGANISATION_SECRET = 'xoxe-1234567890-abcdefghij';

  it('stores a value the organisation holds under the reserved key, sealed for it, and opens it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const credentialId = await harness.action(internal.credentials.store, {
      userId: ORGANISATION_OWNER_KEY,
      holder: ORGANISATION_HOLDER,
      kind: 'value',
      label: 'Slack configuration refresh token',
      plaintext: ORGANISATION_SECRET,
      source: 'entered',
    });
    const [row] = await rows(harness);
    expect(row).toMatchObject({
      _id: credentialId,
      userId: ORGANISATION_OWNER_KEY,
      holder: ORGANISATION_HOLDER,
      keyId: credentialKeyId(process.env.DAY0_CREDENTIAL_KEY ?? ''),
    });
    expect(JSON.stringify(row)).not.toContain(ORGANISATION_SECRET);
    await expect(harness.action(internal.credentials.decrypt, { credentialId })).resolves.toBe(
      ORGANISATION_SECRET,
    );
  });

  it('refuses a holder and a key that disagree, and a page-derived organisation value, storing nothing', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seedSource(harness, ORGANISATION_OWNER_KEY);
    const base = { kind: 'value' as const, label: 'secret', plaintext: ORGANISATION_SECRET };
    await expect(
      harness.action(internal.credentials.store, {
        ...base,
        userId: 'owner',
        holder: ORGANISATION_HOLDER,
        source: 'entered',
      }),
    ).rejects.toThrow(/organisation/);
    await expect(
      harness.action(internal.credentials.store, {
        ...base,
        userId: ORGANISATION_OWNER_KEY,
        source: 'entered',
      }),
    ).rejects.toThrow(/organisation/);
    await expect(
      harness.action(internal.credentials.store, {
        ...base,
        userId: ORGANISATION_OWNER_KEY,
        holder: ORGANISATION_HOLDER,
        source: { sourceId, ref: 'slack-config' },
      }),
    ).rejects.toThrow(/organisation/);
    await expect(
      harness.mutation(internal.credentials.persistEncrypted, {
        userId: ORGANISATION_OWNER_KEY,
        kind: 'value',
        label: 'secret',
        ciphertext: 'sealed',
        iv: 'iv',
        keyId: 'key',
        source: 'entered',
        rotated: false,
      }),
    ).rejects.toThrow(/organisation/);
    expect(await rows(harness)).toEqual([]);
  });

  it('counts only the owners’ credentials for the setup diagnostic, never the organisation’s', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await harness.action(internal.credentials.store, {
      userId: ORGANISATION_OWNER_KEY,
      holder: ORGANISATION_HOLDER,
      kind: 'value',
      label: 'Linear client secret',
      plaintext: ORGANISATION_SECRET,
      source: 'entered',
    });
    await expect(harness.query(internal.credentials.countStored, {})).resolves.toBe(0);
    await harness.action(internal.credentials.store, {
      userId: 'owner',
      kind: 'value',
      label: 'Linear access',
      plaintext: SECRET,
      source: 'entered',
    });
    await expect(harness.query(internal.credentials.countStored, {})).resolves.toBe(1);
  });
});

describe('the issuer stored with a value Day0 obtained (the pre-tag item 10)', (): void => {
  const CLIENT_SECRET = 'w11as-secret-0123';
  const ISSUED = {
    system: 'slack',
    grant: 'app-created' as const,
    appId: 'A0APP1',
    clientId: '1234.1',
  };

  it('writes the issuer in the same write as the sealed value, so no such row is ever without it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const credentialId = await harness.action(internal.credentials.store, {
      userId: ORGANISATION_OWNER_KEY,
      holder: ORGANISATION_HOLDER,
      kind: 'oauth',
      label: 'Leo (Day0) client secret',
      plaintext: CLIENT_SECRET,
      source: 'oauth',
      appId: 'A0APP1',
      issuedBy: ISSUED,
    });

    const [row] = await rows(harness);
    expect(row).toMatchObject({ _id: credentialId, issuedBy: ISSUED });
    await expect(harness.action(internal.credentials.decrypt, { credentialId })).resolves.toBe(
      CLIENT_SECRET,
    );
  });

  it('refuses an issuer on a value found in documentation, which Day0 never obtained, storing nothing', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seedSource(harness, 'owner');

    await expect(
      harness.action(internal.credentials.store, {
        userId: 'owner',
        kind: 'value',
        label: 'Slack token',
        plaintext: CLIENT_SECRET,
        source: { sourceId, ref: 'slack-token' },
        issuedBy: ISSUED,
      }),
    ).rejects.toThrow('A value found in documentation is never one Day0 obtained');
    expect(await rows(harness)).toEqual([]);
  });
});

describe('a credential Day0 obtained, held for its revocation at the vendor (11-AR, F19)', (): void => {
  const BOT_TOKEN = ['xoxb', '1234567890', 'abcdefghij'].join('-');

  /** Store a bot token as the install path does, and name how Day0 obtained it. */
  async function issuedToken(harness: TestConvex<typeof schema>): Promise<Id<'credentials'>> {
    const credentialId = await harness.action(internal.credentials.store, {
      userId: 'owner',
      kind: 'oauth',
      label: 'Slack bot token',
      plaintext: BOT_TOKEN,
      source: 'oauth',
      appId: 'A0W11AR',
    });
    await harness.run(async (ctx) => {
      await ctx.db.patch(credentialId, {
        issuedBy: { system: 'slack', grant: 'oauth-install', appId: 'A0W11AR' },
      });
    });
    return credentialId;
  }

  it('is unusable at once and keeps its ciphertext while the vendor call is pending', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const credentialId = await issuedToken(harness);
    await harness.run(async (ctx) => {
      const row = await ctx.db.get(credentialId);
      await credentialsModule.holdForSourceRevocation(ctx, row!, 'disconnect', 1_000);
    });
    const [held] = await rows(harness);
    expect(held).toMatchObject({
      revokedAt: 1_000,
      sourceRevocation: { state: 'pending', attempts: 0, at: 1_000, end: 'disconnect' },
    });
    expect(held.ciphertext).toEqual(expect.any(String));
    await expect(harness.action(internal.credentials.decrypt, { credentialId })).rejects.toThrow(
      'Credential is unavailable.',
    );
    await expect(
      harness.action(internal.credentials.decryptForRevocation, { credentialId }),
    ).resolves.toBe(BOT_TOKEN);
  });

  it('keeps a pending row’s ciphertext through a purge, and deletes it once the revocation is final', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const credentialId = await issuedToken(harness);
    await harness.run(async (ctx) => {
      await credentialsModule.holdForSourceRevocation(
        ctx,
        (await ctx.db.get(credentialId))!,
        'retire',
        1_000,
      );
      await credentialsModule.purgeCredential(ctx, (await ctx.db.get(credentialId))!, 2_000);
    });
    expect((await rows(harness))[0].ciphertext).toEqual(expect.any(String));
    await harness.run(async (ctx) => {
      await credentialsModule.finishSourceRevocation(ctx, (await ctx.db.get(credentialId))!, {
        state: 'done',
        now: 3_000,
      });
    });
    const [finished] = await rows(harness);
    expect(finished).toMatchObject({
      revokedAt: 1_000,
      sourceRevocation: { state: 'done', attempts: 0, at: 3_000, end: 'retire' },
    });
    expect(finished.ciphertext).toBeUndefined();
    expect(finished.iv).toBeUndefined();
    await expect(
      harness.action(internal.credentials.decryptForRevocation, { credentialId }),
    ).rejects.toThrow('Credential is not awaiting its revocation at the vendor.');
  });

  it('opens a revoked MCP client connection’s secret only for the end its own revoke made (join 8)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const secretId = await harness.action(internal.credentials.store, {
      userId: ORGANISATION_OWNER_KEY,
      holder: ORGANISATION_HOLDER,
      kind: 'value',
      label: 'Docs MCP client secret',
      plaintext: SECRET,
      source: 'entered',
    });
    const tokenId = await harness.run(async (ctx) => {
      const connectionId = await ctx.db.insert('organisationConnections', {
        system: 'mcp:auth.acme.test',
        displayName: 'Docs MCP',
        kind: 'mcp-client',
        mode: 'per-employee',
        clientId: 'day0-mcp',
        scopes: [],
        secretCredentialId: secretId,
        registeredBy: { via: 'setup-cli', at: 1 },
        status: 'revoked',
        revokedAt: 1_000,
        createdAt: 1,
      });
      await ctx.db.patch(secretId, { revokedAt: 1_000 });
      return await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'oauth',
        label: 'Docs access token',
        ciphertext: 'sealed',
        iv: 'iv',
        source: 'oauth',
        createdAt: 1,
        issuedBy: {
          system: 'mcp:auth.acme.test',
          grant: 'authorisation-code',
          organisationConnectionId: connectionId,
        },
        revokedAt: 1_000,
        sourceRevocation: { state: 'pending', attempts: 0, end: 'organisation-revoked' },
      });
    });
    await expect(
      harness.action(internal.credentials.decryptConnectionSecretForRevocation, {
        credentialId: tokenId,
      }),
    ).resolves.toBe(SECRET);
    await expect(
      harness.action(internal.credentials.decrypt, { credentialId: secretId }),
    ).rejects.toThrow('Credential is unavailable.');
    for (const sourceRevocation of [
      { state: 'pending' as const, attempts: 0, end: 'disconnect' as const },
      { state: 'done' as const, attempts: 1, end: 'organisation-revoked' as const },
    ]) {
      await harness.run(async (ctx) => await ctx.db.patch(tokenId, { sourceRevocation }));
      await expect(
        harness.action(internal.credentials.decryptConnectionSecretForRevocation, {
          credentialId: tokenId,
        }),
      ).rejects.toThrow("The connection's client secret is not admitted for this revocation.");
    }
  });

  it('never opens a pasted key for a vendor call, even one marked pending', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const credentialId = await harness.action(internal.credentials.store, {
      userId: 'owner',
      kind: 'value',
      label: 'Linear access',
      plaintext: SECRET,
      source: 'entered',
    });
    await harness.run(async (ctx) => {
      await ctx.db.patch(credentialId, {
        revokedAt: 1_000,
        sourceRevocation: { state: 'pending', attempts: 0, at: 1_000, end: 'disconnect' },
      });
    });
    await expect(
      harness.action(internal.credentials.decryptForRevocation, { credentialId }),
    ).rejects.toThrow('Credential is not awaiting its revocation at the vendor.');
    await harness.run(async (ctx) => {
      await expect(
        credentialsModule.holdForSourceRevocation(
          ctx,
          (await ctx.db.get(credentialId))!,
          'disconnect',
          1_000,
        ),
      ).rejects.toThrow('A pasted key is never revoked at the vendor.');
    });
  });
});
