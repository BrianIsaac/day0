import { ConvexError, v, type Infer, type ObjectType } from 'convex/values';
import {
  action,
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
import { appendConnectionEvent } from './connectionEvents';
import { purgeCredential } from './credentials';
import { endOrganisationSecrets } from './organisationSecrets';
import { activeConnectionFor } from './organisationConnectionReads';
import { assertAdministrator, callerIsAdministrator, getCallerOrThrow } from './ownership';
import {
  CONNECTION_CARD_LIMIT,
  endCardsOnConnection,
  holdsAccessThroughConnection,
} from './surfaces';
import { log } from '../src/lib/logger';
import { ORGANISATION_HOLDER, ORGANISATION_OWNER_KEY } from '../src/lib/organisation-key';
import {
  MCP_CLIENT_REGISTRATIONS,
  ORGANISATION_CONNECTION_KINDS,
  ORGANISATION_CONNECTION_MODES,
  type OrganisationConnectionKind,
  type OrganisationConnectionMode,
  type OrganisationRegistrar,
} from '../src/surfaces/access-identity';
import { isOrganisationSystemKey, organisationSystemOf } from '../src/surfaces/access-request';
import { KEEP_CURRENT_MIN_DELAY_MS } from '../src/surfaces/identity-issuers/slack';

/*
 * The organisation's connections (the access plan, section 4.1; B8, AC12): one row per system per
 * deployment holding what IT registered at install, its secret sealed for the organisation, reused
 * by every employee's card. Administrators named at install land, rotate and revoke them from the
 * organisation page; the operator's setup verb does the same through the `...FromSetup` internal
 * functions with the deployment's admin key. A manager sees which systems are connected and never
 * a secret, and an administrator sees no employee's card through any of it. Every change writes
 * one line to the ledger (`connectionEvents`, AC11).
 */

/** The most connections one deployment's page lists: a handful per system the kit knows. */
const CONNECTION_READ_LIMIT = 200;

/** The longest name a system is shown under. */
const DISPLAY_NAME_MAX = 80;

/** The most scopes one registration carries, past any vendor's list. */
const SCOPE_COUNT_MAX = 100;

/** The longest one scope may be. */
const SCOPE_MAX = 200;

/** The longest reason a revoke records. */
const REASON_MAX = 400;

const connectionKindValidator = v.union(
  ...ORGANISATION_CONNECTION_KINDS.map((kind) => v.literal(kind)),
);
const connectionModeValidator = v.union(
  ...ORGANISATION_CONNECTION_MODES.map((mode) => v.literal(mode)),
);
const clientRegistrationValidator = v.union(
  ...MCP_CLIENT_REGISTRATIONS.map((registration) => v.literal(registration)),
);

/** What IT registered for a system: everything a landing gives but its secrets. */
const registrationFields = {
  system: v.string(),
  displayName: v.string(),
  kind: connectionKindValidator,
  mode: connectionModeValidator,
  scopes: v.array(v.string()),
  clientId: v.optional(v.string()),
  appId: v.optional(v.string()),
  providerWorkspaceId: v.optional(v.string()),
  issuer: v.optional(v.string()),
  resource: v.optional(v.string()),
  clientRegistration: v.optional(clientRegistrationValidator),
  redirectUrl: v.optional(v.string()),
  clientCredentialsScopes: v.optional(v.array(v.string())),
};

/** What a landing gives: the registration and the secrets IT produced for it. */
const landingFields = {
  ...registrationFields,
  /** The client secret, configuration token, service key or static key. */
  secret: v.optional(v.string()),
  /** The refresh token that renews `secret`, where the vendor issues one (Slack's configuration token). */
  refreshToken: v.optional(v.string()),
};

/** A landing as an administrator or the setup verb gives it. */
export type Landing = ObjectType<typeof landingFields>;

/** A landing's registration without its secrets: what the recording mutation is handed. */
const registrationValidator = v.object(registrationFields);

/** A landing's registration without its secrets. */
export type Registration = Infer<typeof registrationValidator>;

/** What a rotation gives: the new secret, its refresh token, and the scopes when they changed. */
const rotationFields = {
  organisationConnectionId: v.id('organisationConnections'),
  secret: v.string(),
  refreshToken: v.optional(v.string()),
  scopes: v.optional(v.array(v.string())),
};

/** A rotation as an administrator or the setup verb gives it. */
export type Rotation = ObjectType<typeof rotationFields>;

/** What a revoke gives. */
const revocationFields = {
  organisationConnectionId: v.id('organisationConnections'),
  reason: v.string(),
};

/** Who made a change: an administrator by verified address, or the setup verb with none. */
const registrarValidator = v.object({
  via: v.union(v.literal('organisation-page'), v.literal('setup-cli')),
  address: v.optional(v.string()),
});

/** Who made a change to an organisation connection. */
export interface Registrar {
  readonly via: OrganisationRegistrar;
  readonly address?: string;
}

/** The setup verb: the operator's CLI with the deployment's admin key, which names no address. */
const SETUP_CLI: Registrar = { via: 'setup-cli' };

/** What each kind's secret is called on its credential row, and its refresh token's. */
const SECRET_NOUNS: { readonly [Kind in OrganisationConnectionKind]: string } = {
  'slack-configuration': 'configuration token',
  'oauth-app': 'client secret',
  'service-account': 'service account key',
  'mcp-client': 'client secret',
  'static-key': 'key',
};

/** Trimmed, without blanks or repeats, in order. */
export function cleanScopes(scopes: readonly string[]): readonly string[] {
  return [...new Set(scopes.map((scope: string): string => scope.trim()))];
}

/** Why a scope list is not one, or undefined when it is. */
export function scopesRefusal(scopes: readonly string[], name: string): string | undefined {
  if (scopes.length > SCOPE_COUNT_MAX) return `${name} lists more than ${SCOPE_COUNT_MAX} scopes.`;
  if (scopes.some((scope: string): boolean => scope.trim() === '' || scope.length > SCOPE_MAX)) {
    return `${name} holds an empty scope, or one longer than ${SCOPE_MAX} characters.`;
  }
  return undefined;
}

/**
 * Whether a connection holds no organisation secret by its nature: a per-employee OAuth app, whose
 * every employee's own app carries its own client id and secret (Linear, L1; AI5), so the
 * organisation's connection records only the system, its mode, its scopes and its redirect.
 */
function holdsNoOrganisationSecret(connection: {
  readonly kind: OrganisationConnectionKind;
  readonly mode: OrganisationConnectionMode;
}): boolean {
  return connection.kind === 'oauth-app' && connection.mode === 'per-employee';
}

/**
 * Why a landing cannot be one, or undefined when it can (the access plan, section 4.1): a system
 * key, a name, scopes, a secret for every kind but an MCP client (which may be a public client
 * with PKCE) and a per-employee OAuth app (which holds none, nor a client id), the
 * client-credentials scopes only on a shared OAuth app (L2), and the MCP fields only on an MCP
 * client, whose system names its server by host.
 *
 * @param landing - The landing as given.
 */
export function landingRefusal(landing: Landing): string | undefined {
  if (!isOrganisationSystemKey(landing.system)) {
    return 'The system is a lower-case key such as slack or linear, or mcp:<host> for an MCP server.';
  }
  const name = landing.displayName.trim();
  if (name === '' || name.length > DISPLAY_NAME_MAX) {
    return `Name the system in 1 to ${DISPLAY_NAME_MAX} characters.`;
  }
  const scopes = scopesRefusal(landing.scopes, 'The registration');
  if (scopes !== undefined) return scopes;
  if (holdsNoOrganisationSecret(landing)) {
    if (landing.secret !== undefined || landing.clientId !== undefined) {
      return 'A per-employee OAuth app holds no organisation secret or client id: each employee’s own app brings its own.';
    }
  }
  const secretNeeded = landing.kind !== 'mcp-client' && !holdsNoOrganisationSecret(landing);
  if (secretNeeded && (landing.secret === undefined || landing.secret.trim() === '')) {
    return `A ${landing.kind} connection needs its ${SECRET_NOUNS[landing.kind]}.`;
  }
  if (landing.refreshToken !== undefined && landing.refreshToken.trim() === '') {
    return 'The refresh token is empty.';
  }
  if (landing.refreshToken !== undefined && landing.secret === undefined) {
    return 'A refresh token renews a secret: give the secret it renews as well.';
  }
  if (landing.clientCredentialsScopes !== undefined) {
    if (landing.kind !== 'oauth-app' || landing.mode !== 'shared') {
      return 'Only a shared OAuth app requests tokens with fixed client-credentials scopes.';
    }
    const fixed = scopesRefusal(landing.clientCredentialsScopes, 'The client-credentials set');
    if (fixed !== undefined) return fixed;
  }
  const mcpField =
    landing.issuer !== undefined ||
    landing.resource !== undefined ||
    landing.clientRegistration !== undefined;
  if (landing.kind === 'mcp-client') {
    if (!landing.system.startsWith('mcp:')) {
      return 'An MCP client connection names its server as mcp:<host>.';
    }
    if (landing.clientId === undefined || landing.clientId.trim() === '') {
      return 'An MCP client connection needs the client id IT registered.';
    }
    // With no issuer the secret could go to whichever server a resource names, so every card
    // refuses one (`startAuthorisation`); the landing refuses it first (the review's M12 f). A
    // public client names its server too, so no manager's first authorisation chooses it for
    // every employee (the review's m4).
    if ((landing.issuer ?? '').trim() === '') {
      return landing.secret !== undefined
        ? "A confidential MCP client needs the issuer of the authorisation server IT registered it with: Day0 sends the secret to that server's token endpoint alone."
        : MCP_ISSUER_NEEDED;
    }
  } else if (mcpField) {
    return 'The issuer, the resource and the client registration belong to an MCP client only.';
  } else if (landing.system.startsWith('mcp:')) {
    return 'An MCP server is connected as an MCP client.';
  }
  return undefined;
}

/** Why a public MCP client is not landed without its issuer (the review's m4). */
export const MCP_ISSUER_NEEDED =
  "An MCP client connection needs the issuer of its authorisation server: every employee's authorisation goes to that server alone. The setup verb finds it from the server's own metadata when IT leaves it blank.";

/** Why a revoke's reason is not one, or undefined when it is. */
function reasonRefusal(reason: string): string | undefined {
  const trimmed = reason.trim();
  if (trimmed === '' || trimmed.length > REASON_MAX) {
    return `Say why the connection is revoked, in 1 to ${REASON_MAX} characters.`;
  }
  return undefined;
}

/** The refusal for a second connection of a system that has one active or needing IT's attention. */
function alreadyConnected(displayName: string): string {
  return `${displayName} is already connected for the organisation: rotate its secret, or revoke it first.`;
}

/** The refusal for a connection that does not exist. */
const CONNECTION_NOT_FOUND = 'That organisation connection does not exist.';

/** The refusal for a change to a revoked connection. */
const CONNECTION_REVOKED = 'That organisation connection is revoked: land a new one instead.';

/**
 * The system's connection that keeps it occupied, if any: an active one, or one that needs IT's
 * attention, which an administrator rotates rather than lands beside, so a system never has two
 * connections a rotation could make active together.
 *
 * @param ctx - A query's or a mutation's context.
 * @param system - The system key.
 */
export async function occupyingConnectionFor(
  ctx: Pick<QueryCtx, 'db'>,
  system: string,
): Promise<Doc<'organisationConnections'> | null> {
  return (
    (await activeConnectionFor(ctx, system)) ??
    (await ctx.db
      .query('organisationConnections')
      .withIndex('by_system_status', (index) =>
        index.eq('system', system).eq('status', 'needs-attention'),
      )
      .first())
  );
}

/** The secret rows a landing or a rotation stored, before the connection names them. */
interface StoredSecrets {
  readonly secretCredentialId?: Id<'credentials'>;
  readonly refreshCredentialId?: Id<'credentials'>;
}

/**
 * Seal a landing's or a rotation's secrets as rows the organisation holds, under the reserved key
 * (AC12). Nothing names them until the mutation that records the change does. When one of the two
 * stores fails, the one that landed is revoked before the failure is rethrown, so no secret is
 * left live with nothing naming it.
 *
 * @throws The first store's failure, after revoking what was stored.
 */
export async function storeSecrets(
  ctx: Pick<ActionCtx, 'runAction' | 'runMutation'>,
  connection: { readonly displayName: string; readonly kind: OrganisationConnectionKind },
  secrets: { readonly secret?: string; readonly refreshToken?: string },
): Promise<StoredSecrets> {
  const name = `${connection.displayName.trim()} ${SECRET_NOUNS[connection.kind]}`;
  const store = async (label: string, plaintext: string): Promise<Id<'credentials'>> =>
    await ctx.runAction(internal.credentials.store, {
      userId: ORGANISATION_OWNER_KEY,
      holder: ORGANISATION_HOLDER,
      kind: 'value',
      label,
      plaintext: plaintext.trim(),
      source: 'entered',
    });
  const [secret, refresh] = await Promise.allSettled([
    secrets.secret === undefined ? undefined : store(name, secrets.secret),
    secrets.refreshToken === undefined
      ? undefined
      : store(`${connection.displayName.trim()} configuration refresh token`, secrets.refreshToken),
  ]);
  const failure = [secret, refresh].find((outcome) => outcome.status === 'rejected');
  if (failure !== undefined) {
    const landed = [secret, refresh].flatMap((outcome) =>
      outcome.status === 'fulfilled' && outcome.value !== undefined ? [outcome.value] : [],
    );
    await releaseOrLog(ctx, landed);
    throw asError(failure.reason);
  }
  const secretCredentialId = secret.status === 'fulfilled' ? secret.value : undefined;
  const refreshCredentialId = refresh.status === 'fulfilled' ? refresh.value : undefined;
  return {
    ...(secretCredentialId === undefined ? {} : { secretCredentialId }),
    ...(refreshCredentialId === undefined ? {} : { refreshCredentialId }),
  };
}

/** A rejection as an `Error`: a store's or a recording's failure is one, and anything else is wrapped. */
function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/**
 * Revoke stored secrets nothing could name, logging (never throwing) when the release itself
 * fails, so the failure that called for it is the one the caller reads. Values are never logged.
 */
async function releaseOrLog(
  ctx: Pick<ActionCtx, 'runMutation'>,
  credentialIds: readonly Id<'credentials'>[],
): Promise<void> {
  if (credentialIds.length === 0) return;
  try {
    await ctx.runMutation(internal.organisationConnections.releaseStoredSecrets, {
      credentialIds: [...credentialIds],
    });
  } catch (error) {
    log.error('organisation secrets stored for a change that failed could not be revoked', {
      credentialIds,
      reason: asError(error).message,
    });
  }
}

/**
 * Record a change's stored secrets, revoking them when the recording fails, so none is left live
 * with nothing naming it. A secret the recording named before its call failed is kept: the
 * release skips every secret a connection names.
 *
 * @throws The recording's failure, after the secrets are released.
 */
export async function recordOrRelease<Recorded>(
  ctx: Pick<ActionCtx, 'runMutation'>,
  secrets: StoredSecrets,
  record: () => Promise<Recorded>,
): Promise<Recorded> {
  try {
    return await record();
  } catch (error) {
    await releaseOrLog(
      ctx,
      [secrets.secretCredentialId, secrets.refreshCredentialId].filter(
        (credentialId): credentialId is Id<'credentials'> => credentialId !== undefined,
      ),
    );
    throw asError(error);
  }
}

/**
 * Revoke organisation secrets a landing or a rotation stored and could not record. Internal, for
 * {@link storeSecrets} and {@link recordOrRelease}; only organisation rows are touched, and never
 * one a connection names (its secret, that secret's refresh token, or its shared token), which a
 * recording committed before its call failed would have done.
 */
export const releaseStoredSecrets = internalMutation({
  args: { credentialIds: v.array(v.id('credentials')) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const connections = await ctx.db.query('organisationConnections').take(CONNECTION_READ_LIMIT);
    const named = new Set<Id<'credentials'> | undefined>();
    for (const connection of connections) {
      for (const credentialId of await secretAndRefresh(ctx, connection.secretCredentialId)) {
        named.add(credentialId);
      }
      named.add(connection.sharedTokenCredentialId);
    }
    await revokeSecrets(
      ctx,
      args.credentialIds.filter((credentialId) => !named.has(credentialId)),
      Date.now(),
    );
    return null;
  },
});

/**
 * Revoke organisation credential rows a landing or a rotation stored and never put to use, and
 * delete their values: nothing was done with them, so nothing at the vendor needs them (the wave 11
 * review's M6). Secrets a revoke or a rotation takes out of use go through
 * {@link endOrganisationSecrets} instead.
 */
async function revokeSecrets(
  ctx: MutationCtx,
  credentialIds: ReadonlyArray<Id<'credentials'> | undefined>,
  now: number,
): Promise<void> {
  for (const credentialId of credentialIds) {
    if (credentialId === undefined) continue;
    const row = await ctx.db.get(credentialId);
    if (row === null || row.holder !== ORGANISATION_HOLDER || row.revokedAt !== undefined) continue;
    await purgeCredential(ctx, row, now);
  }
}

/** A secret and the refresh token paired with it, read off the secret's row. */
async function secretAndRefresh(
  ctx: Pick<QueryCtx, 'db'>,
  secretCredentialId: Id<'credentials'> | undefined,
): Promise<Array<Id<'credentials'> | undefined>> {
  if (secretCredentialId === undefined) return [];
  const secret = await ctx.db.get(secretCredentialId);
  return [secretCredentialId, secret?.refreshCredentialId];
}

/** What recording a landing or a rotation answers. */
const recordedValidator = v.union(
  v.object({
    recorded: v.literal(true),
    organisationConnectionId: v.id('organisationConnections'),
  }),
  v.object({ recorded: v.literal(false), reason: v.string() }),
);

const storedSecretsFields = {
  secretCredentialId: v.optional(v.id('credentials')),
  refreshCredentialId: v.optional(v.id('credentials')),
};

/**
 * Queue the renewal that keeps a Slack configuration token current from the moment IT lands or
 * rotates it, so the chain no longer waits for the first app to be created (the wave 11 review's
 * m9). The token's age is unknown until its first rotation says when it lapses, so the first
 * renewal runs as soon as a renewal may ({@link KEEP_CURRENT_MIN_DELAY_MS}); each rotation then
 * queues the next. A token landed without its refresh token has nothing to renew with.
 *
 * @param input - The connection, its kind, the secrets just stored for it, and the time.
 */
async function keepConfigurationCurrentFrom(
  ctx: MutationCtx,
  input: {
    readonly organisationConnectionId: Id<'organisationConnections'>;
    readonly kind: OrganisationConnectionKind;
    readonly secrets: ObjectType<typeof storedSecretsFields>;
    readonly now: number;
  },
): Promise<void> {
  const { secretCredentialId, refreshCredentialId } = input.secrets;
  if (
    input.kind !== 'slack-configuration' ||
    secretCredentialId === undefined ||
    refreshCredentialId === undefined
  ) {
    return;
  }
  await ctx.scheduler.runAt(
    input.now + KEEP_CURRENT_MIN_DELAY_MS,
    internal.slackProvisionActions.keepConfigurationCurrent,
    { organisationConnectionId: input.organisationConnectionId, secretCredentialId, generation: 0 },
  );
}

/**
 * Record a landed connection and its ledger line, in one transaction. Internal, for
 * {@link landConnection}. When the system gained an active connection since the action checked,
 * the secrets the action stored are revoked here and the refusal returned, so none is left live.
 * A Slack configuration pair queues its first renewal ({@link keepConfigurationCurrentFrom}).
 */
export const recordLanded = internalMutation({
  args: {
    landing: registrationValidator,
    secrets: v.object(storedSecretsFields),
    registrar: registrarValidator,
  },
  returns: recordedValidator,
  handler: async (ctx, args): Promise<Infer<typeof recordedValidator>> => {
    const now = Date.now();
    const { landing, secrets, registrar } = args;
    const displayName = landing.displayName.trim();
    if ((await occupyingConnectionFor(ctx, landing.system)) !== null) {
      await revokeSecrets(ctx, [secrets.secretCredentialId, secrets.refreshCredentialId], now);
      return { recorded: false, reason: alreadyConnected(displayName) };
    }
    if (secrets.secretCredentialId !== undefined && secrets.refreshCredentialId !== undefined) {
      await ctx.db.patch(secrets.secretCredentialId, {
        refreshCredentialId: secrets.refreshCredentialId,
      });
    }
    const scopes = [...cleanScopes(landing.scopes)];
    const organisationConnectionId = await ctx.db.insert('organisationConnections', {
      system: landing.system,
      displayName,
      kind: landing.kind,
      mode: landing.mode,
      scopes,
      ...optionalRegistration(landing),
      ...(secrets.secretCredentialId === undefined
        ? {}
        : { secretCredentialId: secrets.secretCredentialId }),
      registeredBy: { ...registrarRecord(registrar), at: now },
      status: 'active',
      createdAt: now,
    });
    await appendConnectionEvent(ctx, {
      organisationConnectionId,
      type: 'organisation.connection-landed',
      payload: {
        organisationConnectionId,
        system: landing.system,
        displayName,
        via: registrar.via,
        kind: landing.kind,
        mode: landing.mode,
        scopes,
      },
      ...actorOf(registrar),
      createdAt: now,
    });
    await keepConfigurationCurrentFrom(ctx, {
      organisationConnectionId,
      kind: landing.kind,
      secrets,
      now,
    });
    return { recorded: true, organisationConnectionId };
  },
});

/** The optional registration fields a landing carries, trimmed, each only when given. */
function optionalRegistration(
  landing: Registration,
): Partial<
  Pick<
    Doc<'organisationConnections'>,
    | 'clientId'
    | 'appId'
    | 'providerWorkspaceId'
    | 'issuer'
    | 'resource'
    | 'clientRegistration'
    | 'redirectUrl'
    | 'clientCredentialsScopes'
  >
> {
  const trimmed = (value: string | undefined): string | undefined => {
    const text = value?.trim();
    return text ? text : undefined;
  };
  const fields = {
    clientId: trimmed(landing.clientId),
    appId: trimmed(landing.appId),
    providerWorkspaceId: trimmed(landing.providerWorkspaceId),
    issuer: trimmed(landing.issuer),
    resource: trimmed(landing.resource),
    clientRegistration: landing.clientRegistration,
    redirectUrl: trimmed(landing.redirectUrl),
    clientCredentialsScopes:
      landing.clientCredentialsScopes === undefined
        ? undefined
        : [...cleanScopes(landing.clientCredentialsScopes)],
  };
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as ReturnType<typeof optionalRegistration>;
}

/** Who registered a connection, as its row records it: the address only when an administrator did. */
function registrarRecord(
  registrar: Registrar,
): Omit<Doc<'organisationConnections'>['registeredBy'], 'at'> {
  return registrar.address === undefined
    ? { via: registrar.via }
    : { via: registrar.via, address: registrar.address };
}

/** The ledger line's actor: the administrator's address, or nothing for the setup verb. */
function actorOf(registrar: Registrar): { readonly actorAddress?: string } {
  return registrar.address === undefined ? {} : { actorAddress: registrar.address };
}

/**
 * Land an organisation connection: check it, seal its secrets for the organisation, record it and
 * its ledger line. The helper both the administrator's action and the setup verb's call.
 *
 * @throws ConvexError with the refusal when the landing is not one or the system is connected.
 */
async function landConnection(
  ctx: ActionCtx,
  landing: Landing,
  registrar: Registrar,
): Promise<Id<'organisationConnections'>> {
  const refusal = landingRefusal(landing);
  if (refusal !== undefined) throw new ConvexError(refusal);
  const existing = await ctx.runQuery(internal.organisationConnections.occupyingFor, {
    system: landing.system,
  });
  if (existing !== null) throw new ConvexError(alreadyConnected(landing.displayName.trim()));
  const { secret, refreshToken, ...registration } = landing;
  const secrets = await storeSecrets(ctx, landing, { secret, refreshToken });
  const recorded = await recordOrRelease(
    ctx,
    secrets,
    async () =>
      await ctx.runMutation(internal.organisationConnections.recordLanded, {
        landing: registration,
        secrets,
        registrar: { ...registrar },
      }),
  );
  if (!recorded.recorded) throw new ConvexError(recorded.reason);
  return recorded.organisationConnectionId;
}

/**
 * Land an organisation connection from the organisation page. Public, guarded by
 * `assertAdministrator`. Writes the connection, its secrets as rows the organisation holds and one
 * `organisation.connection-landed` ledger line naming the administrator's address.
 *
 * @throws ConvexError with the refusal: not an administrator, a landing that is not one, or a
 *   system already connected.
 */
export const land = action({
  args: landingFields,
  returns: v.id('organisationConnections'),
  handler: async (ctx, args): Promise<Id<'organisationConnections'>> => {
    const { address } = await assertAdministrator(ctx);
    return await landConnection(ctx, args, { via: 'organisation-page', address });
  },
});

/**
 * Land an organisation connection from the setup verb (`./setup.sh access`), which acts as
 * administrator with the deployment's admin key. Internal. Writes what {@link land} writes, its
 * ledger line naming no address.
 */
export const landFromSetup = internalAction({
  args: landingFields,
  returns: v.id('organisationConnections'),
  handler: async (ctx, args): Promise<Id<'organisationConnections'>> =>
    await landConnection(ctx, args, SETUP_CLI),
});

/**
 * Empty the shared token a connection's cards hold, in place, when its app's secret is rotated:
 * rotating the secret ends every client-credentials token issued with the old one at the vendor
 * (Linear, L2), so the stored value would only meet a 401. The row keeps its id, which every
 * shared-mode card holds (AL6), and its next read requests a token with the new secret into it
 * (`linearIdentity.landSharedToken`); its generation moves, so a renewal that read the old value
 * never lands a token requested with the old secret. A revoke ends the row instead.
 *
 * @param credentialId - The connection's shared token, when it holds one.
 */
async function emptySharedToken(
  ctx: MutationCtx,
  credentialId: Id<'credentials'> | undefined,
): Promise<void> {
  if (credentialId === undefined) return;
  const row = await ctx.db.get(credentialId);
  if (row === null || row.revokedAt !== undefined || row.ciphertext === undefined) return;
  await ctx.db.patch(credentialId, {
    ciphertext: undefined,
    iv: undefined,
    keyId: undefined,
    expiresAt: undefined,
    lastUsedAt: undefined,
    generation: (row.generation ?? 0) + 1,
  });
}

/**
 * Record a rotation and its ledger line, in one transaction. Internal, for
 * {@link rotateConnection}. The new secret replaces the old, which is revoked with its refresh
 * token and ended by its kind ({@link endOrganisationSecrets}; M6), and the shared token issued with it is
 * emptied in place ({@link emptySharedToken}); the scopes change only when given, and the
 * client-credentials scopes never (L2). A connection revoked since the action read it refuses,
 * and the secrets the action stored are revoked here. A Slack configuration pair queues the
 * renewal of the new token ({@link keepConfigurationCurrentFrom}).
 */
export const recordRotated = internalMutation({
  args: {
    organisationConnectionId: v.id('organisationConnections'),
    scopes: v.optional(v.array(v.string())),
    secrets: v.object(storedSecretsFields),
    registrar: registrarValidator,
  },
  returns: recordedValidator,
  handler: async (ctx, args): Promise<Infer<typeof recordedValidator>> => {
    const now = Date.now();
    const { secrets, registrar } = args;
    const fresh = [secrets.secretCredentialId, secrets.refreshCredentialId];
    const connection = await ctx.db.get(args.organisationConnectionId);
    if (connection === null || connection.status === 'revoked') {
      await revokeSecrets(ctx, fresh, now);
      return {
        recorded: false,
        reason: connection === null ? CONNECTION_NOT_FOUND : CONNECTION_REVOKED,
      };
    }
    if (secrets.secretCredentialId !== undefined && secrets.refreshCredentialId !== undefined) {
      await ctx.db.patch(secrets.secretCredentialId, {
        refreshCredentialId: secrets.refreshCredentialId,
      });
    }
    await endOrganisationSecrets(
      ctx,
      {
        organisationConnectionId: connection._id,
        kind: connection.kind,
        secretCredentialId: connection.secretCredentialId,
        credentialIds: await secretAndRefresh(ctx, connection.secretCredentialId),
      },
      now,
    );
    await emptySharedToken(ctx, connection.sharedTokenCredentialId);
    const scopes = args.scopes === undefined ? connection.scopes : [...cleanScopes(args.scopes)];
    const changed = scopes.join('\n') !== connection.scopes.join('\n');
    await ctx.db.patch(connection._id, {
      secretCredentialId: secrets.secretCredentialId,
      scopes,
      status: 'active',
      statusReason: undefined,
      lastRotatedAt: now,
    });
    await appendConnectionEvent(ctx, {
      organisationConnectionId: connection._id,
      type: 'organisation.connection-rotated',
      payload: {
        organisationConnectionId: connection._id,
        system: connection.system,
        displayName: connection.displayName,
        via: registrar.via,
        scopes,
        ...(changed ? { previousScopes: connection.scopes } : {}),
      },
      ...actorOf(registrar),
      createdAt: now,
    });
    await keepConfigurationCurrentFrom(ctx, {
      organisationConnectionId: connection._id,
      kind: connection.kind,
      secrets,
      now,
    });
    return { recorded: true, organisationConnectionId: connection._id };
  },
});

/**
 * Rotate an organisation connection's secret: seal the new one, record the rotation and its
 * ledger line. The helper both the administrator's action and the setup verb's call.
 *
 * @throws ConvexError when the rotation is not one, or the connection is gone or revoked.
 */
async function rotateConnection(
  ctx: ActionCtx,
  rotation: Rotation,
  registrar: Registrar,
): Promise<void> {
  if (rotation.secret.trim() === '') throw new ConvexError('The new secret is empty.');
  if (rotation.refreshToken !== undefined && rotation.refreshToken.trim() === '') {
    throw new ConvexError('The refresh token is empty.');
  }
  if (rotation.scopes !== undefined) {
    const refusal = scopesRefusal(rotation.scopes, 'The registration');
    if (refusal !== undefined) throw new ConvexError(refusal);
  }
  const connection = await ctx.runQuery(internal.organisationConnections.getInternal, {
    organisationConnectionId: rotation.organisationConnectionId,
  });
  if (connection === null) throw new ConvexError(CONNECTION_NOT_FOUND);
  if (connection.status === 'revoked') throw new ConvexError(CONNECTION_REVOKED);
  if (holdsNoOrganisationSecret(connection)) {
    throw new ConvexError(
      'A per-employee OAuth app holds no organisation secret to rotate: each employee’s own app is rotated where it was created.',
    );
  }
  const secrets = await storeSecrets(ctx, connection, rotation);
  const recorded = await recordOrRelease(
    ctx,
    secrets,
    async () =>
      await ctx.runMutation(internal.organisationConnections.recordRotated, {
        organisationConnectionId: connection._id,
        ...(rotation.scopes === undefined ? {} : { scopes: rotation.scopes }),
        secrets,
        registrar: { ...registrar },
      }),
  );
  if (!recorded.recorded) throw new ConvexError(recorded.reason);
}

/**
 * Rotate an organisation connection's secret from the organisation page. Public, guarded by
 * `assertAdministrator`. Writes the new secret as a row the organisation holds, revokes the old
 * one, and appends one `organisation.connection-rotated` ledger line.
 */
export const rotate = action({
  args: rotationFields,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { address } = await assertAdministrator(ctx);
    await rotateConnection(ctx, args, { via: 'organisation-page', address });
    return null;
  },
});

/** Rotate an organisation connection's secret from the setup verb. Internal; writes what {@link rotate} writes. */
export const rotateFromSetup = internalAction({
  args: rotationFields,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await rotateConnection(ctx, args, SETUP_CLI);
    return null;
  },
});

/**
 * Revoke an organisation connection in the caller's transaction: its status, its reason and every
 * secret under it (the secret, its refresh token and a shared token), every card on it ended with
 * the reason (`endCardsOnConnection`, cross-unit test 3), and one
 * `organisation.connection-revoked` ledger line.
 *
 * @param ctx - The mutation's context.
 * @param revocation - The connection and why it is revoked.
 * @param registrar - Who revoked it.
 * @throws ConvexError when the reason is not one, the connection is gone or already revoked, or
 *   more cards are on it than one transaction ends.
 */
export async function revokeConnection(
  ctx: MutationCtx,
  revocation: {
    readonly organisationConnectionId: Id<'organisationConnections'>;
    readonly reason: string;
  },
  registrar: Registrar,
): Promise<void> {
  const refusal = reasonRefusal(revocation.reason);
  if (refusal !== undefined) throw new ConvexError(refusal);
  const connection = await ctx.db.get(revocation.organisationConnectionId);
  if (connection === null) throw new ConvexError(CONNECTION_NOT_FOUND);
  if (connection.status === 'revoked') throw new ConvexError(CONNECTION_REVOKED);
  const now = Date.now();
  const reason = revocation.reason.trim();
  await endOrganisationSecrets(
    ctx,
    {
      organisationConnectionId: connection._id,
      kind: connection.kind,
      secretCredentialId: connection.secretCredentialId,
      credentialIds: [
        ...(await secretAndRefresh(ctx, connection.secretCredentialId)),
        connection.sharedTokenCredentialId,
      ],
    },
    now,
  );
  await ctx.db.patch(connection._id, { status: 'revoked', statusReason: reason, revokedAt: now });
  await endCardsOnConnection(ctx, { organisationConnectionId: connection._id, reason, now });
  await appendConnectionEvent(ctx, {
    organisationConnectionId: connection._id,
    type: 'organisation.connection-revoked',
    payload: {
      organisationConnectionId: connection._id,
      system: connection.system,
      displayName: connection.displayName,
      via: registrar.via,
      reason,
    },
    ...actorOf(registrar),
    createdAt: now,
  });
}

/**
 * Revoke an organisation connection from the organisation page. Public, guarded by
 * `assertAdministrator`. Writes the connection's status and every secret's revocation, ends every
 * card on it, and one ledger line naming the administrator's address.
 */
export const revoke = mutation({
  args: revocationFields,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { address } = await assertAdministrator(ctx);
    await revokeConnection(ctx, args, { via: 'organisation-page', address });
    return null;
  },
});

/**
 * How many employee cards a revoke of the connection would end (11-AC's item 3), for the revoke's
 * confirmation, counting only cards that still hold access through it (the round review's m24): a count and nothing else, so no employee or card is named to an administrator (B8).
 * `atLeast` says the cards are more than one revoke ends (`CONNECTION_CARD_LIMIT`), which the
 * revoke refuses. Public, guarded by `assertAdministrator`; writes nothing.
 */
export const cardsOn = query({
  args: { organisationConnectionId: v.id('organisationConnections') },
  returns: v.object({ cards: v.number(), atLeast: v.boolean() }),
  handler: async (ctx, args): Promise<{ cards: number; atLeast: boolean }> => {
    await assertAdministrator(ctx);
    const cards = await ctx.db
      .query('surfaces')
      .withIndex('by_organisation_connection', (q) =>
        q.eq('organisationConnectionId', args.organisationConnectionId),
      )
      .take(CONNECTION_CARD_LIMIT + 1);
    const holding = cards.filter(holdsAccessThroughConnection);
    return {
      cards: Math.min(holding.length, CONNECTION_CARD_LIMIT),
      atLeast: holding.length > CONNECTION_CARD_LIMIT,
    };
  },
});

/** Revoke an organisation connection from the setup verb. Internal; writes what {@link revoke} writes. */
export const revokeFromSetup = internalMutation({
  args: revocationFields,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await revokeConnection(ctx, args, SETUP_CLI);
    return null;
  },
});

/** One connection as the organisation page shows it: the registration, never a secret's row. */
const administratorViewValidator = v.object({
  _id: v.id('organisationConnections'),
  system: v.string(),
  displayName: v.string(),
  kind: connectionKindValidator,
  mode: connectionModeValidator,
  scopes: v.array(v.string()),
  clientCredentialsScopes: v.optional(v.array(v.string())),
  clientId: v.optional(v.string()),
  appId: v.optional(v.string()),
  providerWorkspaceId: v.optional(v.string()),
  issuer: v.optional(v.string()),
  resource: v.optional(v.string()),
  clientRegistration: v.optional(clientRegistrationValidator),
  redirectUrl: v.optional(v.string()),
  registeredBy: v.object({
    via: v.union(v.literal('organisation-page'), v.literal('setup-cli')),
    address: v.optional(v.string()),
    at: v.number(),
  }),
  status: v.union(v.literal('active'), v.literal('needs-attention'), v.literal('revoked')),
  statusReason: v.optional(v.string()),
  lastRotatedAt: v.optional(v.number()),
  revokedAt: v.optional(v.number()),
  createdAt: v.number(),
  /** Whether a secret is held for it; the secret itself never leaves the backend. */
  hasSecret: v.boolean(),
  /** When the held secret expires, where the vendor dates it. */
  secretExpiresAt: v.optional(v.number()),
});

/** One connection as the organisation page shows it. */
export type AdministratorView = Infer<typeof administratorViewValidator>;

/** A connection's row as the page shows it, without the ids of its secrets. */
async function administratorView(
  ctx: Pick<QueryCtx, 'db'>,
  connection: Doc<'organisationConnections'>,
): Promise<AdministratorView> {
  const secret =
    connection.secretCredentialId === undefined
      ? null
      : await ctx.db.get(connection.secretCredentialId);
  const held = secret !== null && secret.revokedAt === undefined;
  const shown = {
    _id: connection._id,
    system: connection.system,
    displayName: connection.displayName,
    kind: connection.kind,
    mode: connection.mode,
    scopes: connection.scopes,
    clientCredentialsScopes: connection.clientCredentialsScopes,
    clientId: connection.clientId,
    appId: connection.appId,
    providerWorkspaceId: connection.providerWorkspaceId,
    issuer: connection.issuer,
    resource: connection.resource,
    clientRegistration: connection.clientRegistration,
    redirectUrl: connection.redirectUrl,
    registeredBy: connection.registeredBy,
    status: connection.status,
    statusReason: connection.statusReason,
    lastRotatedAt: connection.lastRotatedAt,
    revokedAt: connection.revokedAt,
    createdAt: connection.createdAt,
    hasSecret: held,
    secretExpiresAt: held ? secret.expiresAt : undefined,
  };
  // A field the row lacks stays absent from the view rather than present and undefined.
  return Object.fromEntries(
    Object.entries(shown).filter(([, value]) => value !== undefined),
  ) as AdministratorView;
}

/**
 * Every organisation connection for the organisation page, by system and newest first. Public,
 * guarded by `assertAdministrator`; writes nothing. It reads the connections only: no employee,
 * no card and no secret's row is in it.
 */
export const listForAdministrator = query({
  args: {},
  returns: v.array(administratorViewValidator),
  handler: async (ctx): Promise<AdministratorView[]> => {
    await assertAdministrator(ctx);
    const connections = await ctx.db
      .query('organisationConnections')
      .order('desc')
      .take(CONNECTION_READ_LIMIT);
    const ordered = [...connections].sort(
      (left, right) => left.system.localeCompare(right.system) || right.createdAt - left.createdAt,
    );
    return await Promise.all(ordered.map((connection) => administratorView(ctx, connection)));
  },
});

/** One connected system as a manager sees it. */
const managerSystemValidator = v.object({
  system: v.string(),
  displayName: v.string(),
  /** What IT registered, so a card reads whether an issuer acts through it (D6). */
  kind: connectionKindValidator,
  mode: connectionModeValidator,
  status: v.union(v.literal('active'), v.literal('needs-attention')),
  connectedAt: v.number(),
});

const managerSummaryValidator = v.object({
  /** Whether the caller is one of the deployment's administrators: the organisation page's way in. */
  callerIsAdministrator: v.boolean(),
  systems: v.array(managerSystemValidator),
});

/**
 * Which systems are connected for the organisation, for any signed-in manager (a card's "Connected
 * for your organisation by IT on 1 October"), and whether the caller administers them. Public,
 * guarded by `getCallerOrThrow`; writes nothing. Never a secret, a client id or a revoked
 * connection.
 */
export const summaryForManager = query({
  args: {},
  returns: managerSummaryValidator,
  handler: async (ctx): Promise<Infer<typeof managerSummaryValidator>> => {
    await getCallerOrThrow(ctx);
    const connections = await ctx.db
      .query('organisationConnections')
      .order('desc')
      .take(CONNECTION_READ_LIMIT);
    const systems = connections
      .filter(
        (
          connection,
        ): connection is Doc<'organisationConnections'> & {
          status: 'active' | 'needs-attention';
        } => connection.status !== 'revoked',
      )
      .sort((left, right) => left.system.localeCompare(right.system))
      .map((connection) => ({
        system: connection.system,
        displayName: connection.displayName,
        kind: connection.kind,
        mode: connection.mode,
        status: connection.status,
        connectedAt: connection.createdAt,
      }));
    return { callerIsAdministrator: await callerIsAdministrator(ctx), systems };
  },
});

/** The system's active organisation connection, or null. Internal; the paths that use a connection read it here. */
export const activeFor = internalQuery({
  args: { system: v.string() },
  handler: async (ctx, args): Promise<Doc<'organisationConnections'> | null> =>
    await activeConnectionFor(ctx, args.system),
});

/** The system's active connection, or the one needing IT's attention, or null. Internal; the landing's check. */
export const occupyingFor = internalQuery({
  args: { system: v.string() },
  handler: async (ctx, args): Promise<Doc<'organisationConnections'> | null> =>
    await occupyingConnectionFor(ctx, args.system),
});

/** One organisation connection by id, or null. Internal. */
export const getInternal = internalQuery({
  args: { organisationConnectionId: v.id('organisationConnections') },
  handler: async (ctx, args): Promise<Doc<'organisationConnections'> | null> =>
    await ctx.db.get(args.organisationConnectionId),
});

/**
 * Link a card to the active organisation connection of its system, so the card's credential comes
 * from the connection and a revoke of the connection ends it (11-AR). Internal, for the paths that
 * connect a card through a connection (11-AS, 11-AL, 11-AM). Refuses a connection that is not
 * active, or whose system is not the card's ({@link organisationSystemOf}).
 *
 * @throws Error when the card or the connection is gone, the connection is not active, or the
 *   systems differ.
 */
export const linkSurface = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    organisationConnectionId: v.id('organisationConnections'),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const [surface, connection] = await Promise.all([
      ctx.db.get(args.surfaceId),
      ctx.db.get(args.organisationConnectionId),
    ]);
    if (surface === null) throw new Error('Surface not found.');
    if (connection === null || connection.status !== 'active') {
      throw new Error('The organisation connection is not active.');
    }
    if (organisationSystemOf(surface) !== connection.system) {
      throw new Error(`The card is not a ${connection.displayName} card.`);
    }
    await ctx.db.patch(surface._id, { organisationConnectionId: connection._id });
    return null;
  },
});
