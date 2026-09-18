/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import * as cryptoActions from '../../convex/credentialCryptoActions';
import * as credentialsModule from '../../convex/credentials';
import * as eventsModule from '../../convex/events';
import * as exportActions from '../../convex/exportActions';
import { redactCredentials } from '../../src/docs/redaction';
import { CORPUS_SLOTS } from '../fixtures/redaction-corpus';
import { ScriptedSpanModel } from '../fixtures/redaction-double';
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

describe('the public API surface and decryption', (): void => {
  it('has no public query in a module that can reach a decrypted value', (): void => {
    const modules = readdirSync('convex').filter((name: string): boolean => name.endsWith('.ts'));
    const reaches = /credential-crypto|credentialCryptoActions|ownerKnownValues|ownerValuesRef|credentials\.decrypt|DAY0_CREDENTIAL_KEY|ciphertext/;
    // Each exported definition is one chunk; a public query's chunk is its handler.
    const offenders = modules.flatMap((name: string): string[] =>
      readFileSync(join('convex', name), 'utf8')
        .split(/\nexport const /)
        .filter((chunk: string): boolean => /^\w+ = query\(\{/.test(chunk) && reaches.test(chunk))
        .map((chunk: string): string => `${name}: ${chunk.split(' ', 1)[0]}`),
    );
    expect(offenders).toEqual([]);
    expect(eventsModule.exportForAgent.isInternal).toBe(true);
    expect(exportActions.exportForAgent.isPublic).toBe(true);
  });
});

it('keeps a page-derived password that happens to look like a scope, by its label', async () => {
  const harness = convexTest(schema, allConvexModules());
  const passwordId = await insertRow(harness, { userId: 'owner', label: 'looker password', plaintext: 'ops:hunter2' });
  const scopeId = await insertRow(harness, { userId: 'owner', label: 'slack credential', plaintext: 'chat:write' });
  await harness.run(async (ctx) => {
    const sourceId = await ctx.db.insert('docSources', {
      userId: 'owner', label: 'Handbook', kind: 'folder', locator: '.', status: 'synced', createdAt: 1, updatedAt: 1,
    });
    await ctx.db.patch(passwordId, { source: { sourceId, ref: 'looker.md' } });
    await ctx.db.patch(scopeId, { source: { sourceId, ref: 'slack.md' } });
  });
  expect(await harness.action(internal.credentialCryptoActions.ownerValues, { userId: 'owner' })).toEqual(['ops:hunter2']);
  const rows = await harness.run(async (ctx) => ({
    password: (await ctx.db.get(passwordId))!,
    scope: (await ctx.db.get(scopeId))!,
  }));
  expect(cryptoActions.storedCredentialGuardReason(rows.password)).toBeUndefined();
  expect(cryptoActions.storedCredentialGuardReason(rows.scope)).toBe('permission scope');
});

it('lets resync repair an old scope row instead of redacting it as a known value forever', async () => {
  const harness = convexTest(schema, allConvexModules());
  const credentialId = await insertRow(harness, { userId: 'owner', label: 'Slack credential', plaintext: 'users:read' });
  await harness.run(async (ctx) => {
    const sourceId = await ctx.db.insert('docSources', {
      userId: 'owner', label: 'Handbook', kind: 'folder', locator: '.', status: 'synced', createdAt: 1, updatedAt: 1,
    });
    await ctx.db.patch(credentialId, { source: { sourceId, ref: 'slack.md' } });
  });
  const known = await harness.action(internal.credentialCryptoActions.ownerValues, { userId: 'owner' });
  const markdown = readFileSync('tests/fixtures/slack-manifest-scopes.md', 'utf8');
  const model = new ScriptedSpanModel((text) => [...text.matchAll(/[a-z]+:[a-z]+(?:\.[a-z]+)?/g)].map((match) => ({
    start: match.index!, end: match.index! + match[0].length, label: 'credential', score: 0.99,
  })));
  expect((await redactCredentials(markdown, 'Slack automation policy', { model, known })).credentials).toEqual([]);
  // Explicitly entered material still participates in exact-value protection.
  await insertRow(harness, { userId: 'owner', label: 'Entered value', plaintext: 'users:read' });
  expect(await harness.action(internal.credentialCryptoActions.ownerValues, { userId: 'owner' })).toEqual(['users:read']);
});

it('leaves a stored channel name or method name out of exact removal while every real secret stays in', async () => {
  const harness = convexTest(schema, allConvexModules());
  const dotted = ['Ops', 'Desk', 'Winter'].join('.');
  // The rows a sync at 0acb98f left behind: the two originals, and the copies the
  // owner-wide removal itself stored under other pages' refs.
  const stored = {
    channel: await insertRow(harness, { userId: 'owner', label: 'revenue operations token', plaintext: '#ops-requests' }),
    method: await insertRow(harness, { userId: 'owner', label: 'slack token', plaintext: 'users.lookupByEmail' }),
    spread: await insertRow(harness, { userId: 'owner', label: 'slack credential', plaintext: '#ops-requests' }),
    slack: await insertRow(harness, { userId: 'owner', label: 'slack bot token', plaintext: CORPUS_SLOTS.slack_bot_token }),
    linear: await insertRow(harness, { userId: 'owner', label: 'linear service token', plaintext: CORPUS_SLOTS.linear_token }),
    generic: await insertRow(harness, { userId: 'owner', label: 'warehouse api key', plaintext: CORPUS_SLOTS.client_secret }),
    dotted: await insertRow(harness, { userId: 'owner', label: 'looker password', plaintext: dotted }),
  };
  await harness.run(async (ctx) => {
    const sourceId = await ctx.db.insert('docSources', {
      userId: 'owner', label: 'Handbook', kind: 'folder', locator: '.', status: 'synced', createdAt: 1, updatedAt: 1,
    });
    for (const [ref, id] of Object.entries(stored)) await ctx.db.patch(id, { source: { sourceId, ref: `${ref}.md` } });
  });
  const values = await harness.action(internal.credentialCryptoActions.ownerValues, { userId: 'owner' });
  expect([...values].sort()).toEqual(
    [CORPUS_SLOTS.slack_bot_token, CORPUS_SLOTS.linear_token, CORPUS_SLOTS.client_secret, dotted].sort(),
  );
  const rows = await harness.run(async (ctx) => ({
    channel: (await ctx.db.get(stored.channel))!,
    method: (await ctx.db.get(stored.method))!,
    dotted: (await ctx.db.get(stored.dotted))!,
  }));
  expect(cryptoActions.storedCredentialGuardReason(rows.channel)).toBe('channel reference');
  expect(cryptoActions.storedCredentialGuardReason(rows.method)).toBe('dotted identifier');
  expect(cryptoActions.storedCredentialGuardReason(rows.dotted)).toBeUndefined();
  // A value a person typed in is theirs to protect, whatever its shape.
  await insertRow(harness, { userId: 'owner', label: 'Entered value', plaintext: '#ops-requests' });
  expect(await harness.action(internal.credentialCryptoActions.ownerValues, { userId: 'owner' })).toContain('#ops-requests');
});
