import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import { appendConnectionEvent } from './connectionEvents';
import { purgeAppLevelToken, purgeCredential } from './credentials';
import { appendEvent } from './eventLog';
import { endedByItsRevoke } from './organisationConnectionReads';
import { assertOwnsAgent, getCallerOrThrow } from './ownership';
import { recordAppTakesMessages } from './slackMessagesTab';
import { ORGANISATION_HOLDER, ORGANISATION_OWNER_KEY } from '../src/lib/organisation-key';
import { assertRealMode } from '../src/lib/surface-mode';
import type {
  OrganisationConfigurationUsedPayload,
  SlackConfigurationMethod,
} from '../src/events/contract';
import {
  isIssuedAs,
  keepCurrentAt,
  slackClientSecretIssuer,
} from '../src/surfaces/identity-issuers/slack';

/*
 * The transactions of Slack's identity issuer (wave 11, 11-AS; the access plan, section 4.9): the
 * organisation's configuration token and its refresh token, read as one snapshot and rewritten as
 * a pair only while they are still at the generation a rotation read (B9; S2: Slack does not say
 * whether a used refresh token dies, so the new pair is written before it is used and a concurrent
 * rotation loses and re-reads); one line on the connection's ledger for every use (AC11); and the
 * app an employee's card was given, with its client secret held by the organisation and its
 * `issuedBy` (11-AR's rule reads it). The calls to Slack are `slackProvisionActions`'.
 */

/** The configuration token's row, its refresh token's and their connection, as one read saw them. */
export interface HeldConfigurationRows {
  readonly connection: Doc<'organisationConnections'>;
  /** The configuration token's row, while it holds a value and is not revoked. */
  readonly secret: Doc<'credentials'>;
  /** Its refresh token's row, while it holds a value and is not revoked; null when IT gave none. */
  readonly refresh: Doc<'credentials'> | null;
}

/** Why IT must give the connection a new pair: Slack refused the kept refresh token. */
export const SPENT_REFRESH_REASON =
  'Slack refused the configuration refresh token, so Day0 can no longer renew the configuration ' +
  "token: generate a new configuration token and its refresh token in Slack's app settings and " +
  'rotate the connection.';

/** A row the organisation holds that still has a value and has not been revoked. */
function liveOrganisationRow(row: Doc<'credentials'> | null): row is Doc<'credentials'> {
  return (
    row !== null &&
    row.holder === ORGANISATION_HOLDER &&
    row.userId === ORGANISATION_OWNER_KEY &&
    row.revokedAt === undefined &&
    row.status === undefined &&
    row.ciphertext !== undefined &&
    row.iv !== undefined
  );
}

/**
 * The connection's configuration token and refresh token as one snapshot, or null when the
 * connection is not a Slack configuration connection, is revoked, or holds no live token.
 *
 * @param ctx - Any reader.
 * @param organisationConnectionId - The connection.
 */
async function heldRows(
  ctx: Pick<QueryCtx, 'db'>,
  organisationConnectionId: Id<'organisationConnections'>,
): Promise<HeldConfigurationRows | null> {
  const connection = await ctx.db.get(organisationConnectionId);
  if (
    connection === null ||
    connection.kind !== 'slack-configuration' ||
    connection.status === 'revoked' ||
    connection.secretCredentialId === undefined
  ) {
    return null;
  }
  const secret = await ctx.db.get(connection.secretCredentialId);
  if (!liveOrganisationRow(secret)) return null;
  const refresh = secret.refreshCredentialId ? await ctx.db.get(secret.refreshCredentialId) : null;
  return { connection, secret, refresh: liveOrganisationRow(refresh) ? refresh : null };
}

/**
 * The connection's configuration token, its refresh token and the connection, read in one
 * snapshot so a rotation opens the refresh token of the generation it read. Internal; writes
 * nothing.
 */
export const heldConfiguration = internalQuery({
  args: { organisationConnectionId: v.id('organisationConnections') },
  handler: async (ctx, args): Promise<HeldConfigurationRows | null> =>
    await heldRows(ctx, args.organisationConnectionId),
});

const sealedValidator = v.object({ ciphertext: v.string(), iv: v.string(), keyId: v.string() });

/** What writing a rotation answers. */
export type RotationRecorded =
  | { readonly ok: true; readonly generation: number }
  | { readonly ok: false; readonly reason: 'stale' | 'gone' };

/** One line on the connection's ledger for a use of its configuration token or refresh token. */
async function appendUse(
  ctx: Pick<MutationCtx, 'db'>,
  connection: Doc<'organisationConnections'>,
  use: {
    readonly method: SlackConfigurationMethod;
    readonly outcome: OrganisationConfigurationUsedPayload['outcome'];
    readonly reason?: string;
    readonly appId?: string;
    readonly expiresAt?: number;
  },
  now: number,
): Promise<void> {
  await appendConnectionEvent(ctx, {
    organisationConnectionId: connection._id,
    type: 'organisation.configuration-used',
    payload: {
      organisationConnectionId: connection._id,
      system: connection.system,
      displayName: connection.displayName,
      method: use.method,
      outcome: use.outcome,
      ...(use.reason === undefined ? {} : { reason: use.reason }),
      ...(use.appId === undefined ? {} : { appId: use.appId }),
      ...(use.expiresAt === undefined ? {} : { expiresAt: use.expiresAt }),
    },
    createdAt: now,
  });
}

/**
 * Write a rotation's new configuration token and refresh token over the kept pair, only while it
 * is still the connection's pair at the generation the rotation read; queue the renewal that keeps
 * it current; and write the use on the connection's ledger. A rotation that lost to a concurrent
 * one (`stale`), or whose connection was revoked or given a new secret meanwhile (`gone`), writes
 * nothing but its `superseded` line: Slack issued a pair Day0 does not keep, and the caller
 * re-reads. A connection Day0 had marked for IT's attention because its refresh token was refused
 * is active again, since a pair landed after all. Internal, for `slackProvisionActions`.
 */
export const recordRotation = internalMutation({
  args: {
    organisationConnectionId: v.id('organisationConnections'),
    secretCredentialId: v.id('credentials'),
    expectedGeneration: v.number(),
    token: sealedValidator,
    refresh: sealedValidator,
    expiresAt: v.number(),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<RotationRecorded> => {
    const held = await heldRows(ctx, args.organisationConnectionId);
    if (held === null || held.secret._id !== args.secretCredentialId || held.refresh === null) {
      return await superseded(ctx, args, 'gone');
    }
    if ((held.secret.generation ?? 0) !== args.expectedGeneration) {
      return await superseded(ctx, args, 'stale');
    }
    const generation = args.expectedGeneration + 1;
    await ctx.db.patch(held.refresh._id, { ...args.refresh });
    // The rotation ends the refresh lease its holder took (`refreshLease.claim`).
    await ctx.db.patch(held.secret._id, {
      ...args.token,
      generation,
      expiresAt: args.expiresAt,
      refreshingUntil: undefined,
    });
    if (
      held.connection.status === 'needs-attention' &&
      held.connection.statusReason === SPENT_REFRESH_REASON
    ) {
      await ctx.db.patch(held.connection._id, { status: 'active', statusReason: undefined });
    }
    await appendUse(
      ctx,
      held.connection,
      { method: 'tooling.tokens.rotate', outcome: 'done', expiresAt: args.expiresAt },
      args.now,
    );
    await ctx.scheduler.runAt(
      keepCurrentAt(args.expiresAt, args.now),
      internal.slackProvisionActions.keepConfigurationCurrent,
      {
        organisationConnectionId: args.organisationConnectionId,
        secretCredentialId: held.secret._id,
        generation,
      },
    );
    return { ok: true, generation };
  },
});

/** The words a superseded rotation's ledger line gives, by why it was superseded. */
const SUPERSEDED_BECAUSE: { readonly [Reason in 'stale' | 'gone']: string } = {
  stale: 'another renewal wrote its pair first',
  gone: 'the connection was revoked or given a new secret meanwhile',
};

/**
 * Write a rotation's `superseded` line, on the connection's ledger while the connection exists,
 * and answer why nothing else was written.
 */
async function superseded(
  ctx: Pick<MutationCtx, 'db'>,
  args: { readonly organisationConnectionId: Id<'organisationConnections'>; readonly now: number },
  reason: 'stale' | 'gone',
): Promise<RotationRecorded> {
  const connection = await ctx.db.get(args.organisationConnectionId);
  if (connection !== null) {
    await appendUse(
      ctx,
      connection,
      {
        method: 'tooling.tokens.rotate',
        outcome: 'superseded',
        reason: SUPERSEDED_BECAUSE[reason],
      },
      args.now,
    );
  }
  return { ok: false, reason };
}

/**
 * Record a rotation Slack refused, on the connection's ledger. When the refresh token is spent
 * and the pair is still the one the rotation read, the connection is marked for IT's attention
 * with {@link SPENT_REFRESH_REASON}: only a new pair revives it, and until then a card's field is
 * the way to create an app. Internal, for `slackProvisionActions`.
 *
 * @returns Whether the pair moved on since the rotation read it, so the caller re-reads.
 */
export const recordRotationRefused = internalMutation({
  args: {
    organisationConnectionId: v.id('organisationConnections'),
    secretCredentialId: v.id('credentials'),
    expectedGeneration: v.number(),
    reason: v.string(),
    spent: v.boolean(),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<{ readonly moved: boolean }> => {
    const held = await heldRows(ctx, args.organisationConnectionId);
    const connection = held?.connection ?? (await ctx.db.get(args.organisationConnectionId));
    if (connection !== null) {
      await appendUse(
        ctx,
        connection,
        { method: 'tooling.tokens.rotate', outcome: 'failed', reason: args.reason },
        args.now,
      );
    }
    const moved =
      held === null ||
      held.secret._id !== args.secretCredentialId ||
      (held.secret.generation ?? 0) !== args.expectedGeneration;
    if (!moved && args.spent && held.connection.status === 'active') {
      await ctx.db.patch(held.connection._id, {
        status: 'needs-attention',
        statusReason: SPENT_REFRESH_REASON,
      });
    }
    return { moved };
  },
});

/**
 * Write one use of the configuration token on the connection's ledger: an app created, read or
 * opened for messages, or a call Slack refused. Internal, for `slackProvisionActions` and
 * `slackMessagesTabActions`.
 */
export const recordConfigurationUse = internalMutation({
  args: {
    organisationConnectionId: v.id('organisationConnections'),
    method: v.union(
      v.literal('tooling.tokens.rotate'),
      v.literal('apps.manifest.create'),
      v.literal('apps.manifest.export'),
      v.literal('apps.manifest.update'),
    ),
    outcome: v.union(v.literal('done'), v.literal('failed')),
    reason: v.optional(v.string()),
    appId: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const connection = await ctx.db.get(args.organisationConnectionId);
    if (connection === null) return null;
    await appendUse(
      ctx,
      connection,
      {
        method: args.method,
        outcome: args.outcome,
        ...(args.reason === undefined ? {} : { reason: args.reason }),
        ...(args.appId === undefined ? {} : { appId: args.appId }),
      },
      args.now,
    );
    return null;
  },
});

/** Why an app's record was refused: the card was given an app meanwhile. */
export const CARD_HAS_APP = 'This card already has its own Slack app.';

const installLinkFields = {
  installUrl: v.string(),
  stateNonce: v.string(),
  stateExpiresAt: v.number(),
};

/** Why an app created under the employee's previous owner is not recorded (m10). */
const CHANGED_HANDS =
  'The employee changed hands while its app was being created, so the app was not recorded.';

/**
 * Record the app Day0 just created for an employee, with its install link, in one transaction:
 * the card's `provisioning` (the connection that created it, when one did: 11-AR's retire reads it
 * to choose `apps.manifest.delete`, S4) and the record's `surface.app-provisioned`. The client
 * secret is a row the organisation holds, stored by the action with its holder and this app's
 * `issuedBy` (`app-created`), which nothing names until this write. Internal, for
 * `slackProvisionActions`. Refuses an employee that changed hands since the action started, as the
 * Linear and MCP recorders do (the wave 11 review's m10): the old manager's app never lands on a
 * card the handover gave another.
 *
 * @throws ConvexError with {@link CARD_HAS_APP} when the card was given an app meanwhile, when the
 *   employee changed hands, or when the secret is not a live row the organisation holds for this
 *   app.
 */
export const recordCreatedApp = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    appId: v.string(),
    appName: v.string(),
    clientId: v.string(),
    clientSecretCredentialId: v.id('credentials'),
    redirectUrl: v.string(),
    scopes: v.array(v.string()),
    organisationConnectionId: v.optional(v.id('organisationConnections')),
    ...installLinkFields,
    /** The owner key the provisioning action started under. */
    startedUnder: v.string(),
    /** The manifest the app was created from opens its messages tab (W12V-7). */
    takesMessages: v.optional(v.boolean()),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const [surface, secret] = await Promise.all([
      ctx.db.get(args.surfaceId),
      ctx.db.get(args.clientSecretCredentialId),
    ]);
    if (surface === null) throw new ConvexError('Surface not found.');
    const agent = await ctx.db.get(surface.agentId);
    if (agent?.userId !== args.startedUnder) throw new ConvexError(CHANGED_HANDS);
    if (surface.provisioning !== undefined) throw new ConvexError(CARD_HAS_APP);
    const app = {
      appId: args.appId,
      clientId: args.clientId,
      ...(args.organisationConnectionId === undefined
        ? {}
        : { organisationConnectionId: args.organisationConnectionId }),
    };
    // The action stored the secret with this app's issuer (the pre-tag's item 10): one stored for
    // another app, or without one, is not this app's.
    if (
      !liveOrganisationRow(secret) ||
      !isIssuedAs(secret.issuedBy, slackClientSecretIssuer(app))
    ) {
      throw new ConvexError("The app's client secret is not one the organisation holds for it.");
    }
    await ctx.db.patch(surface._id, {
      provisioning: {
        ...app,
        appName: args.appName,
        clientSecretCredentialId: secret._id,
        installUrl: args.installUrl,
        redirectUrl: args.redirectUrl,
        scopes: args.scopes,
        createdAt: args.now,
        stateNonce: args.stateNonce,
        stateExpiresAt: args.stateExpiresAt,
      },
    });
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.app-provisioned',
      payload: { surfaceId: surface._id, appId: args.appId, appName: args.appName },
      createdAt: args.now,
    });
    if (args.takesMessages === true) {
      await recordAppTakesMessages(
        ctx,
        surface,
        { appId: args.appId, appName: args.appName },
        'created',
        args.now,
      );
    }
    return null;
  },
});

/**
 * File a fresh single-use install link for the card's kept app: the second click before its
 * install, or the renewal after an expiry or a Disconnect (A26's `reissue: 'install'`), which
 * installs the same app again rather than creating a second one (P3-17). The app, its secret and
 * when it was first installed are kept. Internal, for `slackProvisionActions`.
 *
 * @throws ConvexError when the card's app is not the one the link was signed for.
 */
export const recordInstallLink = internalMutation({
  args: { surfaceId: v.id('surfaces'), appId: v.string(), ...installLinkFields, now: v.number() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (surface?.provisioning?.appId !== args.appId) {
      throw new ConvexError("The card's app changed while its install link was being issued.");
    }
    await ctx.db.patch(surface._id, {
      provisioning: {
        ...surface.provisioning,
        installUrl: args.installUrl,
        stateNonce: args.stateNonce,
        stateExpiresAt: args.stateExpiresAt,
        lastError: undefined,
      },
    });
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.app-provisioned',
      payload: {
        surfaceId: surface._id,
        appId: surface.provisioning.appId,
        appName: surface.provisioning.appName,
      },
      createdAt: args.now,
    });
    return null;
  },
});

/** Why Forget this app is refused: the card's own app is not one IT's revoke ended. */
export const FORGET_NOT_ENDED =
  "This card's own Slack app is not one IT's revoke ended, so there is nothing to forget.";

/**
 * Forget the employee's own Slack app that IT's revoke ended (W12X-4; 13-FS's design 2, option
 * (b), the operator's "recommended decisions" of 6 October), so the card offers Connect and
 * `provisionApp` creates a new app through IT's new connection. Day0 cannot delete the old app:
 * `apps.manifest.delete` needs the configuration token of the connection that created it, which IT
 * revoked, so IT deletes it in Slack's app settings, and the record says so by the app's id and
 * name, the one pointer left to it once the card forgets it.
 *
 * Public, owner-guarded, real mode only; the manager's control on such a card. Writes the card
 * (its app and what the old app's bot answered: its identity, its DM with the manager and the
 * channels it was not in), purges the app's client secret and app-level token, which nothing can
 * use, and appends `surface.app-forgotten`.
 *
 * @throws ConvexError with {@link FORGET_NOT_ENDED} when the card's app is not one IT's revoke
 *   ended.
 */
export const forgetEndedApp = mutation({
  args: { surfaceId: v.id('surfaces') },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await getCallerOrThrow(ctx);
    const surface = await ctx.db.get(args.surfaceId);
    if (surface === null) throw new ConvexError('Surface not found.');
    await assertOwnsAgent(ctx, surface.agentId);
    assertRealMode('Forgetting an app');
    const app = surface.provisioning;
    if (app === undefined || (await endedByItsRevoke(ctx, surface)) !== 'kept-app-ended') {
      throw new ConvexError(FORGET_NOT_ENDED);
    }
    const now = Date.now();
    const secret = await ctx.db.get(app.clientSecretCredentialId);
    if (secret !== null) await purgeCredential(ctx, secret, now);
    await purgeAppLevelToken(ctx, app.appLevelTokenCredentialId, now);
    await ctx.db.patch(surface._id, {
      provisioning: undefined,
      // The old bot's: the new app has its own identity and its own DM, which its probe reads.
      providerIdentityId: undefined,
      providerBotId: undefined,
      managerDmChannelId: undefined,
      channelsNotJoined: undefined,
      lastDecisionPolledAt: undefined,
      lastDecisionError: undefined,
    });
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.app-forgotten',
      payload: {
        surfaceId: surface._id,
        appId: app.appId,
        appName: app.appName,
        ...(app.organisationConnectionId === undefined
          ? {}
          : { organisationConnectionId: app.organisationConnectionId }),
      },
      createdAt: now,
    });
    return null;
  },
});
