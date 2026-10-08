import { v, type Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import { appendEvent } from './eventLog';
import { employeeOwnerScope, ownerScope } from './ownership';
import { retireEdgesOf } from './reset';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { proposedValues, sameValues } from '../src/people/proposed-change';
import { normaliseManagerAddress } from '../src/agent/manager-address';
import { transcriptTurns, type TranscriptTurn } from '../src/agent/transcript-turns';
import { charterPeople, charterQuote, type CharterPerson } from '../src/people/charter-people';
import { managerQuoteFor } from '../src/people/evidence';
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

/** The `ref` of the evidence that records an address the manager said is someone else's. */
const NOT_THEIR_ADDRESS_REF = 'not-their-address:';

/**
 * The evidence a person keeps of an address the manager said is someone else's, on **A different
 * person** (W13-R8): shown on the card with the rest, and read so no source and no lookup gives
 * the address back. Kept on the evidence the row already has; a field of its own is for the next
 * schema step.
 *
 * @param address - The normalised address.
 * @param at - When the manager said so.
 */
export function notTheirAddressEvidence(address: string, at: number): Evidence {
  return {
    quote: `${address} is someone else's address`,
    where: 'you, on A different person',
    at,
    ref: `${NOT_THEIR_ADDRESS_REF}${address}`,
  };
}

/**
 * The addresses a person's evidence marks as someone else's ({@link notTheirAddressEvidence}): the
 * marker the `people-not-their-addresses` pass lifts into `people.notTheirAddresses`. Read by that
 * pass alone since 14-FX; it goes with the marker in the release after (N10).
 */
export function notTheirAddresses(person: Pick<Doc<'people'>, 'evidence'>): ReadonlySet<string> {
  return new Set(
    person.evidence.flatMap((item) =>
      item.ref?.startsWith(NOT_THEIR_ADDRESS_REF) === true
        ? [item.ref.slice(NOT_THEIR_ADDRESS_REF.length)]
        : [],
    ),
  );
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
  // Standing: proposed, in force, or dismissed (retired before it ever held), which the manager
  // has answered and is not asked again.
  const standing = held.filter(
    (edge) =>
      edge.status === 'proposed' ||
      edge.status === 'active' ||
      (edge.status === 'retired' && edge.effectiveUntil === undefined),
  );
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
 * The change a source proposes to a person the manager confirmed (W13-R3): the title, team and
 * address it gives that differ from the confirmed ones, with the words that gave them; nothing
 * when it gives none that differ, has no words, or proposes what the person already holds as its
 * proposed change. The owner's own row is the Manager card's and is offered no change.
 */
function proposedChangeOf(
  person: Doc<'people'>,
  proposal: ProposedPerson,
  address: string | undefined,
  origin: ProposalOrigin,
  now: number,
): NonNullable<Doc<'people'>['proposedChange']> | undefined {
  if (person.isOwner === true) return undefined;
  const values = proposedValues(person, {
    title: proposal.title,
    team: proposal.team,
    primaryEmail: address,
  });
  const evidence = proposal.evidence[0];
  if (values === undefined || evidence === undefined) return undefined;
  if (person.proposedChange !== undefined && sameValues(person.proposedChange, values)) {
    return undefined;
  }
  return { ...values, source: origin.source, evidence, proposedAt: now };
}

/**
 * Merge a proposal into a person the graph holds, as evidence: the new words, identities nobody
 * holds, the edges it implies as proposals, and, while the person still waits on Confirm, an
 * address, title or team it has none of. A person the manager confirmed (active, or inactive
 * since) keeps the address, title and team as confirmed: a source never writes one, even where the
 * person has none (W13-R3), since the People block prints them to the planner and the executor;
 * the source's words stay as evidence, and what it gives that differs is kept as the person's
 * proposed change, for the manager to take or dismiss on the card.
 */
async function mergeProposal(
  ctx: MutationCtx,
  scope: string,
  person: Doc<'people'>,
  proposal: ProposedPerson,
  origin: ProposalOrigin,
  now: number,
): Promise<void> {
  const notTheirs = new Set(person.notTheirAddresses ?? []);
  const given = normaliseManagerAddress(proposal.email);
  const address = given !== undefined && notTheirs.has(given) ? undefined : given;
  const fills = person.status === 'unverified';
  const change = fills ? undefined : proposedChangeOf(person, proposal, address, origin, now);
  await ctx.db.patch(person._id, {
    evidence: withEvidence(person.evidence, proposal.evidence),
    ...(change === undefined ? {} : { proposedChange: change }),
    ...(fills && person.primaryEmail === undefined && address !== undefined
      ? { primaryEmail: address }
      : {}),
    ...(fills && person.title === undefined && proposal.title !== undefined
      ? { title: proposal.title }
      : {}),
    ...(fills && person.team === undefined && proposal.team !== undefined
      ? { team: proposal.team }
      : {}),
    updatedAt: now,
  });
  // An address the manager said is someone else's is not brought back as an identity either.
  const identities = proposal.identities.filter(
    (identity) =>
      identity.provider !== 'email' ||
      !notTheirs.has(normaliseManagerAddress(identity.externalId) ?? identity.externalId),
  );
  await addIdentities(ctx, scope, person._id, identities, origin, now);
  // The owner is the manager: no edge ends at their own row (the one-role rulings).
  if (person.isOwner !== true) await proposeEdges(ctx, scope, person._id, proposal, origin, now);
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

/** How many of an employee's one-to-one sessions are read to find the one a charter came from. */
const SESSIONS_SEARCHED = 20;

/** How many superseded versions are walked back to the draft the one-to-one wrote. */
const VERSIONS_WALKED = 50;

/** The one-to-one a charter's first version was drafted from, with when it closed. */
async function oneToOneOf(
  ctx: QueryCtx,
  charter: Doc<'charters'>,
): Promise<{ turns: TranscriptTurn[]; at: number } | undefined> {
  let first = charter;
  for (let hops = 0; first.supersedes !== undefined && hops < VERSIONS_WALKED; hops += 1) {
    const previous = await ctx.db.get(first.supersedes);
    if (previous === null) break;
    first = previous;
  }
  const sessions = await ctx.db
    .query('voiceSessions')
    .withIndex('by_agent', (q) => q.eq('agentId', charter.agentId))
    .order('desc')
    .take(SESSIONS_SEARCHED);
  const session = sessions.find((candidate) => candidate.charterId === first._id);
  if (session === undefined) return undefined;
  const turns =
    session.turns !== undefined && session.turns.length > 0
      ? session.turns.map(({ speaker, text }): TranscriptTurn => ({ speaker, text }))
      : transcriptTurns(session.transcriptText ?? '');
  return {
    turns,
    at: session.conversationEndedAt ?? session.endedAt ?? session.startedAt,
  };
}

/** One charter person as a proposal from the employee, with the best words there are for them. */
function charterProposal(
  person: CharterPerson,
  agentId: Id<'agents'>,
  charter: Doc<'charters'>,
  oneToOne: { turns: readonly TranscriptTurn[]; at: number } | undefined,
  now: number,
): { proposal: ProposedPerson; origin: ProposalOrigin } {
  const quote = oneToOne === undefined ? undefined : managerQuoteFor(person.name, oneToOne.turns);
  const evidence: Evidence =
    quote !== undefined && oneToOne !== undefined
      ? { quote, where: ONE_TO_ONE_WHERE, at: oneToOne.at }
      : {
          quote: charterQuote(person),
          where: `charter version ${charter.version}`,
          at: charter.approvedAt ?? now,
        };
  return {
    proposal: {
      name: person.name,
      identities: [],
      evidence: [evidence],
      edges: person.edges.map((edge) => ({
        type: edge.type,
        fromAgentId: agentId,
        ...(edge.scope === undefined ? {} : { scope: edge.scope }),
      })),
    },
    origin: { source: quote === undefined ? 'charter' : 'one-to-one', sourceRef: charter._id },
  };
}

/** Where the one-to-one's words were said, as the card says it. */
export const ONE_TO_ONE_WHERE = 'the one-to-one';

/**
 * Whether a proposal may quote the one-to-one: at the charter's approval it may; at a handover's
 * move it may not, since the conversation was the old manager's own and left with them (decision
 * 1 (a) of the wave 9 review), so the charter's own line is the evidence.
 */
export type OneToOneQuoting = 'quote' | 'charter-only';

/**
 * Propose the people an approved charter names into its employee's owner's graph (A1): one per
 * named collaborator and neighbouring role, each with the manager's own sentence from the
 * one-to-one where it can be found and may be quoted, else the charter's line, and the edge from
 * the employee. Safe to run again: the same words are a repeat. Nothing for an employee no owner
 * holds.
 *
 * @param ctx - The mutation's context.
 * @param agent - The employee whose charter it is, keyed by the owner whose graph it proposes into.
 * @param charter - The approved charter.
 * @param now - The proposal's time.
 * @param quoting - Whether the one-to-one may be quoted.
 * @returns What each person came to.
 */
export async function proposeCharterPeople(
  ctx: MutationCtx,
  agent: Pick<Doc<'agents'>, '_id' | 'userId'>,
  charter: Doc<'charters'>,
  now: number,
  quoting: OneToOneQuoting,
): Promise<ProposalOutcome[]> {
  const scope = employeeOwnerScope(agent);
  if (scope === undefined) return [];
  const people = charterPeople(charter.body);
  if (people.length === 0) return [];
  const oneToOne = quoting === 'quote' ? await oneToOneOf(ctx, charter) : undefined;
  const outcomes: ProposalOutcome[] = [];
  for (const person of people) {
    const { proposal, origin } = charterProposal(person, agent._id, charter, oneToOne, now);
    const outcome = await proposePersonInTransaction(ctx, scope, proposal, origin, now);
    outcomes.push(outcome);
    if (outcome.kind !== 'proposed' && outcome.kind !== 'possibly') continue;
    await appendEvent(ctx, {
      agentId: agent._id,
      type: 'person.proposed',
      payload: {
        personId: outcome.personId,
        person: person.name,
        via: quoting === 'quote' ? 'charter' : 'handover',
        ...(outcome.kind === 'possibly' ? { possiblySame: true } : {}),
      },
      createdAt: now,
    });
  }
  return outcomes;
}

/**
 * Internal, scheduled by `onboarding.postCharterApproval` in real mode: propose the people an
 * approved charter names ({@link proposeCharterPeople}). A charter that is no longer approved, or
 * not the employee's, proposes nobody. Writes `people`, `personIdentities` and `relationships`.
 *
 * @returns How many people it proposed afresh.
 */
export const proposeFromCharter = internalMutation({
  args: { agentId: v.id('agents'), charterId: v.id('charters') },
  returns: v.object({ proposed: v.number() }),
  handler: async (ctx, args): Promise<{ proposed: number }> => {
    const [agent, charter] = await Promise.all([
      ctx.db.get(args.agentId),
      ctx.db.get(args.charterId),
    ]);
    if (agent === null || charter === null || charter.agentId !== agent._id || !charter.approved) {
      return { proposed: 0 };
    }
    const outcomes = await proposeCharterPeople(ctx, agent, charter, Date.now(), 'quote');
    return {
      proposed: outcomes.filter(
        (outcome) => outcome.kind === 'proposed' || outcome.kind === 'possibly',
      ).length,
    };
  },
});

/** The standings of a working agreement a move ends: one in force, or one still proposed. */
const AGREEMENTS_ENDED_AT_A_MOVE = ['active', 'proposed'] as const;

/**
 * The people graph at a handover's move (wave 13, 13-P; the wave file's section 5.2), in the
 * move's transaction: the employee's edges in the old owner's graph are retired
 * (`retireEdgesOf`), its work items let go of whom intake resolved their strings to there, the
 * old owner's working agreements that bind the employee alone are retired
 * (their preferences were never the new manager's to approve, A14; the ones for every employee
 * stay theirs), and in real mode the carried charter's people are proposed afresh in the new
 * owner's graph on the charter's own words, for the new manager to confirm. Nothing of the old
 * owner's graph moves.
 *
 * @param ctx - The move's mutation context.
 * @param move - The employee, the two owners' keys and the move's time.
 * @returns How many edges and agreements it retired, and how many people it proposed.
 */
export async function moveGraphInTransaction(
  ctx: MutationCtx,
  move: {
    readonly agentId: Id<'agents'>;
    readonly fromOwnerKey: string;
    readonly toOwnerKey: string;
    readonly now: number;
  },
): Promise<{ edgesRetired: number; agreementsRetired: number; peopleProposed: number }> {
  const edgesRetired = await retireEdgesOf(ctx, move.agentId, move.now);
  // Whom intake resolved an item's requester and owner to is a person of the old owner's graph;
  // the strings stay, and the new owner's graph answers again from them.
  for await (const item of ctx.db
    .query('workItems')
    .withIndex('by_agent', (q) => q.eq('agentId', move.agentId))) {
    if (item.requesterPerson === undefined && item.ownerPerson === undefined) continue;
    await ctx.db.patch(item._id, { requesterPerson: undefined, ownerPerson: undefined });
  }
  const fromScope = ownerScope({ ownerKey: move.fromOwnerKey });
  let agreementsRetired = 0;
  for (const status of AGREEMENTS_ENDED_AT_A_MOVE) {
    const bound = await ctx.db
      .query('workingAgreements')
      .withIndex('by_user_agent_status', (q) =>
        q.eq('userId', fromScope).eq('agentId', move.agentId).eq('status', status),
      )
      .take(GRAPH_READ_LIMIT);
    for (const agreement of bound) {
      await ctx.db.patch(agreement._id, {
        status: 'retired',
        ...(status === 'active' ? { effectiveUntil: move.now } : {}),
      });
      agreementsRetired += 1;
    }
  }
  if (SURFACE_MODE !== 'real') return { edgesRetired, agreementsRetired, peopleProposed: 0 };
  const charters = await ctx.db
    .query('charters')
    .withIndex('by_agent', (q) => q.eq('agentId', move.agentId))
    .order('desc')
    .take(VERSIONS_WALKED);
  const carried = charters.find((charter) => charter.approved);
  if (carried === undefined) return { edgesRetired, agreementsRetired, peopleProposed: 0 };
  const outcomes = await proposeCharterPeople(
    ctx,
    { _id: move.agentId, userId: move.toOwnerKey },
    carried,
    move.now,
    'charter-only',
  );
  return {
    edgesRetired,
    agreementsRetired,
    peopleProposed: outcomes.filter((outcome) => outcome.kind !== 'dismissed').length,
  };
}

/** The validator of one person a page grounds (`src/people/extraction.ts`). */
export const extractedPersonValidator = v.object({
  name: v.string(),
  ref: v.string(),
  where: v.string(),
  quote: v.string(),
  email: v.optional(v.string()),
  title: v.optional(v.string()),
  team: v.optional(v.string()),
  approves: v.array(v.string()),
  escalationFor: v.array(v.string()),
});

/** The source and completed run an extraction is for. */
const extractionArgs = { sourceId: v.id('docSources'), runId: v.id('docSyncRuns') };

/**
 * The source and run when the run is the source's newest completed generation, no sync is
 * running, and its people have not been extracted yet; else null, which makes the extraction moot.
 */
async function extractableGeneration(
  ctx: QueryCtx,
  sourceId: Id<'docSources'>,
  runId: Id<'docSyncRuns'>,
): Promise<{ source: Doc<'docSources'>; run: Doc<'docSyncRuns'> } | null> {
  const [source, run] = await Promise.all([ctx.db.get(sourceId), ctx.db.get(runId)]);
  if (
    source === null ||
    run === null ||
    source.activeSyncId !== undefined ||
    source.lastCompletedSyncId !== run._id ||
    source.peopleExtractionSyncId === run._id ||
    run.sourceId !== source._id ||
    run.state !== 'completed'
  ) {
    return null;
  }
  return { source, run };
}

/** The most bytes one window of the extraction's read takes, as discovery's. */
const EXTRACTION_WINDOW_BYTES = 4 * 1024 * 1024;

/**
 * Internal, for `peopleExtractionActions.extractSource`: one window of a completed generation's
 * pages, read with the cursor so a source of any size is covered once. Null once a newer
 * generation, a running sync or an earlier extraction of this run made the read moot.
 */
export const extractionContext = internalQuery({
  args: { ...extractionArgs, cursor: v.union(v.string(), v.null()), numItems: v.number() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    source: Doc<'docSources'>;
    pages: Doc<'docPages'>[];
    continueCursor: string;
    isDone: boolean;
  } | null> => {
    const generation = await extractableGeneration(ctx, args.sourceId, args.runId);
    if (generation === null) return null;
    const window = await ctx.db
      .query('docPages')
      .withIndex('by_source', (q) => q.eq('sourceId', args.sourceId))
      .paginate({
        cursor: args.cursor,
        numItems: args.numItems,
        maximumBytesRead: EXTRACTION_WINDOW_BYTES,
      });
    return {
      source: generation.source,
      pages: window.page,
      continueCursor: window.continueCursor,
      isDone: window.isDone,
    };
  },
});

/** One grounded person of a page as a proposal, with the owner-wide edges its quote states. */
function documentationProposal(
  person: Infer<typeof extractedPersonValidator>,
  sourceId: Id<'docSources'>,
  now: number,
): ProposedPerson {
  return {
    name: person.name,
    ...(person.email === undefined ? {} : { email: person.email }),
    ...(person.title === undefined ? {} : { title: person.title }),
    ...(person.team === undefined ? {} : { team: person.team }),
    identities: [],
    evidence: [{ quote: person.quote, where: person.where, at: now, sourceId, ref: person.ref }],
    edges: [
      ...person.approves.map((scope): ProposedEdge => ({ type: 'approval-authority', scope })),
      ...person.escalationFor.map((scope): ProposedEdge => ({ type: 'escalation-contact', scope })),
    ],
  };
}

/**
 * Internal, for `peopleExtractionActions.extractSource`: propose the people a completed
 * generation's pages ground ({@link proposePersonInTransaction}, source `documentation`), each
 * with its page quote and the owner-wide approval and escalation edges its quote states, and,
 * for the generation's last chunk, stamp the source's four extraction fields. Fenced as the read
 * was: nothing for a generation that is no longer the one to extract.
 *
 * @returns Whether it applied, and the people proposed or merged whose address a lookup may match.
 */
export const applyExtraction = internalMutation({
  args: {
    ...extractionArgs,
    fingerprint: v.string(),
    people: v.array(extractedPersonValidator),
    /** A chunk before the generation's last (W13-R9): proposed, the source not yet stamped. */
    partial: v.optional(v.literal(true)),
  },
  returns: v.object({ applied: v.boolean(), withAddress: v.array(v.id('people')) }),
  handler: async (ctx, args): Promise<{ applied: boolean; withAddress: Id<'people'>[] }> => {
    const generation = await extractableGeneration(ctx, args.sourceId, args.runId);
    if (generation === null) return { applied: false, withAddress: [] };
    const scope = ownerScope({ ownerKey: generation.source.userId });
    const now = Date.now();
    const withAddress = new Set<Id<'people'>>();
    for (const person of args.people) {
      const outcome = await proposePersonInTransaction(
        ctx,
        scope,
        documentationProposal(person, args.sourceId, now),
        { source: 'documentation', sourceRef: `${args.sourceId}:${person.ref}` },
        now,
      );
      if (outcome.kind !== 'dismissed' && person.email !== undefined) {
        withAddress.add(outcome.personId);
      }
    }
    if (args.partial !== true) {
      await ctx.db.patch(args.sourceId, {
        peopleExtractionSyncId: args.runId,
        peopleExtractionFingerprint: args.fingerprint,
        lastPeopleExtractionAt: now,
        lastPeopleExtractionError: undefined,
        updatedAt: now,
      });
    }
    return { applied: true, withAddress: [...withAddress] };
  },
});

/**
 * Internal: stamp a generation whose pages are the ones the last extraction read (the same
 * fingerprint) as extracted, with no model call.
 *
 * @returns Whether it stamped the source.
 */
export const markExtractionUnchanged = internalMutation({
  args: { ...extractionArgs, fingerprint: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const generation = await extractableGeneration(ctx, args.sourceId, args.runId);
    if (generation === null) return false;
    if (generation.source.peopleExtractionFingerprint !== args.fingerprint) return false;
    const now = Date.now();
    await ctx.db.patch(args.sourceId, {
      peopleExtractionSyncId: args.runId,
      lastPeopleExtractionAt: now,
      lastPeopleExtractionError: undefined,
      updatedAt: now,
    });
    return true;
  },
});

/** The longest failure reason kept on the source. */
const EXTRACTION_ERROR_LIMIT = 500;

/**
 * Internal: record why an extraction failed on the source, leaving its sync id where it was so the
 * next completed generation tries again, and its last proposals standing.
 *
 * @returns Whether it recorded the failure.
 */
export const recordExtractionFailure = internalMutation({
  args: { ...extractionArgs, reason: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const generation = await extractableGeneration(ctx, args.sourceId, args.runId);
    if (generation === null) return false;
    await ctx.db.patch(args.sourceId, {
      lastPeopleExtractionError: args.reason.slice(0, EXTRACTION_ERROR_LIMIT),
      updatedAt: Date.now(),
    });
    return true;
  },
});

/** A connected card of the owner's that can look a person up by address. */
export interface LookupCard {
  readonly surfaceId: Id<'surfaces'>;
  readonly kind: 'slack' | 'linear';
  readonly credentialId: Id<'credentials'>;
  readonly endpoint?: string;
  readonly workspaceId?: string;
}

/** The validator of {@link LookupCard}. */
const lookupCardValidator = v.object({
  surfaceId: v.id('surfaces'),
  kind: v.union(v.literal('slack'), v.literal('linear')),
  credentialId: v.id('credentials'),
  endpoint: v.optional(v.string()),
  workspaceId: v.optional(v.string()),
});

/** One person to look up: their address and the cards that can look it up. */
const lookupTargetValidator = v.object({
  personId: v.id('people'),
  address: v.string(),
  cards: v.array(lookupCardValidator),
});

/** How many of an owner's employees, and cards of one employee, a lookup's read takes. */
const OWNER_CARDS_READ = 200;

/**
 * The cards of an owner's employees that can look a person up by address, one per kind and
 * workspace: a connected Slack card (`users.lookupByEmail`, which every Slack probe requires) and a
 * connected Linear card whose approval allows `get_user`. The employee's own connection, never the
 * owner's or another vendor's.
 */
async function lookupCardsOf(ctx: QueryCtx, scope: string): Promise<LookupCard[]> {
  const employees = await ctx.db
    .query('agents')
    .withIndex('by_userId', (q) => q.eq('userId', scope))
    .take(OWNER_CARDS_READ);
  const cards = (
    await Promise.all(
      employees.map(
        async (agent) =>
          await ctx.db
            .query('surfaces')
            .withIndex('by_agent', (q) => q.eq('agentId', agent._id))
            .take(OWNER_CARDS_READ),
      ),
    )
  ).flat();
  const chosen = new Map<string, LookupCard>();
  for (const card of cards) {
    if (card.verdict !== 'connected' || card.credentialId === undefined) continue;
    const kind =
      card.class === 'chat' && card.path === 'documented-api'
        ? 'slack'
        : card.class === 'kanban' &&
            card.path === 'mcp' &&
            card.toolAllowlist?.includes('get_user') === true
          ? 'linear'
          : undefined;
    if (kind === undefined) continue;
    const key = `${kind}/${card.providerWorkspaceId ?? ''}`;
    if (chosen.has(key)) continue;
    chosen.set(key, {
      surfaceId: card._id,
      kind,
      credentialId: card.credentialId,
      ...(card.endpoint === undefined ? {} : { endpoint: card.endpoint }),
      ...(card.providerWorkspaceId === undefined ? {} : { workspaceId: card.providerWorkspaceId }),
    });
  }
  return [...chosen.values()];
}

/**
 * Internal, for `peopleLookupActions.lookUpAddresses`: each person still in the graph with an
 * address, with the cards of their owner's employees that can look the address up.
 */
export const lookupTargets = internalQuery({
  args: { personIds: v.array(v.id('people')) },
  returns: v.array(lookupTargetValidator),
  handler: async (ctx, args): Promise<Infer<typeof lookupTargetValidator>[]> => {
    const targets: Infer<typeof lookupTargetValidator>[] = [];
    const cardsByScope = new Map<string, LookupCard[]>();
    for (const personId of args.personIds) {
      const person = await ctx.db.get(personId);
      if (person === null || person.status === 'dismissed' || person.primaryEmail === undefined) {
        continue;
      }
      let cards = cardsByScope.get(person.userId);
      if (cards === undefined) {
        cards = await lookupCardsOf(ctx, person.userId);
        cardsByScope.set(person.userId, cards);
      }
      if (cards.length === 0) continue;
      targets.push({ personId, address: person.primaryEmail, cards: [...cards] });
    }
    return targets;
  },
});

/** The validator of an identity a lookup found. */
const foundIdentityValidator = v.object({
  provider: v.union(v.literal('slack'), v.literal('linear')),
  externalId: v.string(),
  workspaceId: v.optional(v.string()),
  displayName: v.optional(v.string()),
});

/**
 * Internal, for `peopleLookupActions.lookUpAddresses`: record what a lookup by a person's address
 * found as their identities (`source: 'provider-lookup'`, verified now), and whether it failed
 * (`lookupFailedAt`, W13-R25). An identity on a proposal
 * answers for nobody until Confirm (readers read confirmed people only); one another person
 * already holds is left for the manager to merge.
 *
 * @returns How many identities it added.
 */
export const recordLookups = internalMutation({
  args: {
    personId: v.id('people'),
    /** The address looked up: a lookup of one the person no longer holds records nothing (W13-R8). */
    address: v.optional(v.string()),
    found: v.array(foundIdentityValidator),
    /**
     * How the lookup ended (W13-R25): `failed` marks the person (`lookupFailedAt`) once its asks
     * are spent or a provider refused, `answered` clears a mark; absent while it is still asked.
     */
    outcome: v.optional(v.union(v.literal('answered'), v.literal('failed'))),
  },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    const person = await ctx.db.get(args.personId);
    if (person === null || person.status === 'dismissed') return 0;
    if (
      args.address !== undefined &&
      (person.primaryEmail !== args.address ||
        (person.notTheirAddresses ?? []).includes(args.address))
    ) {
      return 0;
    }
    const now = Date.now();
    if (args.outcome === 'failed') {
      await ctx.db.patch(person._id, { lookupFailedAt: now });
    } else if (args.outcome === 'answered' && person.lookupFailedAt !== undefined) {
      await ctx.db.patch(person._id, { lookupFailedAt: undefined });
    }
    let added = 0;
    let offerable: Id<'people'> | undefined;
    for (const identity of args.found) {
      const held = (await identitiesUnder(ctx, person.userId, [identity])).filter(
        (row) => row.providerWorkspaceId === identity.workspaceId,
      );
      // Another person holds it: the proposal is offered as possibly them, for the manager's merge
      // (W13-R25), never given the identity.
      const holder = held.find((row) => row.personId !== person._id)?.personId;
      if (holder !== undefined && person.status === 'unverified') offerable ??= holder;
      if (held.length > 0) continue;
      await ctx.db.insert('personIdentities', {
        userId: person.userId,
        personId: person._id,
        provider: identity.provider,
        ...(identity.workspaceId === undefined
          ? {}
          : { providerWorkspaceId: identity.workspaceId }),
        externalId: identity.externalId,
        ...(identity.displayName === undefined
          ? {}
          : {
              displayName: identity.displayName,
              displayNameKey: personNameKey(identity.displayName),
            }),
        verifiedAt: now,
        source: 'provider-lookup',
        createdAt: now,
      });
      added += 1;
    }
    // Never the owner's own row (the manager is never a merge target, the one-role rulings), nor a
    // person the manager dismissed.
    const holder = offerable === undefined ? null : await ctx.db.get(offerable);
    if (
      holder !== null &&
      holder.isOwner !== true &&
      holder.status !== 'dismissed' &&
      person.possiblySameAs === undefined
    ) {
      await ctx.db.patch(person._id, { possiblySameAs: holder._id, updatedAt: now });
    }
    return added;
  },
});
