import { v, type Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { normaliseManagerAddress } from '../src/agent/manager-address';
import {
  matchProposal,
  type HeldIdentity,
  type HeldPerson,
  type ProposedIdentity,
} from '../src/people/matching';
import { personNameKey, type PeopleSource, type RelationshipType } from '../src/people/vocabulary';

/*
 * What sources propose into an owner's people graph (wave 13, 13-P; the wave file's section 5.2;
 * A1, A14, C5): the approved charter, the documentation's people extraction, a provider's lookup
 * and a handover's move. A proposal is a person written `unverified`, or an `active` person with
 * `proposed` edges; only Confirm on the People tab's card (`convex/people.ts`) makes either a fact.
 * Matching is by identity or address (`src/people/matching.ts`), never by name.
 */

/** How many rows of one owner's graph one read takes: far more than the people an owner has. */
export const GRAPH_READ_LIMIT = 500;

/** How many pieces of evidence the card shows for one person, newest last. */
export const EVIDENCE_SHOWN = 3;

/** The validator of a source's evidence for a person or an edge. */
export const evidenceValidator = v.object({
  quote: v.string(),
  where: v.string(),
  at: v.number(),
  sourceId: v.optional(v.id('docSources')),
  ref: v.optional(v.string()),
});

/** One piece of a source's evidence. */
export type Evidence = Infer<typeof evidenceValidator>;

/** An identity a source gave for a proposed person, with what the lookup said of it. */
export interface ProposedIdentityRow extends ProposedIdentity {
  readonly displayName?: string;
  /** When a provider's lookup proved it. */
  readonly verifiedAt?: number;
}

/** An edge a source proposes to the person: from an employee, or owner-wide (from nobody). */
export interface ProposedEdge {
  readonly type: RelationshipType;
  readonly fromAgentId?: Id<'agents'>;
  readonly scope?: string;
}

/** A person a source proposes into the owner's graph, with its words and the edges it implies. */
export interface ProposedPerson {
  readonly name: string;
  readonly email?: string;
  readonly title?: string;
  readonly team?: string;
  readonly identities: readonly ProposedIdentityRow[];
  readonly evidence: readonly Evidence[];
  readonly edges: readonly ProposedEdge[];
}

/** Where a proposal came from: the source and its own reference. */
export interface ProposalOrigin {
  readonly source: PeopleSource;
  readonly sourceRef?: string;
}

/**
 * What a proposal came to: a new proposal, one offered as possibly someone known (C5), evidence
 * merged into a person by identity or address, the same words again, or nothing for a person the
 * manager dismissed.
 */
export type ProposalOutcome =
  | {
      readonly kind: 'proposed' | 'possibly' | 'merged' | 'repeat';
      readonly personId: Id<'people'>;
    }
  | { readonly kind: 'dismissed'; readonly personId: Id<'people'> };

/** The owner's rows a proposal could match: by its name key, its address and its identities. */
async function candidatesFor(
  ctx: QueryCtx,
  scope: string,
  proposal: ProposedPerson,
): Promise<{ people: Doc<'people'>[]; identities: Doc<'personIdentities'>[] }> {
  const address = normaliseManagerAddress(proposal.email);
  const nameKey = personNameKey(proposal.name);
  const [named, addressed, identities] = await Promise.all([
    nameKey === ''
      ? []
      : ctx.db
          .query('people')
          .withIndex('by_user_name', (q) => q.eq('userId', scope).eq('nameKey', nameKey))
          .take(GRAPH_READ_LIMIT),
    address === undefined
      ? []
      : ctx.db
          .query('people')
          .withIndex('by_user_email', (q) => q.eq('userId', scope).eq('primaryEmail', address))
          .take(GRAPH_READ_LIMIT),
    identitiesUnder(ctx, scope, [
      ...proposal.identities,
      ...(address === undefined ? [] : [{ provider: 'email' as const, externalId: address }]),
    ]),
  ]);
  const held = new Map<Id<'people'>, Doc<'people'>>(
    [...named, ...addressed].map((person) => [person._id, person]),
  );
  for (const identity of identities) {
    if (held.has(identity.personId)) continue;
    const person = await ctx.db.get(identity.personId);
    if (person !== null && person.userId === scope) held.set(person._id, person);
  }
  return { people: [...held.values()], identities };
}

/** The owner's identities under each of the given providers and ids. */
export async function identitiesUnder(
  ctx: QueryCtx,
  scope: string,
  wanted: readonly Pick<ProposedIdentity, 'provider' | 'externalId'>[],
): Promise<Doc<'personIdentities'>[]> {
  const pages = await Promise.all(
    wanted.map(
      async (identity) =>
        await ctx.db
          .query('personIdentities')
          .withIndex('by_user_provider_external', (q) =>
            q
              .eq('userId', scope)
              .eq('provider', identity.provider)
              .eq('externalId', identity.externalId),
          )
          .take(GRAPH_READ_LIMIT),
    ),
  );
  return pages.flat();
}

/** A person row as matching reads it. */
function heldPerson(person: Doc<'people'>): HeldPerson<Id<'people'>> {
  return {
    id: person._id,
    nameKey: person.nameKey,
    ...(person.primaryEmail === undefined ? {} : { primaryEmail: person.primaryEmail }),
    status: person.status,
    quotes: person.evidence.map((item) => item.quote),
  };
}

/** An identity row as matching reads it. */
function heldIdentity(identity: Doc<'personIdentities'>): HeldIdentity<Id<'people'>> {
  return {
    personId: identity.personId,
    provider: identity.provider,
    externalId: identity.externalId,
    ...(identity.providerWorkspaceId === undefined
      ? {}
      : { workspaceId: identity.providerWorkspaceId }),
  };
}

/** Evidence with the new pieces added, each quote from each place once. */
export function withEvidence(held: readonly Evidence[], added: readonly Evidence[]): Evidence[] {
  const merged = [...held];
  for (const item of added) {
    if (!merged.some((kept) => kept.quote === item.quote && kept.where === item.where)) {
      merged.push(item);
    }
  }
  return merged;
}

/** Record the proposal's identities on a person, each unless the owner holds it already. */
async function addIdentities(
  ctx: MutationCtx,
  scope: string,
  personId: Id<'people'>,
  identities: readonly ProposedIdentityRow[],
  origin: ProposalOrigin,
  now: number,
): Promise<void> {
  for (const identity of identities) {
    const held = await identitiesUnder(ctx, scope, [identity]);
    if (held.some((row) => row.providerWorkspaceId === identity.workspaceId)) continue;
    await ctx.db.insert('personIdentities', {
      userId: scope,
      personId,
      provider: identity.provider,
      ...(identity.workspaceId === undefined ? {} : { providerWorkspaceId: identity.workspaceId }),
      externalId: identity.externalId,
      ...(identity.displayName === undefined
        ? {}
        : {
            displayName: identity.displayName,
            displayNameKey: personNameKey(identity.displayName),
          }),
      ...(identity.verifiedAt === undefined ? {} : { verifiedAt: identity.verifiedAt }),
      source: origin.source,
      createdAt: now,
    });
  }
}

/** Whether two edges say the same thing: one type, from one employee, covering one scope. */
function sameEdge(edge: Doc<'relationships'>, proposed: ProposedEdge): boolean {
  return (
    edge.type === proposed.type &&
    edge.fromAgentId === proposed.fromAgentId &&
    edge.fromPersonId === undefined &&
    personNameKey(edge.scope ?? '') === personNameKey(proposed.scope ?? '')
  );
}

/** Propose the edges a source implies to a person, each unless one standing already says it. */
async function proposeEdges(
  ctx: MutationCtx,
  scope: string,
  personId: Id<'people'>,
  proposal: ProposedPerson,
  origin: ProposalOrigin,
  now: number,
): Promise<void> {
  const held = await ctx.db
    .query('relationships')
    .withIndex('by_user_to', (q) => q.eq('userId', scope).eq('toPersonId', personId))
    .take(GRAPH_READ_LIMIT);
  const standing = held.filter((edge) => edge.status === 'proposed' || edge.status === 'active');
  for (const edge of proposal.edges) {
    if (standing.some((kept) => sameEdge(kept, edge))) continue;
    await ctx.db.insert('relationships', {
      userId: scope,
      ...(edge.fromAgentId === undefined ? {} : { fromAgentId: edge.fromAgentId }),
      toPersonId: personId,
      type: edge.type,
      ...(edge.scope === undefined ? {} : { scope: edge.scope }),
      effectiveFrom: now,
      status: 'proposed',
      source: origin.source,
      ...(origin.sourceRef === undefined ? {} : { sourceRef: origin.sourceRef }),
      evidence: [...proposal.evidence],
      createdAt: now,
    });
  }
}

/**
 * Merge a proposal into a person the graph holds, as evidence: the new words, an address, title or
 * team the person has none of, identities nobody holds, and the edges it implies as proposals. A
 * fact the manager confirmed is never changed by it.
 */
async function mergeProposal(
  ctx: MutationCtx,
  scope: string,
  person: Doc<'people'>,
  proposal: ProposedPerson,
  origin: ProposalOrigin,
  now: number,
): Promise<void> {
  const address = normaliseManagerAddress(proposal.email);
  await ctx.db.patch(person._id, {
    evidence: withEvidence(person.evidence, proposal.evidence),
    ...(person.primaryEmail === undefined && address !== undefined
      ? { primaryEmail: address }
      : {}),
    ...(person.title === undefined && proposal.title !== undefined
      ? { title: proposal.title }
      : {}),
    ...(person.team === undefined && proposal.team !== undefined ? { team: proposal.team } : {}),
    updatedAt: now,
  });
  await addIdentities(ctx, scope, person._id, proposal.identities, origin, now);
  await proposeEdges(ctx, scope, person._id, proposal, origin, now);
}

/** Write a new proposal: the person `unverified`, its identities and its proposed edges. */
async function insertProposal(
  ctx: MutationCtx,
  scope: string,
  proposal: ProposedPerson,
  origin: ProposalOrigin,
  now: number,
  possiblySameAs: Id<'people'> | undefined,
): Promise<Id<'people'>> {
  const displayName = proposal.name.trim();
  const address = normaliseManagerAddress(proposal.email);
  const personId = await ctx.db.insert('people', {
    userId: scope,
    displayName,
    nameKey: personNameKey(displayName),
    ...(address === undefined ? {} : { primaryEmail: address }),
    ...(proposal.title === undefined ? {} : { title: proposal.title }),
    ...(proposal.team === undefined ? {} : { team: proposal.team }),
    status: 'unverified',
    source: origin.source,
    ...(origin.sourceRef === undefined ? {} : { sourceRef: origin.sourceRef }),
    evidence: [...proposal.evidence],
    ...(possiblySameAs === undefined ? {} : { possiblySameAs }),
    createdAt: now,
    updatedAt: now,
  });
  await addIdentities(ctx, scope, personId, proposal.identities, origin, now);
  await proposeEdges(ctx, scope, personId, proposal, origin, now);
  return personId;
}

/**
 * Propose a person into an owner's graph (A1, A14): a person matching by identity or address takes
 * the proposal as evidence, a name alone writes a new proposal offered as possibly that person
 * (C5), and anything else a new proposal. Nothing is ever written `active`: Confirm on the card is
 * the only way a proposal becomes a fact. A person the manager dismissed is not proposed again on
 * the same grounds.
 *
 * @param ctx - The proposing mutation's context.
 * @param scope - The owner scope (`ownerScope` or `employeeOwnerScope`).
 * @param proposal - The proposed person.
 * @param origin - The source and its reference.
 * @param now - The proposal's time.
 */
export async function proposePersonInTransaction(
  ctx: MutationCtx,
  scope: string,
  proposal: ProposedPerson,
  origin: ProposalOrigin,
  now: number,
): Promise<ProposalOutcome> {
  const candidates = await candidatesFor(ctx, scope, proposal);
  const match = matchProposal(
    {
      name: proposal.name,
      ...(proposal.email === undefined ? {} : { email: proposal.email }),
      identities: proposal.identities,
      quotes: proposal.evidence.map((item) => item.quote),
    },
    candidates.people.map(heldPerson),
    candidates.identities.map(heldIdentity),
  );
  switch (match.kind) {
    case 'dismissed':
      return { kind: 'dismissed', personId: match.personId };
    case 'same':
    case 'repeat': {
      const person = candidates.people.find((held) => held._id === match.personId);
      if (person !== undefined) await mergeProposal(ctx, scope, person, proposal, origin, now);
      return { kind: match.kind === 'same' ? 'merged' : 'repeat', personId: match.personId };
    }
    case 'possibly':
      return {
        kind: 'possibly',
        personId: await insertProposal(ctx, scope, proposal, origin, now, match.personId),
      };
    case 'new':
      return {
        kind: 'proposed',
        personId: await insertProposal(ctx, scope, proposal, origin, now, undefined),
      };
    default: {
      const unknown: never = match;
      throw new Error(`unhandled proposal match ${String(unknown)}`);
    }
  }
}
