import { sealForOwner } from '../../../src/lib/credential-crypto';
import { credentialPageRef } from '../../../src/docs/credential-ref';
import type { GenericId } from 'convex/values';
import { v } from 'convex/values';
import { internalAction, internalQuery } from '../../../convex/_generated/server';
import type { Doc } from '../../../convex/_generated/dataModel';
import { fakeCredentialState } from './credential-registry';

const credentialKind = v.union(v.literal('value'), v.literal('location'), v.literal('oauth'));

/**
 * Mirror lane A's `store` contract: a value-bearing kind needs plaintext.
 *
 * Nothing is persisted by this fake beyond the recorded call, so a test can
 * assert that orientation never tries to store a value it does not have.
 */
export const store = internalAction({
  args: {
    userId: v.string(),
    kind: credentialKind,
    label: v.string(),
    plaintext: v.optional(v.string()),
    explicitlyAssigned: v.optional(v.boolean()),
    quoted: v.optional(v.boolean()),
    source: v.union(
      v.object({ sourceId: v.id('docSources'), ref: v.string() }),
      v.literal('entered'),
    ),
    appId: v.optional(v.string()),
    /** The sync generation that found the value, as the real store takes it. */
    syncRunId: v.optional(v.id('docSyncRuns')),
  },
  handler: async (_ctx, args): Promise<GenericId<'credentials'>> => {
    fakeCredentialState().storeCalls.push({
      kind: args.kind,
      label: args.label,
      plaintext: args.plaintext,
      source: args.source,
    });
    if (args.plaintext === undefined && args.kind !== 'location') {
      throw new Error('Credential plaintext is required.');
    }
    return 'entered-credential' as GenericId<'credentials'>;
  },
});

/**
 * Mirror lane A's `pageRowsByLabel`, the read orientation binds a page marker
 * through: the live rows of one page carrying the marker's label, oldest
 * (first seeded) first, each sealed to its owner as the store seals it.
 */
export const pageRowsByLabel = internalQuery({
  args: {
    userId: v.string(),
    sourceId: v.id('docSources'),
    pageRef: v.string(),
    label: v.string(),
  },
  handler: async (_ctx, args): Promise<Doc<'credentials'>[]> => {
    const wanted = args.label.trim().toLowerCase();
    return [...fakeCredentialState().rows.values()]
      .filter(
        (row): boolean =>
          row.userId === args.userId &&
          row.sourceId === String(args.sourceId) &&
          credentialPageRef(row.ref) === args.pageRef &&
          row.revokedAt === undefined &&
          row.label.trim().toLowerCase() === wanted,
      )
      .map((row): Doc<'credentials'> => {
        const key = process.env.DAY0_CREDENTIAL_KEY;
        if (key === undefined) throw new Error('DAY0_CREDENTIAL_KEY is not configured.');
        return {
          _id: row._id,
          _creationTime: 1,
          userId: row.userId,
          kind: 'value',
          label: row.label,
          source: { sourceId: args.sourceId, ref: row.ref },
          createdAt: 1,
          explicitlyAssigned: row.explicitlyAssigned,
          ...sealForOwner(row.plaintext, { current: key }, row.userId),
        };
      });
  },
});

/**
 * Mirror lane A's `pageRowsForStore`: every row of one page, which the sync reads for a page it
 * keeps as stored (14-I) and for one it could not read, sealed to its owner as the store seals it.
 */
export const pageRowsForStore = internalQuery({
  args: { userId: v.string(), sourceId: v.id('docSources'), pageRef: v.string() },
  handler: async (_ctx, args): Promise<Doc<'credentials'>[]> =>
    [...fakeCredentialState().rows.values()]
      .filter(
        (row): boolean =>
          row.userId === args.userId &&
          row.sourceId === String(args.sourceId) &&
          credentialPageRef(row.ref) === args.pageRef,
      )
      .map((row): Doc<'credentials'> => {
        const key = process.env.DAY0_CREDENTIAL_KEY;
        if (key === undefined) throw new Error('DAY0_CREDENTIAL_KEY is not configured.');
        return {
          _id: row._id,
          _creationTime: 1,
          userId: row.userId,
          kind: 'value',
          label: row.label,
          source: { sourceId: args.sourceId, ref: row.ref },
          createdAt: 1,
          explicitlyAssigned: row.explicitlyAssigned,
          ...(row.revokedAt !== undefined ? { revokedAt: row.revokedAt } : {}),
          ...sealForOwner(row.plaintext, { current: key }, row.userId),
        };
      }),
});

/** Mirror lane A's list for the exact-value layer: these fixtures store nothing to remove. */
export const activeValuesForOwner = internalQuery({
  args: { userId: v.string() },
  handler: async (): Promise<{ overflow: boolean; rows: never[] }> => ({
    overflow: false,
    rows: [],
  }),
});

/** Mirror lane A's `decrypt`: an unknown or revoked row is unavailable. */
export const decrypt = internalAction({
  args: { credentialId: v.id('credentials') },
  handler: async (_ctx, args): Promise<string> => {
    const row = [...fakeCredentialState().rows.values()].find(
      (candidate): boolean => candidate._id === args.credentialId,
    );
    if (!row || row.revokedAt !== undefined) throw new Error('Credential is unavailable.');
    return row.plaintext;
  },
});
