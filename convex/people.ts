import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { mutation, type MutationCtx } from './_generated/server';
import { getCallerOrThrow, ownerScope, verifiedAddressOf } from './ownership';
import { sameManagerAddress } from '../src/agent/manager-address';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { personNameKey } from '../src/people/vocabulary';

/*
 * The owner's people graph (wave 13; the wave file's section 5.1). This module holds the owner's
 * own row, written at the owner's sign-in (13-K); the proposals, the confirmations and the
 * graph's readers are 13-P's.
 */

/** What {@link ensureOwner} came to: the owner's person, and how many identities it added. */
const ensuredValidator = v.object({
  personId: v.union(v.id('people'), v.null()),
  identitiesAdded: v.number(),
});

/** The owner a sign-in names: the scope their rows are keyed by, their verified address, a name. */
interface SignedInOwner {
  readonly scope: string;
  readonly address: string;
  readonly name: string | undefined;
}

/**
 * The most employees of one owner, and chat cards of one employee, the owner's sign-in reads: far
 * more than an owner has, so a read past it is a deployment this was not built for.
 */
const OWNER_READ_LIMIT = 500;

/** A Slack user a connected chat card looked up by the owner's address, by its workspace. */
interface LookedUpSlackUser {
  readonly workspaceId: string | undefined;
  readonly userId: string;
  readonly name: string | undefined;
  readonly verifiedAt: number | undefined;
}

/**
 * The owner's own row: the one marked `isOwner`, or else a person the graph already holds under
 * the owner's address (a page may have named them first), made the owner's own row rather than
 * written twice; a new one otherwise. A row already the owner's takes a changed address.
 */
async function ownerPerson(
  ctx: MutationCtx,
  owner: SignedInOwner,
  now: number,
): Promise<Id<'people'>> {
  const marked = await ctx.db
    .query('people')
    .withIndex('by_user_owner', (q) => q.eq('userId', owner.scope).eq('isOwner', true))
    .first();
  if (marked !== null) {
    if (marked.primaryEmail !== owner.address) {
      await ctx.db.patch(marked._id, { primaryEmail: owner.address, updatedAt: now });
    }
    return marked._id;
  }
  const named = await ctx.db
    .query('people')
    .withIndex('by_user_email', (q) =>
      q.eq('userId', owner.scope).eq('primaryEmail', owner.address),
    )
    .first();
  if (named !== null) {
    await ctx.db.patch(named._id, {
      isOwner: true,
      status: 'active',
      confirmedAt: named.confirmedAt ?? now,
      updatedAt: now,
    });
    return named._id;
  }
  const displayName = owner.name?.trim() || owner.address;
  return await ctx.db.insert('people', {
    userId: owner.scope,
    displayName,
    nameKey: personNameKey(displayName),
    primaryEmail: owner.address,
    isOwner: true,
    status: 'active',
    source: 'owner',
    evidence: [],
    confirmedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * The Slack users the owner's connected chat cards looked up by the owner's own address
 * (`users.lookupByEmail` at the probe, kept as `managerUserId`), one per user and workspace. Only
 * an employee managed under the owner's verified address counts: one deployed before wave 9 may
 * still name an address its owner typed, and its card looked up whoever that address is.
 */
async function slackUsersOf(ctx: MutationCtx, owner: SignedInOwner): Promise<LookedUpSlackUser[]> {
  const employees = await ctx.db
    .query('agents')
    .withIndex('by_userId', (q) => q.eq('userId', owner.scope))
    .take(OWNER_READ_LIMIT);
  const managed = employees.filter((agent) => sameManagerAddress(agent.bossEmail, owner.address));
  const cards = (
    await Promise.all(
      managed.map(
        async (agent): Promise<Doc<'surfaces'>[]> =>
          await ctx.db
            .query('surfaces')
            .withIndex('by_agent', (q) => q.eq('agentId', agent._id))
            .take(OWNER_READ_LIMIT),
      ),
    )
  ).flat();
  const users = new Map<string, LookedUpSlackUser>();
  for (const card of cards) {
    if (card.class !== 'chat' || card.verdict !== 'connected') continue;
    if (card.managerUserId === undefined) continue;
    const key = `${card.providerWorkspaceId ?? ''}/${card.managerUserId}`;
    if (users.has(key)) continue;
    users.set(key, {
      workspaceId: card.providerWorkspaceId,
      userId: card.managerUserId,
      name: card.managerName,
      verifiedAt: card.lastVerifiedAt,
    });
  }
  return [...users.values()];
}

/**
 * Record an identity on the owner's person unless the owner scope holds that identity already, in
 * the same workspace (an id is unique only in its workspace), on this person or another (a merge
 * is the manager's, 13-P's).
 *
 * @returns Whether it was added.
 */
async function addIdentity(
  ctx: MutationCtx,
  owner: SignedInOwner,
  identity: Omit<Doc<'personIdentities'>, '_id' | '_creationTime' | 'userId'>,
): Promise<boolean> {
  const held = await ctx.db
    .query('personIdentities')
    .withIndex('by_user_provider_external', (q) =>
      q
        .eq('userId', owner.scope)
        .eq('provider', identity.provider)
        .eq('externalId', identity.externalId),
    )
    .take(OWNER_READ_LIMIT);
  if (held.some((row) => row.providerWorkspaceId === identity.providerWorkspaceId)) return false;
  await ctx.db.insert('personIdentities', { userId: owner.scope, ...identity });
  return true;
}

/**
 * Write the owner's own person and its identities, as {@link ensureOwner} does for a caller: the
 * person keyed by the verified address, the address as an identity, and one Slack identity per
 * distinct Slack user the owner's connected chat cards looked up by that address. Safe to run any
 * number of times: what is held is left.
 *
 * @param ctx - The mutation's context.
 * @param owner - The signed-in owner.
 * @param now - The sign-in's time.
 * @returns The owner's person and how many identities were added.
 */
export async function ensureOwnerPerson(
  ctx: MutationCtx,
  owner: SignedInOwner,
  now: number,
): Promise<{ personId: Id<'people'>; identitiesAdded: number }> {
  const personId = await ownerPerson(ctx, owner, now);
  const added = [
    await addIdentity(ctx, owner, {
      personId,
      provider: 'email',
      externalId: owner.address,
      verifiedAt: now,
      source: 'owner',
      createdAt: now,
    }),
  ];
  for (const user of await slackUsersOf(ctx, owner)) {
    added.push(
      await addIdentity(ctx, owner, {
        personId,
        provider: 'slack',
        ...(user.workspaceId === undefined ? {} : { providerWorkspaceId: user.workspaceId }),
        externalId: user.userId,
        ...(user.name === undefined
          ? {}
          : { displayName: user.name, displayNameKey: personNameKey(user.name) }),
        ...(user.verifiedAt === undefined ? {} : { verifiedAt: user.verifiedAt }),
        source: 'provider-lookup',
        createdAt: now,
      }),
    );
  }
  return { personId, identitiesAdded: added.filter(Boolean).length };
}

/**
 * Public, any signed-in caller (`getCallerOrThrow` first, 12-G): write the caller's own person in
 * their people graph, the backfill of the graph for every owner from before it and its writer
 * from then on (wave 13, 13-K; the wave file's section 5.1). The signed-in home calls it each
 * time it opens, since no address is known to the server before the owner signs in; an owner who
 * never opens the home has no row yet, which every reader of the graph tolerates. Writes `people` and
 * `personIdentities` under the caller's owner scope ({@link ensureOwnerPerson}); nothing in mock
 * mode, where the graph is not kept and a hosted visitor's address is stored nowhere new, and
 * nothing for a caller whose address the issuer does not verify.
 *
 * @returns The owner's person, or null when nothing was written, and how many identities it added.
 */
export const ensureOwner = mutation({
  args: {},
  returns: ensuredValidator,
  handler: async (ctx): Promise<{ personId: Id<'people'> | null; identitiesAdded: number }> => {
    const caller = await getCallerOrThrow(ctx);
    if (SURFACE_MODE !== 'real') return { personId: null, identitiesAdded: 0 };
    const address = verifiedAddressOf(caller);
    if (address === undefined) return { personId: null, identitiesAdded: 0 };
    return await ensureOwnerPerson(
      ctx,
      { scope: ownerScope(caller), address, name: caller.name },
      Date.now(),
    );
  },
});
