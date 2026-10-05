import { ConvexError, v, type Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import {
  assertOwnsAgent,
  employeeOwnerScope,
  assertOwnsPerson,
  assertOwnsRelationship,
  getCallerOrThrow,
  ownerScope,
  verifiedAddressOf,
} from './ownership';
import { appendEvent } from './eventLog';
import { EVIDENCE_SHOWN, GRAPH_READ_LIMIT, identitiesUnder, withEvidence } from './peopleProposals';
import { normaliseManagerAddress, sameManagerAddress } from '../src/agent/manager-address';
import type { RelationshipChange } from '../src/events/contract';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import {
  edgeHeldAt,
  edgeInForce,
  resolveMatches,
  scopeCovers,
  type PersonLookup,
  type PersonResolution,
} from '../src/people/resolution';
import {
  IDENTITY_PROVIDERS,
  personNameKey,
  RELATIONSHIP_TYPES,
  type IdentityProvider,
  type PersonStatus,
  type RelationshipType,
} from '../src/people/vocabulary';
import {
  CONFIRM_BEFORE_RELATING,
  EMPLOYEE_RELATIONSHIP_TYPES,
  NOT_OFFERED_AS_SAME,
  NOT_THE_MATCH,
  NOTHING_WAITING,
  OWNER_IS_THE_MANAGER,
  RELATIONSHIP_ENDED,
  RELATIONSHIP_SCOPE_LIMIT,
  SAME_PERSON_GONE,
  SAY_WHETHER_SAME_FIRST,
  SCOPE_TOO_LONG,
} from '../src/people/words';

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

/*
 * The graph's card and readers (wave 13, 13-P; the wave file's section 5.2; A1, A14, C5, Q11):
 * what the manager confirms on the People tab, and the readers the employee's work and the audit
 * ask. What sources propose is written by `convex/peopleProposals.ts`. Every read leads with the
 * owner scope or, where its index does not (`by_from_agent_type`, `by_person`), keeps only the
 * scope's rows, so after a handover nothing of the old owner's graph answers the new owner.
 */

/** The validator of the systems a person's identity can be in. */
const identityProviderValidator = v.union(
  ...IDENTITY_PROVIDERS.map((provider) => v.literal(provider)),
);

/** The validator of what an edge says. */
const relationshipTypeValidator = v.union(...RELATIONSHIP_TYPES.map((type) => v.literal(type)));

/** The validator of the edge types the manager adds from one employee's People tab. */
const employeeRelationshipTypeValidator = v.union(
  ...EMPLOYEE_RELATIONSHIP_TYPES.map((type) => v.literal(type)),
);

/** The edges into a person under the owner scope. */
async function edgesTo(
  ctx: QueryCtx,
  scope: string,
  personId: Id<'people'>,
): Promise<Doc<'relationships'>[]> {
  return await ctx.db
    .query('relationships')
    .withIndex('by_user_to', (q) => q.eq('userId', scope).eq('toPersonId', personId))
    .take(GRAPH_READ_LIMIT);
}

/** A person the card may decide: not the owner's own row, which is the manager. */
function decidable(person: Doc<'people'>): Doc<'people'> {
  if (person.isOwner === true) throw new ConvexError(OWNER_IS_THE_MANAGER);
  return person;
}

/**
 * Confirm a proposal, in one transaction: an `unverified` person becomes `active` with
 * `confirmedAt`, and every edge proposed to them becomes `active`, in force from now. A person
 * already confirmed has only its proposed edges confirmed.
 */
async function confirmInTransaction(
  ctx: MutationCtx,
  person: Doc<'people'>,
  now: number,
): Promise<number> {
  if (person.possiblySameAs !== undefined) throw new ConvexError(SAY_WHETHER_SAME_FIRST);
  const proposed = (await edgesTo(ctx, person.userId, person._id)).filter(
    (edge) => edge.status === 'proposed',
  );
  if (person.status !== 'unverified' && proposed.length === 0) {
    throw new ConvexError(NOTHING_WAITING);
  }
  if (person.status === 'unverified') {
    await ctx.db.patch(person._id, { status: 'active', confirmedAt: now, updatedAt: now });
  }
  for (const edge of proposed) {
    await ctx.db.patch(edge._id, { status: 'active', confirmedAt: now, effectiveFrom: now });
  }
  return proposed.length;
}

/**
 * Public, owner-level (`assertOwnsPerson` first, then `assertOwnsAgent` for the tab's employee):
 * the card's **Confirm**. Makes a proposed person `active` and their proposed edges `active` (A14:
 * a card activates). Refused for a person with nothing waiting, for one offered as possibly
 * someone known until the manager says whether they are, and for the owner's own row.
 *
 * @returns How many edges it confirmed.
 */
export const confirm = mutation({
  args: { personId: v.id('people'), agentId: v.id('agents') },
  returns: v.object({ edgesConfirmed: v.number() }),
  handler: async (ctx, args): Promise<{ edgesConfirmed: number }> => {
    const person = decidable(await assertOwnsPerson(ctx, args.personId));
    await assertOwnsAgent(ctx, args.agentId);
    const now = Date.now();
    const edgesConfirmed = await confirmInTransaction(ctx, person, now);
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'person.confirmed',
      payload: { personId: person._id, person: person.displayName, how: 'confirm', edgesConfirmed },
      createdAt: now,
    });
    return { edgesConfirmed };
  },
});

/**
 * Public, owner-level (`assertOwnsPerson` first, then `assertOwnsAgent`): the card's **Dismiss**.
 * A proposed person becomes `dismissed` (kept, so the same words do not propose them again); a
 * confirmed person keeps standing and only the edges proposed to them are retired, never having
 * been in force.
 *
 * @returns How many proposed edges it retired.
 */
export const dismiss = mutation({
  args: { personId: v.id('people'), agentId: v.id('agents') },
  returns: v.object({ edgesRetired: v.number() }),
  handler: async (ctx, args): Promise<{ edgesRetired: number }> => {
    const person = decidable(await assertOwnsPerson(ctx, args.personId));
    await assertOwnsAgent(ctx, args.agentId);
    const now = Date.now();
    const proposed = (await edgesTo(ctx, person.userId, person._id)).filter(
      (edge) => edge.status === 'proposed',
    );
    if (person.status !== 'unverified' && proposed.length === 0) {
      throw new ConvexError(NOTHING_WAITING);
    }
    if (person.status === 'unverified') {
      await ctx.db.patch(person._id, { status: 'dismissed', dismissedAt: now, updatedAt: now });
    }
    for (const edge of proposed) await ctx.db.patch(edge._id, { status: 'retired' });
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'person.dismissed',
      payload: { personId: person._id, person: person.displayName, edgesRetired: proposed.length },
      createdAt: now,
    });
    return { edgesRetired: proposed.length };
  },
});

/**
 * Public, owner-level (`assertOwnsPerson` first, then `assertOwnsAgent`): **Same person** on a
 * proposal whose name alone matched someone known (C5). The manager's word merges it: its
 * evidence, identities and edges move to that person (the edges still proposed, for Confirm), and
 * the proposal's row goes. A merge never confirms anything.
 *
 * @returns The person it was merged into.
 */
export const samePerson = mutation({
  args: { personId: v.id('people'), agentId: v.id('agents') },
  returns: v.object({ personId: v.id('people') }),
  handler: async (ctx, args): Promise<{ personId: Id<'people'> }> => {
    const proposal = decidable(await assertOwnsPerson(ctx, args.personId));
    await assertOwnsAgent(ctx, args.agentId);
    if (proposal.possiblySameAs === undefined || proposal.status !== 'unverified') {
      throw new ConvexError(NOT_OFFERED_AS_SAME);
    }
    const target = await ctx.db.get(proposal.possiblySameAs);
    if (target === null || target.userId !== proposal.userId || target.status === 'dismissed') {
      throw new ConvexError(SAME_PERSON_GONE);
    }
    const now = Date.now();
    await ctx.db.patch(target._id, {
      evidence: withEvidence(target.evidence, proposal.evidence),
      ...(target.primaryEmail === undefined && proposal.primaryEmail !== undefined
        ? { primaryEmail: proposal.primaryEmail }
        : {}),
      ...(target.title === undefined && proposal.title !== undefined
        ? { title: proposal.title }
        : {}),
      ...(target.team === undefined && proposal.team !== undefined ? { team: proposal.team } : {}),
      updatedAt: now,
    });
    const identities = await ctx.db
      .query('personIdentities')
      .withIndex('by_person', (q) => q.eq('personId', proposal._id))
      .take(GRAPH_READ_LIMIT);
    for (const identity of identities) await ctx.db.patch(identity._id, { personId: target._id });
    for (const edge of await edgesTo(ctx, proposal.userId, proposal._id)) {
      await ctx.db.patch(edge._id, { toPersonId: target._id });
    }
    const offered = await ctx.db
      .query('people')
      .withIndex('by_user_status', (q) =>
        q.eq('userId', proposal.userId).eq('status', 'unverified'),
      )
      .take(GRAPH_READ_LIMIT);
    for (const other of offered) {
      if (other.possiblySameAs === proposal._id) {
        await ctx.db.patch(other._id, { possiblySameAs: target._id });
      }
    }
    await ctx.db.delete(proposal._id);
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'person.confirmed',
      payload: { personId: target._id, person: target.displayName, how: 'same-person' },
      createdAt: now,
    });
    return { personId: target._id };
  },
});

/**
 * Public, owner-level (`assertOwnsPerson` first, then `assertOwnsAgent`): **Different** on a
 * proposal whose name alone matched someone known (C5). It stays a proposal of its own, for
 * Confirm or Dismiss.
 */
export const notTheSame = mutation({
  args: { personId: v.id('people'), agentId: v.id('agents') },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const proposal = decidable(await assertOwnsPerson(ctx, args.personId));
    await assertOwnsAgent(ctx, args.agentId);
    if (proposal.possiblySameAs === undefined || proposal.status !== 'unverified') {
      throw new ConvexError(NOT_OFFERED_AS_SAME);
    }
    await ctx.db.patch(proposal._id, { possiblySameAs: undefined, updatedAt: Date.now() });
    return null;
  },
});

/**
 * Public, owner-level (`assertOwnsPerson` first, then `assertOwnsAgent`): **A different person**
 * on a proposal a lookup matched to a chat user. The match goes and the proposal stays, for
 * Confirm or Dismiss; no later lookup proposes it again, since a lookup runs only when an address
 * first reaches the graph.
 */
export const notThisMatch = mutation({
  args: {
    personId: v.id('people'),
    identityId: v.id('personIdentities'),
    agentId: v.id('agents'),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const proposal = decidable(await assertOwnsPerson(ctx, args.personId));
    await assertOwnsAgent(ctx, args.agentId);
    const identity = await ctx.db.get(args.identityId);
    if (
      proposal.status !== 'unverified' ||
      identity === null ||
      identity.personId !== proposal._id ||
      identity.source !== 'provider-lookup'
    ) {
      throw new ConvexError(NOT_THE_MATCH);
    }
    await ctx.db.delete(identity._id);
    await ctx.db.patch(proposal._id, { updatedAt: Date.now() });
    return null;
  },
});

/** Record a change the manager made to an edge in the tab's employee's record. */
async function recordEdgeChange(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  relationshipId: Id<'relationships'>,
  change: RelationshipChange,
  now: number,
): Promise<void> {
  const edge = await ctx.db.get(relationshipId);
  const person = edge === null ? null : await ctx.db.get(edge.toPersonId);
  if (edge === null || person === null) return;
  await appendEvent(ctx, {
    agentId,
    type: 'relationship.changed',
    payload: {
      relationshipId,
      personId: person._id,
      person: person.displayName,
      change,
      type: edge.type,
    },
    createdAt: now,
  });
}

/** A scope the manager typed, trimmed and bounded, or undefined for none. */
function typedScope(scope: string | undefined): string | undefined {
  const trimmed = scope?.trim();
  if (trimmed === undefined || trimmed === '') return undefined;
  if (trimmed.length > RELATIONSHIP_SCOPE_LIMIT) throw new ConvexError(SCOPE_TOO_LONG);
  return trimmed;
}

/**
 * Public, owner-level (`assertOwnsPerson` first, then `assertOwnsAgent`): the manager adds an edge
 * from the tab's employee to a confirmed person. The manager's own hand is the card (A14), so the
 * edge is `active` and in force from now.
 *
 * @returns The new edge.
 */
export const addRelationship = mutation({
  args: {
    personId: v.id('people'),
    agentId: v.id('agents'),
    type: employeeRelationshipTypeValidator,
    scope: v.optional(v.string()),
  },
  returns: v.id('relationships'),
  handler: async (ctx, args): Promise<Id<'relationships'>> => {
    const person = await assertOwnsPerson(ctx, args.personId);
    await assertOwnsAgent(ctx, args.agentId);
    if (person.status !== 'active') throw new ConvexError(CONFIRM_BEFORE_RELATING);
    const scope = typedScope(args.scope);
    const now = Date.now();
    const relationshipId = await ctx.db.insert('relationships', {
      userId: person.userId,
      fromAgentId: args.agentId,
      toPersonId: person._id,
      type: args.type,
      ...(scope === undefined ? {} : { scope }),
      effectiveFrom: now,
      status: 'active',
      source: 'manager',
      confirmedAt: now,
      createdAt: now,
    });
    await recordEdgeChange(ctx, args.agentId, relationshipId, 'added', now);
    return relationshipId;
  },
});

/** An edge the manager may change: in force, and of the caller's owner scope. */
function standingEdge(edge: Doc<'relationships'>): Doc<'relationships'> {
  if (edge.status !== 'active' || edge.effectiveUntil !== undefined) {
    throw new ConvexError(RELATIONSHIP_ENDED);
  }
  return edge;
}

/**
 * Public, owner-level (`assertOwnsRelationship` first, then `assertOwnsAgent`): the manager edits
 * an edge in force. The edit supersedes it: a new `active` edge carries the new type and scope with
 * `supersedes`, and the old one ends `superseded` now, so a past date still answers what held then.
 *
 * @returns The edge that replaced it.
 */
export const editRelationship = mutation({
  args: {
    relationshipId: v.id('relationships'),
    agentId: v.id('agents'),
    type: relationshipTypeValidator,
    scope: v.optional(v.string()),
  },
  returns: v.id('relationships'),
  handler: async (ctx, args): Promise<Id<'relationships'>> => {
    const edge = standingEdge(await assertOwnsRelationship(ctx, args.relationshipId));
    await assertOwnsAgent(ctx, args.agentId);
    const scope = typedScope(args.scope);
    const now = Date.now();
    await ctx.db.patch(edge._id, { status: 'superseded', effectiveUntil: now });
    const relationshipId = await ctx.db.insert('relationships', {
      userId: edge.userId,
      ...(edge.fromAgentId === undefined ? {} : { fromAgentId: edge.fromAgentId }),
      ...(edge.fromPersonId === undefined ? {} : { fromPersonId: edge.fromPersonId }),
      toPersonId: edge.toPersonId,
      type: args.type,
      ...(scope === undefined ? {} : { scope }),
      effectiveFrom: now,
      status: 'active',
      supersedes: edge._id,
      source: 'manager',
      confirmedAt: now,
      createdAt: now,
    });
    await recordEdgeChange(ctx, args.agentId, relationshipId, 'edited', now);
    return relationshipId;
  },
});

/**
 * Public, owner-level (`assertOwnsRelationship` first, then `assertOwnsAgent`): the manager retires
 * an edge in force. It ends `retired` now and still answers for the dates it held.
 */
export const retireRelationship = mutation({
  args: { relationshipId: v.id('relationships'), agentId: v.id('agents') },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const edge = standingEdge(await assertOwnsRelationship(ctx, args.relationshipId));
    await assertOwnsAgent(ctx, args.agentId);
    const now = Date.now();
    await ctx.db.patch(edge._id, { status: 'retired', effectiveUntil: now });
    await recordEdgeChange(ctx, args.agentId, edge._id, 'retired', now);
    return null;
  },
});

/** Whom a lookup resolved to, as `workItems.requesterPerson` stores it. */
const resolutionValidator = v.union(
  v.object({ kind: v.literal('person'), personId: v.id('people') }),
  v.object({ kind: v.literal('ambiguous'), candidates: v.number() }),
  v.object({ kind: v.literal('unknown') }),
);

/** The confirmed people a set of identities names, by id. */
async function activePeopleOf(
  ctx: QueryCtx,
  scope: string,
  identities: readonly Doc<'personIdentities'>[],
): Promise<Id<'people'>[]> {
  const people = await Promise.all(
    identities.map(async (identity) => await ctx.db.get(identity.personId)),
  );
  return people.flatMap((person) =>
    person !== null && person.userId === scope && person.status === 'active' ? [person._id] : [],
  );
}

/**
 * Whom a provider's printed person is in the owner's graph (a lookup, never an insert): by a
 * recorded identity's id first, then, for an address, the person holding it, then by the display
 * name recorded on an identity of that provider; one confirmed person is the answer, more are
 * `ambiguous`, none `unknown` (Q11: never a guess, never the graph's own names). A proposal the
 * manager has not confirmed answers for nobody. A Slack id answers only through an identity a
 * lookup recorded (RM6: no `users.info`).
 *
 * @param ctx - A query or mutation context.
 * @param scope - The owner scope.
 * @param lookup - What the provider printed.
 */
export async function resolvePerson(
  ctx: QueryCtx,
  scope: string,
  lookup: PersonLookup,
): Promise<PersonResolution<Id<'people'>>> {
  const externalId =
    lookup.provider === 'email'
      ? normaliseManagerAddress(lookup.externalId)
      : lookup.externalId?.trim() || undefined;
  if (externalId !== undefined) {
    const held = (
      await identitiesUnder(ctx, scope, [{ provider: lookup.provider, externalId }])
    ).filter(
      (identity) =>
        lookup.workspaceId === undefined ||
        identity.providerWorkspaceId === undefined ||
        identity.providerWorkspaceId === lookup.workspaceId,
    );
    const addressed =
      lookup.provider === 'email'
        ? await ctx.db
            .query('people')
            .withIndex('by_user_email', (q) => q.eq('userId', scope).eq('primaryEmail', externalId))
            .take(GRAPH_READ_LIMIT)
        : [];
    const byId = resolveMatches([
      ...(await activePeopleOf(ctx, scope, held)),
      ...addressed.filter((person) => person.status === 'active').map((person) => person._id),
    ]);
    if (byId.kind !== 'unknown') return byId;
  }
  const nameKey = personNameKey(lookup.displayName ?? '');
  if (nameKey === '') return { kind: 'unknown' };
  const named = await ctx.db
    .query('personIdentities')
    .withIndex('by_user_provider_display', (q) =>
      q.eq('userId', scope).eq('provider', lookup.provider).eq('displayNameKey', nameKey),
    )
    .take(GRAPH_READ_LIMIT);
  return resolveMatches(await activePeopleOf(ctx, scope, named));
}

/**
 * Public, any signed-in caller (`getCallerOrThrow` first): whom a provider's printed person is in
 * the caller's graph ({@link resolvePerson}). Reads only; writes nothing.
 */
export const personFor = query({
  args: {
    provider: identityProviderValidator,
    externalId: v.optional(v.string()),
    displayName: v.optional(v.string()),
    workspaceId: v.optional(v.string()),
  },
  returns: resolutionValidator,
  handler: async (ctx, args): Promise<PersonResolution<Id<'people'>>> => {
    const caller = await getCallerOrThrow(ctx);
    return await resolvePerson(ctx, ownerScope(caller), args);
  },
});

/** A confirmed person a reader answers with, by name and role. */
export interface PersonAnswer {
  readonly personId: Id<'people'>;
  readonly displayName: string;
  readonly title?: string;
  readonly team?: string;
}

/** The validator of {@link PersonAnswer}. */
const personAnswerFields = {
  personId: v.id('people'),
  displayName: v.string(),
  title: v.optional(v.string()),
  team: v.optional(v.string()),
};

/** A person as a reader answers with them. */
function answerOf(person: Doc<'people'>): PersonAnswer {
  return {
    personId: person._id,
    displayName: person.displayName,
    ...(person.title === undefined ? {} : { title: person.title }),
    ...(person.team === undefined ? {} : { team: person.team }),
  };
}

/** The person an edge points at, when the scope holds them and they are in the given standings. */
async function personAt(
  ctx: QueryCtx,
  scope: string,
  edge: Doc<'relationships'>,
  standings: readonly PersonStatus[],
): Promise<Doc<'people'> | undefined> {
  const person = await ctx.db.get(edge.toPersonId);
  return person !== null && person.userId === scope && standings.includes(person.status)
    ? person
    : undefined;
}

/** One employee's edges under the owner scope (the index leads with the employee, not the owner). */
async function employeeEdges(
  ctx: QueryCtx,
  scope: string,
  agentId: Id<'agents'>,
  types: readonly RelationshipType[],
): Promise<Doc<'relationships'>[]> {
  const pages = await Promise.all(
    types.map(
      async (type) =>
        await ctx.db
          .query('relationships')
          .withIndex('by_from_agent_type', (q) => q.eq('fromAgentId', agentId).eq('type', type))
          .take(GRAPH_READ_LIMIT),
    ),
  );
  return pages.flat().filter((edge) => edge.userId === scope);
}

/** The owner-wide edges of a type: from no employee and no person. */
async function ownerWideEdges(
  ctx: QueryCtx,
  scope: string,
  type: RelationshipType,
): Promise<Doc<'relationships'>[]> {
  const edges = await ctx.db
    .query('relationships')
    .withIndex('by_user_type', (q) => q.eq('userId', scope).eq('type', type))
    .take(GRAPH_READ_LIMIT);
  return edges.filter((edge) => edge.fromAgentId === undefined && edge.fromPersonId === undefined);
}

/** The edge types that say whom an employee works beside. */
const COLLABORATOR_TYPES = ['collaborator', 'adjacent-role', 'dotted-line'] as const;

/** Whether an edge type says whom an employee works beside. */
function isCollaboratorType(type: RelationshipType): type is (typeof COLLABORATOR_TYPES)[number] {
  return (COLLABORATOR_TYPES as readonly RelationshipType[]).includes(type);
}

/** A person an employee works beside, with what the edge says. */
export interface CollaboratorAnswer extends PersonAnswer {
  readonly type: (typeof COLLABORATOR_TYPES)[number];
  readonly scope?: string;
}

/**
 * The confirmed people an employee works beside now, in name order: its collaborator,
 * neighbouring-role and dotted-line edges in force, under the owner scope only. Empty for an
 * employee no owner holds.
 *
 * @param ctx - A query or mutation context.
 * @param agent - The employee.
 * @param now - The moment, in epoch milliseconds.
 */
export async function collaboratorsOfEmployee(
  ctx: QueryCtx,
  agent: Pick<Doc<'agents'>, '_id' | 'userId'>,
  now: number,
): Promise<CollaboratorAnswer[]> {
  const scope = employeeOwnerScope(agent);
  if (scope === undefined) return [];
  const edges = (await employeeEdges(ctx, scope, agent._id, COLLABORATOR_TYPES)).filter((edge) =>
    edgeInForce(edge, now),
  );
  const answers = await Promise.all(
    edges.map(async (edge): Promise<CollaboratorAnswer[]> => {
      const person = await personAt(ctx, scope, edge, ['active']);
      if (person === undefined || !isCollaboratorType(edge.type)) return [];
      return [
        {
          ...answerOf(person),
          type: edge.type,
          ...(edge.scope === undefined ? {} : { scope: edge.scope }),
        },
      ];
    }),
  );
  return answers.flat().sort((left, right) => left.displayName.localeCompare(right.displayName));
}

/**
 * Public, owner-guarded (`assertOwnsAgent` first): whom an employee works beside now
 * ({@link collaboratorsOfEmployee}). Reads only.
 */
export const collaboratorsOf = query({
  args: { agentId: v.id('agents') },
  returns: v.array(
    v.object({
      ...personAnswerFields,
      type: v.union(...COLLABORATOR_TYPES.map((type) => v.literal(type))),
      scope: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args): Promise<CollaboratorAnswer[]> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    return await collaboratorsOfEmployee(ctx, agent, Date.now());
  },
});

/**
 * Whom an employee escalates to now: its own escalation contact in force (the newest), else the
 * owner's escalation contact for everyone in force, else the manager, who is always there (the
 * one-role rulings), with the owner's own person where the graph holds one yet. A `covering` scope
 * keeps only edges covering it.
 */
export type EscalationAnswer =
  | (PersonAnswer & { readonly kind: 'person'; readonly via: 'employee' | 'owner' })
  | { readonly kind: 'manager'; readonly personId: Id<'people'> | null };

/** The newest edge in force among some, for its person. */
async function newestInForce(
  ctx: QueryCtx,
  scope: string,
  edges: readonly Doc<'relationships'>[],
  covering: string | undefined,
  now: number,
): Promise<Doc<'people'> | undefined> {
  const standing = edges
    .filter((edge) => edgeInForce(edge, now))
    .filter((edge) => covering === undefined || scopeCovers(edge.scope, covering))
    .sort((left, right) => right.effectiveFrom - left.effectiveFrom);
  for (const edge of standing) {
    const person = await personAt(ctx, scope, edge, ['active']);
    if (person !== undefined) return person;
  }
  return undefined;
}

/**
 * Whom an employee escalates to now ({@link EscalationAnswer}).
 *
 * @param ctx - A query or mutation context.
 * @param agent - The employee.
 * @param covering - The matter, when the question is about one.
 * @param now - The moment, in epoch milliseconds.
 */
export async function escalationContactOfEmployee(
  ctx: QueryCtx,
  agent: Pick<Doc<'agents'>, '_id' | 'userId'>,
  covering: string | undefined,
  now: number,
): Promise<EscalationAnswer> {
  const scope = employeeOwnerScope(agent);
  if (scope === undefined) return { kind: 'manager', personId: null };
  const own = await newestInForce(
    ctx,
    scope,
    await employeeEdges(ctx, scope, agent._id, ['escalation-contact']),
    covering,
    now,
  );
  if (own !== undefined) return { kind: 'person', via: 'employee', ...answerOf(own) };
  const shared = await newestInForce(
    ctx,
    scope,
    await ownerWideEdges(ctx, scope, 'escalation-contact'),
    covering,
    now,
  );
  if (shared !== undefined) return { kind: 'person', via: 'owner', ...answerOf(shared) };
  const owner = await ctx.db
    .query('people')
    .withIndex('by_user_owner', (q) => q.eq('userId', scope).eq('isOwner', true))
    .first();
  return { kind: 'manager', personId: owner?._id ?? null };
}

/**
 * Public, owner-guarded (`assertOwnsAgent` first): whom an employee escalates to now
 * ({@link escalationContactOfEmployee}). Reads only.
 */
export const escalationContactFor = query({
  args: { agentId: v.id('agents'), covering: v.optional(v.string()) },
  returns: v.union(
    v.object({
      kind: v.literal('person'),
      via: v.union(v.literal('employee'), v.literal('owner')),
      ...personAnswerFields,
    }),
    v.object({ kind: v.literal('manager'), personId: v.union(v.id('people'), v.null()) }),
  ),
  handler: async (ctx, args): Promise<EscalationAnswer> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    return await escalationContactOfEmployee(ctx, agent, args.covering, Date.now());
  },
});

/** A person who approved, or approves, a scope, with the edge's own words and when it began. */
export interface ApproverAnswer extends PersonAnswer {
  readonly scope?: string;
  readonly since: number;
}

/**
 * Who held approval authority over a scope at a moment, newest first: the owner's
 * `approval-authority` edges confirmed and in force then (A17: it informs routing and
 * reorientation and never decides an employee's writes). A person who has since left still
 * answers for a date they held it.
 *
 * @param ctx - A query or mutation context.
 * @param scope - The owner scope.
 * @param covering - The scope asked about.
 * @param at - The moment, in epoch milliseconds.
 */
export async function approversAt(
  ctx: QueryCtx,
  scope: string,
  covering: string,
  at: number,
): Promise<ApproverAnswer[]> {
  const edges = await ctx.db
    .query('relationships')
    .withIndex('by_user_type', (q) =>
      q.eq('userId', scope).eq('type', 'approval-authority').lte('effectiveFrom', at),
    )
    .order('desc')
    .take(GRAPH_READ_LIMIT);
  const held = edges.filter((edge) => edgeHeldAt(edge, at) && scopeCovers(edge.scope, covering));
  const answers = await Promise.all(
    held.map(async (edge): Promise<ApproverAnswer[]> => {
      const person = await personAt(ctx, scope, edge, ['active', 'inactive']);
      return person === undefined
        ? []
        : [
            {
              ...answerOf(person),
              ...(edge.scope === undefined ? {} : { scope: edge.scope }),
              since: edge.effectiveFrom,
            },
          ];
    }),
  );
  return answers.flat();
}

/**
 * Public, any signed-in caller (`getCallerOrThrow` first): who approves a scope in the caller's
 * graph now, or on a past date ({@link approversAt}). Reads only.
 */
export const approverFor = query({
  args: { covering: v.string(), at: v.optional(v.number()) },
  returns: v.array(
    v.object({ ...personAnswerFields, scope: v.optional(v.string()), since: v.number() }),
  ),
  handler: async (ctx, args): Promise<ApproverAnswer[]> => {
    const caller = await getCallerOrThrow(ctx);
    return await approversAt(ctx, ownerScope(caller), args.covering, args.at ?? Date.now());
  },
});

/** One identity of a person, as a reader answers it. */
export interface IdentityAnswer {
  readonly identityId: Id<'personIdentities'>;
  readonly provider: IdentityProvider;
  readonly externalId: string;
  readonly workspaceId?: string;
  readonly displayName?: string;
  /** Whether a provider or the sign-in proved it. */
  readonly verified: boolean;
}

/** The validator of {@link IdentityAnswer}. */
const identityAnswerValidator = v.object({
  identityId: v.id('personIdentities'),
  provider: identityProviderValidator,
  externalId: v.string(),
  workspaceId: v.optional(v.string()),
  displayName: v.optional(v.string()),
  verified: v.boolean(),
});

/** A person's identities under the owner scope, of one provider or all. */
async function identitiesOfPerson(
  ctx: QueryCtx,
  person: Doc<'people'>,
  provider: IdentityProvider | undefined,
): Promise<IdentityAnswer[]> {
  const rows = await ctx.db
    .query('personIdentities')
    .withIndex('by_person', (q) => q.eq('personId', person._id))
    .take(GRAPH_READ_LIMIT);
  return rows
    .filter((row) => row.userId === person.userId)
    .filter((row) => provider === undefined || row.provider === provider)
    .map((row) => ({
      identityId: row._id,
      provider: row.provider,
      externalId: row.externalId,
      ...(row.providerWorkspaceId === undefined ? {} : { workspaceId: row.providerWorkspaceId }),
      ...(row.displayName === undefined ? {} : { displayName: row.displayName }),
      verified: row.verifiedAt !== undefined,
    }));
}

/**
 * Public, owner-level (`assertOwnsPerson` first): a person's identities, of one provider or all.
 * The People tab's row and the audit read them; no prompt does (F9: never identities). Reads
 * only.
 */
export const identityOf = query({
  args: { personId: v.id('people'), provider: v.optional(identityProviderValidator) },
  returns: v.array(identityAnswerValidator),
  handler: async (ctx, args): Promise<IdentityAnswer[]> => {
    const person = await assertOwnsPerson(ctx, args.personId);
    return await identitiesOfPerson(ctx, person, args.provider);
  },
});

/** One piece of evidence as the card shows it. */
const evidenceShownValidator = v.object({ quote: v.string(), where: v.string(), at: v.number() });

/** An edge as the tab shows it. */
const edgeShownValidator = v.object({
  relationshipId: v.id('relationships'),
  type: relationshipTypeValidator,
  scope: v.optional(v.string()),
  since: v.number(),
  /** From the tab's own employee, rather than one for everyone the owner manages. */
  fromEmployee: v.boolean(),
});

/** A chat user a lookup matched a proposal to: the card's "Matches Slack user @{handle}". */
const matchShownValidator = v.object({
  identityId: v.id('personIdentities'),
  handle: v.string(),
});

/** One person waiting on the manager, as the Proposed card shows them. */
const proposalShownValidator = v.object({
  personId: v.id('people'),
  name: v.string(),
  role: v.optional(v.string()),
  status: v.union(v.literal('unverified'), v.literal('active')),
  evidence: v.array(evidenceShownValidator),
  match: v.optional(matchShownValidator),
  possiblySameAs: v.optional(v.object({ personId: v.id('people'), name: v.string() })),
  waiting: v.array(v.object({ type: relationshipTypeValidator, scope: v.optional(v.string()) })),
});

/** One confirmed person, as the tab's People card shows them. */
const confirmedShownValidator = v.object({
  personId: v.id('people'),
  name: v.string(),
  role: v.optional(v.string()),
  confirmedAt: v.optional(v.number()),
  evidence: v.optional(evidenceShownValidator),
  identities: v.array(identityAnswerValidator),
  edges: v.array(edgeShownValidator),
});

/** What the People tab draws from the graph for one employee. */
const employeePeopleValidator = v.object({
  proposals: v.array(proposalShownValidator),
  confirmed: v.array(confirmedShownValidator),
});

/** What {@link forEmployee} answers. */
export type EmployeePeople = Infer<typeof employeePeopleValidator>;

/** A person's role as the card says it: their title, else their team. */
function roleOf(person: Doc<'people'>): string | undefined {
  return person.title ?? person.team;
}

/** Whether an edge concerns the tab's employee: from it, or owner-wide (from nobody). */
function concerns(edge: Doc<'relationships'>, agentId: Id<'agents'>): boolean {
  return (
    edge.fromAgentId === agentId ||
    (edge.fromAgentId === undefined && edge.fromPersonId === undefined)
  );
}

/** One person waiting on the manager, or undefined when nothing of theirs concerns the employee. */
async function proposalShown(
  ctx: QueryCtx,
  person: Doc<'people'>,
  agentId: Id<'agents'>,
): Promise<EmployeePeople['proposals'][number] | undefined> {
  if (person.isOwner === true) return undefined;
  if (person.status !== 'unverified' && person.status !== 'active') return undefined;
  const edges = await edgesTo(ctx, person.userId, person._id);
  const proposed = edges.filter((edge) => edge.status === 'proposed');
  const waiting = proposed.filter((edge) => concerns(edge, agentId));
  // A proposal only another employee's charter named is that employee's tab's to show.
  if (proposed.length > 0 && waiting.length === 0) return undefined;
  if (person.status === 'active' && waiting.length === 0) return undefined;
  const match = (await identitiesOfPerson(ctx, person, 'slack')).find(
    (identity) => identity.verified && identity.displayName !== undefined,
  );
  const offered =
    person.possiblySameAs === undefined ? null : await ctx.db.get(person.possiblySameAs);
  const role = roleOf(person);
  return {
    personId: person._id,
    name: person.displayName,
    ...(role === undefined ? {} : { role }),
    status: person.status,
    evidence: person.evidence
      .slice(-EVIDENCE_SHOWN)
      .map(({ quote, where, at }) => ({ quote, where, at })),
    ...(person.status === 'unverified' && match?.displayName !== undefined
      ? { match: { identityId: match.identityId, handle: match.displayName } }
      : {}),
    ...(offered === null || offered.userId !== person.userId
      ? {}
      : { possiblySameAs: { personId: offered._id, name: offered.displayName } }),
    waiting: waiting.map((edge) => ({
      type: edge.type,
      ...(edge.scope === undefined ? {} : { scope: edge.scope }),
    })),
  };
}

/** One confirmed person with the edges in force that concern the employee. */
async function confirmedShown(
  ctx: QueryCtx,
  person: Doc<'people'>,
  agentId: Id<'agents'>,
  now: number,
): Promise<EmployeePeople['confirmed'][number] | undefined> {
  if (person.isOwner === true || person.status !== 'active') return undefined;
  const edges = (await edgesTo(ctx, person.userId, person._id)).filter(
    (edge) => concerns(edge, agentId) && edgeInForce(edge, now),
  );
  if (edges.length === 0) return undefined;
  const role = roleOf(person);
  const first = person.evidence[0];
  return {
    personId: person._id,
    name: person.displayName,
    ...(role === undefined ? {} : { role }),
    ...(person.confirmedAt === undefined ? {} : { confirmedAt: person.confirmedAt }),
    ...(first === undefined
      ? {}
      : { evidence: { quote: first.quote, where: first.where, at: first.at } }),
    identities: await identitiesOfPerson(ctx, person, undefined),
    edges: edges.map((edge) => ({
      relationshipId: edge._id,
      type: edge.type,
      ...(edge.scope === undefined ? {} : { scope: edge.scope }),
      since: edge.effectiveFrom,
      fromEmployee: edge.fromAgentId === agentId,
    })),
  };
}

/** The people of the graph that concern an employee: the ones its edges reach, and the proposals. */
async function employeePeople(
  ctx: QueryCtx,
  agent: Pick<Doc<'agents'>, '_id' | 'userId'>,
  now: number,
): Promise<EmployeePeople> {
  const scope = employeeOwnerScope(agent);
  if (scope === undefined) return { proposals: [], confirmed: [] };
  const [unverified, active] = await Promise.all(
    (['unverified', 'active'] as const).map(
      async (status) =>
        await ctx.db
          .query('people')
          .withIndex('by_user_status', (q) => q.eq('userId', scope).eq('status', status))
          .take(GRAPH_READ_LIMIT),
    ),
  );
  const people = [...(unverified ?? []), ...(active ?? [])];
  const [proposals, confirmed] = await Promise.all([
    Promise.all(people.map(async (person) => await proposalShown(ctx, person, agent._id))),
    Promise.all(people.map(async (person) => await confirmedShown(ctx, person, agent._id, now))),
  ]);
  const byName = <Row extends { readonly name: string }>(left: Row, right: Row): number =>
    left.name.localeCompare(right.name);
  return {
    proposals: proposals.filter((row) => row !== undefined).sort(byName),
    confirmed: confirmed.filter((row) => row !== undefined).sort(byName),
  };
}

/**
 * Public, owner-guarded (`assertOwnsAgent` first): what the People tab draws from the graph for one
 * employee: the people waiting on the manager (a proposal, or a confirmed person with edges
 * proposed) that concern this employee or everyone, and the confirmed people its edges in force
 * reach. The owner's own row is the Manager card's. Reads only; empty for a graph not kept (mock
 * mode keeps none).
 */
export const forEmployee = query({
  args: { agentId: v.id('agents') },
  returns: employeePeopleValidator,
  handler: async (ctx, args): Promise<EmployeePeople> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    return await employeePeople(ctx, agent, Date.now());
  },
});

/** The validator of one lookup intake asks the graph. */
const lookupValidator = v.object({
  provider: identityProviderValidator,
  externalId: v.optional(v.string()),
  displayName: v.optional(v.string()),
  workspaceId: v.optional(v.string()),
});

/** The first answer of a list of lookups that names somebody, else unknown. */
async function resolveFirst(
  ctx: QueryCtx,
  scope: string,
  lookups: readonly PersonLookup[],
): Promise<PersonResolution<Id<'people'>>> {
  for (const lookup of lookups) {
    const answer = await resolvePerson(ctx, scope, lookup);
    if (answer.kind !== 'unknown') return answer;
  }
  return { kind: 'unknown' };
}

/** Whether two resolutions say the same thing. */
function sameResolution(
  left: PersonResolution<Id<'people'>> | undefined,
  right: PersonResolution<Id<'people'>>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Internal, called by intake's seed once the listed item's row lands (`convex/intakeActions.ts`):
 * whom the item's requester and owner are in the owner's graph ({@link resolvePerson}, a lookup
 * and never an insert), written as `requesterPerson` and `ownerPerson` beside the strings, never
 * in place of them. Fenced as the seed is: nothing once a handover moved the employee to another
 * owner since the sweep read it. Writes only a field whose answer changed.
 *
 * @returns Whether it wrote the row.
 */
export const resolveItemPeople = internalMutation({
  args: {
    agentId: v.id('agents'),
    sourceSystem: v.string(),
    externalId: v.string(),
    startedUnder: v.union(v.string(), v.null()),
    requester: v.optional(v.array(lookupValidator)),
    owner: v.optional(v.array(lookupValidator)),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const agent = await ctx.db.get(args.agentId);
    if (agent === null || (agent.userId ?? null) !== args.startedUnder) return false;
    const scope = employeeOwnerScope(agent);
    if (scope === undefined) return false;
    const item = await ctx.db
      .query('workItems')
      .withIndex('by_agent_extId', (q) =>
        q
          .eq('agentId', agent._id)
          .eq('sourceSystem', args.sourceSystem)
          .eq('externalId', args.externalId),
      )
      .first();
    if (item === null) return false;
    const requesterPerson =
      args.requester === undefined ? undefined : await resolveFirst(ctx, scope, args.requester);
    const ownerPerson =
      args.owner === undefined ? undefined : await resolveFirst(ctx, scope, args.owner);
    const changes = {
      ...(requesterPerson === undefined || sameResolution(item.requesterPerson, requesterPerson)
        ? {}
        : { requesterPerson }),
      ...(ownerPerson === undefined || sameResolution(item.ownerPerson, ownerPerson)
        ? {}
        : { ownerPerson }),
    };
    if (Object.keys(changes).length === 0) return false;
    await ctx.db.patch(item._id, changes);
    return true;
  },
});

/** What {@link recordOwnerChatIdentity} came to. */
const ownerChatIdentityOutcome = v.union(
  v.literal('added'),
  v.literal('held'),
  v.literal('held-by-another'),
  v.literal('no-owner-person'),
  v.literal('not-the-owner'),
);

/**
 * Internal, called by the Slack probe once the connection is recorded (`convex/surfaceActions.ts`,
 * the identity region): the manager `users.lookupByEmail` found is the owner's own person's Slack
 * identity in that workspace (`source: 'provider-lookup'`, verified at the lookup). A card whose
 * Slack user changed is reconciled: the owner's looked-up identities in the workspace that name
 * another user go, since Slack answers one user per address there. Only for an employee managed
 * under the owner's verified address (13-K: a typed address from before wave 9 looked up whoever
 * it is); nothing for an owner with no row yet (`ensureOwner` adds it from the card at the next
 * sign-in), and nothing when another person already holds the id (a merge is the manager's).
 */
export const recordOwnerChatIdentity = internalMutation({
  args: {
    agentId: v.id('agents'),
    workspaceId: v.optional(v.string()),
    userId: v.string(),
    name: v.optional(v.string()),
    lookedUpAt: v.number(),
  },
  returns: ownerChatIdentityOutcome,
  handler: async (ctx, args): Promise<Infer<typeof ownerChatIdentityOutcome>> => {
    const agent = await ctx.db.get(args.agentId);
    const scope = agent === null ? undefined : employeeOwnerScope(agent);
    if (agent === null || scope === undefined) return 'no-owner-person';
    const owner = await ctx.db
      .query('people')
      .withIndex('by_user_owner', (q) => q.eq('userId', scope).eq('isOwner', true))
      .first();
    if (owner === null) return 'no-owner-person';
    if (
      owner.primaryEmail === undefined ||
      !sameManagerAddress(agent.bossEmail, owner.primaryEmail)
    ) {
      return 'not-the-owner';
    }
    const own = await ctx.db
      .query('personIdentities')
      .withIndex('by_person', (q) => q.eq('personId', owner._id))
      .take(GRAPH_READ_LIMIT);
    for (const stale of own) {
      if (
        stale.userId === scope &&
        stale.provider === 'slack' &&
        stale.source === 'provider-lookup' &&
        stale.providerWorkspaceId === args.workspaceId &&
        stale.externalId !== args.userId
      ) {
        await ctx.db.delete(stale._id);
      }
    }
    const held = (
      await identitiesUnder(ctx, scope, [{ provider: 'slack', externalId: args.userId }])
    ).filter((identity) => identity.providerWorkspaceId === args.workspaceId);
    if (held.some((identity) => identity.personId === owner._id)) return 'held';
    if (held.length > 0) return 'held-by-another';
    await ctx.db.insert('personIdentities', {
      userId: scope,
      personId: owner._id,
      provider: 'slack',
      ...(args.workspaceId === undefined ? {} : { providerWorkspaceId: args.workspaceId }),
      externalId: args.userId,
      ...(args.name === undefined
        ? {}
        : { displayName: args.name, displayNameKey: personNameKey(args.name) }),
      verifiedAt: args.lookedUpAt,
      source: 'provider-lookup',
      createdAt: args.lookedUpAt,
    });
    return 'added';
  },
});
