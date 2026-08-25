import type { GenericId } from 'convex/values';
import { v } from 'convex/values';
import { internalAction, internalQuery } from '../../../convex/_generated/server';
import { fakeCredentialKey, fakeCredentialState } from './credential-registry';

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
    source: v.union(
      v.object({ sourceId: v.id('docSources'), ref: v.string() }),
      v.literal('entered'),
    ),
    appId: v.optional(v.string()),
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

/** Mirror lane A's `by_user_source_ref` read used to resolve a page marker. */
export const bySourceForStore = internalQuery({
  args: { userId: v.string(), sourceId: v.id('docSources'), ref: v.string() },
  handler: async (
    _ctx,
    args,
  ): Promise<{ _id: GenericId<'credentials'>; label: string; revokedAt?: number } | null> => {
    const row = fakeCredentialState().rows.get(
      fakeCredentialKey(args.userId, String(args.sourceId), args.ref),
    );
    return row ? { _id: row._id, label: row.label, revokedAt: row.revokedAt } : null;
  },
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
