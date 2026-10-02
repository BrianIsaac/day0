import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, internalQuery, mutation, type MutationCtx } from './_generated/server';
import {
  actsAsValidator,
  credentialIssuerValidator,
  pendingAuthorisationValidator,
} from './schema';
import { appendEvent } from './eventLog';
import { assertOwnsAgent } from './ownership';

/*
 * The rows behind the MCP rung's OAuth 2.1 client (wave 11, 11-AM; the access plan, section 4.6):
 * the authorisation a card has started (`surfaces.pendingAuthorisation`, the PKCE verifier sealed
 * in it), its consumption by the redirect, the tokens it lands, and their rotation. The actions
 * that talk to the authorisation server are `mcpOauthActions.ts`, since Convex keeps a Node
 * module's actions apart from queries and mutations.
 */

/** How long before an access token's expiry the scheduled refresh runs, at most. */
export const MCP_REFRESH_LEAD_MS = 5 * 60_000;

/**
 * How close to its expiry a token read for use is refreshed first: a call made with it must still
 * reach the server inside its lifetime.
 */
export const MCP_READ_REFRESH_MARGIN_MS = 60_000;

/**
 * The soonest a scheduled refresh runs after it is scheduled: a token issued with a lifetime of a
 * few seconds, or a clock behind the server's, must not refresh in a loop.
 */
export const MCP_MIN_REFRESH_INTERVAL_MS = 30_000;

/** A token sealed for its owner, as `sealForOwner` returns it. */
const sealedValidator = v.object({ ciphertext: v.string(), iv: v.string(), keyId: v.string() });

/** Why a redirect found no authorisation to complete. */
export type PendingClaimFailure = 'none' | 'used' | 'expired';

/** What an authorisation needs to know about its card, its employee and its server's client. */
export interface AuthorisationContext {
  readonly surface: Doc<'surfaces'>;
  readonly agent: Doc<'agents'>;
  /** The organisation's active `mcp-client` connection for the server's system, if exactly one. */
  readonly connection: Doc<'organisationConnections'> | null;
  /** More than one active `mcp-client` connection names the system, so none is chosen. */
  readonly ambiguous: boolean;
}

/**
 * When the scheduled refresh of a token expiring at `expiresAt` runs: {@link MCP_REFRESH_LEAD_MS}
 * before it, or half its remaining life for a token that lives shorter than twice that, and never
 * sooner than {@link MCP_MIN_REFRESH_INTERVAL_MS} from now.
 */
export function refreshDueAt(expiresAt: number, now: number): number {
  const remaining = Math.max(0, expiresAt - now);
  const due = expiresAt - Math.min(MCP_REFRESH_LEAD_MS, Math.floor(remaining / 2));
  return Math.max(due, now + MCP_MIN_REFRESH_INTERVAL_MS);
}

/**
 * One card, its employee and the organisation's MCP client for its server. Internal, for
 * `mcpOauthActions`; writes nothing.
 */
export const authorisationContext = internalQuery({
  args: { surfaceId: v.id('surfaces'), system: v.string() },
  handler: async (ctx, args): Promise<AuthorisationContext | null> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) return null;
    const agent = await ctx.db.get(surface.agentId);
    if (!agent) return null;
    const active = (
      await ctx.db
        .query('organisationConnections')
        .withIndex('by_system_status', (index) =>
          index.eq('system', args.system).eq('status', 'active'),
        )
        .take(10)
    ).filter((connection) => connection.kind === 'mcp-client');
    return {
      surface,
      agent,
      connection: active.length === 1 ? active[0] : null,
      ambiguous: active.length > 1,
    };
  },
});

/** Clear a card's pending authorisation if it is still the one with this nonce. */
async function clearPending(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  stateNonce?: string,
): Promise<boolean> {
  const pending = surface.pendingAuthorisation;
  if (!pending || (stateNonce !== undefined && pending.stateNonce !== stateNonce)) return false;
  await ctx.db.patch(surface._id, { pendingAuthorisation: undefined });
  return true;
}

/**
 * Record an authorisation the card's owner has started, replacing any earlier one, and what
 * discovery found on the organisation's connection: its issuer and resource where IT left them
 * unset, and the server's endpoints (11-AR's RFC 7009 revoker reads `revocation`). Schedules the
 * clearing at the state's expiry. Internal, for `mcpOauthActions.startAuthorisation`, which has
 * checked the caller owns the employee; refuses when the employee changed hands since.
 */
export const recordPendingAuthorisation = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    ownerKey: v.string(),
    pending: pendingAuthorisationValidator,
    discovered: v.object({
      issuer: v.string(),
      resource: v.string(),
      authorisation: v.string(),
      token: v.string(),
      revocation: v.optional(v.string()),
      registration: v.optional(v.string()),
      discoveredAt: v.number(),
    }),
  },
  handler: async (ctx, args): Promise<void> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new ConvexError('Surface not found.');
    const agent = await ctx.db.get(surface.agentId);
    if (!agent || agent.userId !== args.ownerKey) {
      throw new ConvexError('The employee changed hands while the authorisation was starting.');
    }
    await ctx.db.patch(surface._id, { pendingAuthorisation: args.pending });
    const connectionId = args.pending.organisationConnectionId;
    const connection = connectionId ? await ctx.db.get(connectionId) : null;
    if (connection) {
      const { issuer, resource, discoveredAt, ...endpoints } = args.discovered;
      await ctx.db.patch(connection._id, {
        issuer: connection.issuer ?? issuer,
        resource: connection.resource ?? resource,
        authorisationEndpoints: { ...endpoints, discoveredAt },
      });
    }
    await ctx.scheduler.runAt(
      args.pending.stateExpiresAt,
      internal.mcpOauth.expirePendingAuthorisation,
      { surfaceId: surface._id, stateNonce: args.pending.stateNonce },
    );
  },
});

/**
 * Clear a pending authorisation at its state's expiry, unless a newer one replaced it. Internal;
 * scheduled by {@link recordPendingAuthorisation}.
 */
export const expirePendingAuthorisation = internalMutation({
  args: { surfaceId: v.id('surfaces'), stateNonce: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (surface) await clearPending(ctx, surface, args.stateNonce);
  },
});

/**
 * Cancel the authorisation a card has started, so its link stops working. Public; the caller must
 * own the employee (`assertOwnsAgent`). Writes only the card's `pendingAuthorisation`.
 *
 * @returns Whether an authorisation was pending.
 */
export const cancelAuthorisation = mutation({
  args: { surfaceId: v.id('surfaces') },
  handler: async (ctx, args): Promise<boolean> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new ConvexError('Surface not found.');
    await assertOwnsAgent(ctx, surface.agentId);
    return await clearPending(ctx, surface);
  },
});

/** A pending authorisation the redirect consumed, with what completing it needs. */
export interface ClaimedAuthorisation {
  readonly ok: true;
  readonly pending: NonNullable<Doc<'surfaces'>['pendingAuthorisation']>;
  readonly agentId: Id<'agents'>;
  readonly ownerKey: string;
  readonly managerAddress: string;
  readonly slug: string;
  readonly displayName: string;
}

/**
 * Consume a card's pending authorisation for the redirect that names its nonce: one transaction,
 * so two redirects cannot both win and a replay finds nothing. An expired one is cleared and
 * refused. Internal, for `mcpOauthActions.completeAuthorisation`, which has verified the state's
 * signature.
 */
export const claimPendingAuthorisation = internalMutation({
  args: { surfaceId: v.id('surfaces'), stateNonce: v.string(), now: v.number() },
  handler: async (
    ctx,
    args,
  ): Promise<ClaimedAuthorisation | { ok: false; reason: PendingClaimFailure }> => {
    const surface = await ctx.db.get(args.surfaceId);
    const pending = surface?.pendingAuthorisation;
    if (!surface || !pending) return { ok: false, reason: 'none' };
    if (pending.stateNonce !== args.stateNonce) return { ok: false, reason: 'used' };
    await clearPending(ctx, surface);
    if (pending.stateExpiresAt <= args.now) return { ok: false, reason: 'expired' };
    const agent = await ctx.db.get(surface.agentId);
    if (!agent?.userId) return { ok: false, reason: 'none' };
    return {
      ok: true,
      pending,
      agentId: agent._id,
      ownerKey: agent.userId,
      managerAddress: agent.bossEmail,
      slug: surface.slug,
      displayName: surface.displayName,
    };
  },
});

/**
 * Write a failed authorisation or refresh onto the card's record. Internal, for `mcpOauthActions`.
 */
export const recordAuthorisationFailure = internalMutation({
  args: { surfaceId: v.id('surfaces'), reason: v.string(), now: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) return;
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.authorisation-failed',
      payload: { surfaceId: surface._id, reason: args.reason },
      createdAt: args.now,
    });
  },
});

/**
 * Stamp a credential Day0 obtained and the card no longer holds as revoked, with its revocation at
 * the vendor asked for (11-AR's revoker answers it), keeping its ciphertext for that call (F19).
 * A pasted key is only detached: Day0 never revokes one (D5); nor is a credential another card
 * still holds.
 */
async function retireReplaced(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  now: number,
): Promise<void> {
  const replaced = surface.credentialId ? await ctx.db.get(surface.credentialId) : null;
  if (!replaced?.issuedBy || replaced.revokedAt !== undefined) return;
  const holders = await ctx.db
    .query('surfaces')
    .withIndex('by_credentialId', (index) => index.eq('credentialId', replaced._id))
    .take(2);
  if (holders.some((holder) => holder._id !== surface._id)) return;
  const pair = replaced.refreshCredentialId ? await ctx.db.get(replaced.refreshCredentialId) : null;
  for (const row of [replaced, pair]) {
    if (!row || row.revokedAt !== undefined) continue;
    await ctx.db.patch(row._id, {
      revokedAt: now,
      sourceRevocation: { state: 'pending', attempts: 0, end: 'disconnect' },
    });
  }
}

/**
 * Land an authorisation's tokens on the card: the refresh token and the access token as two
 * credential rows of the employee's owner (the access token's `refreshCredentialId` naming the
 * other, `generation` 0, `issuedBy` the authorisation code), bound to the card with whom it acts
 * as, in one transaction; the token the card held before, where Day0 obtained it, retired; the
 * probe and the first scheduled refresh queued. The pending authorisation it completes was cleared
 * by the claim; one the manager started since is left for its own redirect. Internal, for the token store's native
 * implementation in `mcpOauthActions`; refuses when the employee changed hands since the start.
 *
 * @returns The access token's credential.
 */
export const landAuthorisedTokens = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    ownerKey: v.string(),
    access: sealedValidator,
    refresh: v.optional(sealedValidator),
    expiresAt: v.optional(v.number()),
    issuedBy: credentialIssuerValidator,
    actsAs: actsAsValidator,
    issuer: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<Id<'credentials'>> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new ConvexError('Surface not found.');
    const agent = await ctx.db.get(surface.agentId);
    if (!agent || agent.userId !== args.ownerKey) {
      throw new ConvexError('The employee changed hands while the authorisation was completing.');
    }
    const common = {
      userId: args.ownerKey,
      kind: 'oauth' as const,
      source: 'oauth' as const,
      createdAt: args.now,
      issuedBy: args.issuedBy,
    };
    const refreshCredentialId = args.refresh
      ? await ctx.db.insert('credentials', {
          ...common,
          ...args.refresh,
          label: `${surface.displayName} refresh token`,
        })
      : undefined;
    const credentialId = await ctx.db.insert('credentials', {
      ...common,
      ...args.access,
      label: `${surface.displayName} access token`,
      generation: 0,
      ...(args.expiresAt === undefined ? {} : { expiresAt: args.expiresAt }),
      ...(refreshCredentialId ? { refreshCredentialId } : {}),
    });
    await retireReplaced(ctx, surface, args.now);
    const approved = surface.managerApprovedAt !== undefined;
    await ctx.db.patch(surface._id, {
      credentialId,
      credentialKind: 'oauth',
      credentialLocation: undefined,
      credentialLanded: false,
      actsAs: args.actsAs,
      ...(args.issuedBy.organisationConnectionId
        ? { organisationConnectionId: args.issuedBy.organisationConnectionId }
        : {}),
      verdict:
        approved && (surface.verdict === 'ungranted' || surface.verdict === 'listed-dead')
          ? 'approved'
          : surface.verdict,
      reason: approved ? undefined : surface.reason,
    });
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.authorised',
      payload: { surfaceId: surface._id, issuer: args.issuer },
      createdAt: args.now,
    });
    await ctx.scheduler.runAfter(0, internal.surfaceActions.probeInternal, {
      surfaceId: surface._id,
    });
    if (refreshCredentialId && args.expiresAt !== undefined) {
      await ctx.scheduler.runAt(
        refreshDueAt(args.expiresAt, args.now),
        internal.mcpOauthActions.refreshScheduled,
        { credentialId, generation: 0 },
      );
    }
    return credentialId;
  },
});

/** A held access token's row, its refresh token's row and the connection whose client issued them. */
export interface HeldTokenRows {
  readonly access: Doc<'credentials'>;
  readonly refresh: Doc<'credentials'> | null;
  readonly connection: Doc<'organisationConnections'> | null;
}

/**
 * One access token's rows for a read or a refresh. Internal; writes nothing. The id arrives as the
 * adapters hold it, a string: one that names no credential reads as none, and the caller decrypts
 * it the plain way, whose own check then answers for it.
 */
export const heldTokens = internalQuery({
  args: { credentialId: v.string() },
  handler: async (ctx, args): Promise<HeldTokenRows | null> => {
    const id = ctx.db.normalizeId('credentials', args.credentialId);
    const access = id === null ? null : await ctx.db.get(id);
    if (!access) return null;
    const refresh = access.refreshCredentialId
      ? await ctx.db.get(access.refreshCredentialId)
      : null;
    const connectionId = access.issuedBy?.organisationConnectionId;
    const connection = connectionId ? await ctx.db.get(connectionId) : null;
    return { access, refresh, connection };
  },
});

/**
 * Write a refused refresh onto the record of every card holding the access token, in one
 * transaction. Internal, for `mcpOauthActions.refreshScheduled`.
 */
export const recordRefreshRefusal = internalMutation({
  args: { credentialId: v.id('credentials'), reason: v.string(), now: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const cards = await ctx.db
      .query('surfaces')
      .withIndex('by_credentialId', (index) => index.eq('credentialId', args.credentialId))
      .take(50);
    for (const surface of cards) {
      await appendEvent(ctx, {
        agentId: surface.agentId,
        type: 'surface.authorisation-failed',
        payload: { surfaceId: surface._id, reason: args.reason },
        createdAt: args.now,
      });
    }
  },
});

/** What a rotation's write answers. */
export type RotationOutcome =
  | { readonly ok: true; readonly generation: number }
  | { readonly ok: false; readonly reason: 'stale' | 'gone' };

/**
 * Write a refresh's tokens, the access token and the rotated refresh token together, only while
 * the pair is still at the generation the refresh read: a concurrent refresh that read the same
 * generation loses here and re-reads. Queues the next scheduled refresh. Internal, for the token
 * store's native implementation in `mcpOauthActions`.
 */
export const rotateTokens = internalMutation({
  args: {
    credentialId: v.id('credentials'),
    expectedGeneration: v.number(),
    access: sealedValidator,
    refresh: v.optional(sealedValidator),
    expiresAt: v.optional(v.number()),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<RotationOutcome> => {
    const access = await ctx.db.get(args.credentialId);
    if (!access?.issuedBy || access.revokedAt !== undefined || access.ciphertext === undefined) {
      return { ok: false, reason: 'gone' };
    }
    if ((access.generation ?? 0) !== args.expectedGeneration) return { ok: false, reason: 'stale' };
    const generation = args.expectedGeneration + 1;
    const issuedBy = { ...access.issuedBy, grant: 'token-rotation' as const };
    let refreshCredentialId = access.refreshCredentialId;
    if (args.refresh && refreshCredentialId) {
      await ctx.db.patch(refreshCredentialId, { ...args.refresh, issuedBy });
    } else if (args.refresh) {
      refreshCredentialId = await ctx.db.insert('credentials', {
        userId: access.userId,
        kind: 'oauth',
        source: 'oauth',
        label: access.label.replace(/ access token$/, ' refresh token'),
        createdAt: args.now,
        issuedBy,
        ...args.refresh,
      });
    }
    await ctx.db.patch(access._id, {
      ...args.access,
      generation,
      expiresAt: args.expiresAt,
      issuedBy,
      refreshCredentialId,
    });
    if (refreshCredentialId && args.expiresAt !== undefined) {
      await ctx.scheduler.runAt(
        refreshDueAt(args.expiresAt, args.now),
        internal.mcpOauthActions.refreshScheduled,
        { credentialId: access._id, generation },
      );
    }
    return { ok: true, generation };
  },
});
