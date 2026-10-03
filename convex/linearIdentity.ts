import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import { purgeCredential } from './credentials';
import { appendEvent } from './eventLog';
import { activeConnectionFor } from './organisationConnectionReads';
import { pendingAuthorisationValidator } from './schema';
import { endAccessAtSource } from './sourceRevocation';
import { ORGANISATION_HOLDER, ORGANISATION_OWNER_KEY } from '../src/lib/organisation-key';
import type { ActsAs } from '../src/surfaces/access-identity';
import { organisationSystemOf } from '../src/surfaces/access-request';
import {
  ACCESS_TOKEN_REFRESH_LEAD_MS,
  LINEAR_ISSUER,
  LINEAR_SYSTEM,
  renewalDueAt,
  SHARED_TOKEN_RENEWAL_LEAD_MS,
} from '../src/surfaces/identity-issuers/linear';
import type { ActingCard } from '../src/work/ticket-ownership';

/*
 * The rows behind Linear's app actor (wave 11, 11-AL; the access plan, sections 4.2 and 4.10): the
 * organisation's shared app-actor token, an employee's own app and the tokens its installation
 * lands, and whom a card acts as. The actions that talk to Linear are `linearIdentityActions.ts`,
 * since Convex keeps a Node module's actions apart from queries and mutations.
 *
 * Every token and secret here is held by the organisation (`holder: 'organisation'` under
 * `ORGANISATION_OWNER_KEY`, the wave's common rules): a handover keeps the employee's identity
 * without a re-seal (A25), and a manager's "Delete my data" never ends another manager's employee's
 * identity. Every row carries `issuedBy`, which 11-AR's ends of access read.
 */

/** A token or secret sealed for the organisation, as `sealForOwner` returns it. */
const sealedValidator = v.object({ ciphertext: v.string(), iv: v.string(), keyId: v.string() });

/** The app user a token acts as, as Linear's `viewer` named it. */
const appUserValidator = v.object({ id: v.string(), name: v.string() });

/** The most cards one credential's refusal is written to, in one transaction. */
const CARDS_PER_CREDENTIAL_LIMIT = 1_000;

/** A card and its employee, with the organisation's active Linear connection. */
export interface LinearIssuerContext {
  readonly surface: Doc<'surfaces'>;
  readonly agent: Doc<'agents'>;
  /** The active `linear` connection, of any kind; the action checks it is an OAuth app. */
  readonly connection: Doc<'organisationConnections'> | null;
}

/** A held Linear token's rows: the token, its refresh token, and the connection that issued it. */
export interface HeldLinearToken {
  readonly access: Doc<'credentials'>;
  readonly refresh: Doc<'credentials'> | null;
  readonly connection: Doc<'organisationConnections'> | null;
}

/** What a write of a renewed token answers: the generation written, or why it was not. */
export type LinearRotationOutcome =
  | { readonly ok: true; readonly credentialId: Id<'credentials'>; readonly generation: number }
  | {
      readonly ok: false;
      /** `stale`: another renewal wrote first; `gone`: the token or its connection was ended. */
      readonly reason: 'stale' | 'gone';
      readonly credentialId?: Id<'credentials'>;
    };

/** A pending authorisation the redirect consumed, with what completing it needs. */
export interface ClaimedLinearAuthorisation {
  readonly ok: true;
  readonly pending: NonNullable<Doc<'surfaces'>['pendingAuthorisation']>;
  readonly agentId: Id<'agents'>;
  readonly slug: string;
  readonly appName: string;
  readonly clientSecretCredentialId: Id<'credentials'>;
}

/** Why a redirect found no authorisation to complete. */
export type LinearClaimFailure = 'none' | 'used' | 'expired' | 'replaced';

/**
 * One card, its employee and the organisation's active Linear connection. Internal, for
 * `linearIdentityActions`; writes nothing.
 */
export const issuerContext = internalQuery({
  args: { surfaceId: v.id('surfaces') },
  handler: async (ctx, args): Promise<LinearIssuerContext | null> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) return null;
    const agent = await ctx.db.get(surface.agentId);
    if (!agent) return null;
    return { surface, agent, connection: await activeConnectionFor(ctx, LINEAR_SYSTEM) };
  },
});

/** A credential's rows, its refresh token's and the connection named on its `issuedBy`. */
async function heldRows(
  ctx: Pick<QueryCtx, 'db'>,
  access: Doc<'credentials'>,
): Promise<HeldLinearToken> {
  const [refresh, connection] = await Promise.all([
    access.refreshCredentialId ? ctx.db.get(access.refreshCredentialId) : null,
    access.issuedBy?.organisationConnectionId
      ? ctx.db.get(access.issuedBy.organisationConnectionId)
      : null,
  ]);
  return { access, refresh, connection };
}

/**
 * A held token's rows for a read or a renewal. Internal; writes nothing. The id arrives as the
 * adapters hold it, a string: one that names no credential reads as none.
 */
export const heldToken = internalQuery({
  args: { credentialId: v.string() },
  handler: async (ctx, args): Promise<HeldLinearToken | null> => {
    const id = ctx.db.normalizeId('credentials', args.credentialId);
    const access = id === null ? null : await ctx.db.get(id);
    return access === null ? null : await heldRows(ctx, access);
  },
});

/**
 * The shared app-actor token a Linear connection holds, with the connection. Internal; writes
 * nothing.
 *
 * @returns The connection and its token's row (null when it holds none), or null when the
 *   connection is gone.
 */
export const sharedTokenOf = internalQuery({
  args: { organisationConnectionId: v.id('organisationConnections') },
  handler: async (
    ctx,
    args,
  ): Promise<{
    connection: Doc<'organisationConnections'>;
    token: Doc<'credentials'> | null;
  } | null> => {
    const connection = await ctx.db.get(args.organisationConnectionId);
    if (!connection) return null;
    const token = connection.sharedTokenCredentialId
      ? await ctx.db.get(connection.sharedTokenCredentialId)
      : null;
    return { connection, token };
  },
});

/** Whether a connection is the organisation's active shared Linear app. */
function isSharedLinearApp(connection: Doc<'organisationConnections'> | null): boolean {
  return (
    connection !== null &&
    connection.status === 'active' &&
    connection.system === LINEAR_SYSTEM &&
    connection.kind === 'oauth-app' &&
    connection.mode === 'shared'
  );
}

/** Whether a connection is the organisation's active per-employee Linear app connection. */
function isPerEmployeeLinear(connection: Doc<'organisationConnections'> | null): boolean {
  return (
    connection !== null &&
    connection.status === 'active' &&
    connection.system === LINEAR_SYSTEM &&
    connection.kind === 'oauth-app' &&
    connection.mode === 'per-employee'
  );
}

/** Whether a row still holds a value Day0 may use. */
function holdsValue(row: Doc<'credentials'> | null): row is Doc<'credentials'> {
  return row !== null && row.revokedAt === undefined && row.ciphertext !== undefined;
}

/**
 * Write the shared app-actor token a `client_credentials` request returned (L2), the one row per
 * connection every shared-mode card holds: renewed in place, so no card is touched, and only while
 * the row is still at the generation the renewal read (or still empty, after a rotation of the
 * app's secret emptied it), so two renewals racing write once and the loser uses the winner's
 * token (both are live: Linear keeps up to 1,000 with the same scopes).
 * Queues the next renewal for the token's last day. Internal, for `linearIdentityActions`.
 */
export const landSharedToken = internalMutation({
  args: {
    organisationConnectionId: v.id('organisationConnections'),
    sealed: sealedValidator,
    expiresAt: v.optional(v.number()),
    /** The generation the renewal read; absent for the connection's first token. */
    expectedGeneration: v.optional(v.number()),
    /**
     * The connection's secret the token was requested with: a token requested before a rotation
     * replaced it may be dead at Linear (L2), so it never lands.
     */
    secretCredentialId: v.id('credentials'),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<LinearRotationOutcome> => {
    const connection = await ctx.db.get(args.organisationConnectionId);
    if (!connection || !isSharedLinearApp(connection)) return { ok: false, reason: 'gone' };
    const held = connection.sharedTokenCredentialId
      ? await ctx.db.get(connection.sharedTokenCredentialId)
      : null;
    if (connection.secretCredentialId !== args.secretCredentialId) {
      return { ok: false, reason: 'stale', ...(held ? { credentialId: held._id } : {}) };
    }
    let credentialId: Id<'credentials'>;
    let generation: number;
    if (held !== null && held.revokedAt === undefined) {
      // A rotation of the app's secret empties the row in place (join 3): only a renewal that read
      // it empty fills it, so a token requested with the old secret never lands.
      const read = held.ciphertext === undefined ? undefined : (held.generation ?? 0);
      if (args.expectedGeneration !== read) {
        return { ok: false, reason: 'stale', credentialId: held._id };
      }
      generation = (held.generation ?? 0) + 1;
      await ctx.db.patch(held._id, {
        ...args.sealed,
        expiresAt: args.expiresAt,
        generation,
        lastUsedAt: undefined,
      });
      credentialId = held._id;
    } else {
      generation = 0;
      credentialId = await ctx.db.insert('credentials', {
        userId: ORGANISATION_OWNER_KEY,
        holder: ORGANISATION_HOLDER,
        kind: 'oauth',
        source: 'oauth',
        label: `${connection.displayName} app token`,
        ...args.sealed,
        issuedBy: {
          system: LINEAR_SYSTEM,
          grant: 'client-credentials',
          organisationConnectionId: connection._id,
          ...(connection.clientId === undefined ? {} : { clientId: connection.clientId }),
        },
        ...(args.expiresAt === undefined ? {} : { expiresAt: args.expiresAt }),
        generation,
        createdAt: args.now,
      });
      await ctx.db.patch(connection._id, { sharedTokenCredentialId: credentialId });
    }
    if (args.expiresAt !== undefined) {
      await ctx.scheduler.runAt(
        renewalDueAt(args.expiresAt, args.now, SHARED_TOKEN_RENEWAL_LEAD_MS),
        internal.linearIdentityActions.renewSharedScheduled,
        { organisationConnectionId: connection._id, generation },
      );
    }
    return { ok: true, credentialId, generation };
  },
});

/**
 * Detach the credential a card held before a Linear identity lands on it. A token Day0 obtained for
 * this card alone is ended with its refresh token through the end of access (`endAccessAtSource`,
 * end `disconnect`): revoked in Day0, its ciphertext kept for the call (F19), and the revocation
 * at Linear scheduled (11-AR's seam: a card's pointer to such a row is never dropped without
 * ending it). A pasted key is only detached: Day0 never revokes one (D5, A27). The organisation's
 * shared token, and any credential another card still holds, are left alone.
 */
async function retireReplaced(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  replacement: Id<'credentials'>,
  now: number,
): Promise<void> {
  if (surface.credentialId === undefined || surface.credentialId === replacement) return;
  const replaced = await ctx.db.get(surface.credentialId);
  if (!replaced?.issuedBy || replaced.revokedAt !== undefined) return;
  if (replaced.issuedBy.grant === 'client-credentials') return;
  const holders = await ctx.db
    .query('surfaces')
    .withIndex('by_credentialId', (index) => index.eq('credentialId', replaced._id))
    .take(2);
  if (holders.some((holder) => holder._id !== surface._id)) return;
  const pair = replaced.refreshCredentialId ? await ctx.db.get(replaced.refreshCredentialId) : null;
  await endAccessAtSource(ctx, {
    agentId: surface.agentId,
    surfaceId: surface._id,
    surfaceName: surface.displayName,
    credentials: [replaced, ...(pair !== null && pair.revokedAt === undefined ? [pair] : [])],
    end: 'disconnect',
    now,
  });
}

/** The client secret the card's held token is refreshed with, if it holds one Day0 obtained. */
async function secretInUse(
  ctx: Pick<QueryCtx, 'db'>,
  surface: Doc<'surfaces'>,
): Promise<Id<'credentials'> | undefined> {
  const held = surface.credentialId ? await ctx.db.get(surface.credentialId) : null;
  return held?.issuedBy?.clientSecretCredentialId;
}

/** Purge an employee app's client secret row, if it still holds its value. */
async function purgeSecret(
  ctx: MutationCtx,
  credentialId: Id<'credentials'>,
  now: number,
): Promise<void> {
  const row = await ctx.db.get(credentialId);
  if (row) await purgeCredential(ctx, row, now);
}

/** The verdict and reason a card takes when a new identity lands: a failed check is cleared. */
function landedVerdict(surface: Doc<'surfaces'>): Pick<Doc<'surfaces'>, 'verdict' | 'reason'> {
  const approved = surface.managerApprovedAt !== undefined;
  return {
    verdict:
      approved && (surface.verdict === 'ungranted' || surface.verdict === 'listed-dead')
        ? 'approved'
        : surface.verdict,
    reason: approved ? undefined : surface.reason,
  };
}

/** The card a Linear identity lands on, checked against the employee and the connection. */
async function landingCard(
  ctx: MutationCtx,
  args: {
    readonly surfaceId: Id<'surfaces'>;
    readonly organisationConnectionId: Id<'organisationConnections'>;
  },
): Promise<{ surface: Doc<'surfaces'>; connection: Doc<'organisationConnections'> }> {
  const surface = await ctx.db.get(args.surfaceId);
  if (!surface) throw new ConvexError('Surface not found.');
  if (surface.managerApprovedAt === undefined) {
    throw new ConvexError('The manager has not approved this card.');
  }
  if (organisationSystemOf(surface) !== LINEAR_SYSTEM) {
    throw new ConvexError('This card is not a Linear card.');
  }
  const connection = await ctx.db.get(args.organisationConnectionId);
  if (!connection || connection.status !== 'active' || connection.system !== LINEAR_SYSTEM) {
    throw new ConvexError("The organisation's Linear connection is no longer active.");
  }
  if (surface.organisationConnectionId !== connection._id) {
    throw new ConvexError("The card is not linked to the organisation's Linear connection.");
  }
  return { surface, connection };
}

/**
 * Connect a card through the organisation's shared Linear app (D3, shared mode): the card holds the
 * connection's one app-actor token and acts as the shared app user, so its writes carry the
 * employee's trailer (the provenance rules read the card's `shared-app` identity:
 * `signsForEmployee`). The probe is queued. Internal, for `linearIdentityActions.connect`,
 * which has checked the caller owns the employee and linked the card; refuses when the employee
 * changed hands since, or the token is no longer the connection's.
 */
export const connectSharedCard = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    ownerKey: v.string(),
    organisationConnectionId: v.id('organisationConnections'),
    credentialId: v.id('credentials'),
    appUser: appUserValidator,
    now: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    const { surface, connection } = await landingCard(ctx, args);
    const agent = await ctx.db.get(surface.agentId);
    if (!agent || agent.userId !== args.ownerKey) {
      throw new ConvexError('The employee changed hands while the card was connecting.');
    }
    if (
      !isSharedLinearApp(connection) ||
      connection.sharedTokenCredentialId !== args.credentialId
    ) {
      throw new ConvexError(
        "The organisation's Linear app token changed while the card was connecting.",
      );
    }
    await retireReplaced(ctx, surface, args.credentialId, args.now);
    const actsAs: ActsAs = {
      kind: 'shared-app',
      label: connection.displayName,
      providerIdentityId: args.appUser.id,
    };
    await ctx.db.patch(surface._id, {
      credentialId: args.credentialId,
      // The OAuth token it is; the card's `shared-app` identity makes every write through it name
      // the employee (`signsForEmployee`).
      credentialKind: 'oauth',
      credentialLocation: undefined,
      credentialLanded: false,
      actsAs,
      providerIdentityId: args.appUser.id,
      ...landedVerdict(surface),
    });
    await ctx.scheduler.runAfter(0, internal.surfaceActions.probeInternal, {
      surfaceId: surface._id,
    });
  },
});

/**
 * Record the employee's own Linear app a Linear administrator created for the card (per-employee
 * mode, L1: one app per employee, no API creates one) and start its installation: its client
 * secret sealed as an organisation row with `issuedBy` (an app Day0 holds the secret of, which no
 * API deletes: 11-AR names it), the app on `provisioning`, and the authorisation the administrator
 * completes on `pendingAuthorisation`. An app recorded before on the card is replaced and its secret
 * purged. Writes `surface.app-provisioned`. Internal, for `linearIdentityActions.registerEmployeeApp`,
 * which has checked the caller is an administrator.
 */
export const recordEmployeeApp = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    organisationConnectionId: v.id('organisationConnections'),
    appName: v.string(),
    clientId: v.string(),
    sealedSecret: sealedValidator,
    redirectUrl: v.string(),
    scopes: v.array(v.string()),
    installUrl: v.string(),
    pending: pendingAuthorisationValidator,
    now: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    const { surface, connection } = await landingCard(ctx, args);
    if (!isPerEmployeeLinear(connection)) {
      throw new ConvexError("The organisation's Linear connection is not per employee.");
    }
    const clientSecretCredentialId = await ctx.db.insert('credentials', {
      userId: ORGANISATION_OWNER_KEY,
      holder: ORGANISATION_HOLDER,
      kind: 'value',
      source: 'entered',
      label: `${args.appName} client secret`,
      ...args.sealedSecret,
      issuedBy: {
        system: LINEAR_SYSTEM,
        grant: 'app-created',
        organisationConnectionId: connection._id,
        clientId: args.clientId,
      },
      createdAt: args.now,
    });
    // An app recorded before and never installed has its secret purged now; one whose tokens the
    // card holds keeps it, since they are refreshed with it, until this app's installation lands.
    const previous = surface.provisioning?.clientSecretCredentialId;
    if (previous !== undefined && (await secretInUse(ctx, surface)) !== previous) {
      await purgeSecret(ctx, previous, args.now);
    }
    await ctx.db.patch(surface._id, {
      provisioning: {
        appId: args.clientId,
        appName: args.appName,
        clientId: args.clientId,
        clientSecretCredentialId,
        installUrl: args.installUrl,
        redirectUrl: args.redirectUrl,
        scopes: args.scopes,
        createdAt: args.now,
      },
      pendingAuthorisation: args.pending,
    });
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.app-provisioned',
      payload: { surfaceId: surface._id, appId: args.clientId, appName: args.appName },
      createdAt: args.now,
    });
    await ctx.scheduler.runAt(
      args.pending.stateExpiresAt,
      internal.linearIdentity.expirePendingAuthorisation,
      { surfaceId: surface._id, stateNonce: args.pending.stateNonce },
    );
  },
});

/**
 * Record a fresh installation link for the card's registered app, replacing any earlier one.
 * Internal, for `linearIdentityActions.startAuthorisation`, which has checked the caller.
 */
export const recordPendingAuthorisation = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    clientId: v.string(),
    installUrl: v.string(),
    pending: pendingAuthorisationValidator,
  },
  handler: async (ctx, args): Promise<void> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new ConvexError('Surface not found.');
    if (surface.provisioning?.clientId !== args.clientId) {
      throw new ConvexError("The card's Linear app changed while its installation was starting.");
    }
    await ctx.db.patch(surface._id, {
      provisioning: { ...surface.provisioning, installUrl: args.installUrl },
      pendingAuthorisation: args.pending,
    });
    await ctx.scheduler.runAt(
      args.pending.stateExpiresAt,
      internal.linearIdentity.expirePendingAuthorisation,
      { surfaceId: surface._id, stateNonce: args.pending.stateNonce },
    );
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
 * Clear a pending installation at its state's expiry, unless a newer one replaced it. Internal;
 * scheduled by {@link recordEmployeeApp} and {@link recordPendingAuthorisation}.
 */
export const expirePendingAuthorisation = internalMutation({
  args: { surfaceId: v.id('surfaces'), stateNonce: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (surface) await clearPending(ctx, surface, args.stateNonce);
  },
});

/**
 * Consume a card's pending installation for the redirect that names its nonce: one transaction, so
 * two redirects cannot both win and a replay finds nothing. An expired one is cleared and refused;
 * one whose app the card no longer holds is refused. Internal, for
 * `linearIdentityActions.completeAuthorisation`, which has verified the state's signature.
 */
export const claimPendingAuthorisation = internalMutation({
  args: { surfaceId: v.string(), stateNonce: v.string(), now: v.number() },
  handler: async (
    ctx,
    args,
  ): Promise<ClaimedLinearAuthorisation | { ok: false; reason: LinearClaimFailure }> => {
    const id = ctx.db.normalizeId('surfaces', args.surfaceId);
    const surface = id === null ? null : await ctx.db.get(id);
    const pending = surface?.pendingAuthorisation;
    if (!surface || !pending) return { ok: false, reason: 'none' };
    if (pending.stateNonce !== args.stateNonce) return { ok: false, reason: 'used' };
    // Another flow's authorisation (11-AM's MCP rung shares the row) is left for its own redirect.
    if (pending.issuer !== LINEAR_ISSUER) return { ok: false, reason: 'none' };
    await clearPending(ctx, surface);
    if (pending.stateExpiresAt <= args.now) return { ok: false, reason: 'expired' };
    const app = surface.provisioning;
    if (!app || app.clientId !== pending.clientId) return { ok: false, reason: 'replaced' };
    return {
      ok: true,
      pending,
      agentId: surface.agentId,
      slug: surface.slug,
      appName: app.appName,
      clientSecretCredentialId: app.clientSecretCredentialId,
    };
  },
});

/**
 * Land an installation's tokens on the card (per-employee mode): the refresh token and the access
 * token as two organisation rows (the access token's `refreshCredentialId` naming the other,
 * `generation` 0, `issuedBy` the authorisation code with the app's ids), bound to the card acting as
 * its own app user, in one transaction; the credential the card held before retired; the probe and
 * the first scheduled refresh queued. Writes `surface.app-installed`. Internal, for
 * `linearIdentityActions.completeAuthorisation`.
 *
 * @returns The access token's credential.
 */
export const landEmployeeTokens = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    organisationConnectionId: v.id('organisationConnections'),
    clientId: v.string(),
    access: sealedValidator,
    refresh: sealedValidator,
    expiresAt: v.optional(v.number()),
    appUser: appUserValidator,
    now: v.number(),
  },
  handler: async (ctx, args): Promise<Id<'credentials'>> => {
    const { surface, connection } = await landingCard(ctx, args);
    const app = surface.provisioning;
    if (!isPerEmployeeLinear(connection) || !app || app.clientId !== args.clientId) {
      throw new ConvexError("The card's Linear app changed while its installation was completing.");
    }
    const common: Pick<
      Doc<'credentials'>,
      'userId' | 'holder' | 'kind' | 'source' | 'issuedBy' | 'createdAt'
    > = {
      userId: ORGANISATION_OWNER_KEY,
      holder: ORGANISATION_HOLDER,
      kind: 'oauth',
      source: 'oauth',
      issuedBy: {
        system: LINEAR_SYSTEM,
        grant: 'authorisation-code',
        organisationConnectionId: connection._id,
        appId: app.appId,
        clientId: app.clientId,
        clientSecretCredentialId: app.clientSecretCredentialId,
      },
      createdAt: args.now,
    };
    const refreshCredentialId = await ctx.db.insert('credentials', {
      ...common,
      ...args.refresh,
      label: `${app.appName} refresh token`,
    });
    const credentialId = await ctx.db.insert('credentials', {
      ...common,
      ...args.access,
      label: `${app.appName} access token`,
      generation: 0,
      ...(args.expiresAt === undefined ? {} : { expiresAt: args.expiresAt }),
      refreshCredentialId,
    });
    const replacedSecret = await secretInUse(ctx, surface);
    await retireReplaced(ctx, surface, credentialId, args.now);
    if (replacedSecret !== undefined && replacedSecret !== app.clientSecretCredentialId) {
      await purgeSecret(ctx, replacedSecret, args.now);
    }
    const actsAs: ActsAs = {
      kind: 'own-app',
      label: app.appName,
      providerIdentityId: args.appUser.id,
    };
    await ctx.db.patch(surface._id, {
      credentialId,
      credentialKind: 'oauth',
      credentialLocation: undefined,
      credentialLanded: false,
      actsAs,
      providerIdentityId: args.appUser.id,
      provisioning: { ...app, installedAt: args.now, lastError: undefined },
      ...landedVerdict(surface),
    });
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.app-installed',
      payload: { surfaceId: surface._id, appId: app.appId },
      createdAt: args.now,
    });
    await ctx.scheduler.runAfter(0, internal.surfaceActions.probeInternal, {
      surfaceId: surface._id,
    });
    if (args.expiresAt !== undefined) {
      await ctx.scheduler.runAt(
        renewalDueAt(args.expiresAt, args.now, ACCESS_TOKEN_REFRESH_LEAD_MS),
        internal.linearIdentityActions.refreshScheduled,
        { credentialId, generation: 0 },
      );
    }
    return credentialId;
  },
});

/**
 * Write a refresh's tokens, the access token and the rotated refresh token together, only while
 * the pair is still at the generation the refresh read (the rotation-safe write): a concurrent
 * refresh that read the same generation loses here and uses the winner's token. Queues the next
 * scheduled refresh. Internal, for `linearIdentityActions`.
 */
export const rotateEmployeeTokens = internalMutation({
  args: {
    credentialId: v.id('credentials'),
    expectedGeneration: v.number(),
    access: sealedValidator,
    refresh: v.optional(sealedValidator),
    expiresAt: v.optional(v.number()),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<LinearRotationOutcome> => {
    const access = await ctx.db.get(args.credentialId);
    if (!holdsValue(access) || !access.issuedBy) return { ok: false, reason: 'gone' };
    const current = access.generation ?? 0;
    if (current !== args.expectedGeneration) {
      return { ok: false, reason: 'stale', credentialId: access._id };
    }
    const generation = current + 1;
    const issuedBy = { ...access.issuedBy, grant: 'token-rotation' as const };
    await ctx.db.patch(access._id, {
      ...args.access,
      expiresAt: args.expiresAt,
      generation,
      issuedBy,
      lastUsedAt: undefined,
      // The rotation ends the refresh lease its holder took (`refreshLease.claim`).
      refreshingUntil: undefined,
    });
    if (args.refresh !== undefined && access.refreshCredentialId !== undefined) {
      const refresh = await ctx.db.get(access.refreshCredentialId);
      if (holdsValue(refresh)) await ctx.db.patch(refresh._id, { ...args.refresh, issuedBy });
    }
    if (args.expiresAt !== undefined) {
      await ctx.scheduler.runAt(
        renewalDueAt(args.expiresAt, args.now, ACCESS_TOKEN_REFRESH_LEAD_MS),
        internal.linearIdentityActions.refreshScheduled,
        { credentialId: access._id, generation },
      );
    }
    return { ok: true, credentialId: access._id, generation };
  },
});

/** The cards holding a credential, bounded. */
async function cardsHolding(
  ctx: Pick<QueryCtx, 'db'>,
  credentialId: Id<'credentials'>,
): Promise<Doc<'surfaces'>[]> {
  return await ctx.db
    .query('surfaces')
    .withIndex('by_credentialId', (index) => index.eq('credentialId', credentialId))
    .take(CARDS_PER_CREDENTIAL_LIMIT);
}

/**
 * Write a refused renewal onto the record of every card holding the token, with the reason, and
 * queue each card's check for when the token stops working, so the card ends with the reason then
 * (`surface.install-failed`: the remedy is a Linear administrator installing the app again).
 * Internal, for `linearIdentityActions.refreshScheduled`.
 */
export const recordRefusal = internalMutation({
  args: {
    credentialId: v.id('credentials'),
    reason: v.string(),
    endsAt: v.optional(v.number()),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    for (const surface of await cardsHolding(ctx, args.credentialId)) {
      await appendEvent(ctx, {
        agentId: surface.agentId,
        type: 'surface.install-failed',
        payload: { surfaceId: surface._id, reason: args.reason },
        createdAt: args.now,
      });
      await ctx.scheduler.runAt(
        Math.max(args.now, args.endsAt ?? args.now),
        internal.surfaceActions.probeInternal,
        { surfaceId: surface._id, routine: true },
      );
    }
  },
});

/**
 * Write a failed installation onto the card's record and its app's `lastError`. Internal, for
 * `linearIdentityActions.completeAuthorisation`.
 */
export const recordAuthorisationFailure = internalMutation({
  args: { surfaceId: v.id('surfaces'), reason: v.string(), now: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) return;
    if (surface.provisioning) {
      await ctx.db.patch(surface._id, {
        provisioning: { ...surface.provisioning, lastError: args.reason },
      });
    }
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.install-failed',
      payload: { surfaceId: surface._id, reason: args.reason },
      createdAt: args.now,
    });
  },
});

/**
 * Whom an employee's card acts as, by the employee and the card's slug, for the re-read before a
 * run's first write on a ticket (D6): the identity the landing recorded and the one the card's last
 * probe read. Internal; writes nothing.
 *
 * @returns The card's identity, or null when the employee has no card of that slug.
 */
export const actingCard = internalQuery({
  args: { agentId: v.id('agents'), slug: v.string() },
  handler: async (ctx, args): Promise<ActingCard | null> => {
    const card: Doc<'surfaces'> | null = await ctx.db
      .query('surfaces')
      .withIndex('by_agent_slug', (index) =>
        index.eq('agentId', args.agentId).eq('slug', args.slug),
      )
      .first();
    if (card === null) return null;
    return {
      ...(card.actsAs === undefined ? {} : { actsAs: card.actsAs }),
      ...(card.providerIdentityId === undefined
        ? {}
        : { providerIdentityId: card.providerIdentityId }),
    };
  },
});
