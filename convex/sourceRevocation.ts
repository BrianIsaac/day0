import { v, type Infer } from 'convex/values';
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { finishSourceRevocation, holdForSourceRevocation, purgeCredential } from './credentials';
import { appendConnectionEvent } from './connectionEvents';
import { appendEvent } from './eventLog';
import { ACCESS_ENDS, type AccessEnd } from '../src/surfaces/access-identity';
import type { SourceRevocationOutcome } from '../src/surfaces/revokers/outcome';
import {
  callOutcome,
  HANDOVER_WORDS,
  revocationPlanFor,
  sharedByOrganisation,
} from '../src/surfaces/revokers/plan';

/*
 * Revocation at the vendor, the transaction half (wave 11, 11-AR; the access plan, section 4.4;
 * F19). An end of access hands each card's credentials here in its own transaction: what Day0
 * itself obtained is revoked at once and held for the vendor call, which a scheduled action makes
 * (`sourceRevocationActions.ts`); a pasted key is never sent to a vendor (D5, AC4); a token the
 * organisation holds is never revoked by one employee's end. Each attempt writes one
 * `credential.revoked-at-source` line on the employee's record, and a line on the organisation
 * connection's ledger when the connection's secret made the call.
 */

const HOUR_MS = 60 * 60 * 1000;

/**
 * When each attempt at a revocation runs, counted from the end of access: at once, an hour later,
 * and twelve hours later (AC14: three attempts over 24 hours).
 */
export const SOURCE_REVOCATION_ATTEMPT_OFFSETS_MS = [0, HOUR_MS, 12 * HOUR_MS] as const;

/** The longest a held credential keeps its ciphertext for the vendor call (F19). */
export const SOURCE_REVOCATION_KEEP_MS = 24 * HOUR_MS;

/** The words a revocation that never got an answer ends with. */
export const NO_ANSWER_WORDS = 'No answer from the vendor within 24 hours.';

/** Why a credential Day0 obtained could not be revoked: its value was deleted before the end. */
export const NO_VALUE_WORDS =
  "Day0 no longer held the credential's value, so it could not be revoked at the vendor.";

/** Why a token the token store holds is not revoked here: the store revokes it (11-AT). */
export const TOKEN_STORE_WORDS =
  'Its token is held by the token store; Day0 stopped using it and called no vendor itself.';

/** The most overdue revocations one sweep closes. */
const OVERDUE_SWEEP_LIMIT = 100;

/** What every attempt and the final purge carry: the held credentials and the card they ended. */
export const revocationJobValidator = v.object({
  /** The credential the vendor call is made for: the card's token, else its app's secret. */
  credentialId: v.id('credentials'),
  /** The rows ended with it and finished with it: its refresh token, its app's secret. */
  companionIds: v.array(v.id('credentials')),
  agentId: v.id('agents'),
  surfaceId: v.id('surfaces'),
  surfaceName: v.string(),
  /** True where the credential is a refresh token whose access token an earlier end held. */
  primaryIsRefresh: v.optional(v.boolean()),
});

/** One revocation job. */
export type RevocationJob = Infer<typeof revocationJobValidator>;

/** One end of access on one card, as the ending transaction hands it over. */
export interface CardAccessEnd {
  readonly agentId: Id<'agents'>;
  readonly surfaceId: Id<'surfaces'>;
  /** The card's name as it stands, kept on the line since a retire deletes the card. */
  readonly surfaceName: string;
  /**
   * The rows the end takes from the card, each only once it is known nothing else binds it: its
   * credential, that credential's refresh token, and its app's client secret where the app goes.
   */
  readonly credentials: readonly Doc<'credentials'>[];
  readonly end: AccessEnd;
  readonly now: number;
}

/** What {@link endAccessAtSource} did with the card's credentials. */
export interface EndedAtSource {
  /** The rows held for a vendor call, the call scheduled. */
  readonly held: readonly Id<'credentials'>[];
  /** The rows Day0 obtained that an end calling no vendor purged at once (a handover). */
  readonly purged: readonly Id<'credentials'>[];
  /** The pasted keys: never sent to a vendor, and left to the caller's own rule. */
  readonly pasted: readonly Id<'credentials'>[];
  /** The organisation's own rows (`sharedByOrganisation`): never revoked by one employee's end. */
  readonly shared: readonly Id<'credentials'>[];
  /**
   * The rows Day0 obtained but cannot revoke at the vendor here (their value is gone, or the
   * token store holds the token): Day0 stops using them at once, and the card lets them go.
   */
  readonly stopped: readonly Id<'credentials'>[];
}

/** A credential row that says how Day0 obtained it. */
type IssuedCredential = Doc<'credentials'> & {
  readonly issuedBy: NonNullable<Doc<'credentials'>['issuedBy']>;
};

/**
 * Whether a row is a credential Day0 obtained and one employee may end: it carries `issuedBy` and
 * is not the organisation's own, whoever holds it (a per-employee identity the organisation holds
 * is the employee's to end).
 */
function ownIssued(credential: Doc<'credentials'>): credential is IssuedCredential {
  return credential.issuedBy !== undefined && !sharedByOrganisation(credential);
}

/**
 * The row the vendor call is made for: an access token (not the refresh token another row pairs,
 * and not an app's client secret) where there is one, else the app's client secret.
 *
 * @param rows - The rows Day0 obtained that one end of one card holds.
 */
function primaryOf(rows: readonly IssuedCredential[]): IssuedCredential {
  const refreshes = new Set(rows.map((row) => row.refreshCredentialId));
  const tokens = rows.filter(
    (row) => !refreshes.has(row._id) && row.issuedBy.grant !== 'app-created',
  );
  const [primary] = tokens.length > 0 ? tokens : rows;
  if (primary === undefined) throw new Error('An end of access names no credential to revoke.');
  return primary;
}

/**
 * Append one ledger line for an end of access on the employee's record.
 *
 * @param ctx - The writing transaction.
 * @param job - The card and the credential the line is for.
 * @param line - What happened, and the system it happened at.
 */
async function appendLine(
  ctx: Pick<MutationCtx, 'db'>,
  job: Pick<RevocationJob, 'agentId' | 'surfaceId' | 'surfaceName' | 'credentialId'>,
  line: {
    readonly system: string;
    readonly end: AccessEnd;
    readonly outcome: SourceRevocationOutcome;
    readonly now: number;
    readonly attempt?: number;
    readonly reason?: string;
  },
): Promise<void> {
  await appendEvent(ctx, {
    agentId: job.agentId,
    type: 'credential.revoked-at-source',
    payload: {
      credentialId: job.credentialId,
      surfaceId: job.surfaceId,
      surfaceName: job.surfaceName,
      system: line.system,
      end: line.end,
      outcome: line.outcome,
      ...(line.attempt !== undefined ? { attempt: line.attempt } : {}),
      ...(line.reason !== undefined ? { reason: line.reason } : {}),
      ...(line.system === 'slack' && line.outcome === 'token-revoked'
        ? { channelMembershipsRemoved: true }
        : {}),
    },
    createdAt: line.now,
  });
}

/** How one end of a card's access sorts the card's rows. */
interface SortedRows {
  readonly issued: readonly IssuedCredential[];
  readonly pasted: readonly Doc<'credentials'>[];
  readonly shared: readonly Doc<'credentials'>[];
  /** Day0 obtained these and holds their value, so a vendor call can be made for them. */
  readonly revocable: readonly IssuedCredential[];
  /** Day0 obtained these but cannot revoke them here: the token store holds them, or no value. */
  readonly unrevocable: readonly IssuedCredential[];
}

/**
 * Sort a card's rows for one end: pasted, shared, and what Day0 obtained, split into the rows a
 * vendor call can be made for and the rows it cannot. A row an earlier end already holds is in
 * neither: its own attempts speak for it.
 */
function sortRows(credentials: readonly Doc<'credentials'>[]): SortedRows {
  const issued = credentials.filter(ownIssued);
  const unheld = issued.filter((row) => row.sourceRevocation === undefined);
  // A token the token store holds is the store's to revoke (11-AT); Day0 never opens it here.
  const revocable = unheld.filter((row) => row.tokenStore !== 'nango' && holdsValue(row));
  return {
    issued,
    pasted: credentials.filter((row) => row.issuedBy === undefined && !row.holder),
    shared: credentials.filter(sharedByOrganisation),
    revocable,
    unrevocable: unheld.filter((row) => !revocable.includes(row)),
  };
}

/** The line a card's end writes when no vendor call speaks for it, and the row it names. */
interface CardLine {
  readonly row: Doc<'credentials'>;
  readonly system: string;
  readonly outcome: SourceRevocationOutcome;
  readonly reason?: string;
}

/**
 * The one line a card's end writes itself, if any: none where a vendor call will speak (its
 * attempts write theirs) or an earlier end's held rows already do; a handover's "nothing at the
 * vendor"; why Day0 could not revoke what it obtained; else the shared token's; else the pasted
 * key's, the card's own listed first.
 */
function cardLine(sorted: SortedRows, end: AccessEnd, surfaceName: string): CardLine | null {
  if (sorted.revocable.length > 0 && end !== 'transfer') return null;
  const [obtained] = [...sorted.revocable, ...sorted.unrevocable];
  if (obtained !== undefined) {
    if (end === 'transfer') {
      return {
        row: obtained,
        system: obtained.issuedBy.system,
        outcome: 'not-at-vendor',
        reason: HANDOVER_WORDS,
      };
    }
    return {
      row: obtained,
      system: obtained.issuedBy.system,
      ...(obtained.tokenStore === 'nango'
        ? { outcome: 'not-supported', reason: TOKEN_STORE_WORDS }
        : { outcome: 'failed', reason: NO_VALUE_WORDS }),
    };
  }
  if (sorted.issued.length > 0) return null;
  const [shared] = sorted.shared;
  if (shared !== undefined) {
    return { row: shared, system: shared.issuedBy?.system ?? surfaceName, outcome: 'shared' };
  }
  const [pasted] = sorted.pasted;
  return pasted === undefined ? null : { row: pasted, system: surfaceName, outcome: 'pasted-key' };
}

/**
 * End one card's access at the vendor, in the ending transaction (the access plan, section 4.4).
 * The rows Day0 obtained and holds a value for are revoked at once and held, their ciphertext
 * kept, and the first attempt is scheduled for the one the call is made for, the others finished
 * with it; a handover calls no vendor (A25), so it purges them at once. A row Day0 obtained but
 * cannot revoke here (its value gone, or the token store holding it) is revoked in Day0 at once.
 * A pasted key is never sent to a vendor, and the caller's own rule decides whether Day0's copy
 * goes. The organisation's own row is untouched; a per-employee identity the organisation holds is
 * ended as any row Day0 obtained. One line is written per card, so per system
 * ({@link cardLine}), or none where the attempts will write it. A row already held by an earlier
 * end keeps its scheduled attempts and is not scheduled again.
 *
 * @param ctx - The ending transaction.
 * @param input - The card, its credentials, the end and its time.
 * @returns What it did with each row.
 */
export async function endAccessAtSource(
  ctx: MutationCtx,
  input: CardAccessEnd,
): Promise<EndedAtSource> {
  const card = {
    agentId: input.agentId,
    surfaceId: input.surfaceId,
    surfaceName: input.surfaceName,
  };
  const sorted = sortRows(input.credentials);
  const line = cardLine(sorted, input.end, input.surfaceName);
  if (line !== null) {
    await appendLine(
      ctx,
      { ...card, credentialId: line.row._id },
      {
        system: line.system,
        end: input.end,
        outcome: line.outcome,
        now: input.now,
        ...(line.reason !== undefined ? { reason: line.reason } : {}),
      },
    );
  }
  for (const row of sorted.unrevocable) {
    if (row.revokedAt === undefined) await ctx.db.patch(row._id, { revokedAt: input.now });
  }
  const answer = {
    pasted: ids(sorted.pasted),
    shared: ids(sorted.shared),
    stopped: ids(sorted.unrevocable),
  };
  const fresh = sorted.revocable;
  if (fresh.length === 0) return { held: [], purged: [], ...answer };
  if (input.end === 'transfer') {
    for (const row of fresh) await purgeCredential(ctx, row, input.now);
    return { held: [], purged: ids(fresh), ...answer };
  }
  const primary = primaryOf(fresh);
  for (const row of fresh) await holdForSourceRevocation(ctx, row, input.end, input.now);
  // A refresh token whose access token an earlier end already held is revoked as one (L3).
  const primaryIsRefresh = input.credentials.some((row) => row.refreshCredentialId === primary._id);
  await ctx.scheduler.runAfter(0, internal.sourceRevocationActions.attempt, {
    ...card,
    credentialId: primary._id,
    companionIds: fresh.filter((row) => row._id !== primary._id).map((row) => row._id),
    ...(primaryIsRefresh ? { primaryIsRefresh } : {}),
  });
  return { held: ids(fresh), purged: [], ...answer };
}

/** The ids of some rows. */
function ids(rows: readonly Doc<'credentials'>[]): Id<'credentials'>[] {
  return rows.map((row) => row._id);
}

/** What Day0 holds for a credential's revocation besides the credential itself. */
interface HeldMeans {
  /** The organisation connection it was issued through, whatever its state. */
  readonly connection: Doc<'organisationConnections'> | null;
  /** Whether that connection is active, so its secrets may still be used. */
  readonly active: boolean;
  /** That connection's Slack configuration token, while it still holds its value. */
  readonly configuration: Doc<'credentials'> | null;
  /** The app's client secret, while Day0 still holds its value (F19 keeps it with the token). */
  readonly secret: Doc<'credentials'> | null;
}

/**
 * Read what a credential's revocation may use beside it: the organisation connection it was
 * issued through while that is active, the connection's configuration token, and the app's client
 * secret, each only while it still holds a value.
 *
 * @param db - Any reader.
 * @param credential - A credential Day0 obtained.
 */
async function meansOf(db: QueryCtx['db'], credential: IssuedCredential): Promise<HeldMeans> {
  const { issuedBy } = credential;
  const connection =
    issuedBy.organisationConnectionId === undefined
      ? null
      : await db.get(issuedBy.organisationConnectionId);
  // A revoked connection still names its endpoints and client; only its secret is gone with it.
  const active = connection?.status === 'active';
  const configuration =
    active &&
    connection.kind === 'slack-configuration' &&
    connection.secretCredentialId !== undefined
      ? await db.get(connection.secretCredentialId)
      : null;
  const secret =
    issuedBy.clientSecretCredentialId === undefined
      ? null
      : await db.get(issuedBy.clientSecretCredentialId);
  return {
    connection,
    active,
    configuration:
      holdsValue(configuration) && configuration.revokedAt === undefined ? configuration : null,
    secret: holdsValue(secret) ? secret : null,
  };
}

/** What an end of access will do at the vendor for one card, as the retire dialog says it. */
export type PlannedOutcome =
  | 'token-revoked'
  | 'app-deleted'
  | 'app-uninstalled'
  | 'not-supported'
  | 'failed'
  | 'shared'
  | 'not-at-vendor'
  | 'pasted-key'
  | 'kept';

/**
 * The planned outcome a line the end writes itself stands for: the same words, the attempts'
 * outcomes aside, which a line written at the end never carries.
 */
function plannedOf(outcome: SourceRevocationOutcome): PlannedOutcome {
  switch (outcome) {
    case 'token-revoked':
    case 'app-deleted':
    case 'app-uninstalled':
    case 'not-supported':
    case 'failed':
    case 'shared':
    case 'not-at-vendor':
    case 'pasted-key':
      return outcome;
    case 'already-gone':
      return 'token-revoked';
    case 'retrying':
      return 'failed';
  }
}

/**
 * What ending one card's access will do at the vendor, by the rules {@link endAccessAtSource} and
 * the attempt follow: the plan of the credential the call is made for, its preferred call's
 * meaning; for a row Day0 obtained and cannot revoke here, or a handover, the line the end would
 * write ({@link cardLine}); a pasted key that only this card binds is Day0's copy deleted and
 * never sent; a row that something else still binds is kept; a row the organisation holds is
 * shared.
 *
 * @param db - Any reader.
 * @param card - The card's name, the rows the end takes, the rows something else keeps.
 * @param end - The end of access.
 * @returns The outcome and the system it is at, or null for a card that binds nothing.
 */
export async function plannedAtSource(
  db: QueryCtx['db'],
  card: {
    readonly surfaceName: string;
    readonly ended: readonly Doc<'credentials'>[];
    readonly kept: readonly Doc<'credentials'>[];
  },
  end: AccessEnd,
): Promise<{ readonly system: string; readonly outcome: PlannedOutcome } | null> {
  const sorted = sortRows(card.ended);
  if (sorted.revocable.length > 0 && end !== 'transfer') {
    const primary = primaryOf(sorted.revocable);
    const means = await meansOf(db, primary);
    const plan = revocationPlanFor({ issuedBy: primary.issuedBy, role: 'access' }, end, {
      configurationToken: means.configuration !== null,
      clientSecret: means.secret !== null,
      ...(means.connection?.authorisationEndpoints?.revocation !== undefined
        ? { revocationEndpoint: means.connection.authorisationEndpoints.revocation }
        : {}),
    });
    const [preferred] = plan.kind === 'call' ? plan.calls : [];
    return {
      system: primary.issuedBy.system,
      outcome:
        plan.kind === 'none' ? plan.outcome : preferred ? callOutcome(preferred) : 'not-supported',
    };
  }
  const line = cardLine(sorted, end, card.surfaceName);
  if (line !== null && line.outcome !== 'shared' && line.outcome !== 'pasted-key') {
    return { system: line.system, outcome: plannedOf(line.outcome) };
  }
  const organisation = [...card.ended, ...card.kept].find(sharedByOrganisation);
  if (organisation !== undefined) {
    return { system: organisation.issuedBy?.system ?? card.surfaceName, outcome: 'shared' };
  }
  if (card.ended.length > 0) return { system: card.surfaceName, outcome: 'pasted-key' };
  if (card.kept.length > 0) return { system: card.surfaceName, outcome: 'kept' };
  return null;
}

/** What an attempt needs beyond the credential: the means a plan reads and their rows. */
const attemptPlanValidator = v.object({
  attempt: v.number(),
  last: v.boolean(),
  end: v.union(...ACCESS_ENDS.map((end) => v.literal(end))),
  system: v.string(),
  /** The configuration token of the Slack connection the app was created through. */
  configurationTokenCredentialId: v.optional(v.id('credentials')),
  /** The connection whose secret a call would use, for its ledger. */
  organisationConnectionId: v.optional(v.id('organisationConnections')),
  clientSecretCredentialId: v.optional(v.id('credentials')),
  revocationEndpoint: v.optional(v.string()),
  connectionClientId: v.optional(v.string()),
  connectionSecretCredentialId: v.optional(v.id('credentials')),
  /**
   * True where the connection's own revoke revoked that secret in the transaction that ended the
   * card (`organisation-revoked`): the attempt opens it through the path that admits only that.
   */
  connectionSecretRevoked: v.optional(v.boolean()),
  /** The companion rows that are the refresh token of the pair. */
  refreshCredentialIds: v.array(v.id('credentials')),
});

/** What {@link beginAttempt} hands the action. */
export type AttemptPlan = Infer<typeof attemptPlanValidator>;

/** Whether a row still holds a value a call could open. */
function holdsValue(row: Doc<'credentials'> | null): row is Doc<'credentials'> {
  return row !== null && row.ciphertext !== undefined && row.iv !== undefined;
}

/**
 * Count one attempt at a held credential's revocation and schedule what follows it before the
 * vendor is called, so an attempt that dies on the way still has its successor: the next attempt
 * at its offset from the end of access, or, after the last, the purge at the 24-hour bound. Reads
 * what the call needs: the organisation connection the credential was issued through (its
 * configuration token for Slack's app deletion; its revocation endpoint, client and, while it is
 * active or for the end its own revoke made, its client secret for RFC 7009) and the app's client
 * secret while Day0 still holds it.
 *
 * Internal; `sourceRevocationActions.attempt` is its only caller.
 *
 * @returns The attempt and what it needs, or null when the revocation is no longer pending.
 */
export const beginAttempt = internalMutation({
  args: revocationJobValidator,
  returns: v.union(v.null(), attemptPlanValidator),
  handler: async (ctx, job): Promise<AttemptPlan | null> => {
    const credential = await ctx.db.get(job.credentialId);
    const held = credential?.sourceRevocation;
    if (credential === null || !ownIssued(credential) || held?.state !== 'pending') return null;
    const attempt = held.attempts + 1;
    const now = Date.now();
    await ctx.db.patch(credential._id, {
      sourceRevocation: { ...held, attempts: attempt, at: now },
    });
    const endedAt = credential.revokedAt ?? now;
    const next = SOURCE_REVOCATION_ATTEMPT_OFFSETS_MS[attempt];
    const last = next === undefined;
    if (last) {
      await ctx.scheduler.runAt(
        endedAt + SOURCE_REVOCATION_KEEP_MS,
        internal.sourceRevocation.expire,
        job,
      );
    } else {
      await ctx.scheduler.runAt(
        Math.max(now, endedAt + next),
        internal.sourceRevocationActions.attempt,
        job,
      );
    }
    const means = await meansOf(ctx.db, credential);
    const mcpSecretId =
      means.connection?.kind === 'mcp-client' ? means.connection.secretCredentialId : undefined;
    // The organisation's own revoke revoked the client secret with the connection, in the same
    // transaction that ended the card; its own end still revokes the card's token with it, or a
    // confidential client answers invalid_client (join 8).
    const revokedWithConnection = !means.active && held.end === 'organisation-revoked';
    const companions = await Promise.all(job.companionIds.map(async (id) => await ctx.db.get(id)));
    return {
      attempt,
      last,
      end: held.end ?? 'disconnect',
      system: credential.issuedBy.system,
      ...(means.configuration !== null
        ? { configurationTokenCredentialId: means.configuration._id }
        : {}),
      ...(means.connection !== null ? { organisationConnectionId: means.connection._id } : {}),
      ...(means.secret !== null ? { clientSecretCredentialId: means.secret._id } : {}),
      ...(means.connection?.authorisationEndpoints?.revocation !== undefined
        ? { revocationEndpoint: means.connection.authorisationEndpoints.revocation }
        : {}),
      ...(means.connection?.clientId !== undefined
        ? { connectionClientId: means.connection.clientId }
        : {}),
      ...(mcpSecretId !== undefined && (means.active || revokedWithConnection)
        ? {
            connectionSecretCredentialId: mcpSecretId,
            ...(revokedWithConnection ? { connectionSecretRevoked: true } : {}),
          }
        : {}),
      refreshCredentialIds: companions
        .filter(
          (row): row is Doc<'credentials'> =>
            holdsValue(row) && credential.refreshCredentialId === row._id,
        )
        .map((row) => row._id),
    };
  },
});

/** What one attempt found, as the action hands it over. */
const attemptResultValidator = v.union(
  v.object({
    kind: v.literal('final'),
    outcome: v.union(
      v.literal('token-revoked'),
      v.literal('app-deleted'),
      v.literal('app-uninstalled'),
      v.literal('already-gone'),
      v.literal('not-supported'),
      v.literal('shared'),
      v.literal('not-at-vendor'),
    ),
    reason: v.optional(v.string()),
  }),
  v.object({ kind: v.literal('failure'), words: v.string(), permanent: v.boolean() }),
);

/** What one attempt found. */
export type AttemptResult = Infer<typeof attemptResultValidator>;

/** The stored state each final outcome writes. */
function finalState(
  outcome: Extract<AttemptResult, { kind: 'final' }>['outcome'],
): 'done' | 'not-supported' {
  switch (outcome) {
    case 'token-revoked':
    case 'app-deleted':
    case 'app-uninstalled':
    case 'already-gone':
      return 'done';
    case 'not-supported':
    case 'shared':
    case 'not-at-vendor':
      return 'not-supported';
  }
}

/**
 * Finish a held credential and the rows held with it, deleting their ciphertext.
 *
 * @param ctx - The recording transaction.
 * @param job - The held rows.
 * @param outcome - The final state and the vendor's words for a failure.
 */
async function finishJob(
  ctx: MutationCtx,
  job: Pick<RevocationJob, 'credentialId' | 'companionIds'>,
  outcome: Parameters<typeof finishSourceRevocation>[2],
): Promise<void> {
  for (const id of [job.credentialId, ...job.companionIds]) {
    const row = await ctx.db.get(id);
    if (row?.sourceRevocation?.state === 'pending') await finishSourceRevocation(ctx, row, outcome);
  }
}

/**
 * Record one attempt's answer (the access plan, section 4.4): a final outcome finishes the held
 * rows and deletes their ciphertext; a failure that another attempt cannot change, or the last
 * attempt's failure, finishes them `failed` with the vendor's words; any other failure keeps them
 * pending with the words, for the attempt already scheduled. Each writes its line on the
 * employee's record, and on the organisation connection's ledger when its secret made the call.
 * An answer for an attempt that is no longer the latest, or for a revocation no longer pending,
 * is dropped.
 *
 * Internal; `sourceRevocationActions.attempt` is its only caller.
 */
export const recordAttempt = internalMutation({
  args: {
    job: revocationJobValidator,
    attempt: v.number(),
    last: v.boolean(),
    result: attemptResultValidator,
    viaConnection: v.optional(v.id('organisationConnections')),
  },
  handler: async (ctx, args): Promise<void> => {
    const credential = await ctx.db.get(args.job.credentialId);
    const held = credential?.sourceRevocation;
    if (!credential?.issuedBy || held?.state !== 'pending' || held.attempts !== args.attempt) {
      return;
    }
    const now = Date.now();
    const end = held.end ?? 'disconnect';
    const system = credential.issuedBy.system;
    const { result } = args;
    let outcome: SourceRevocationOutcome;
    let reason: string | undefined;
    if (result.kind === 'final') {
      outcome = result.outcome;
      reason = result.reason;
      await finishJob(ctx, args.job, { state: finalState(result.outcome), now });
    } else if (result.permanent || args.last) {
      outcome = 'failed';
      reason = result.words;
      await finishJob(ctx, args.job, { state: 'failed', now, lastError: result.words });
    } else {
      outcome = 'retrying';
      reason = result.words;
      await ctx.db.patch(credential._id, {
        sourceRevocation: { ...held, lastError: result.words, at: now },
      });
    }
    await appendLine(ctx, args.job, {
      system,
      end,
      outcome,
      now,
      attempt: args.attempt,
      ...(reason !== undefined ? { reason } : {}),
    });
    if (args.viaConnection !== undefined) {
      await appendConnectionEvent(ctx, {
        organisationConnectionId: args.viaConnection,
        type: 'organisation.revoked-at-source',
        payload: {
          credentialId: credential._id,
          system,
          end,
          outcome,
          attempt: args.attempt,
          ...(reason !== undefined ? { reason } : {}),
        },
        createdAt: now,
      });
    }
  },
});

/**
 * Close a revocation the attempts did not finish by its 24-hour bound (F19): the held rows are
 * finished `failed` with the last words the vendor gave, or {@link NO_ANSWER_WORDS}, their
 * ciphertext deleted, and the line written. Nothing is done for one already final.
 *
 * Internal; scheduled by the last attempt's {@link beginAttempt}.
 */
export const expire = internalMutation({
  args: revocationJobValidator,
  handler: async (ctx, job): Promise<void> => {
    const credential = await ctx.db.get(job.credentialId);
    const held = credential?.sourceRevocation;
    if (!credential || held?.state !== 'pending') return;
    const now = Date.now();
    const words = held.lastError ?? NO_ANSWER_WORDS;
    await finishJob(ctx, job, { state: 'failed', now, lastError: words });
    await appendLine(ctx, job, {
      system: credential.issuedBy?.system ?? job.surfaceName,
      end: held.end ?? 'disconnect',
      outcome: 'failed',
      now,
      attempt: held.attempts,
      reason: words,
    });
  },
});

/**
 * The held credentials whose revocation is still pending past the 24-hour bound, oldest first,
 * read by `by_source_revocation_state` (11-AK, AK7): the range on `revokedAt` in the same index.
 *
 * Internal; the sweep's read, and the bed's proof that the index answers with rows in it.
 */
export const overdue = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, args): Promise<Id<'credentials'>[]> =>
    (
      await ctx.db
        .query('credentials')
        .withIndex('by_source_revocation_state', (q) =>
          q
            .eq('sourceRevocation.state', 'pending')
            .lt('revokedAt', args.now - SOURCE_REVOCATION_KEEP_MS),
        )
        .take(OVERDUE_SWEEP_LIMIT)
    ).map((row) => row._id),
});

/**
 * Close every held credential the attempts left pending past the 24-hour bound, for the case
 * where the scheduled purge itself was lost: finished `failed`, ciphertext deleted. No line is
 * written, since the row does not name the employee; the row keeps the words.
 *
 * Internal; the hourly sweep's (`convex/crons.ts`).
 *
 * @returns How many it closed.
 */
export const expireOverdue = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const now = Date.now();
    const rows = await ctx.db
      .query('credentials')
      .withIndex('by_source_revocation_state', (q) =>
        q.eq('sourceRevocation.state', 'pending').lt('revokedAt', now - SOURCE_REVOCATION_KEEP_MS),
      )
      .take(OVERDUE_SWEEP_LIMIT);
    for (const row of rows) {
      await finishSourceRevocation(ctx, row, {
        state: 'failed',
        now,
        lastError: row.sourceRevocation?.lastError ?? NO_ANSWER_WORDS,
      });
    }
    return rows.length;
  },
});
