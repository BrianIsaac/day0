import { v } from 'convex/values';
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
} from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { purgeCredential } from './credentials';
import { appendConnectionEvent } from './connectionEvents';
import { ORGANISATION_HOLDER } from '../src/lib/organisation-key';
import type { OrganisationConnectionKind } from '../src/surfaces/access-identity';
import { readLinearAnswer, linearTokenRevocation } from '../src/surfaces/revokers/linear';
import type { RevocationAnswer } from '../src/surfaces/revokers/types';
import {
  revokeSlackConfigurationToken,
  sendRevocation,
  slackRevocationOutcome,
  type SlackRevocationAnswer,
} from './sourceRevocationSend';

/*
 * The end of an organisation secret a revoke or a rotation takes out of use (the wave 11 review's
 * M6). Such a secret is revoked in Day0 in the change's own transaction, and then, by its
 * connection's kind: Slack's configuration token, which can create and delete apps in the
 * workspace, is revoked at Slack with `auth.revoke` and the pair's values deleted; an MCP client's
 * secret keeps its value for the 24 hours (F19) the card revocations its connection's revoke
 * scheduled may need it for (AJ6), and is then deleted; a shared Linear app's app-actor token,
 * which no employee is left to share once its connection is revoked, is revoked at Linear (`POST
 * /oauth/revoke {token}`, no client authentication, R41V-1) and its value deleted; any other
 * secret (an app's client secret, a service key, IT's own static key) has no call Day0 makes to
 * end it, and its value is deleted at once.
 */

/** How long a taken-out secret may keep its value: F19's bound on a kept ciphertext. */
export const ORGANISATION_SECRET_HOLD_MS = 24 * 60 * 60 * 1000;

/** How many times Day0 asks a vendor to revoke an organisation secret before it gives up. */
const VENDOR_REVOKE_ATTEMPTS = 3;

/** How long Day0 waits before asking the vendor again after a failure another attempt may pass. */
const VENDOR_REVOKE_RETRY_MS = 60 * 60 * 1000;

/** The longest reason a ledger line keeps. */
const REASON_LIMIT = 300;

/** The secrets one revoke or rotation takes out of use, and the connection they were under. */
export interface TakenOutSecrets {
  readonly organisationConnectionId: Id<'organisationConnections'>;
  readonly kind: OrganisationConnectionKind;
  /** The connection's secret: for Slack, the configuration token `auth.revoke` is sent. */
  readonly secretCredentialId?: Id<'credentials'>;
  /** Every row taken out: the secret, its refresh token, a shared token. */
  readonly credentialIds: ReadonlyArray<Id<'credentials'> | undefined>;
}

/**
 * Revoke the organisation secrets a revoke or a rotation takes out of use, in its transaction, and
 * end each by its connection's kind (the module's rule). Only the organisation's own rows are
 * touched, and a row already revoked is left to whatever revoked it.
 *
 * @param ctx - The revoke's or the rotation's transaction.
 * @param secrets - The connection, its kind and the rows taken out.
 * @param now - The change's time.
 */
export async function endOrganisationSecrets(
  ctx: MutationCtx,
  secrets: TakenOutSecrets,
  now: number,
): Promise<void> {
  const ended: Doc<'credentials'>[] = [];
  for (const credentialId of secrets.credentialIds) {
    if (credentialId === undefined) continue;
    const row = await ctx.db.get(credentialId);
    if (row === null || row.holder !== ORGANISATION_HOLDER || row.revokedAt !== undefined) continue;
    await ctx.db.patch(credentialId, { revokedAt: now });
    ended.push(row);
  }
  if (ended.length === 0) return;
  const credentialIds = ended.map((row) => row._id);
  switch (secrets.kind) {
    case 'slack-configuration': {
      const configuration = ended.find((row) => row._id === secrets.secretCredentialId);
      if (configuration !== undefined) {
        await ctx.scheduler.runAfter(0, internal.organisationSecrets.revokeAtSlack, {
          organisationConnectionId: secrets.organisationConnectionId,
          configurationCredentialId: configuration._id,
          credentialIds,
          attempt: 1,
        });
      }
      // The values go after the 24 hours whatever became of the call: a lost job never keeps one.
      await ctx.scheduler.runAfter(
        ORGANISATION_SECRET_HOLD_MS,
        internal.organisationSecrets.purge,
        {
          credentialIds,
        },
      );
      return;
    }
    case 'mcp-client':
      await ctx.scheduler.runAfter(
        ORGANISATION_SECRET_HOLD_MS,
        internal.organisationSecrets.purge,
        {
          credentialIds,
        },
      );
      return;
    case 'oauth-app': {
      const sharedTokens = ended.filter(revocableSharedToken);
      for (const row of sharedTokens) {
        await ctx.scheduler.runAfter(0, internal.organisationSecrets.revokeSharedAtLinear, {
          organisationConnectionId: secrets.organisationConnectionId,
          credentialId: row._id,
          attempt: 1,
        });
      }
      for (const row of ended) {
        if (!sharedTokens.includes(row))
          await purgeCredential(ctx, { ...row, revokedAt: now }, now);
      }
      if (sharedTokens.length > 0) {
        // As for Slack's pair: the value goes after the 24 hours whatever became of the call.
        await ctx.scheduler.runAfter(
          ORGANISATION_SECRET_HOLD_MS,
          internal.organisationSecrets.purge,
          { credentialIds: sharedTokens.map((row) => row._id) },
        );
      }
      return;
    }
    case 'service-account':
    case 'static-key':
      for (const row of ended) await purgeCredential(ctx, { ...row, revokedAt: now }, now);
      return;
    default: {
      const unknown: never = secrets.kind;
      throw new Error(`unhandled connection kind ${String(unknown)}`);
    }
  }
}

/**
 * Whether a row taken out of use is a shared Linear app's app-actor token holding a value: the
 * one token of the organisation's that Day0 revokes at Linear when its connection is revoked.
 */
function revocableSharedToken(row: Doc<'credentials'>): boolean {
  return (
    row.issuedBy?.system === 'linear' &&
    row.issuedBy.grant === 'client-credentials' &&
    row.ciphertext !== undefined &&
    row.iv !== undefined
  );
}

/**
 * Delete the values of organisation secrets a revoke or a rotation took out of use, once nothing
 * may need them. Internal, scheduled by {@link endOrganisationSecrets} and
 * {@link finishSlackRevocation}; touches only revoked rows the organisation holds.
 */
export const purge = internalMutation({
  args: { credentialIds: v.array(v.id('credentials')) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const now = Date.now();
    for (const credentialId of args.credentialIds) {
      const row = await ctx.db.get(credentialId);
      if (row === null || row.holder !== ORGANISATION_HOLDER || row.revokedAt === undefined)
        continue;
      await purgeCredential(ctx, row, now);
    }
    return null;
  },
});

/**
 * The configuration token a revoke or a rotation took out of use, while it still holds its value:
 * the organisation's, revoked, on a Slack configuration connection. Internal, for
 * {@link revokeAtSlack}; writes nothing.
 */
export const heldConfigurationToken = internalQuery({
  args: {
    organisationConnectionId: v.id('organisationConnections'),
    credentialId: v.id('credentials'),
  },
  handler: async (ctx, args): Promise<Doc<'credentials'> | null> => {
    const [connection, row] = await Promise.all([
      ctx.db.get(args.organisationConnectionId),
      ctx.db.get(args.credentialId),
    ]);
    return connection?.kind === 'slack-configuration' &&
      row?.holder === ORGANISATION_HOLDER &&
      row.revokedAt !== undefined &&
      row.ciphertext !== undefined &&
      row.iv !== undefined
      ? row
      : null;
  },
});

/**
 * Open the held configuration token and ask Slack to revoke it.
 *
 * @returns Slack's answer, or a refusal when Day0 no longer holds the value.
 */
async function askSlack(
  ctx: ActionCtx,
  args: {
    readonly organisationConnectionId: Id<'organisationConnections'>;
    readonly configurationCredentialId: Id<'credentials'>;
  },
): Promise<SlackRevocationAnswer> {
  const held: Doc<'credentials'> | null = await ctx.runQuery(
    internal.organisationSecrets.heldConfigurationToken,
    {
      organisationConnectionId: args.organisationConnectionId,
      credentialId: args.configurationCredentialId,
    },
  );
  if (held === null || held.ciphertext === undefined || held.iv === undefined) {
    return {
      kind: 'refused',
      words:
        "Day0 no longer held the configuration token's value, so it could not be revoked at Slack.",
    };
  }
  const token = await ctx.runAction(internal.credentialCryptoActions.open, {
    ciphertext: held.ciphertext,
    iv: held.iv,
    userId: held.userId,
    keyId: held.keyId,
  });
  return await revokeSlackConfigurationToken(token);
}

/**
 * Revoke a Slack configuration token a revoke or a rotation took out of use at Slack
 * (`auth.revoke`), asking again an hour later after a failure another attempt may pass, up to
 * {@link VENDOR_REVOKE_ATTEMPTS} times, then delete the pair's values and write the call on the
 * connection's ledger (`organisation.configuration-used`, method `auth.revoke`). Internal,
 * scheduled by {@link endOrganisationSecrets}; the token is never written anywhere.
 */
export const revokeAtSlack = internalAction({
  args: {
    organisationConnectionId: v.id('organisationConnections'),
    configurationCredentialId: v.id('credentials'),
    credentialIds: v.array(v.id('credentials')),
    attempt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const answer = await askSlack(ctx, args);
    if (answer.kind === 'retry' && args.attempt < VENDOR_REVOKE_ATTEMPTS) {
      await ctx.scheduler.runAfter(
        VENDOR_REVOKE_RETRY_MS,
        internal.organisationSecrets.revokeAtSlack,
        {
          ...args,
          attempt: args.attempt + 1,
        },
      );
      return null;
    }
    await ctx.runMutation(internal.organisationSecrets.finishSlackRevocation, {
      organisationConnectionId: args.organisationConnectionId,
      credentialIds: args.credentialIds,
      ...slackRevocationOutcome(answer),
    });
    return null;
  },
});

/**
 * Write the configuration token's revocation at Slack on the connection's ledger and delete the
 * pair's values. Internal, for {@link revokeAtSlack}.
 */
export const finishSlackRevocation = internalMutation({
  args: {
    organisationConnectionId: v.id('organisationConnections'),
    credentialIds: v.array(v.id('credentials')),
    outcome: v.union(
      v.literal('done'),
      v.literal('already-revoked'),
      v.literal('unrecognised'),
      v.literal('failed'),
    ),
    reason: v.optional(v.string()),
    /** A token Slack issued that Day0 kept nowhere: no copy to delete. */
    unkept: v.optional(v.literal(true)),
    /** Slack's `auth.test` could not be asked afterwards whether the token still works. */
    unchecked: v.optional(v.literal(true)),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const now = Date.now();
    const connection = await ctx.db.get(args.organisationConnectionId);
    for (const credentialId of args.credentialIds) {
      const row = await ctx.db.get(credentialId);
      if (row === null || row.holder !== ORGANISATION_HOLDER || row.revokedAt === undefined)
        continue;
      await purgeCredential(ctx, row, now);
    }
    if (connection === null) return null;
    await appendConnectionEvent(ctx, {
      organisationConnectionId: connection._id,
      type: 'organisation.configuration-used',
      payload: {
        organisationConnectionId: connection._id,
        system: connection.system,
        displayName: connection.displayName,
        method: 'auth.revoke',
        outcome: args.outcome,
        ...(args.reason !== undefined ? { reason: args.reason.slice(0, REASON_LIMIT) } : {}),
        ...(args.unkept === true ? { unkept: true as const } : {}),
        ...(args.unchecked === true ? { unchecked: true as const } : {}),
      },
      createdAt: now,
    });
    return null;
  },
});

/**
 * The shared Linear app-actor token a connection's revoke took out of use, while it still holds
 * its value: the organisation's, revoked, issued by client credentials. Internal, for
 * {@link revokeSharedAtLinear}; writes nothing.
 */
export const heldSharedToken = internalQuery({
  args: { credentialId: v.id('credentials') },
  handler: async (ctx, args): Promise<Doc<'credentials'> | null> => {
    const row = await ctx.db.get(args.credentialId);
    return row !== null &&
      row.holder === ORGANISATION_HOLDER &&
      row.revokedAt !== undefined &&
      revocableSharedToken(row)
      ? row
      : null;
  },
});

/**
 * Open the held shared token and ask Linear to revoke it.
 *
 * @returns Linear's answer, or a refusal when Day0 no longer holds the value.
 */
async function askLinear(
  ctx: ActionCtx,
  credentialId: Id<'credentials'>,
): Promise<RevocationAnswer> {
  const held: Doc<'credentials'> | null = await ctx.runQuery(
    internal.organisationSecrets.heldSharedToken,
    { credentialId },
  );
  if (held === null || held.ciphertext === undefined || held.iv === undefined) {
    return {
      kind: 'refused',
      words:
        "Day0 no longer held the shared app token's value, so it could not be revoked at Linear.",
    };
  }
  const token = await ctx.runAction(internal.credentialCryptoActions.open, {
    ciphertext: held.ciphertext,
    iv: held.iv,
    userId: held.userId,
    keyId: held.keyId,
  });
  return await sendRevocation({
    request: linearTokenRevocation(token, 'access_token'),
    token,
    vendor: 'Linear',
    read: readLinearAnswer,
  });
}

/** The ledger's outcome for Linear's answer to the shared token's revoke. */
function sharedRevocationOutcome(
  answer: RevocationAnswer,
):
  | { readonly outcome: 'token-revoked' | 'already-gone' }
  | { readonly outcome: 'failed'; readonly reason: string } {
  switch (answer.kind) {
    case 'revoked':
      return { outcome: 'token-revoked' };
    case 'gone':
      return { outcome: 'already-gone' };
    case 'retry':
    case 'refused':
      return { outcome: 'failed', reason: answer.words };
    default: {
      const unknown: never = answer;
      throw new Error(`unhandled revocation answer ${String(unknown)}`);
    }
  }
}

/**
 * Revoke a revoked shared Linear connection's app-actor token at Linear (`POST /oauth/revoke
 * {token}`, which needs no client authentication), asking again an hour later after a failure
 * another attempt may pass, up to {@link VENDOR_REVOKE_ATTEMPTS} times, then delete its value and
 * write the call on the connection's ledger (`organisation.revoked-at-source`, `shared`). No
 * employee is left to share the token once its connection is revoked (R41V-1). Internal,
 * scheduled by {@link endOrganisationSecrets}; the token is never written anywhere.
 */
export const revokeSharedAtLinear = internalAction({
  args: {
    organisationConnectionId: v.id('organisationConnections'),
    credentialId: v.id('credentials'),
    attempt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const answer = await askLinear(ctx, args.credentialId);
    if (answer.kind === 'retry' && args.attempt < VENDOR_REVOKE_ATTEMPTS) {
      await ctx.scheduler.runAfter(
        VENDOR_REVOKE_RETRY_MS,
        internal.organisationSecrets.revokeSharedAtLinear,
        { ...args, attempt: args.attempt + 1 },
      );
      return null;
    }
    await ctx.runMutation(internal.organisationSecrets.finishSharedRevocation, {
      organisationConnectionId: args.organisationConnectionId,
      credentialId: args.credentialId,
      attempt: args.attempt,
      ...sharedRevocationOutcome(answer),
    });
    return null;
  },
});

/**
 * Write the shared token's revocation at Linear on the connection's ledger and delete its value.
 * Internal, for {@link revokeSharedAtLinear}.
 */
export const finishSharedRevocation = internalMutation({
  args: {
    organisationConnectionId: v.id('organisationConnections'),
    credentialId: v.id('credentials'),
    attempt: v.number(),
    outcome: v.union(v.literal('token-revoked'), v.literal('already-gone'), v.literal('failed')),
    reason: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const now = Date.now();
    const row = await ctx.db.get(args.credentialId);
    if (row !== null && row.holder === ORGANISATION_HOLDER && row.revokedAt !== undefined) {
      await purgeCredential(ctx, row, now);
    }
    const connection = await ctx.db.get(args.organisationConnectionId);
    if (connection === null) return null;
    await appendConnectionEvent(ctx, {
      organisationConnectionId: connection._id,
      type: 'organisation.revoked-at-source',
      payload: {
        credentialId: args.credentialId,
        system: connection.system,
        end: 'organisation-revoked',
        outcome: args.outcome,
        attempt: args.attempt,
        shared: true,
        ...(args.reason !== undefined ? { reason: args.reason.slice(0, REASON_LIMIT) } : {}),
      },
      createdAt: now,
    });
    return null;
  },
});
