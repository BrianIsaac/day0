'use node';

import { v } from 'convex/values';
import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { createMcpClient, decodeMcpPayload } from './intakeActions';
import { readSurfaceBearer } from './mcpOauthActions';
import type { LookupCard } from './peopleProposals';
import { normaliseManagerAddress } from '../src/agent/manager-address';
import { log } from '../src/lib/logger';
import { LINEAR_MCP_ENDPOINT } from '../src/surfaces/fixed-endpoints';
import { safeFailureMessage } from '../src/surfaces/redact';
import { slackApiUrl } from '../src/surfaces/slack-endpoint';

/*
 * A person's identities looked up by their address (wave 13, 13-P; the wave file's section 5.2):
 * on the employee's own connections, Slack's `users.lookupByEmail` (the method every Slack probe
 * already requires, so no new scope) and Linear's `get_user` where the card's approval allows it.
 * Run when an address first reaches the graph, so the People tab's card can say whom a proposal
 * matches; an identity on a proposal answers for nobody until the manager confirms the person.
 * Never `users.info` (RM6), and never a lookup by name.
 */

/** How long one lookup waits for its provider. */
const LOOKUP_TIMEOUT_MS = 30_000;

/** How many times a person's lookup is asked before a failure is marked on the person (W13-R25). */
export const LOOKUP_ATTEMPTS = 3;

/** How long a lookup waits before asking again when the provider names no wait. */
const LOOKUP_RETRY_MS = 60_000;

/** The longest wait a provider's Retry-After is taken at. */
const LOOKUP_RETRY_LIMIT_MS = 600_000;

/** What one lookup found: the person's user in that system, and how it shows them. */
interface FoundIdentity {
  readonly provider: 'slack' | 'linear';
  readonly externalId: string;
  readonly workspaceId?: string;
  readonly displayName?: string;
}

/** An MCP client as the lookup uses it. */
type LookupMcpClient = ReturnType<typeof createMcpClient>;

/** What the lookups reach the outside through: replaced by fakes in tests, never the network there. */
export interface LookupDependencies {
  /** The bearer a card's credential holds, renewed first when due. */
  readonly bearer: (credentialId: Id<'credentials'>) => Promise<string>;
  /** Slack's Web API transport. */
  readonly fetch: (input: URL, init: RequestInit) => Promise<Response>;
  /** An MCP client for a Linear card's endpoint. */
  readonly makeMcpClient: (endpoint: URL, credential: string) => LookupMcpClient;
  /**
   * Ask again later for the people whose lookup failed in a way a later ask may not (a rate limit,
   * a timeout, a provider down): the action schedules itself. Absent, a failure is marked at once.
   */
  readonly retry?: (
    personIds: readonly Id<'people'>[],
    attempt: number,
    delayMs: number,
  ) => Promise<void>;
}

/** A provider's refusal a later ask would meet again (a missing scope, a revoked token). */
class LookupRefused extends Error {}

/** A provider's answer that asks the caller to wait, with the wait it names when it names one. */
class LookupRateLimited extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(retryAfterMs: number | undefined) {
    super('The provider limited the lookup rate.');
    this.retryAfterMs = retryAfterMs;
  }
}

/** The wait a Retry-After header names, bounded, or undefined when it names none. */
function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get('Retry-After'));
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(seconds * 1000, LOOKUP_RETRY_LIMIT_MS);
}

/** What one card's lookup of an address came to. */
type CardLookup =
  | { readonly kind: 'answered'; readonly identity?: FoundIdentity }
  | { readonly kind: 'refused' }
  | { readonly kind: 'failed'; readonly retryAfterMs?: number };

/** A value as an object, or undefined. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A non-empty string, trimmed, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** The name Slack shows for a member as their handle: the display name, else the username. */
function slackHandle(user: Record<string, unknown>): string | undefined {
  return text(asRecord(user.profile)?.display_name) ?? text(user.name) ?? text(user.real_name);
}

/**
 * The Slack user an address is, by `users.lookupByEmail` on the card's own bot token: none for an
 * address Slack does not know, a bot or a deactivated member.
 *
 * @throws Error for any other refusal, for the caller to log.
 */
async function slackUserByAddress(
  card: LookupCard,
  address: string,
  credential: string,
  dependencies: LookupDependencies,
): Promise<FoundIdentity | undefined> {
  const url = slackApiUrl('users.lookupByEmail');
  url.searchParams.set('email', address);
  const response = await dependencies.fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${credential}` },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  const payload = asRecord(await response.json().catch((): unknown => ({})));
  if (response.status === 429 || payload?.error === 'ratelimited') {
    throw new LookupRateLimited(retryAfterMs(response));
  }
  if (payload?.ok !== true) {
    if (payload?.error === 'users_not_found') return undefined;
    const reason = `Slack users.lookupByEmail failed: ${text(payload?.error) ?? `HTTP ${response.status}`}`;
    // A refusal Slack states is met again on the next ask; a server's failure may pass.
    throw response.status >= 500 || payload === undefined
      ? new Error(reason)
      : new LookupRefused(reason);
  }
  const user = asRecord(payload.user);
  const userId = text(user?.id);
  if (user === undefined || userId === undefined || user.is_bot === true || user.deleted === true) {
    return undefined;
  }
  const workspaceId = card.workspaceId ?? text(user.team_id);
  const handle = slackHandle(user);
  return {
    provider: 'slack',
    externalId: userId,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(handle === undefined ? {} : { displayName: handle }),
  };
}

/**
 * The Linear user an address is, by the card's own `get_user`: only an answer whose address is the
 * one asked, so a server that matched on anything else names nobody.
 */
async function linearUserByAddress(
  card: LookupCard,
  address: string,
  credential: string,
  dependencies: LookupDependencies,
): Promise<FoundIdentity | undefined> {
  const client = dependencies.makeMcpClient(
    new URL(card.endpoint ?? LINEAR_MCP_ENDPOINT),
    credential,
  );
  try {
    const { definitions, errors } = await client.listToolDefinitionsWithErrors({
      perServerTimeoutMs: LOOKUP_TIMEOUT_MS,
    });
    if (errors.surface !== undefined) throw new Error(errors.surface);
    const definition = definitions.surface?.get_user;
    if (definition === undefined) return undefined;
    const tool = await client.toolFromDefinition({ serverName: 'surface', definition });
    if (tool.execute === undefined) return undefined;
    const answer = asRecord(
      decodeMcpPayload(
        await tool.execute(
          { query: address },
          { abortSignal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) },
        ),
      ),
    );
    const user = asRecord(answer?.user) ?? answer;
    const userId = text(user?.id);
    if (userId === undefined || normaliseManagerAddress(text(user?.email)) !== address) {
      return undefined;
    }
    const name = text(user?.name) ?? text(user?.displayName);
    return {
      provider: 'linear',
      externalId: userId,
      ...(card.workspaceId === undefined ? {} : { workspaceId: card.workspaceId }),
      ...(name === undefined ? {} : { displayName: name }),
    };
  } finally {
    await client.disconnect();
  }
}

/** One card's lookup of an address, a failure logged and told apart from an answer. */
async function lookUpOnCard(
  card: LookupCard,
  address: string,
  dependencies: LookupDependencies,
): Promise<CardLookup> {
  let credential = '';
  try {
    credential = await dependencies.bearer(card.credentialId);
    const identity =
      card.kind === 'slack'
        ? await slackUserByAddress(card, address, credential, dependencies)
        : await linearUserByAddress(card, address, credential, dependencies);
    return identity === undefined ? { kind: 'answered' } : { kind: 'answered', identity };
  } catch (error: unknown) {
    // A lookup is a convenience for the card: the proposal stands without it, and the manager
    // confirms or dismisses it either way. A failure a later ask may pass is asked again.
    log.warn('a person lookup by address failed; the proposal stands without its match', {
      surfaceId: card.surfaceId,
      kind: card.kind,
      reason: safeFailureMessage(error, credential, 'The lookup failed.', 300),
    });
    if (error instanceof LookupRefused) return { kind: 'refused' };
    return error instanceof LookupRateLimited && error.retryAfterMs !== undefined
      ? { kind: 'failed', retryAfterMs: error.retryAfterMs }
      : { kind: 'failed' };
  } finally {
    credential = '';
  }
}

/**
 * Look each person's address up on the owner's cards and record what is found as their
 * identities (`peopleProposals.recordLookups`). A lookup that fails in a way a later ask may pass
 * is asked again, within {@link LOOKUP_ATTEMPTS}, after the wait the provider names; past that, or
 * at once for a refusal, the person is marked (`lookupFailedAt`, W13-R25) until a lookup answers.
 *
 * @param ctx - The action's runners.
 * @param personIds - The people whose addresses reached the graph.
 * @param dependencies - The outside the lookups reach.
 * @param attempt - Which ask this is, from 1.
 * @returns How many identities were added.
 */
export async function runLookups(
  ctx: Pick<ActionCtx, 'runQuery' | 'runMutation'>,
  personIds: readonly Id<'people'>[],
  dependencies: LookupDependencies,
  attempt = 1,
): Promise<number> {
  const targets = await ctx.runQuery(internal.peopleProposals.lookupTargets, {
    personIds: [...personIds],
  });
  const canRetry = dependencies.retry !== undefined && attempt < LOOKUP_ATTEMPTS;
  const again: Id<'people'>[] = [];
  let delayMs = 0;
  let added = 0;
  for (const target of targets) {
    const looked: CardLookup[] = [];
    for (const card of target.cards)
      looked.push(await lookUpOnCard(card, target.address, dependencies));
    const found = looked.flatMap((card) =>
      card.kind === 'answered' && card.identity !== undefined ? [card.identity] : [],
    );
    const failed = looked.filter((card) => card.kind === 'failed');
    const retried = canRetry && failed.length > 0;
    if (retried) {
      again.push(target.personId);
      delayMs = Math.max(
        delayMs,
        ...failed.map((card) => card.retryAfterMs ?? LOOKUP_RETRY_MS * attempt),
      );
    }
    const outcome =
      failed.length > 0 || looked.some((card) => card.kind === 'refused')
        ? retried
          ? undefined
          : ('failed' as const)
        : ('answered' as const);
    if (found.length === 0 && outcome === undefined) continue;
    added += await ctx.runMutation(internal.peopleProposals.recordLookups, {
      personId: target.personId,
      address: target.address,
      found,
      ...(outcome === undefined ? {} : { outcome }),
    });
  }
  if (again.length > 0 && dependencies.retry !== undefined) {
    await dependencies.retry(again, attempt + 1, delayMs);
  }
  return added;
}

/**
 * Internal, scheduled when an address first reaches the graph (the documentation's extraction):
 * look each person's address up on the owner's employees' Slack and Linear cards and record the
 * users found as the person's identities. Reads the cards' credentials; writes
 * `personIdentities` and the person's `lookupFailedAt`; schedules itself again for a lookup that
 * failed and may pass later (W13-R25).
 *
 * @returns How many identities it added.
 */
export const lookUpAddresses = internalAction({
  args: {
    personIds: v.array(v.id('people')),
    /** Which ask this is, from 1; a retry of a failed lookup asks again with the next. */
    attempt: v.optional(v.number()),
  },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> =>
    await runLookups(
      ctx,
      args.personIds,
      {
        bearer: async (credentialId) => await readSurfaceBearer(ctx, credentialId),
        fetch: async (input, init) => await fetch(input, init),
        makeMcpClient: (endpoint, credential) => createMcpClient(endpoint, credential),
        retry: async (personIds, attempt, delayMs) => {
          await ctx.scheduler.runAfter(delayMs, internal.peopleLookupActions.lookUpAddresses, {
            personIds: [...personIds],
            attempt,
          });
        },
      },
      args.attempt ?? 1,
    ),
});
