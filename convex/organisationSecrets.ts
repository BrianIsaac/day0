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
import { readSlackAnswer, slackTokenRevocation } from '../src/surfaces/revokers/slack';
import type { RevocationAnswer, RevocationRequest } from '../src/surfaces/revokers/types';
import { safeFailureMessage } from '../src/surfaces/redact';

/*
 * The end of an organisation secret a revoke or a rotation takes out of use (the wave 11 review's
 * M6). Such a secret is revoked in Day0 in the change's own transaction, and then, by its
 * connection's kind: Slack's configuration token, which can create and delete apps in the
 * workspace, is revoked at Slack with `auth.revoke` and the pair's values deleted; an MCP client's
 * secret keeps its value for the 24 hours (F19) the card revocations its connection's revoke
 * scheduled may need it for (AJ6), and is then deleted; any other secret (an app's client secret,
 * a service key, IT's own static key, a shared token) has no call Day0 makes to end it, and its
 * value is deleted at once.
 */

/** How long a taken-out secret may keep its value: F19's bound on a kept ciphertext. */
export const ORGANISATION_SECRET_HOLD_MS = 24 * 60 * 60 * 1000;

/** How many times Day0 asks Slack to revoke a configuration token before it gives up. */
const SLACK_REVOKE_ATTEMPTS = 3;

/** How long Day0 waits before asking Slack again after a failure another attempt may pass. */
const SLACK_REVOKE_RETRY_MS = 60 * 60 * 1000;

/** How long one call to Slack may take. */
const SLACK_CALL_TIMEOUT_MS = 15_000;

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
    case 'oauth-app':
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

/** The body of Slack's answer, parsed when it is JSON. */
async function bodyOf(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not JSON: a proxy's or Slack's own error page, which the reader reads by its status.
    return text;
  }
}

/** Send one `auth.revoke` and read Slack's answer; a redirect is never followed. */
async function sendToSlack(request: RevocationRequest, token: string): Promise<RevocationAnswer> {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(SLACK_CALL_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    return {
      kind: 'retry',
      words: safeFailureMessage(error, token, 'Could not reach Slack.', REASON_LIMIT),
    };
  }
  return readSlackAnswer('auth.revoke', response.status, await bodyOf(response));
}

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
): Promise<RevocationAnswer> {
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
  const answer = await sendToSlack(slackTokenRevocation(token), token);
  switch (answer.kind) {
    case 'revoked':
    case 'gone':
      return answer;
    case 'retry':
    case 'refused':
      return {
        kind: answer.kind,
        words: safeFailureMessage(new Error(answer.words), token, answer.words, REASON_LIMIT),
      };
    default: {
      const unknown: never = answer;
      throw new Error(`unhandled revocation answer ${String(unknown)}`);
    }
  }
}

/**
 * Revoke a Slack configuration token a revoke or a rotation took out of use at Slack
 * (`auth.revoke`), asking again an hour later after a failure another attempt may pass, up to
 * {@link SLACK_REVOKE_ATTEMPTS} times, then delete the pair's values and write the call on the
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
    if (answer.kind === 'retry' && args.attempt < SLACK_REVOKE_ATTEMPTS) {
      await ctx.scheduler.runAfter(
        SLACK_REVOKE_RETRY_MS,
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
      ...(answer.kind === 'revoked' || answer.kind === 'gone'
        ? { outcome: 'done' as const }
        : { outcome: 'failed' as const, reason: answer.words }),
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
    outcome: v.union(v.literal('done'), v.literal('failed')),
    reason: v.optional(v.string()),
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
      },
      createdAt: now,
    });
    return null;
  },
});
