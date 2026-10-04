import { v, type Infer } from 'convex/values';
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { getCallerOrThrow } from './ownership';
import { credentialIssuerValidator } from './schema';
import { isOrganisationOwnerKey, ORGANISATION_HOLDER } from '../src/lib/organisation-key';
import { OWNER_KNOWN_VALUE_CAP } from '../src/redaction/known-values';
import { credentialPageRef, credentialRefRange, isValueKeyedRef } from '../src/docs/credential-ref';
import { assertCurrentGeneration } from '../src/docs/sync-generation';
import type { AccessEnd, SourceRevocationState } from '../src/surfaces/access-identity';

const credentialKind = v.union(v.literal('value'), v.literal('location'), v.literal('oauth'));

const credentialSource = v.union(
  v.object({ sourceId: v.id('docSources'), ref: v.string() }),
  v.literal('entered'),
  v.literal('oauth'),
);

type CredentialKind = 'value' | 'location' | 'oauth';

/** Who holds a row other than its owner: only the organisation, under the reserved key (AC12). */
const credentialHolder = v.literal(ORGANISATION_HOLDER);

/** Why a write is refused whose holder and owner key disagree. */
const ORGANISATION_HOLDER_MISMATCH =
  'An organisation credential is stored under the reserved organisation key and only there.';

/** Why an organisation credential from a documentation page is refused. */
const ORGANISATION_PAGE_SOURCE =
  "An organisation credential is entered by IT or issued to Day0, never read off an owner's page.";

/**
 * Refuse an issuer on a value found in documentation: Day0 obtains a value through an issuer or an
 * install, never from a page, and a page-derived row is upserted by its page and ref.
 *
 * @throws Error when a page-derived value names an issuer.
 */
function assertIssuedNotFound(
  issuedBy: Infer<typeof credentialIssuerValidator> | undefined,
  source: Infer<typeof credentialSource>,
): void {
  if (issuedBy !== undefined && pageSource(source) !== undefined) {
    throw new Error(
      'A value found in documentation is never one Day0 obtained; nothing was stored.',
    );
  }
}

/**
 * Refuse a credential write whose holder and owner key disagree (AC12): a row the organisation
 * holds carries `holder: 'organisation'` and the reserved key together, so an owner-keyed read
 * never reaches it by index and its seal binds the organisation; and it is never page-derived,
 * since every documentation source is an owner's.
 *
 * @throws Error naming the organisation when the holder, the key or the source disagree.
 */
function assertHolderOfKey(
  userId: string,
  holder: typeof ORGANISATION_HOLDER | undefined,
  source: CredentialSource,
): void {
  const organisationKey = isOrganisationOwnerKey(userId);
  if (organisationKey !== (holder === ORGANISATION_HOLDER)) {
    throw new Error(ORGANISATION_HOLDER_MISMATCH);
  }
  if (organisationKey && pageSource(source) !== undefined) {
    throw new Error(ORGANISATION_PAGE_SOURCE);
  }
}

type CredentialSource = { ref: string; sourceId: Id<'docSources'> } | 'entered' | 'oauth';

/**
 * Whether a credential came from a documentation page rather than a person or
 * a provider handshake.
 *
 * Only a page-derived credential is upserted by `(userId, sourceId, ref)`; a
 * typed value and an OAuth grant each stand alone, so neither is deduplicated
 * against a page that never held it.
 */
function pageSource(
  source: CredentialSource,
): { ref: string; sourceId: Id<'docSources'> } | undefined {
  return typeof source === 'string' ? undefined : source;
}

/**
 * Validate credential material without normalising its bytes.
 *
 * Args:
 *   kind: Credential acquisition kind.
 *   plaintext: Optional secret supplied by the caller.
 *
 * Returns:
 *   The exact supplied value, or an empty sentinel for an unlanded location.
 *
 * Raises:
 *   Error: If a value-bearing credential has no plaintext.
 */
function credentialPlaintext(kind: CredentialKind, plaintext?: string): string {
  if (kind === 'location' && !plaintext) return '';
  if (!plaintext) throw new Error('Credential plaintext is required.');
  return plaintext;
}

/**
 * Refuse a sync's write once its generation is superseded (step 14): a stale
 * action must not revive a row the newer generation retired. A write that
 * names no generation is not a sync's and is not fenced.
 *
 * @throws Error when the write names a generation that may no longer write.
 */
async function fenceSyncWrite(
  ctx: MutationCtx,
  sourceId: Id<'docSources'> | undefined,
  syncRunId: Id<'docSyncRuns'> | undefined,
): Promise<void> {
  if (syncRunId === undefined) return;
  if (sourceId === undefined) throw new Error('A sync writes only page-derived credentials.');
  await assertCurrentGeneration(ctx, sourceId, syncRunId);
}

/**
 * The migration that re-seals every stored value bound to its owner under the
 * current key and writes its key id (decision Q15). Its completion is the
 * switch that ends the unbound open of a row without a key id.
 */
export const CREDENTIAL_RESEAL_MIGRATION = 'credentials-reseal';

/**
 * The migration that rewrites each page-derived row's ref to the value-keyed
 * form (`credentialSourceRef`), which it must open the value to fingerprint.
 * It runs after the re-seal, so every row it opens is bound to its owner.
 */
export const CREDENTIAL_VALUE_REF_MIGRATION = 'credentials-value-refs';

/**
 * Whether a row without a key id may still open unbound: true until the
 * re-seal has run to the end, so no legacy row stops opening part-way through,
 * and false from then on, so an unbound value put on a row since is refused.
 *
 * @param ctx - A query or mutation context.
 */
export async function unboundOpenAllowed(ctx: QueryCtx): Promise<boolean> {
  const reseal = await ctx.db
    .query('migrations')
    .withIndex('by_name', (index) => index.eq('name', CREDENTIAL_RESEAL_MIGRATION))
    .unique();
  return reseal?.completedAt === undefined;
}

/**
 * How the Node side may open a stored value right now. Internal; read by
 * `credentialCryptoActions.open` before it decrypts.
 */
export const openingPolicy = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ allowUnbound: boolean }> => ({
    allowUnbound: await unboundOpenAllowed(ctx),
  }),
});

/** The reason a rotated row keeps a person's revoke, shown with the credential. */
export const REVOKE_STANDS_REASON =
  'Revoked by a person. The page now holds a different value; it stays revoked until a person lands or approves one.';

/**
 * Store encrypted credential bytes, upserting page-derived rows by source.
 * Internal; written by `store`. A row the organisation holds carries its
 * holder and the reserved key together, or nothing is written.
 *
 * A changed source value is a rotation: the stable row takes the new value
 * and its usage restarts. Only a person sets `revokedAt`, so neither a
 * rotation nor an unchanged value clears it; a sync can never undo a
 * person's revoke, and a revoked row that rotates says so in its reason.
 */
export const persistEncrypted = internalMutation({
  args: {
    userId: v.string(),
    kind: credentialKind,
    label: v.string(),
    ciphertext: v.string(),
    iv: v.string(),
    /** The id of the key that sealed `ciphertext`, bound to `userId`. */
    keyId: v.string(),
    explicitlyAssigned: v.optional(v.boolean()),
    quoted: v.optional(v.boolean()),
    source: credentialSource,
    appId: v.optional(v.string()),
    rotated: v.boolean(),
    syncRunId: v.optional(v.id('docSyncRuns')),
    /** `organisation` for a row the organisation holds, under the reserved key; absent for an owner's. */
    holder: v.optional(credentialHolder),
    /** How Day0 obtained the value, written with it (`store`'s `issuedBy`). */
    issuedBy: v.optional(credentialIssuerValidator),
  },
  handler: async (ctx, args): Promise<Id<'credentials'>> => {
    assertHolderOfKey(args.userId, args.holder, args.source);
    assertIssuedNotFound(args.issuedBy, args.source);
    const sourced = pageSource(args.source);
    await fenceSyncWrite(ctx, sourced?.sourceId, args.syncRunId);
    if (sourced) {
      // Unlink can commit while the store action is encrypting the value.
      const source = await ctx.db.get(sourced.sourceId);
      if (!source || source.userId !== args.userId) {
        throw new Error('Credential source does not belong to its owner.');
      }
    }
    const existing =
      sourced === undefined
        ? null
        : await ctx.db
            .query('credentials')
            .withIndex('by_user_source_ref', (index) =>
              index
                .eq('userId', args.userId)
                .eq('source.sourceId', sourced.sourceId)
                .eq('source.ref', sourced.ref),
            )
            .unique();
    if (!existing) {
      return await ctx.db.insert('credentials', {
        userId: args.userId,
        ...(args.holder === undefined ? {} : { holder: args.holder }),
        kind: args.kind,
        label: args.label,
        ciphertext: args.ciphertext,
        iv: args.iv,
        keyId: args.keyId,
        explicitlyAssigned: args.explicitlyAssigned,
        quoted: args.quoted,
        source: args.source,
        appId: args.appId,
        ...(args.issuedBy === undefined ? {} : { issuedBy: args.issuedBy }),
        createdAt: Date.now(),
      });
    }
    await ctx.db.patch(existing._id, {
      kind: args.kind,
      label: args.label,
      ciphertext: args.ciphertext,
      iv: args.iv,
      keyId: args.keyId,
      explicitlyAssigned: args.explicitlyAssigned,
      quoted: args.quoted,
      appId: args.appId,
      lastUsedAt: args.rotated ? undefined : existing.lastUsedAt,
      status: undefined,
      supersededAt: undefined,
      statusReason: existing.revokedAt && args.rotated ? REVOKE_STANDS_REASON : undefined,
    });
    return existing._id;
  },
});

/**
 * Update non-secret metadata without changing revocation or usage state.
 * Internal. Clears the status, so a row a sync superseded is live again once
 * its value is found again; a person's revoke stays, and so does its reason.
 */
export const updateMetadata = internalMutation({
  args: {
    credentialId: v.id('credentials'),
    kind: credentialKind,
    label: v.string(),
    appId: v.optional(v.string()),
    explicitlyAssigned: v.optional(v.boolean()),
    quoted: v.optional(v.boolean()),
    syncRunId: v.optional(v.id('docSyncRuns')),
  },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.credentialId);
    const source = row === null ? undefined : pageSource(row.source);
    await fenceSyncWrite(ctx, source?.sourceId, args.syncRunId);
    await ctx.db.patch(args.credentialId, {
      kind: args.kind,
      label: args.label,
      appId: args.appId,
      explicitlyAssigned: args.explicitlyAssigned,
      quoted: args.quoted,
      status: undefined,
      supersededAt: undefined,
      statusReason: row?.revokedAt && !row.status ? row.statusReason : undefined,
    });
  },
});

/** Read a page-derived credential while deciding whether a sync rotated it. */
export const bySourceForStore = internalQuery({
  args: {
    userId: v.string(),
    sourceId: v.id('docSources'),
    ref: v.string(),
  },
  handler: async (ctx, args) =>
    await ctx.db
      .query('credentials')
      .withIndex('by_user_source_ref', (index) =>
        index
          .eq('userId', args.userId)
          .eq('source.sourceId', args.sourceId)
          .eq('source.ref', args.ref),
      )
      .unique(),
});

/**
 * The most of an owner's rows the exact-value list reads past to find the
 * active ones. Revoked, superseded and purged rows are read but not counted
 * against the cap, so a sync that retires values cannot lock the owner out;
 * an owner with more rows than this still fails closed.
 */
const OWNER_CREDENTIAL_SCAN_LIMIT = 4 * OWNER_KNOWN_VALUE_CAP;

/** A row the exact-value layer decrypts: live, and holding a value. */
function activeValueRow(
  row: Doc<'credentials'>,
): row is Doc<'credentials'> & { ciphertext: string; iv: string } {
  return !row.revokedAt && !row.status && row.ciphertext !== undefined && row.iv !== undefined;
}

/**
 * The owner's active, value-bearing rows for the exact-value layer. Internal;
 * read by the Node action that decrypts them.
 *
 * Only the fields the Node action needs to decrypt leave this query, and
 * only to that action: it is internal, and the plaintext never comes back
 * through a query. The cap counts active rows only; the list overflows when
 * one more active row than the cap exists, or when the scan limit is reached
 * before the owner's rows end, because a list read through a bound is only
 * complete when the bound was not reached.
 */
export const activeValuesForOwner = internalQuery({
  args: { userId: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    overflow: boolean;
    allowUnbound: boolean;
    rows: Array<{
      _id: Id<'credentials'>;
      ciphertext: string;
      iv: string;
      keyId?: string;
      label: string;
      pageDerived: boolean;
      explicitlyAssigned?: boolean;
      quoted?: boolean;
    }>;
  }> => {
    const scanned = await ctx.db
      .query('credentials')
      .withIndex('by_userId', (index) => index.eq('userId', args.userId))
      .take(OWNER_CREDENTIAL_SCAN_LIMIT + 1);
    const active = scanned.slice(0, OWNER_CREDENTIAL_SCAN_LIMIT).filter(activeValueRow);
    return {
      overflow:
        scanned.length > OWNER_CREDENTIAL_SCAN_LIMIT || active.length > OWNER_KNOWN_VALUE_CAP,
      allowUnbound: await unboundOpenAllowed(ctx),
      rows: active.slice(0, OWNER_KNOWN_VALUE_CAP + 1).map((row) => ({
        _id: row._id,
        ciphertext: row.ciphertext,
        iv: row.iv,
        keyId: row.keyId,
        label: row.label,
        pageDerived: typeof row.source !== 'string',
        explicitlyAssigned: row.explicitlyAssigned,
        quoted: row.quoted,
      })),
    };
  },
});

/** Read one credential for an internal decrypt action. */
export const getInternal = internalQuery({
  args: { credentialId: v.id('credentials') },
  handler: async (ctx, args) => await ctx.db.get(args.credentialId),
});

/**
 * Revoke a credential and delete its ciphertext, keeping the row.
 *
 * The reset and unlink paths delete the value outright: nothing can be
 * rotated back into a source that no longer exists. The label, source and
 * dates stay so the audit trail still says what was held and when it ended.
 * A credential Day0 obtained whose revocation at the vendor is still pending
 * is revoked and keeps its ciphertext for that call (F19): its final state
 * deletes it (`finishSourceRevocation`), within 24 hours in any case.
 *
 * Args:
 *   ctx: Convex mutation context.
 *   credential: The row to purge.
 *   now: Revocation time for a row not yet revoked.
 */
export async function purgeCredential(
  ctx: MutationCtx,
  credential: Doc<'credentials'>,
  now: number,
): Promise<void> {
  if (credential.ciphertext === undefined && credential.iv === undefined && credential.revokedAt) {
    return;
  }
  // Deferred deletion (F19): a credential whose revocation at the vendor is still pending keeps
  // its ciphertext for that call, and only its final state deletes it (finishSourceRevocation).
  if (credential.sourceRevocation?.state === 'pending') {
    if (credential.revokedAt === undefined) await ctx.db.patch(credential._id, { revokedAt: now });
    return;
  }
  await ctx.db.patch(credential._id, {
    revokedAt: credential.revokedAt ?? now,
    ciphertext: undefined,
    iv: undefined,
  });
}

/**
 * Stop using a credential Day0 itself obtained and hold it for its revocation at the vendor (the
 * access plan, section 4.4; F19): revoked at once, so `decrypt` refuses it from this transaction
 * on, with its revocation `pending` for the end that asked and its ciphertext kept for the vendor
 * call. The hold stamps `revokedAt` itself, even over a person's earlier revoke, since the
 * attempts and the 24 hours the ciphertext is kept count from it. A row already pending or final
 * is left as it is.
 *
 * @param ctx - The ending transaction.
 * @param credential - A row that carries `issuedBy`.
 * @param end - The end of access that asked.
 * @param now - When the access ended.
 * @throws Error for a row without `issuedBy`: a pasted key is never revoked at the vendor (D5).
 */
export async function holdForSourceRevocation(
  ctx: MutationCtx,
  credential: Doc<'credentials'>,
  end: AccessEnd,
  now: number,
): Promise<void> {
  if (credential.issuedBy === undefined) {
    throw new Error('A pasted key is never revoked at the vendor.');
  }
  if (credential.sourceRevocation !== undefined) return;
  await ctx.db.patch(credential._id, {
    revokedAt: now,
    sourceRevocation: { state: 'pending', attempts: 0, at: now, end },
  });
}

/**
 * Write a held credential's final revocation state and delete its ciphertext (F19): `done`,
 * `not-supported`, or `failed` with the vendor's words. The attempts and the end are kept as the
 * attempts wrote them.
 *
 * @param ctx - The recording transaction.
 * @param credential - The held row.
 * @param outcome - The final state, when it was reached, and the vendor's words for a failure.
 */
export async function finishSourceRevocation(
  ctx: MutationCtx,
  credential: Doc<'credentials'>,
  outcome: {
    readonly state: Exclude<SourceRevocationState, 'pending'>;
    readonly now: number;
    readonly lastError?: string;
  },
): Promise<void> {
  const held = credential.sourceRevocation;
  await ctx.db.patch(credential._id, {
    revokedAt: credential.revokedAt ?? outcome.now,
    ciphertext: undefined,
    iv: undefined,
    sourceRevocation: {
      state: outcome.state,
      attempts: held?.attempts ?? 0,
      at: outcome.now,
      ...(held?.end !== undefined ? { end: held.end } : {}),
      ...(outcome.lastError !== undefined
        ? { lastError: outcome.lastError }
        : held?.lastError !== undefined
          ? { lastError: held.lastError }
          : {}),
    },
  });
}

/** The most credential rows one owner's purge, or the read of what it would take, reads. */
const OWNED_CREDENTIAL_LIMIT = 1_000;

/** One owner's credential rows, one past the limit so a read can tell it was reached. */
async function ownedCredentialRows(
  ctx: Pick<QueryCtx, 'db'>,
  userId: string,
): Promise<Doc<'credentials'>[]> {
  return await ctx.db
    .query('credentials')
    .withIndex('by_userId', (index) => index.eq('userId', userId))
    .take(OWNED_CREDENTIAL_LIMIT + 1);
}

/**
 * Whether {@link purgeOwnedCredentials} would take a stored value from the owner: a row that still
 * holds its ciphertext, is not held for its vendor's revocation (which keeps the value until that
 * call is final) and is not an identity kept for another owner's employee. Bounded as the purge
 * is; read by `reset.holdings`, so the deletion's card says only what the purge takes (the second
 * pass's code reader).
 *
 * @param ctx - A query's context.
 * @param userId - The owner.
 */
export async function holdsPurgeableCredential(
  ctx: Pick<QueryCtx, 'db'>,
  userId: string,
): Promise<boolean> {
  const live = (await ownedCredentialRows(ctx, userId)).filter(
    (row) => row.ciphertext !== undefined && row.sourceRevocation?.state !== 'pending',
  );
  if (live.length === 0) return false;
  const kept = await identitiesKeptForAnotherOwner(ctx, userId, live);
  return live.some((row) => !kept.has(row._id));
}

/**
 * Purge every credential one owner holds, for a reset that unlinks documentation, save an
 * identity another owner's employee still acts as: a token Day0 obtained through IT's
 * organisation connection that a handover kept for the employee (A25) stays, with its pair and
 * its app's secret, since ending it is the new manager's.
 *
 * Args:
 *   ctx: Convex mutation context.
 *   userId: Owner subject being reset.
 *
 * Returns:
 *   Number of rows purged.
 */
export async function purgeOwnedCredentials(ctx: MutationCtx, userId: string): Promise<number> {
  const rows = await ownedCredentialRows(ctx, userId);
  if (rows.length > OWNED_CREDENTIAL_LIMIT) {
    throw new Error('Owner exceeds 1,000 credentials.');
  }
  const keptForAnother = await identitiesKeptForAnotherOwner(ctx, userId, rows);
  const now = Date.now();
  let purged = 0;
  for (const row of rows) {
    if (keptForAnother.has(row._id)) continue;
    await purgeCredential(ctx, row, now);
    purged += 1;
  }
  return purged;
}

/**
 * The owner's rows that are an identity another owner's employee acts as since a handover kept
 * it (A25): each token issued through an organisation connection that a card of an employee the
 * owner no longer has binds, with its refresh token and its app's client secret.
 *
 * @param ctx - The reset's transaction, or the read of what it would take.
 * @param userId - The owner being reset.
 * @param rows - The owner's rows.
 */
async function identitiesKeptForAnotherOwner(
  ctx: Pick<QueryCtx, 'db'>,
  userId: string,
  rows: readonly Doc<'credentials'>[],
): Promise<Set<Id<'credentials'>>> {
  const issuedThroughConnection = rows.filter(
    (row) => row.issuedBy?.organisationConnectionId !== undefined,
  );
  const keptRows = await Promise.all(
    issuedThroughConnection.map(async (row) =>
      (await boundForAnotherOwner(ctx, userId, row)) ? row : null,
    ),
  );
  const kept = new Set<Id<'credentials'>>();
  for (const row of keptRows) {
    if (row === null) continue;
    kept.add(row._id);
    if (row.refreshCredentialId !== undefined) kept.add(row.refreshCredentialId);
    if (row.issuedBy?.clientSecretCredentialId !== undefined) {
      kept.add(row.issuedBy.clientSecretCredentialId);
    }
  }
  return kept;
}

/** The most cards one row's binders, or one connection's cards, are read for. */
const KEPT_IDENTITY_SCAN_LIMIT = 1_000;

/**
 * Whether a card of an employee another owner now has binds a row issued through an
 * organisation connection: as its credential, or as its app's client secret (a card Disconnect
 * left with only its app, then handed over).
 */
async function boundForAnotherOwner(
  ctx: Pick<QueryCtx, 'db'>,
  userId: string,
  row: Doc<'credentials'>,
): Promise<boolean> {
  const connectionId = row.issuedBy?.organisationConnectionId;
  const [byCredential, byConnection] = await Promise.all([
    ctx.db
      .query('surfaces')
      .withIndex('by_credentialId', (index) => index.eq('credentialId', row._id))
      .take(KEPT_IDENTITY_SCAN_LIMIT),
    connectionId === undefined || row.issuedBy?.grant !== 'app-created'
      ? Promise.resolve([])
      : ctx.db
          .query('surfaces')
          .withIndex('by_organisation_connection', (index) =>
            index.eq('organisationConnectionId', connectionId),
          )
          .take(KEPT_IDENTITY_SCAN_LIMIT),
  ]);
  const binders = [
    ...byCredential,
    ...byConnection.filter((card) => card.provisioning?.clientSecretCredentialId === row._id),
  ];
  const agents = await Promise.all(binders.map(async (card) => await ctx.db.get(card.agentId)));
  return agents.some((agent) => agent !== null && agent.userId !== userId);
}

/** Record credential use without exposing the decrypted value. */
export const touch = internalMutation({
  args: { credentialId: v.id('credentials') },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.patch(args.credentialId, { lastUsedAt: Date.now() });
  },
});

/** Revoke a credential after an already-authorised internal operation. */
export const revokeInternal = internalMutation({
  args: { credentialId: v.id('credentials') },
  handler: async (ctx, args): Promise<void> => {
    const credential = await ctx.db.get(args.credentialId);
    if (credential && !credential.revokedAt) {
      await ctx.db.patch(credential._id, { revokedAt: Date.now() });
    }
  },
});

/**
 * The most rows of one page a read returns. A page's rows are its live values
 * and every value a sync superseded there, which stays so it revives if it
 * returns; a page past this has had hundreds of values swapped on it, and the
 * read refuses rather than leave some of its rows out.
 */
const PAGE_ROW_LIMIT = 512;

/**
 * The page-derived rows of one page of one source, whatever shape of ref they
 * carry: value-keyed, or the page-only and position-and-label refs stored
 * before them.
 *
 * @param ctx - A query context.
 * @param page - The owner, the source and the page.
 * @throws Error when the page holds more rows than one read returns.
 */
async function pageRows(
  ctx: QueryCtx,
  page: { userId: string; sourceId: Id<'docSources'>; pageRef: string },
): Promise<Doc<'credentials'>[]> {
  const { from, to } = credentialRefRange(page.pageRef);
  const rows: Doc<'credentials'>[] = [];
  // The page-only ref and the refs extending it, each an exact index range, so
  // no other page's rows are read.
  for (const query of [
    ctx.db
      .query('credentials')
      .withIndex('by_user_source_ref', (index) =>
        index
          .eq('userId', page.userId)
          .eq('source.sourceId', page.sourceId)
          .eq('source.ref', page.pageRef),
      ),
    ctx.db
      .query('credentials')
      .withIndex('by_user_source_ref', (index) =>
        index
          .eq('userId', page.userId)
          .eq('source.sourceId', page.sourceId)
          .gte('source.ref', from)
          .lte('source.ref', to),
      ),
  ]) {
    for await (const row of query) {
      if (typeof row.source === 'string' || credentialPageRef(row.source.ref) !== page.pageRef) {
        continue;
      }
      if (rows.length === PAGE_ROW_LIMIT) {
        throw new Error(
          `A documentation page holds more than ${PAGE_ROW_LIMIT} stored credentials; it cannot be read whole.`,
        );
      }
      rows.push(row);
    }
  }
  return rows;
}

/**
 * The page-derived rows of one page of one source. Internal; read by `store`
 * before it inserts and by the sync for a page it could not read.
 */
export const pageRowsForStore = internalQuery({
  args: { userId: v.string(), sourceId: v.id('docSources'), pageRef: v.string() },
  handler: async (ctx, args): Promise<Doc<'credentials'>[]> => await pageRows(ctx, args),
});

/**
 * The live rows of one page whose label is the marker's, oldest first.
 * Internal; read by orientation to bind a `<credential: label, stored>`
 * marker to the row its sync stored, which a value-keyed ref does not name.
 * Oldest first is the page's own order when one sync stored them all, as
 * `store` runs in document order.
 */
export const pageRowsByLabel = internalQuery({
  args: {
    userId: v.string(),
    sourceId: v.id('docSources'),
    pageRef: v.string(),
    label: v.string(),
  },
  handler: async (ctx, args): Promise<Doc<'credentials'>[]> => {
    const wanted = args.label.trim().toLowerCase();
    return (await pageRows(ctx, args))
      .filter(
        (row) =>
          row.revokedAt === undefined &&
          row.status === undefined &&
          row.label.trim().toLowerCase() === wanted,
      )
      .sort((left, right) => left._creationTime - right._creationTime);
  },
});

/**
 * Move a page-derived row to the ref its page now gives its value, with the
 * metadata the sync found. Internal. Clears a sync's supersede like
 * `updateMetadata`; a person's revoke stays.
 *
 * @returns False, and nothing written, when the row is not the owner's page
 *   row on this source, has moved from the ref `store` read it at, or another
 *   row already holds the new ref.
 */
export const moveToRef = internalMutation({
  args: {
    credentialId: v.id('credentials'),
    userId: v.string(),
    fromRef: v.string(),
    source: v.object({ sourceId: v.id('docSources'), ref: v.string() }),
    kind: credentialKind,
    label: v.string(),
    appId: v.optional(v.string()),
    explicitlyAssigned: v.optional(v.boolean()),
    quoted: v.optional(v.boolean()),
    syncRunId: v.optional(v.id('docSyncRuns')),
  },
  handler: async (ctx, args): Promise<boolean> => {
    await fenceSyncWrite(ctx, args.source.sourceId, args.syncRunId);
    const row = await ctx.db.get(args.credentialId);
    if (
      !row ||
      row.userId !== args.userId ||
      typeof row.source === 'string' ||
      row.source.sourceId !== args.source.sourceId ||
      row.source.ref !== args.fromRef
    ) {
      return false;
    }
    const taken = await ctx.db
      .query('credentials')
      .withIndex('by_user_source_ref', (index) =>
        index
          .eq('userId', args.userId)
          .eq('source.sourceId', args.source.sourceId)
          .eq('source.ref', args.source.ref),
      )
      .first();
    if (taken) return false;
    await ctx.db.patch(row._id, {
      source: args.source,
      kind: args.kind,
      label: args.label,
      appId: args.appId,
      explicitlyAssigned: args.explicitlyAssigned,
      quoted: args.quoted,
      status: undefined,
      supersededAt: undefined,
      statusReason: undefined,
    });
    return true;
  },
});

/**
 * A row's value, or undefined when it holds none this deployment can read.
 *
 * @param ctx - The action context the Node decrypt runs through.
 * @param row - A stored credential row; its owner is the one its value must be bound to.
 */
async function storedValue(
  ctx: ActionCtx,
  row: Pick<Doc<'credentials'>, 'ciphertext' | 'iv' | 'userId' | 'keyId'>,
): Promise<string | undefined> {
  if (row.ciphertext === undefined || row.iv === undefined) return undefined;
  try {
    return await ctx.runAction(internal.credentialCryptoActions.open, {
      ciphertext: row.ciphertext,
      iv: row.iv,
      userId: row.userId,
      keyId: row.keyId,
    });
  } catch {
    // Sealed under a rotated DAY0_CREDENTIAL_KEY, or bound to another owner:
    // unreadable, so it holds no value this sync can match, and the page's
    // value replaces it rather than failing every sync of that page.
    return undefined;
  }
}

/**
 * Encrypt and store one credential through the stable lane-A contract.
 * Internal.
 *
 * A page-derived value is upserted by `(userId, sourceId, ref)`, its ref keyed
 * by the value's fingerprint (`credentialSourceRef`), so the same value found
 * again lands on its own row whatever its label or place on the page. A ref
 * the source has no row for is first looked for on the same page by value: a
 * row stored under a ref from before value-keyed refs, or under a fingerprint
 * taken with a key since rotated, is moved to the new ref rather than stored
 * again, so no known value mints a second row. The value is sealed bound to its
 * owner, so it opens only on that owner's row; a value the organisation holds
 * (`holder: 'organisation'` under the reserved key) is sealed bound to the
 * organisation (F18). A value Day0 itself obtained carries its `issuedBy`
 * into the same write, so no such row ever exists without it (a row without
 * one is read as a pasted key and never revoked at the vendor); a value found
 * in documentation never carries one. The Node-only AES operation is
 * isolated in `credentialCryptoActions` because Convex forbids a Node module
 * from also exporting this module's public query and mutation.
 */
export const store = internalAction({
  args: {
    userId: v.string(),
    kind: credentialKind,
    label: v.string(),
    plaintext: v.optional(v.string()),
    explicitlyAssigned: v.optional(v.boolean()),
    quoted: v.optional(v.boolean()),
    source: credentialSource,
    appId: v.optional(v.string()),
    /** The sync generation that found the value; every write it makes is fenced by it. */
    syncRunId: v.optional(v.id('docSyncRuns')),
    /**
     * `organisation` for a value the organisation holds (an organisation connection's secret),
     * with `userId` the reserved organisation key; absent for an owner's.
     */
    holder: v.optional(credentialHolder),
    /** How Day0 obtained the value (11-AR reads it to revoke it at the vendor); absent for a pasted one. */
    issuedBy: v.optional(credentialIssuerValidator),
  },
  handler: async (ctx, args): Promise<Id<'credentials'>> => {
    assertHolderOfKey(args.userId, args.holder, args.source);
    assertIssuedNotFound(args.issuedBy, args.source);
    const plaintext = credentialPlaintext(args.kind, args.plaintext);
    const sourced = pageSource(args.source);
    if (sourced) {
      const source = await ctx.runQuery(internal.docSources.getInternal, {
        sourceId: sourced.sourceId,
      });
      if (!source || source.userId !== args.userId) {
        throw new Error('Credential source does not belong to its owner.');
      }
    }
    const metadata = {
      kind: args.kind,
      label: args.label,
      appId: args.appId,
      explicitlyAssigned: args.explicitlyAssigned,
      quoted: args.quoted,
    };
    const existing = !sourced
      ? null
      : await ctx.runQuery(internal.credentials.bySourceForStore, {
          userId: args.userId,
          sourceId: sourced.sourceId,
          ref: sourced.ref,
        });
    // The same value found again: a row an earlier sync superseded because
    // its page went briefly missing is revived here.
    if (existing && (await storedValue(ctx, existing)) === plaintext) {
      await ctx.runMutation(internal.credentials.updateMetadata, {
        credentialId: existing._id,
        ...metadata,
        syncRunId: args.syncRunId,
      });
      return existing._id;
    }
    if (sourced && !existing && plaintext) {
      const pageRows = await ctx.runQuery(internal.credentials.pageRowsForStore, {
        userId: args.userId,
        sourceId: sourced.sourceId,
        pageRef: credentialPageRef(sourced.ref),
      });
      for (const row of pageRows) {
        if ((await storedValue(ctx, row)) !== plaintext) continue;
        if (typeof row.source === 'string') continue;
        const moved = await ctx.runMutation(internal.credentials.moveToRef, {
          credentialId: row._id,
          userId: args.userId,
          fromRef: row.source.ref,
          source: sourced,
          ...metadata,
          syncRunId: args.syncRunId,
        });
        if (moved) return row._id;
      }
    }
    const encrypted = await ctx.runAction(internal.credentialCryptoActions.seal, {
      plaintext,
      userId: args.userId,
    });
    return await ctx.runMutation(internal.credentials.persistEncrypted, {
      userId: args.userId,
      ...(args.holder === undefined ? {} : { holder: args.holder }),
      ...(args.issuedBy === undefined ? {} : { issuedBy: args.issuedBy }),
      source: args.source,
      ...metadata,
      ...encrypted,
      rotated: existing !== null,
      syncRunId: args.syncRunId,
    });
  },
});

/**
 * Decrypt one active value for another server-side action. Internal; records
 * the use. The value opens only on its owner's row: a ciphertext bound to
 * another owner is refused.
 */
export const decrypt = internalAction({
  args: { credentialId: v.id('credentials') },
  handler: async (ctx, args): Promise<string> => {
    const credential = await ctx.runQuery(internal.credentials.getInternal, args);
    if (
      !credential ||
      credential.revokedAt ||
      credential.status !== undefined ||
      credential.ciphertext === undefined ||
      credential.iv === undefined
    ) {
      throw new Error('Credential is unavailable.');
    }
    const plaintext = await openSealed(ctx, credential, credential.ciphertext, credential.iv);
    await ctx.runMutation(internal.credentials.touch, args);
    return plaintext;
  },
});

/**
 * Open a row's sealed value on its owner's row.
 *
 * @throws Error when the row holds no landed value.
 */
async function openSealed(
  ctx: ActionCtx,
  credential: Doc<'credentials'>,
  ciphertext: string,
  iv: string,
): Promise<string> {
  const plaintext = await ctx.runAction(internal.credentialCryptoActions.open, {
    ciphertext,
    iv,
    userId: credential.userId,
    keyId: credential.keyId,
  });
  if (!plaintext) throw new Error('Credential does not contain a landed value.');
  return plaintext;
}

/**
 * Decrypt a credential Day0 obtained for the one call that revokes it at the vendor (the access
 * plan, section 4.4). Internal; `sourceRevocationActions` is its only caller. Admits a revoked row
 * only while its revocation is `pending` and only when Day0 obtained it (`issuedBy`), so a pasted
 * key never opens here, nor a token the token store holds (its row keeps the store's connection
 * id, not a token); records no use, since the employee no longer acts through it.
 *
 * @throws Error when the row is not awaiting its revocation at the vendor.
 */
export const decryptForRevocation = internalAction({
  args: { credentialId: v.id('credentials') },
  handler: async (ctx, args): Promise<string> => {
    const credential = await ctx.runQuery(internal.credentials.getInternal, args);
    if (
      !credential ||
      credential.issuedBy === undefined ||
      credential.tokenStore === 'nango' ||
      credential.sourceRevocation?.state !== 'pending' ||
      credential.ciphertext === undefined ||
      credential.iv === undefined
    ) {
      throw new Error('Credential is not awaiting its revocation at the vendor.');
    }
    return await openSealed(ctx, credential, credential.ciphertext, credential.iv);
  },
});

/**
 * The client secret of the organisation connection a held credential was issued through, when its
 * revocation may use it after the connection's own revoke revoked it (join 8 of 11-AJ): the held
 * credential's revocation for the `organisation-revoked` end is pending, the connection is a
 * revoked MCP client, and the secret is the organisation's and still holds its value (F19).
 * Internal, for {@link decryptConnectionSecretForRevocation}; writes nothing.
 *
 * @returns The secret's row, or null when it is not admitted.
 */
export const connectionSecretForRevocation = internalQuery({
  args: { credentialId: v.id('credentials') },
  handler: async (ctx, args): Promise<Doc<'credentials'> | null> => {
    const held = await ctx.db.get(args.credentialId);
    const connectionId = held?.issuedBy?.organisationConnectionId;
    if (
      !held ||
      held.sourceRevocation?.state !== 'pending' ||
      held.sourceRevocation.end !== 'organisation-revoked' ||
      connectionId === undefined
    ) {
      return null;
    }
    const connection = await ctx.db.get(connectionId);
    if (
      !connection ||
      connection.status !== 'revoked' ||
      connection.kind !== 'mcp-client' ||
      connection.secretCredentialId === undefined
    ) {
      return null;
    }
    const secret = await ctx.db.get(connection.secretCredentialId);
    return secret?.holder === ORGANISATION_HOLDER &&
      secret.ciphertext !== undefined &&
      secret.iv !== undefined
      ? secret
      : null;
  },
});

/**
 * Decrypt the client secret of a revoked MCP client connection for the one RFC 7009 call that
 * revokes a card's token its own revoke ended (`organisation-revoked`, join 8 of 11-AJ): the revoke
 * revoked the secret in the same transaction, and a confidential client answers `invalid_client`
 * without it. Admits only what {@link connectionSecretForRevocation} admits; records no use.
 * Internal; `sourceRevocationActions` is its only caller.
 *
 * @throws Error when the secret is not admitted for this credential's revocation.
 */
export const decryptConnectionSecretForRevocation = internalAction({
  args: { credentialId: v.id('credentials') },
  handler: async (ctx, args): Promise<string> => {
    const secret: Doc<'credentials'> | null = await ctx.runQuery(
      internal.credentials.connectionSecretForRevocation,
      args,
    );
    if (!secret || secret.ciphertext === undefined || secret.iv === undefined) {
      throw new Error("The connection's client secret is not admitted for this revocation.");
    }
    return await openSealed(ctx, secret, secret.ciphertext, secret.iv);
  },
});

/**
 * A revoked row the token store keeps, whose connection the store is still to forget: Day0
 * obtained it (`issuedBy`), it is revoked, and it still holds its sealed location. Internal, for
 * {@link decryptTokenStoreLocation} and {@link forgottenInTokenStore}; writes nothing.
 */
async function awaitingForget(
  db: QueryCtx['db'],
  credentialId: Id<'credentials'>,
): Promise<Doc<'credentials'> | null> {
  const row = await db.get(credentialId);
  return row !== null &&
    row.tokenStore === 'nango' &&
    row.issuedBy !== undefined &&
    row.revokedAt !== undefined &&
    row.ciphertext !== undefined &&
    row.iv !== undefined
    ? row
    : null;
}

/** The row {@link awaitingForget} admits, for the action. Internal; writes nothing. */
export const tokenStoreRowAwaitingForget = internalQuery({
  args: { credentialId: v.id('credentials') },
  handler: async (ctx, args): Promise<Doc<'credentials'> | null> =>
    await awaitingForget(ctx.db, args.credentialId),
});

/**
 * Decrypt the sealed location (the Nango connection, never a token) of a revoked row the token
 * store keeps, so the end of access can ask the store to forget that connection (11-AT; join 9 of
 * 11-AJ). Admits only a row {@link awaitingForget} admits; records no use. Internal;
 * `sourceRevocationActions.forgetInTokenStore` is its only caller.
 *
 * @throws Error when the row is not awaiting its forgetting in the token store.
 */
export const decryptTokenStoreLocation = internalAction({
  args: { credentialId: v.id('credentials') },
  handler: async (ctx, args): Promise<string> => {
    const row: Doc<'credentials'> | null = await ctx.runQuery(
      internal.credentials.tokenStoreRowAwaitingForget,
      args,
    );
    if (!row || row.ciphertext === undefined || row.iv === undefined) {
      throw new Error('Credential is not awaiting its forgetting in the token store.');
    }
    return await openSealed(ctx, row, row.ciphertext, row.iv);
  },
});

/**
 * Delete the location Day0 kept for a row once the token store has forgotten its connection.
 * Internal; `sourceRevocationActions.forgetInTokenStore` is its only caller. Writes the row's
 * ciphertext away (it stays as the audit trail of a credential that was held).
 */
export const forgottenInTokenStore = internalMutation({
  args: { credentialId: v.id('credentials'), now: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const row = await awaitingForget(ctx.db, args.credentialId);
    if (row !== null) await purgeCredential(ctx, row, args.now);
  },
});

/** Revoke one owner credential without returning its encrypted fields. */
export const revoke = mutation({
  args: { credentialId: v.id('credentials') },
  handler: async (ctx, args): Promise<void> => {
    const identity = await getCallerOrThrow(ctx);
    const credential = await ctx.db.get(args.credentialId);
    if (!credential || credential.userId !== identity.ownerKey) {
      throw new Error('Credential not found.');
    }
    if (!credential.revokedAt) await ctx.db.patch(credential._id, { revokedAt: Date.now() });
  },
});

/** List owner credential metadata without ciphertext or IV fields. */
export const summaryForOwner = query({
  args: {},
  handler: async (ctx) => {
    const identity = await getCallerOrThrow(ctx);
    const credentials = await ctx.db
      .query('credentials')
      .withIndex('by_userId', (index) => index.eq('userId', identity.ownerKey))
      .collect();
    return credentials.map((credential) => ({
      _id: credential._id,
      label: credential.label,
      kind: credential.kind,
      source: credential.source,
      createdAt: credential.createdAt,
      lastUsedAt: credential.lastUsedAt,
      revokedAt: credential.revokedAt,
      status: credential.status,
      statusReason: credential.statusReason,
    }));
  },
});

/**
 * Count active stored credentials for local setup diagnostics: the owners'
 * rows neither revoked by a person nor superseded by a sync that no longer
 * found them. The organisation's rows (an organisation connection's secret)
 * are IT's, reported by the access check, and not counted here. Internal.
 */
export const countStored = internalQuery({
  args: {},
  handler: async (ctx): Promise<number> => {
    const credentials = await ctx.db.query('credentials').take(1_001);
    if (credentials.length > 1_000) throw new Error('Credential count exceeds the setup limit.');
    return credentials.filter(
      (credential) =>
        credential.holder === undefined &&
        !credential.revokedAt &&
        credential.status !== 'superseded',
    ).length;
  },
});

/** Quarantine only the ciphertext orientation inspected, without racing a rotation. */
export const markSuspect = internalMutation({
  args: {
    credentialId: v.id('credentials'),
    ciphertext: v.optional(v.string()),
    reason: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.credentialId);
    if (!row || row.ciphertext !== args.ciphertext || row.revokedAt || row.status === 'superseded')
      return;
    await ctx.db.patch(row._id, { status: 'suspect', statusReason: args.reason });
  },
});

/** Rows one page of a re-seal reads: each is opened and sealed again in the Node action. */
export const RESEAL_PAGE = 50;

/** A stored row as the re-seal reads it; only the Node action it goes to sees the ciphertext. */
export interface ResealRow {
  readonly _id: Id<'credentials'>;
  readonly userId: string;
  readonly ciphertext: string;
  readonly iv: string;
  readonly keyId?: string;
}

/**
 * One page of every credential row, in table order, for the re-seal.
 * Internal; read by `credentialCryptoActions.resealPage`, which never
 * returns a value. Rows with no value (purged by a reset or an unlink) are
 * read past, not returned.
 */
export const resealBatch = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    rows: ResealRow[];
    read: number;
    cursor: string;
    isDone: boolean;
    allowUnbound: boolean;
  }> => {
    const page = await ctx.db
      .query('credentials')
      .paginate({ cursor: args.cursor, numItems: RESEAL_PAGE });
    return {
      rows: page.page.flatMap((row): ResealRow[] =>
        row.ciphertext === undefined || row.iv === undefined
          ? []
          : [
              {
                _id: row._id,
                userId: row.userId,
                ciphertext: row.ciphertext,
                iv: row.iv,
                ...(row.keyId !== undefined ? { keyId: row.keyId } : {}),
              },
            ],
      ),
      read: page.page.length,
      cursor: page.continueCursor,
      isDone: page.isDone,
      allowUnbound: await unboundOpenAllowed(ctx),
    };
  },
});

/**
 * Write the re-sealed values of one page. Internal; written by
 * `credentialCryptoActions.resealPage`.
 *
 * A row is rewritten only while it still holds the ciphertext the action
 * opened: a value a sync, a person or another re-seal wrote in between is
 * newer and already carries its key id, so it is left as it is.
 *
 * @returns How many rows were rewritten.
 */
export const applyReseal = internalMutation({
  args: {
    rows: v.array(
      v.object({
        credentialId: v.id('credentials'),
        fromCiphertext: v.string(),
        ciphertext: v.string(),
        iv: v.string(),
        keyId: v.string(),
      }),
    ),
  },
  handler: async (ctx, args): Promise<number> => {
    let applied = 0;
    for (const resealed of args.rows) {
      const row = await ctx.db.get(resealed.credentialId);
      if (row?.ciphertext !== resealed.fromCiphertext) continue;
      await ctx.db.patch(row._id, {
        ciphertext: resealed.ciphertext,
        iv: resealed.iv,
        keyId: resealed.keyId,
      });
      applied += 1;
    }
    return applied;
  },
});

/** A page-derived row as the ref rewrite reads it; only the Node action it goes to sees the ciphertext. */
export interface ValueRefRow extends ResealRow {
  readonly sourceId: Id<'docSources'>;
  readonly ref: string;
}

/**
 * One page of every credential row, in table order, for the ref rewrite.
 * Internal; read by `credentialCryptoActions.valueRefPage`, which never
 * returns a value. Only page-derived rows holding a value on a ref from
 * before value-keyed refs are returned; the rest are read past.
 */
export const valueRefBatch = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    rows: ValueRefRow[];
    read: number;
    cursor: string;
    isDone: boolean;
    allowUnbound: boolean;
  }> => {
    const page = await ctx.db
      .query('credentials')
      .paginate({ cursor: args.cursor, numItems: RESEAL_PAGE });
    return {
      rows: page.page.filter(holdsLegacyRef).map(
        (row): ValueRefRow => ({
          _id: row._id,
          userId: row.userId,
          ciphertext: row.ciphertext,
          iv: row.iv,
          ...(row.keyId !== undefined ? { keyId: row.keyId } : {}),
          sourceId: row.source.sourceId,
          ref: row.source.ref,
        }),
      ),
      read: page.page.length,
      cursor: page.continueCursor,
      isDone: page.isDone,
      allowUnbound: await unboundOpenAllowed(ctx),
    };
  },
});

/**
 * Carry a rewritten ref into its source's newest run while that run can still
 * finish a generation. A running run unions the credential refs it holds at
 * its finish, and one that ended short hands them to the sync that takes it
 * over (`beginSync`); a ref it recorded before the rewrite would otherwise
 * leave the moved row out of the generation's set, and the finish would
 * supersede it for a page that was never re-read.
 *
 * @param ctx - A mutation context.
 * @param sourceId - The row's source.
 * @param fromRef - The ref the row carried before the rewrite.
 * @param ref - Its value-keyed ref.
 */
async function carryRefIntoOpenRun(
  ctx: MutationCtx,
  sourceId: Id<'docSources'>,
  fromRef: string,
  ref: string,
): Promise<void> {
  const latest = await ctx.db
    .query('docSyncRuns')
    .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
    .order('desc')
    .first();
  if (!latest || latest.state === 'completed' || !latest.credentialRefs.includes(fromRef)) return;
  await ctx.db.patch(latest._id, {
    credentialRefs: [
      ...new Set(latest.credentialRefs.map((carried) => (carried === fromRef ? ref : carried))),
    ],
  });
}

/**
 * Move each row of one page of the ref rewrite to its value-keyed ref.
 * Internal; written by `credentialCryptoActions.valueRefPage`.
 *
 * A row is moved only while it is still at the ref the action read it at, so
 * a row a sync moved in between (`moveToRef`) is left where the sync put it.
 * A row whose value-keyed ref another row of the page already holds (one
 * value stored twice by an earlier release) is left as it was and returned,
 * so the action logs it and the status counts it as remaining. A moved row's
 * ref is carried into its source's unfinished run (`carryRefIntoOpenRun`).
 *
 * @returns How many rows moved, and the ids of those another row blocked.
 */
export const applyValueRefs = internalMutation({
  args: {
    rows: v.array(
      v.object({ credentialId: v.id('credentials'), fromRef: v.string(), ref: v.string() }),
    ),
  },
  handler: async (ctx, args): Promise<{ changed: number; blocked: Id<'credentials'>[] }> => {
    let changed = 0;
    const blocked: Id<'credentials'>[] = [];
    for (const moved of args.rows) {
      const row = await ctx.db.get(moved.credentialId);
      if (!row || typeof row.source === 'string' || row.source.ref !== moved.fromRef) continue;
      const { sourceId } = row.source;
      const taken = await ctx.db
        .query('credentials')
        .withIndex('by_user_source_ref', (index) =>
          index
            .eq('userId', row.userId)
            .eq('source.sourceId', sourceId)
            .eq('source.ref', moved.ref),
        )
        .first();
      if (taken) {
        blocked.push(row._id);
        continue;
      }
      await ctx.db.patch(row._id, { source: { sourceId, ref: moved.ref } });
      await carryRefIntoOpenRun(ctx, sourceId, moved.fromRef, moved.ref);
      changed += 1;
    }
    return { changed, blocked };
  },
});

/** The most rows a count of the credential table reads before it answers "at least". */
const KEY_COUNT_SCAN_LIMIT = 4_000;

/** How the stored values divide between keys, as far as a bounded read saw. */
export interface CredentialKeyCounts {
  /** Rows holding a value, by the id of the key that sealed them. */
  readonly byKeyId: Readonly<Record<string, number>>;
  /** Rows holding a value with no key id: sealed before the re-seal reached them. */
  readonly unkeyed: number;
  /**
   * Page-derived rows holding a value whose ref is not keyed by it yet: the
   * rows `credentials-value-refs` has still to rewrite.
   */
  readonly legacyRefs: number;
  /** True when the table held more rows than the count read, so every figure is a floor. */
  readonly atLeast: boolean;
}

/** A page-derived row holding a value. */
type PageValueRow = Doc<'credentials'> & {
  ciphertext: string;
  iv: string;
  source: { sourceId: Id<'docSources'>; ref: string };
};

/** Whether a row holds a value on a page ref from before value-keyed refs. */
function holdsLegacyRef(row: Doc<'credentials'>): row is PageValueRow {
  return (
    row.ciphertext !== undefined &&
    row.iv !== undefined &&
    typeof row.source !== 'string' &&
    !isValueKeyedRef(row.source.ref)
  );
}

/**
 * Count the rows holding a value by the key that sealed them, and those whose
 * page ref is not yet keyed by their value.
 *
 * @param ctx - A query or mutation context.
 */
export async function credentialKeyCounts(ctx: QueryCtx): Promise<CredentialKeyCounts> {
  const rows = await ctx.db.query('credentials').take(KEY_COUNT_SCAN_LIMIT + 1);
  const byKeyId: Record<string, number> = {};
  let unkeyed = 0;
  let legacyRefs = 0;
  for (const row of rows.slice(0, KEY_COUNT_SCAN_LIMIT)) {
    if (row.ciphertext === undefined) continue;
    if (row.keyId === undefined) unkeyed += 1;
    else byKeyId[row.keyId] = (byKeyId[row.keyId] ?? 0) + 1;
    if (holdsLegacyRef(row)) legacyRefs += 1;
  }
  return { byKeyId, unkeyed, legacyRefs, atLeast: rows.length > KEY_COUNT_SCAN_LIMIT };
}

/** Rows one page of `keyCounts` reads. */
const KEY_COUNT_PAGE = 1_000;

/**
 * One page of the stored values counted by the key that sealed them.
 * Internal; the key rotation sums the pages to confirm no row is left on the
 * old key before it drops that key from the deployment.
 */
export const keyCounts = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    byKeyId: Record<string, number>;
    unkeyed: number;
    cursor: string;
    isDone: boolean;
  }> => {
    const page = await ctx.db
      .query('credentials')
      .paginate({ cursor: args.cursor, numItems: KEY_COUNT_PAGE });
    const byKeyId: Record<string, number> = {};
    let unkeyed = 0;
    for (const row of page.page) {
      if (row.ciphertext === undefined) continue;
      if (row.keyId === undefined) unkeyed += 1;
      else byKeyId[row.keyId] = (byKeyId[row.keyId] ?? 0) + 1;
    }
    return { byKeyId, unkeyed, cursor: page.continueCursor, isDone: page.isDone };
  },
});
