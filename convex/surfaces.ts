import { ConvexError, v } from 'convex/values';
import {
  action,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import { internal } from './_generated/api';
import { assertOwnsAgent, assertOwnsAgentAction } from './ownership';
import { grantScopeInTransaction } from './agents';
import { assertRealMode } from '../src/lib/surface-mode';
import type { Doc, Id } from './_generated/dataModel';
import { browserComponentRefusal, withBrowserComponentState } from '../src/surfaces/browser';
import {
  documentedSystemIdentity,
  sameDocumentedSystem,
  sameSystemForHostlessMention,
  stableSlug,
  type DocumentedSystemIdentity,
} from '../src/docs/system-discovery';
import { sameSurfaceSystem, surfaceIdentity } from '../src/surfaces/identity';
import { surfaceSlug } from '../src/surfaces/slug';
import {
  redraftPlansDraftedWithout,
  reevaluatePendingInTransaction,
  resendDecisionsAfterManagerChange,
} from './work';
import schema from './schema';
import { scheduleNextStep } from './workLoop';
import { presentScopeDrift, restatedScope, type ScopeValue } from '../src/surfaces/intake-scope';
import {
  extractDocumentedSystemOrder,
  orderSurfaceWaterfall,
  waterfallEntry,
} from '../src/surfaces/waterfall';
import { cardPageRefs } from '../src/docs/card-pages';
import { PROBE_LEASE_MS, probeInFlight } from '../src/surfaces/probe-lease';
import { agentReadsSource } from '../src/docs/agent-sources';
import { isManagerLookupFailure } from '../src/surfaces/manager-lookup';
import { latestRejoins, type LastRejoin } from './channelRejoins';
import { appendEvent, eventsOfType } from './eventLog';
import { endAccessAtSource } from './sourceRevocation';
import { sharedByOrganisation } from '../src/surfaces/revokers/plan';
import type { AccessEnd } from '../src/surfaces/access-identity';
import { isEventOf, type EventOf, type EventType } from '../src/events/contract';
import { agentZone, expiryNoticeDay, expiryNoticeDue } from '../src/lib/zone';
import { SURFACE_ACCESS_DEFAULT_DAYS, SURFACE_ACCESS_MAX_DAYS } from '../src/surfaces/access';
import { actsAsAtUpgrade } from '../src/surfaces/access-identity';
import {
  installedBotIssuer,
  isIssuedAs,
  KEPT_APP_CONNECTION_REVOKED,
  slackActsAs,
  slackClientSecretIssuer,
} from '../src/surfaces/identity-issuers/slack';
import { ORGANISATION_HOLDER, ORGANISATION_OWNER_KEY } from '../src/lib/organisation-key';
import { organisationSystemOf, servedByIssuer } from '../src/surfaces/access-request';
import { activeConnectionFor, revokedConnectionsAmong } from './organisationConnectionReads';
import {
  listedCardIdentity,
  type CardIdentity,
  type ListedIdentity,
} from '../src/surfaces/card-identity';
import { surfaceHandoverOf, type SurfaceHandover } from '../src/surfaces/handover';
import { assertCredentialOfOwner, credentialOwnerRefusal } from './handoverFence';
import { isDay0FixedEndpoint } from '../src/surfaces/fixed-endpoints';
import { log } from '../src/lib/logger';
import { stampRecheckDueOnSurfaces } from './skillVersions';
import { allowlistChangedReason, reconnectedReason } from '../src/work/skill-controls';

const MAX_LADDER_PATHS = 3;
const MAX_PROBE_ATTEMPTS = 12;
const MAX_DISCOVERY_EVIDENCE = 64;

type ProbeAttempt = NonNullable<Doc<'surfaces'>['probeAttempts']>[number];
type DiscoveryEvidence = NonNullable<Doc<'surfaces'>['discoveryEvidence']>[number];

export interface DocumentedSystemSeed {
  slug: string;
  displayName: string;
  class: string;
  ref: string;
  quote: string;
  url?: string;
  evidence?: Array<{ displayName: string; ref: string; quote: string; url?: string }>;
  identity?: DocumentedSystemIdentity;
}

export interface CharterSystemSeed {
  name: string;
  class: string;
  whereMentioned: string;
}

function withProbeAttempt(surface: Doc<'surfaces'>, attempt: ProbeAttempt): ProbeAttempt[] {
  return [...(surface.probeAttempts ?? []), attempt].slice(-MAX_PROBE_ATTEMPTS);
}

/**
 * Convert a declared system name to its stable per-agent key: the one slug
 * the planner, the evaluator and the corrections compute from the same name.
 */
export { surfaceSlug };

/**
 * Whether a surface is the charter-only row an earlier build minted for this mention.
 *
 * Before charter seeding went through the identity matcher, a mention with no
 * slug-equal surface always minted its own row, so a row that carries the
 * mention's slug and nothing but charter evidence is that legacy alias.
 */
function isLegacyCharterAlias(surface: Doc<'surfaces'>, system: CharterSystemSeed): boolean {
  const evidence = surface.discoveryEvidence ?? [];
  return (
    surface.slug === surfaceSlug(system.name) &&
    evidence.length > 0 &&
    evidence.every((item): boolean => item.kind === 'charter')
  );
}

/**
 * Resolve the surfaces a charter mention stands for.
 *
 * A surface carrying the mention's own slug is that mention whatever class the
 * extractor assigned, as it was before the identity matcher. Otherwise the
 * hostless-mention rule applies. When several surfaces match and one of them
 * is the legacy charter-only alias, the documented rows are the system and the
 * alias is set aside rather than reported as an ambiguity.
 */
function charterMatches(
  surfaces: readonly Doc<'surfaces'>[],
  system: CharterSystemSeed,
): Doc<'surfaces'>[] {
  const slug = surfaceSlug(system.name);
  const mention = documentedSystemIdentity({
    name: system.name,
    quotes: [system.whereMentioned],
  });
  const matches = surfaces.filter(
    (surface) =>
      surface.slug === slug ||
      sameSystemForHostlessMention(system.class, mention, surface.class, surfaceIdentity(surface)),
  );
  if (matches.length < 2) return matches;
  const documented = matches.filter((surface) => !isLegacyCharterAlias(surface, system));
  return documented.length > 0 ? documented : matches;
}

async function recordCharterMatchAmbiguity(
  ctx: MutationCtx,
  args: {
    agentId: Id<'agents'>;
    system: CharterSystemSeed;
    matches: readonly Doc<'surfaces'>[];
    now: number;
  },
): Promise<void> {
  await appendEvent(ctx, {
    agentId: args.agentId,
    type: 'surface.charter-match-ambiguous',
    payload: {
      namedSystem: args.system.name,
      class: args.system.class,
      candidateSlugs: [...new Set(args.matches.map((surface) => surface.slug))].sort(),
    },
    createdAt: args.now,
  });
}

async function attachCharterEvidence(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  system: CharterSystemSeed,
  now: number,
  firstSeenAt = now,
): Promise<DiscoveryEvidence[]> {
  const prior = surface.discoveryEvidence ?? [];
  const charterEvidence = prior.find((item): boolean => item.kind === 'charter');
  const evidence: DiscoveryEvidence = {
    kind: 'charter',
    ref: 'manager 1:1',
    quote: system.whereMentioned,
    current: true,
    firstSeenAt: charterEvidence?.firstSeenAt ?? firstSeenAt,
    lastSeenAt: now,
  };
  const discoveryEvidence = charterEvidence
    ? prior.map((item): DiscoveryEvidence => (item.kind === 'charter' ? evidence : item))
    : [...prior, evidence];
  if (discoveryEvidence.length > MAX_DISCOVERY_EVIDENCE) {
    throw new Error('Surface discovery provenance exceeds 64 sources.');
  }
  await ctx.db.patch(surface._id, { discoveryEvidence });
  await requeueWorkAwaitingAlias(ctx, surface, surfaceSlug(system.name), now);
  return discoveryEvidence;
}

/** Add manager provenance to legacy rows without replaying charter seeding. */
export async function backfillCharterProvenance(
  ctx: MutationCtx,
  args: {
    agentId: Id<'agents'>;
    namedSystems: readonly CharterSystemSeed[];
    now: number;
  },
): Promise<number> {
  const surfaces = await ctx.db
    .query('surfaces')
    .withIndex('by_agent', (index) => index.eq('agentId', args.agentId))
    .collect();
  let updated = 0;
  for (const system of args.namedSystems) {
    if (system.class === 'docs') continue;
    const matches = charterMatches(surfaces, system);
    if (matches.length > 1) {
      await recordCharterMatchAmbiguity(ctx, {
        agentId: args.agentId,
        system,
        matches,
        now: args.now,
      });
      continue;
    }
    const surface = matches[0];
    if (!surface) continue;
    const prior = surface.discoveryEvidence ?? [];
    if (prior.some((item): boolean => item.kind === 'charter')) continue;
    const discoveryEvidence = await attachCharterEvidence(
      ctx,
      surface,
      system,
      args.now,
      surface.createdAt,
    );
    surface.discoveryEvidence = discoveryEvidence;
    updated += 1;
  }
  return updated;
}

/**
 * A surface as the Surfaces tab's card reads it: the stored row, its browser-driven state read
 * against this deployment's component, why a proposed card cannot be approved now, and what has
 * changed on the pages its approved scope quotes.
 */
export interface ListedSurface extends Omit<Doc<'surfaces'>, 'pendingAuthorisation'> {
  /**
   * An authorisation the manager started and has not finished: when it started and when its link
   * lapses, never its sealed verifier, nonce or client (11-AC's cockpit item 7).
   */
  readonly pendingAuthorisation?: { readonly startedAt: number; readonly stateExpiresAt: number };
  /** Whom the card acts as, or will once connected (cockpit item 1; `listedCardIdentity`). */
  readonly identity: CardIdentity;
  /** Whom the organisation's active connection for its system would make it act as, if one covers it. */
  readonly connectionIdentity?: CardIdentity;
  /**
   * Why `approve` would refuse this card now (a documented intake queue changed, or its browser
   * component is absent), so the card disables Approve with the reason (E-63). Only on a
   * proposed card.
   */
  readonly approvalRefusal?: string;
  /**
   * Which approved intake values their pages no longer state, and what to do about it, in the
   * manager's words (D D4). Absent while every value is still stated.
   */
  readonly scopeChange?: string;
  /** The latest re-join a Slack renewal made for the card (11-AC's item 5; `latestRejoins`). */
  readonly lastRejoin?: LastRejoin;
  /**
   * True on a card holding no credential whose organisation connection an administrator revoked:
   * renewing it brings nothing back until IT connects the system again (the pre-tag second pass).
   */
  readonly connectionRevoked?: true;
}

/**
 * The most pages the cards' order and drift read, and a soft cap on their bytes (D D4): a page is
 * read only while the pages already kept leave room for it, so the set never passes the cap. A
 * scope page past either bound reads as no longer stated, which disables Approve with the reason;
 * the scope pages are named first (`cardPageRefs`), so only an employee whose cards cite more
 * than the bounds hold ever meets it.
 */
const CARD_PAGE_LIMIT = 100;
const CARD_PAGE_BYTES = 8 * 1024 * 1024;

/** The most documentation sources of one owner the cards' pages are looked up in. */
const CARD_SOURCE_LIMIT = 100;

/** The most surfaces of one employee the cards are listed from. */
const CARD_SURFACE_LIMIT = 1_000;

/** Why a proposed card whose documented intake queue its page no longer states cannot be approved. */
const INTAKE_QUEUE_CHANGED =
  'A documented intake queue changed; reject this card and re-run orientation before approval.';

/**
 * Read the pages some surface cards read (each scope value's page, then each system's evidence
 * pages, `cardPageRefs`), by reference, from the sources the employee reads, within the card
 * bounds, in the order the sources and their pages were created. The one reader of card pages:
 * the list, the approval and the probe (`docSources.cardPagesForSurface`) read through it.
 *
 * @param agent - The employee, whose readable sources bound the refs.
 * @param surfaces - The cards whose pages are read.
 */
export async function readCardPages(
  ctx: QueryCtx,
  agent: Doc<'agents'>,
  surfaces: readonly Doc<'surfaces'>[],
): Promise<Doc<'docPages'>[]> {
  const owner = agent.userId;
  if (owner === undefined) return [];
  const sources = (
    await ctx.db
      .query('docSources')
      .withIndex('by_user', (index) => index.eq('userId', owner))
      .take(CARD_SOURCE_LIMIT)
  ).filter((source) => agentReadsSource(agent, source._id));
  const rank = new Map(sources.map((source, index) => [String(source._id), index]));
  const encoder = new TextEncoder();
  const pages: Array<Doc<'docPages'>> = [];
  let bytes = 0;
  for (const { sourceId, ref } of cardPageRefs(surfaces, new Set(rank.keys()), CARD_PAGE_LIMIT)) {
    const page = await ctx.db
      .query('docPages')
      .withIndex('by_source_ref', (index) =>
        index.eq('sourceId', sourceId as Id<'docSources'>).eq('ref', ref),
      )
      .unique();
    if (!page) continue;
    const size = encoder.encode(page.markdown).length;
    if (bytes + size > CARD_PAGE_BYTES) break;
    bytes += size;
    pages.push(page);
  }
  return pages.sort(
    (left, right): number =>
      (rank.get(String(left.sourceId)) ?? 0) - (rank.get(String(right.sourceId)) ?? 0) ||
      left._creationTime - right._creationTime,
  );
}

/**
 * Why a proposed card's documented intake queue no longer supports its approval, judged by value
 * from the pages the cards already read (`restatedScope`, the rule the drift line uses), or
 * undefined when every queue value is still stated. A line re-spaced, reflowed or given a remark
 * beside the value states the same queue.
 *
 * @param drift - The scope values `restatedScope` found no longer stated.
 */
function intakeQueueRefusal(drift: readonly ScopeValue[]): string | undefined {
  return drift.some((value): boolean => value.sourceId !== undefined)
    ? INTAKE_QUEUE_CHANGED
    : undefined;
}

/**
 * Whom each card acts as, by the one rule (`listedCardIdentity`; 11-AC's cockpit item 1): the
 * organisation's active connection for each card's system read once per system, and the source of
 * the credential each card holds.
 *
 * @param ctx - The query's reader.
 * @param surfaces - The employee's cards.
 */
async function identitiesOf(
  ctx: Pick<QueryCtx, 'db'>,
  surfaces: readonly Doc<'surfaces'>[],
): Promise<Map<Id<'surfaces'>, ListedIdentity>> {
  const connections = new Map<string, Doc<'organisationConnections'> | null>();
  const hasPublicUrl = publicUrlConfigured();
  const identities = new Map<Id<'surfaces'>, ListedIdentity>();
  for (const surface of surfaces) {
    const system = organisationSystemOf(surface);
    if (system !== undefined && !connections.has(system)) {
      connections.set(system, await activeConnectionFor(ctx, system));
    }
    const connection = system === undefined ? null : (connections.get(system) ?? null);
    const held = surface.credentialId === undefined ? null : await ctx.db.get(surface.credentialId);
    identities.set(
      surface._id,
      listedCardIdentity({
        card: surface,
        ...(connection !== null ? { connection } : {}),
        ...(held !== null ? { heldCredentialSource: held.source } : {}),
        hasPublicUrl,
      }),
    );
  }
  return identities;
}

/**
 * List one owned agent's surfaces as their cards read them.
 *
 * Public, owner-guarded; reads, writes nothing. The rows come in the documented order (the
 * systems table on the pages the cards cite, then class), each with its browser component's
 * state, whom it acts as (`identity`, and `connectionIdentity` where IT's connection covers it),
 * the refusal `approve` would give now on a proposed card (`approvalRefusal`), and what changed on
 * its approved scope's pages (`scopeChange`). The pages are read here, once, and both the refusal
 * and the change are judged from them; the browser is never sent them.
 */
export const listForAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<ListedSurface[]> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const surfaces = await ctx.db
      .query('surfaces')
      .withIndex('by_agent', (index) => index.eq('agentId', args.agentId))
      .take(CARD_SURFACE_LIMIT);
    const identities = await identitiesOf(ctx, surfaces);
    const rejoins = await latestRejoins(ctx, args.agentId);
    const revoked = await revokedConnectionsAmong(
      ctx,
      surfaces.flatMap((surface) =>
        surface.organisationConnectionId === undefined ? [] : [surface.organisationConnectionId],
      ),
    );
    const pages = await readCardPages(ctx, agent, surfaces);
    const documented = extractDocumentedSystemOrder(
      pages.map((page) => waterfallEntry({ title: page.title, content: page.markdown })),
    );
    const refusal = browserComponentRefusal(process.env.DAY0_BROWSER_MCP_URL);
    return orderSurfaceWaterfall(surfaces, documented).map((surface): ListedSurface => {
      const listed = withBrowserComponentState(surface, refusal);
      const drift = listed.intakeScope ? restatedScope(listed.intakeScope, pages).drift : [];
      const scopeChange = listed.intakeScope
        ? presentScopeDrift(listed.intakeScope, drift, {
            // Only a proposed card offers Reject on the page.
            canReject: listed.verdict === 'proposed',
          })
        : undefined;
      const refused =
        listed.verdict === 'proposed'
          ? (intakeQueueRefusal(drift) ?? browserRefusal(listed))
          : undefined;
      const identity = identities.get(surface._id);
      if (identity === undefined) throw new Error('A listed card has no identity read.');
      const rejoin = rejoins.get(surface._id);
      const connectionRevoked =
        surface.credentialId === undefined &&
        surface.organisationConnectionId !== undefined &&
        revoked.has(surface.organisationConnectionId);
      const { pendingAuthorisation, ...card } = listed;
      return {
        ...card,
        ...(pendingAuthorisation === undefined
          ? {}
          : {
              pendingAuthorisation: {
                startedAt: pendingAuthorisation.startedAt,
                stateExpiresAt: pendingAuthorisation.stateExpiresAt,
              },
            }),
        ...identity,
        ...(refused === undefined ? {} : { approvalRefusal: refused }),
        ...(scopeChange === undefined ? {} : { scopeChange }),
        ...(rejoin === undefined ? {} : { lastRejoin: rejoin }),
        ...(connectionRevoked ? { connectionRevoked: true as const } : {}),
      };
    });
  },
});

/**
 * Seed one declared row per work system named in the approved charter.
 *
 * A system of class `docs` is a documentation location: it is configured on
 * the documentation page and read from there, never discovered, connected or
 * polled, so it stays on the charter card and gets no surface.
 */
export const seedFromCharter = internalMutation({
  args: {
    agentId: v.id('agents'),
    namedSystems: v.array(
      v.object({ name: v.string(), class: v.string(), whereMentioned: v.string() }),
    ),
  },
  handler: async (ctx, args): Promise<Id<'surfaces'>[]> => {
    const surfaceIds: Id<'surfaces'>[] = [];
    const now = Date.now();
    for (const system of args.namedSystems) {
      const declared = await declareCharterSystem(ctx, { agentId: args.agentId, system, now });
      if (declared.surfaceId) surfaceIds.push(declared.surfaceId);
    }
    return surfaceIds;
  },
});

/**
 * Declare the surface one charter-named system stands for.
 *
 * A system of class `docs` gets no surface. A mention that resolves to one
 * existing surface refreshes that surface's charter evidence; a mention that
 * resolves to several is recorded as ambiguous and left alone; anything else
 * inserts a declared row. Charter approval seeds every named system through
 * here, and a charter amendment that adds one system calls it for that
 * system alone.
 *
 * Args:
 *   ctx: Mutation context.
 *   args: The agent, the system as the charter names it, and the time.
 *
 * Returns:
 *   The surface the system now stands on, and whether this call created it.
 */
export async function declareCharterSystem(
  ctx: MutationCtx,
  args: { agentId: Id<'agents'>; system: CharterSystemSeed; now: number },
): Promise<{ surfaceId: Id<'surfaces'> | null; created: boolean }> {
  const { system, now } = args;
  if (system.class === 'docs') return { surfaceId: null, created: false };
  const surfaces = await ctx.db
    .query('surfaces')
    .withIndex('by_agent', (index) => index.eq('agentId', args.agentId))
    .collect();
  const matches = charterMatches(surfaces, system);
  if (matches.length > 1) {
    await recordCharterMatchAmbiguity(ctx, { agentId: args.agentId, system, matches, now });
    return { surfaceId: null, created: false };
  }
  const existing = matches[0];
  if (existing) {
    await attachCharterEvidence(ctx, existing, system, now);
    return { surfaceId: existing._id, created: false };
  }
  const evidence: DiscoveryEvidence = {
    kind: 'charter',
    ref: 'manager 1:1',
    quote: system.whereMentioned,
    current: true,
    firstSeenAt: now,
    lastSeenAt: now,
  };
  const surfaceId = await ctx.db.insert('surfaces', {
    agentId: args.agentId,
    slug: surfaceSlug(system.name),
    displayName: system.name,
    class: system.class,
    verdict: 'declared',
    whereFound: [{ ref: 'manager 1:1', quote: system.whereMentioned }],
    discoveryEvidence: [evidence],
    credentialLanded: false,
    createdAt: now,
  });
  return { surfaceId, created: true };
}

/**
 * Retire the charter's claim on the surfaces a named system stood for.
 *
 * The charter evidence is marked no longer current; the surface, its verdict
 * and any documentation evidence stay, because the system may still be
 * documented and connected. Nothing is deleted.
 *
 * Args:
 *   ctx: Mutation context.
 *   args: The agent, the system as the charter named it, and the time.
 *
 * Returns:
 *   How many surfaces had their charter evidence retired.
 */
export async function retireCharterSystem(
  ctx: MutationCtx,
  args: { agentId: Id<'agents'>; system: CharterSystemSeed; now: number },
): Promise<number> {
  const surfaces = await ctx.db
    .query('surfaces')
    .withIndex('by_agent', (index) => index.eq('agentId', args.agentId))
    .collect();
  let retired = 0;
  for (const surface of charterMatches(surfaces, args.system)) {
    const evidence = surface.discoveryEvidence ?? [];
    if (!evidence.some((item): boolean => item.kind === 'charter' && item.current)) continue;
    await ctx.db.patch(surface._id, {
      discoveryEvidence: evidence.map(
        (item): DiscoveryEvidence =>
          item.kind === 'charter' && item.current
            ? { ...item, current: false, lastSeenAt: args.now }
            : item,
      ),
    });
    retired += 1;
  }
  return retired;
}

/** Reconcile one source's current system names into an agent's surface set. */
export async function reconcileDocumentedSystems(
  ctx: MutationCtx,
  args: {
    agentId: Id<'agents'>;
    sourceId: Id<'docSources'>;
    systems: readonly DocumentedSystemSeed[];
    now: number;
  },
): Promise<{ created: number; updated: number; retired: number; scheduled: number }> {
  const agent = await ctx.db.get(args.agentId);
  if (!agent) return { created: 0, updated: 0, retired: 0, scheduled: 0 };
  const surfaces = await ctx.db
    .query('surfaces')
    .withIndex('by_agent', (index) => index.eq('agentId', args.agentId))
    .collect();
  const bySlug = new Map(
    surfaces.map((surface): [string, Doc<'surfaces'>] => [surface.slug, surface]),
  );
  const resolved = new Map<string, DocumentedSystemSeed>();
  for (const system of args.systems) {
    const identity =
      system.identity ??
      documentedSystemIdentity({
        name: system.displayName,
        quotes: (system.evidence ?? [system]).map((item) => item.quote),
      });
    const sameIdentity = (surface: Doc<'surfaces'>): boolean =>
      sameDocumentedSystem(
        system.class,
        identity,
        surface.class,
        documentedSystemIdentity({
          name: surface.displayName,
          quotes: (surface.discoveryEvidence ?? []).map((item) => item.quote),
          endpoints: surface.endpoint ? [surface.endpoint] : [],
        }),
      );
    const direct = bySlug.get(system.slug);
    const matches = surfaces.filter(sameIdentity);
    const existing =
      direct && sameIdentity(direct) ? direct : matches.length === 1 ? matches[0] : undefined;
    const host = stableSlug(identity.hosts[0] ?? '');
    const slug = existing?.slug ?? (direct ? `${system.slug}-${host || 'system'}` : system.slug);
    const prior = resolved.get(slug);
    const evidence = [
      ...(prior?.evidence ?? (prior ? [prior] : [])),
      ...(system.evidence ?? [system]),
    ];
    const uniqueEvidence = new Map(
      evidence.map((item) => [`${item.ref}\0${item.quote}`, item] as const),
    );
    resolved.set(slug, {
      ...system,
      slug,
      displayName: existing?.displayName ?? prior?.displayName ?? system.displayName,
      evidence: [...uniqueEvidence.values()],
      identity,
    });
  }
  const systems = [...resolved.values()];
  const currentSlugs = new Set(systems.map((system): string => system.slug));
  let created = 0;
  let updated = 0;
  let retired = 0;
  let scheduled = 0;

  for (const surface of surfaces) {
    if (currentSlugs.has(surface.slug)) continue;
    const evidence = surface.discoveryEvidence ?? [];
    let changed = false;
    const discoveryEvidence = evidence.map((item): DiscoveryEvidence => {
      if (item.kind !== 'documentation' || item.sourceId !== args.sourceId || !item.current) {
        return item;
      }
      changed = true;
      return { ...item, current: false, lastSeenAt: args.now };
    });
    if (changed) {
      await ctx.db.patch(surface._id, { discoveryEvidence });
      retired += 1;
    }
  }

  for (const system of systems) {
    if (system.class === 'docs') continue;
    const existing = bySlug.get(system.slug);
    const prior = existing?.discoveryEvidence ?? [];
    const incoming = new Map(
      (system.evidence ?? [system]).map((item) => [item.ref, item] as const),
    );
    const previousByRef = new Map(
      prior
        .filter((item): boolean => item.kind === 'documentation' && item.sourceId === args.sourceId)
        .map((item) => [item.ref, item] as const),
    );
    const discoveryEvidence = [
      ...prior.filter(
        (item): boolean => item.kind !== 'documentation' || item.sourceId !== args.sourceId,
      ),
      ...[...incoming.values()].map((item): DiscoveryEvidence => {
        const previous = previousByRef.get(item.ref);
        return {
          kind: 'documentation',
          sourceId: args.sourceId,
          ref: item.ref,
          quote: item.quote,
          url: item.url,
          current: true,
          firstSeenAt: previous?.firstSeenAt ?? args.now,
          lastSeenAt: args.now,
        };
      }),
    ];
    if (discoveryEvidence.length > MAX_DISCOVERY_EVIDENCE) {
      throw new Error('Surface discovery provenance exceeds 64 sources.');
    }
    if (existing) {
      await ctx.db.patch(existing._id, { discoveryEvidence });
      updated += 1;
      continue;
    }
    const surfaceId = await ctx.db.insert('surfaces', {
      agentId: args.agentId,
      slug: system.slug,
      displayName: system.displayName,
      class: system.class,
      verdict: 'declared',
      whereFound: (system.evidence ?? [system]).map((item) => ({
        sourceId: args.sourceId,
        ref: item.ref,
        quote: item.quote,
        url: item.url,
      })),
      discoveryEvidence,
      credentialLanded: false,
      createdAt: args.now,
    });
    created += 1;
    if (agent.state === 'active') {
      const orientationJobId = await ctx.scheduler.runAfter(
        0,
        internal.orientationActions.orientOne,
        { surfaceId },
      );
      await ctx.db.patch(surfaceId, { orientationJobId });
      scheduled += 1;
    }
  }
  return { created, updated, retired, scheduled };
}

const credentialKind = v.union(v.literal('value'), v.literal('location'), v.literal('oauth'));

/** What a proposal carries that came from the owner the orientation read under. */
interface ProposalProvenance {
  readonly credentialId?: Id<'credentials'>;
  readonly request: unknown;
  readonly whereFound: readonly unknown[];
  readonly intakeScope?: Doc<'surfaces'>['intakeScope'];
}

/**
 * Why a proposal may not land on the employee's card, or null when it may: it binds a
 * credential that is not the employee's current owner's, or quotes documentation the current
 * owner does not hold. Both mean the orientation read under an owner the employee has since been
 * handed away from (the wave 9 review's M5): its credential and its quotes are that owner's.
 *
 * @param db - The proposal's reader.
 * @param agentId - The employee.
 * @param proposal - What the orientation drafted.
 */
async function proposalOwnerRefusal(
  db: QueryCtx['db'],
  agentId: Id<'agents'>,
  proposal: ProposalProvenance,
): Promise<string | null> {
  if (proposal.credentialId !== undefined) {
    const refusal = await credentialOwnerRefusal(db, agentId, proposal.credentialId);
    if (refusal !== null) return refusal;
  }
  const agent = await db.get(agentId);
  const quoted = quotedSourceIds([
    {
      whereFound: [...proposal.whereFound],
      intakeScope: proposal.intakeScope,
      request: proposal.request,
      discoveryEvidence: undefined,
    },
  ]);
  for (const sourceId of quoted) {
    const id = db.normalizeId('docSources', sourceId);
    const source = id === null ? null : await db.get(id);
    if (agent === null || source?.userId !== agent.userId) {
      return 'the proposal quotes documentation its employee does not read';
    }
  }
  return null;
}

/** The credential a proposal leaves on its card, and whom the card acts as through it. */
interface DocumentedKeyBinding {
  readonly credentialId: Id<'credentials'> | undefined;
  readonly credentialKind: Doc<'surfaces'>['credentialKind'];
  readonly actsAs: Doc<'surfaces'>['actsAs'];
}

/**
 * What a proposal binds of the key the orientation found in the documentation (the wave 11
 * review's B1, decision 1 (a), a product call, flagged): nothing where IT's active organisation
 * connection covers the card's system, since the card connects through that connection and never
 * a key IT did not choose (the same rule `landCredential` keeps for a paste); otherwise the key,
 * with the card stamped a shared key named by the key's label, so the manager approves knowing
 * whom the employee acts as. A proposal that found no key binds none and names no identity.
 *
 * @param db - The proposal's reader.
 * @param proposal - The card's name, the proposal's rung and endpoint, and the documented key it
 *   would bind.
 */
async function documentedKeyBinding(
  db: QueryCtx['db'],
  proposal: {
    readonly displayName: string;
    readonly path: string;
    readonly endpoint?: string;
    readonly credentialId?: Id<'credentials'>;
    readonly credentialKind?: Doc<'surfaces'>['credentialKind'];
  },
): Promise<DocumentedKeyBinding> {
  const unbound = { credentialId: undefined, credentialKind: undefined, actsAs: undefined };
  if (proposal.credentialId === undefined || proposal.credentialKind === undefined) return unbound;
  const system = organisationSystemOf({ endpoint: proposal.endpoint, path: proposal.path });
  // Only a connection an issuer acts through covers the card (11-AC's item 8).
  if (
    system !== undefined &&
    servedByIssuer(system) &&
    (await activeConnectionFor({ db }, system)) !== null
  ) {
    return unbound;
  }
  const credential = await db.get(proposal.credentialId);
  return {
    credentialId: proposal.credentialId,
    credentialKind: proposal.credentialKind,
    actsAs: actsAsAtUpgrade(
      { displayName: proposal.displayName },
      { kind: proposal.credentialKind, label: credential?.label ?? '' },
    ),
  };
}

/**
 * Store an evidence-backed connect request.
 *
 * A work-bearing card carries the queues its employee will read; they are
 * approved with the rest of the card and replaced only by a new proposal.
 * A proposal names no access length and sets no end date: the approval
 * starts Q5's 90 days and the manager is the only other source (Q5, U3 D2 (b)).
 *
 * Internal, the orientation's. Writes nothing, and answers false, for a card no longer
 * `declared`, and for a proposal that binds a credential not the employee's current owner's or
 * quotes documentation that owner does not hold ({@link proposalOwnerRefusal}): an orientation
 * still running when a handover moved the employee read the old owner's pages and credentials.
 * The card stays declared for the new manager's own proposal. A documented key is bound only
 * where no active organisation connection covers the system, and the card is then stamped a
 * shared key ({@link documentedKeyBinding}; B1).
 */
export const propose = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    request: v.any(),
    whereFound: v.array(v.any()),
    path: v.string(),
    fallbackPath: v.string(),
    pathCandidates: v.optional(v.array(v.object({ path: v.string(), endpoint: v.string() }))),
    endpoint: v.optional(v.string()),
    credentialId: v.optional(v.id('credentials')),
    credentialKind: v.optional(credentialKind),
    credentialLocation: v.optional(v.string()),
    intakeScope: schema.tables.surfaces.validator.fields.intakeScope,
  },
  handler: async (ctx, args): Promise<boolean> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    if (surface.verdict !== 'declared') return false;
    const refusal = await proposalOwnerRefusal(ctx.db, surface.agentId, args);
    if (refusal !== null) {
      log.warn('surface proposal refused: the employee changed owner during its orientation', {
        surfaceId: surface._id,
        reason: refusal,
      });
      return false;
    }
    const binding = await documentedKeyBinding(ctx.db, {
      ...args,
      displayName: surface.displayName,
    });
    const now = Date.now();
    await ctx.db.patch(args.surfaceId, {
      verdict: 'proposed',
      request: args.request,
      whereFound: args.whereFound,
      path: args.path,
      fallbackPath: args.fallbackPath,
      pathCandidates:
        args.pathCandidates && args.pathCandidates.length > 0
          ? args.pathCandidates.slice(0, MAX_LADDER_PATHS)
          : args.endpoint
            ? [{ path: args.path, endpoint: args.endpoint }]
            : undefined,
      endpoint: args.endpoint,
      probeAttempts: undefined,
      ...binding,
      credentialLocation: args.credentialLocation,
      expiresAt: undefined,
      accessSetBy: undefined,
      reason: undefined,
      intakeScope: args.intakeScope,
    });
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.proposed',
      payload: { surfaceId: surface._id, path: args.path },
      createdAt: now,
    });
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.oriented',
      payload: { surfaceId: surface._id, verdict: 'proposed' },
      createdAt: now,
    });
    return true;
  },
});

/**
 * Record that documentation explicitly provides no approved surface.
 *
 * Internal, the orientation's. Writes nothing, and answers false, for a card no longer
 * `declared`, and for quotes of documentation the employee's current owner does not hold
 * ({@link proposalOwnerRefusal}): an orientation still running when a handover moved the
 * employee read the old owner's pages.
 */
export const markAbsent = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    searched: v.array(v.string()),
    whereFound: v.array(v.any()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    if (surface.verdict !== 'declared') return false;
    const refusal = await proposalOwnerRefusal(ctx.db, surface.agentId, {
      request: undefined,
      whereFound: args.whereFound,
    });
    if (refusal !== null) {
      log.warn('surface absence refused: the employee changed owner during its orientation', {
        surfaceId: surface._id,
        reason: refusal,
      });
      return false;
    }
    await ctx.db.patch(args.surfaceId, {
      verdict: 'absent',
      whereFound: args.whereFound,
      reason: `No approved surface found after searching: ${args.searched.join(', ')}`,
    });
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.oriented',
      payload: { surfaceId: surface._id, verdict: 'absent', searched: args.searched },
      createdAt: Date.now(),
    });
    return true;
  },
});

/**
 * Schedule the isolated orientation job for one declared surface, at most once.
 *
 * Charter approval and the owner's re-run control both come through here.
 * A surface whose previous job is still pending or running is left alone,
 * so two requests in quick succession cost one model call, not two, and
 * only the surface id crosses the scheduler boundary.
 */
export const scheduleOrientation = internalMutation({
  args: { surfaceId: v.id('surfaces'), byManager: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<boolean> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) return false;
    const placed = await scheduleOrientationFor(ctx, surface);
    if (placed && args.byManager === true) await recordReoriented(ctx, surface);
    return placed;
  },
});

/**
 * Record that the manager's re-run placed orientation for a surface, in the
 * transaction that placed it; charter approval's run writes nothing here.
 */
export async function recordReoriented(
  ctx: MutationCtx,
  surface: Pick<Doc<'surfaces'>, '_id' | 'agentId'>,
): Promise<void> {
  await appendEvent(ctx, {
    agentId: surface.agentId,
    type: 'surface.reoriented',
    payload: { surfaceId: surface._id },
    createdAt: Date.now(),
  });
}

/**
 * Schedule orientation for one declared surface unless a job is already on it.
 *
 * Args:
 *   ctx: Mutation context.
 *   surface: The surface row as read in this transaction.
 *
 * Returns:
 *   Whether a job was placed.
 */
export async function scheduleOrientationFor(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
): Promise<boolean> {
  if (surface.verdict !== 'declared') return false;
  if (surface.orientationJobId) {
    const job = await ctx.db.system.get(surface.orientationJobId);
    if (job && (job.state.kind === 'pending' || job.state.kind === 'inProgress')) return false;
  }
  const orientationJobId = await ctx.scheduler.runAfter(0, internal.orientationActions.orientOne, {
    surfaceId: surface._id,
  });
  await ctx.db.patch(surface._id, { orientationJobId });
  return true;
}

/**
 * Ask for the card of one documented system the charter does not name.
 *
 * Orientation leaves such a system declared and the card lists it under the
 * others; this is the manager's click that orients that one surface. The
 * card it files still needs the manager's approval. Nothing is
 * stored on the row: a rejected or failed card goes back to waiting, one
 * click from a card again, and a pending job for the surface is replaced
 * so the request is not swallowed by a run that would skip it.
 */
export const requestProposal = mutation({
  args: { surfaceId: v.id('surfaces') },
  handler: async (ctx, args): Promise<null> => {
    assertRealMode('Surface proposal');
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new ConvexError('Surface not found.');
    await assertOwnsAgent(ctx, surface.agentId);
    if (surface.verdict !== 'declared') {
      throw new ConvexError(
        `Only a declared system can be proposed; this one is ${surface.verdict}.`,
      );
    }
    if (surface.orientationJobId) {
      const job = await ctx.db.system.get(surface.orientationJobId);
      if (job?.state.kind === 'inProgress') {
        throw new ConvexError('Orientation is already running for this system; its card follows.');
      }
      if (job?.state.kind === 'pending') await ctx.scheduler.cancel(job._id);
    }
    const orientationJobId = await ctx.scheduler.runAfter(
      0,
      internal.orientationActions.orientOne,
      { surfaceId: surface._id, requested: true },
    );
    await ctx.db.patch(surface._id, { orientationJobId });
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.proposal-requested',
      payload: { surfaceId: surface._id, slug: surface.slug },
      createdAt: Date.now(),
    });
    return null;
  },
});

/**
 * Record that an orientation job failed before it could decide.
 *
 * The surface stays `declared`, because nothing was decided, but the card
 * carries the failure so the operator sees why there is no proposal and the
 * re-run control applies. A surface that has moved on is left alone.
 */
export const recordOrientationFailure = internalMutation({
  args: { surfaceId: v.id('surfaces'), reason: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface || surface.verdict !== 'declared') return false;
    const reason = `orientation failed: ${args.reason}`.slice(0, 400);
    await ctx.db.patch(surface._id, { reason });
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.orientation-failed',
      payload: { surfaceId: surface._id, reason },
      createdAt: Date.now(),
    });
    return true;
  },
});

/**
 * Attach an encrypted credential reference without exposing its value, and write whom the card
 * now acts as (`actsAs`, D2): a pasted value or location is a shared key named by its label, an
 * installed app's token the employee's own app (`actsAsAtUpgrade`).
 *
 * Internal, for `surfaceActions.landCredential`. Refuses a credential that is not the employee's
 * current owner's (`assertCredentialOfOwner`): the action stored it under the owner it started
 * with, and a handover may have moved the employee since.
 *
 * @throws ConvexError with `CREDENTIAL_NOT_THE_OWNERS`.
 */
export const attachCredential = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    credentialId: v.id('credentials'),
    credentialKind,
    credentialLocation: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    await assertCredentialOfOwner(ctx.db, surface.agentId, args.credentialId);
    const credential = await ctx.db.get(args.credentialId);
    const approved = surface.managerApprovedAt !== undefined;
    await ctx.db.patch(surface._id, {
      credentialId: args.credentialId,
      credentialKind: args.credentialKind,
      credentialLocation: args.credentialLocation,
      // The credential's own label names it; the owner check above has read the row.
      actsAs: actsAsAtUpgrade(surface, {
        kind: args.credentialKind,
        label: credential?.label ?? '',
      }),
      credentialLanded: false,
      verdict:
        approved && (surface.verdict === 'ungranted' || surface.verdict === 'listed-dead')
          ? 'approved'
          : surface.verdict,
      reason: approved ? undefined : surface.reason,
    });
  },
});

/**
 * Consume the install link's single-use nonce.
 *
 * This runs before the code is exchanged, so a redirect replayed from a
 * browser history finds no nonce to claim and is refused without a second
 * call reaching the provider. The whole check and clear are one transaction,
 * so two simultaneous redirects cannot both win.
 *
 * Args:
 *   surfaceId: The surface the signed state named.
 *   nonce: The nonce the signed state carried.
 *   now: Current epoch milliseconds.
 *
 * Returns:
 *   The claim needed to exchange the code, or why it was refused.
 */
export const claimInstallState = internalMutation({
  args: { surfaceId: v.id('surfaces'), nonce: v.string(), now: v.number() },
  handler: async (
    ctx,
    args,
  ): Promise<
    | {
        ok: true;
        agentId: Id<'agents'>;
        clientId: string;
        clientSecretCredentialId: Id<'credentials'>;
        redirectUrl: string;
        slug: string;
      }
    | { ok: false; reason: string }
  > => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface?.provisioning) return { ok: false, reason: 'no-provisioning' };
    const provisioning = surface.provisioning;
    if (!provisioning.stateNonce || provisioning.stateNonce !== args.nonce) {
      return { ok: false, reason: 'used' };
    }
    if (provisioning.stateExpiresAt !== undefined && provisioning.stateExpiresAt <= args.now) {
      return { ok: false, reason: 'expired' };
    }
    await ctx.db.patch(surface._id, {
      provisioning: {
        ...provisioning,
        stateNonce: undefined,
        stateExpiresAt: undefined,
        lastError: undefined,
      },
    });
    return {
      ok: true,
      agentId: surface.agentId,
      clientId: provisioning.clientId,
      clientSecretCredentialId: provisioning.clientSecretCredentialId,
      redirectUrl: provisioning.redirectUrl,
      slug: surface.slug,
    };
  },
});

/** Record why an install could not be completed, for the card to explain. */
export const recordInstallFailure = internalMutation({
  args: { surfaceId: v.id('surfaces'), reason: v.string(), now: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface?.provisioning) return;
    await ctx.db.patch(surface._id, {
      provisioning: { ...surface.provisioning, lastError: args.reason },
    });
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.install-failed',
      payload: { surfaceId: surface._id, reason: args.reason },
      createdAt: args.now,
    });
  },
});

/**
 * Refuse a bot token an install did not just land for this card: the token the install stored is a
 * fresh row the organisation holds (the wave 11 common rules), with no `issuedBy` yet; a token an
 * owner holds, as an install before v0.14.0 stored it, must be the employee's current owner's
 * (`assertCredentialOfOwner`).
 *
 * @throws ConvexError with `CREDENTIAL_NOT_THE_OWNERS` for an owner's row of another owner, or the
 *   organisation's refusal for any other row.
 */
async function assertInstalledToken(
  db: MutationCtx['db'],
  surface: Doc<'surfaces'>,
  credentialId: Id<'credentials'>,
): Promise<void> {
  const token = await db.get(credentialId);
  if (token?.holder !== ORGANISATION_HOLDER) {
    await assertCredentialOfOwner(db, surface.agentId, credentialId);
    return;
  }
  // The install stored the token with the issuer of this card's app (the pre-tag's item 10): a row
  // the organisation holds for anything else, or one a card already binds, is not it.
  const provisioning = surface.provisioning;
  const binders = await db
    .query('surfaces')
    .withIndex('by_credentialId', (q) => q.eq('credentialId', credentialId))
    .take(2);
  if (
    token.userId !== ORGANISATION_OWNER_KEY ||
    token.kind !== 'oauth' ||
    token.revokedAt !== undefined ||
    provisioning === undefined ||
    !isIssuedAs(token.issuedBy, installedBotIssuer(provisioning)) ||
    binders.some((binder) => binder._id !== surface._id)
  ) {
    throw new ConvexError('This bot token is not one an install just landed for this card.');
  }
}

/**
 * Attach the bot token an install delivered and retire a shared one.
 *
 * The two writes belong together: the moment the dedicated identity is the
 * surface's credential, the shared token it replaces must stop being usable,
 * or a run could still reach the provider as the workspace's shared app.
 *
 * With them, in the same transaction (11-AS; the cockpit's assignment from 11-AK): the bot token's
 * `issuedBy` (`oauth-install`, with the app's ids and its client secret, which an end of access
 * reads to revoke it at Slack, 11-AR) where the token has none (one the organisation holds was
 * stored with it, the pre-tag's item 10) and the client secret's where it has none; whom the card acts
 * as (`actsAs`: its own app and its bot user, D2); and, for an app the organisation's Slack
 * configuration connection created (`provisioning.organisationConnectionId`), the card's link to
 * that connection (`organisationConnections.linkSurface`; written here while the connection needs
 * IT's attention, which `linkSurface` refuses), so a revoke of the connection ends it. An app
 * whose connection IT revoked is not installed again.
 *
 * Internal, for `slackProvisionActions`. Refuses a bot token that is not one the install just
 * landed for this card's app (`assertInstalledToken`: its stored issuer, bound by no other card),
 * before anything is retired.
 *
 * @throws ConvexError with `CREDENTIAL_NOT_THE_OWNERS`, or when the card has no app, or the app's
 *   connection was revoked.
 */
export const recordInstalledApp = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    credentialId: v.id('credentials'),
    /** The bot user the install returned, which the card names as whom it acts as. */
    botUserId: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<{ retiredCredentialId?: Id<'credentials'> }> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    await assertInstalledToken(ctx.db, surface, args.credentialId);
    const provisioning = surface.provisioning;
    if (!provisioning) throw new ConvexError('This connection has no app awaiting an install.');
    const previous = surface.credentialId;
    if (previous && previous !== args.credentialId && surface.credentialKind === 'oauth') {
      throw new Error('This surface already has a dedicated identity.');
    }
    const connectionId = provisioning.organisationConnectionId;
    const creator = connectionId === undefined ? null : await ctx.db.get(connectionId);
    if (creator?.status === 'revoked') throw new ConvexError(KEPT_APP_CONNECTION_REVOKED);
    const retired =
      previous && previous !== args.credentialId && surface.credentialKind !== 'oauth'
        ? previous
        : undefined;
    const app = {
      appId: provisioning.appId,
      clientId: provisioning.clientId,
      ...(connectionId === undefined ? {} : { organisationConnectionId: connectionId }),
    };
    // A token the organisation holds was stored with this issuer; one stored under an owner's key
    // before v0.14.0's issuers is stamped here.
    const token = await ctx.db.get(args.credentialId);
    if (token !== null && token.issuedBy === undefined) {
      await ctx.db.patch(args.credentialId, { issuedBy: installedBotIssuer(provisioning) });
    }
    const secret = await ctx.db.get(provisioning.clientSecretCredentialId);
    if (secret !== null && secret.issuedBy === undefined) {
      await ctx.db.patch(secret._id, { issuedBy: slackClientSecretIssuer(app) });
    }
    await ctx.db.patch(surface._id, {
      credentialId: args.credentialId,
      credentialKind: 'oauth',
      credentialLanded: false,
      reason: undefined,
      verdict:
        surface.verdict === 'ungranted' || surface.verdict === 'listed-dead'
          ? 'approved'
          : surface.verdict,
      actsAs: slackActsAs({
        appName: provisioning.appName,
        ...(args.botUserId === undefined ? {} : { botUserId: args.botUserId }),
      }),
      provisioning: {
        ...provisioning,
        installedAt: args.now,
        stateNonce: undefined,
        stateExpiresAt: undefined,
        lastError: undefined,
      },
    });
    if (creator?.status === 'active') {
      await ctx.runMutation(internal.organisationConnections.linkSurface, {
        surfaceId: surface._id,
        organisationConnectionId: creator._id,
      });
    } else if (creator?.status === 'needs-attention') {
      // The install uses no configuration token, so a connection whose refresh token IT must
      // replace does not hold it back; `linkSurface` links only through an active connection, and
      // the card is linked to the one that created its app so that its revoke still ends the card.
      await ctx.db.patch(surface._id, { organisationConnectionId: creator._id });
    }
    if (retired) {
      const credential = await ctx.db.get(retired);
      if (credential && !credential.revokedAt) {
        await ctx.db.patch(retired, { revokedAt: args.now });
      }
      await appendEvent(ctx, {
        agentId: surface.agentId,
        type: 'surface.shared-credential-retired',
        payload: {
          surfaceId: surface._id,
          credentialId: retired,
          reason: 'replaced by the dedicated app installed for this employee',
        },
        createdAt: args.now,
      });
    }
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.app-installed',
      payload: { surfaceId: surface._id, appId: provisioning.appId },
      createdAt: args.now,
    });
    return { retiredCredentialId: retired };
  },
});

/** How long a probe holds its card against a routine re-probe (E-88); see `src/surfaces/probe-lease.ts`. */
export { PROBE_LEASE_MS };

/** The verdicts a probe may run on; a row that leaves them is no longer a probe's to call. */
export const PROBEABLE_VERDICTS: ReadonlyArray<Doc<'surfaces'>['verdict']> = [
  'approved',
  'connected',
  'ungranted',
  'listed-dead',
];

/** Why `beginProbe` reserved no generation. */
export type ProbeRefusal = 'not-probeable' | 'access-ended' | 'in-flight';

/** A probe generation `beginProbe` reserved, with the row as it now stands. */
export interface ProbeReserved {
  readonly reserved: true;
  readonly surface: Doc<'surfaces'>;
  readonly generation: number;
}

/** A probe `beginProbe` did not reserve because the card cannot be probed now. */
export interface ProbeRefused {
  readonly reserved: false;
  readonly refusal: Exclude<ProbeRefusal, 'in-flight'>;
}

/**
 * A routine probe `beginProbe` did not reserve because another probe of the
 * card is in flight: the card's verdict, and when the lease on it ends, so a
 * re-ask no sweep would repeat can be asked again then.
 */
export interface ProbeInFlight {
  readonly reserved: false;
  readonly refusal: 'in-flight';
  readonly verdict: Doc<'surfaces'>['verdict'];
  readonly leaseEndsAt: number;
}

/** What `beginProbe` answers. */
export type ProbeReservation = ProbeReserved | ProbeRefused | ProbeInFlight;

/**
 * Reserve the next probe generation for an approved connection candidate.
 *
 * Internal; the probe's first write. The new generation fences every result
 * an older probe may still write, and its start is stamped so a routine
 * re-probe (the hourly sweep, a rate limit's re-ask) asked for while it runs
 * is not made: two such probes within the lease cost one provider round-trip
 * (E-88). A probe a person's action asks for (the card's Probe, a landed
 * credential, an approval, a renewal, a tool approval, a manager change)
 * supersedes the one in flight, whose answer may be about what just changed.
 * A card whose end date has passed is ended here, not probed.
 */
export const beginProbe = internalMutation({
  args: { surfaceId: v.id('surfaces'), routine: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<ProbeReservation> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface || !PROBEABLE_VERDICTS.includes(surface.verdict)) {
      return { reserved: false, refusal: 'not-probeable' };
    }
    // A probe that found the provider working would otherwise reconnect an
    // access whose end date has passed; only the manager's renewal does that.
    const now = Date.now();
    if (accessEndDatePassed(surface, now)) {
      if (surface.reason !== 'expired') await endAccessInTransaction(ctx, surface, now);
      return { reserved: false, refusal: 'access-ended' };
    }
    if (
      args.routine === true &&
      surface.probeStartedAt !== undefined &&
      probeInFlight(surface, now)
    ) {
      return {
        reserved: false,
        refusal: 'in-flight',
        verdict: surface.verdict,
        leaseEndsAt: surface.probeStartedAt + PROBE_LEASE_MS,
      };
    }
    const started = { probeGeneration: (surface.probeGeneration ?? 0) + 1, probeStartedAt: now };
    await ctx.db.patch(surface._id, started);
    return {
      reserved: true,
      surface: { ...surface, ...started },
      generation: started.probeGeneration,
    };
  },
});

/** Persist a safe probe failure while retaining no provider request material. */
export const recordProbeFailure = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    generation: v.number(),
    verdict: v.union(v.literal('ungranted'), v.literal('listed-dead')),
    reason: v.string(),
    attemptedAt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    if (surface.probeGeneration !== args.generation) return false;
    if (!PROBEABLE_VERDICTS.includes(surface.verdict)) {
      await ctx.db.patch(surface._id, { probeStartedAt: undefined });
      return false;
    }
    // A probe that began before the end date and failed after it leaves the
    // access ended, not dead: the renewal reads `expired` (wave 2 review M20).
    if (await endedBeforeProbeLanded(ctx, surface)) return false;
    // The last resolved manager stays: a failed lookup is the usual way a
    // manager leaves, and the connecting probe after it can only say the
    // manager changed (Q6) by comparing with who the row resolved before.
    // Nothing reads it off a row that is not connected.
    await ctx.db.patch(surface._id, {
      verdict: args.verdict,
      reason: args.reason,
      credentialLanded: false,
      toolAllowlist: undefined,
      // A card connected before the approved list existed keeps its list as
      // the approved one, so the connection after this failure is frozen
      // against what the manager saw and not against whatever the provider
      // lists then (wave 3.5 review M1).
      ...(surface.approvedToolAllowlist === undefined && surface.toolAllowlist !== undefined
        ? {
            approvedToolAllowlist: surface.toolAllowlist,
            toolAllowlistApprovedAt: surface.lastVerifiedAt ?? surface.createdAt,
          }
        : {}),
      withheldTools: undefined,
      toolArguments: undefined,
      managerDmChannelId: undefined,
      managerName: undefined,
      providerIdentityId: undefined,
      providerWorkspaceId: undefined,
      channelsNotJoined: undefined,
      lastVerifiedAt: undefined,
      probeStartedAt: undefined,
      probeAttempts: withProbeAttempt(surface, {
        path: surface.path ?? 'unknown',
        endpoint: surface.endpoint,
        outcome: args.verdict,
        reason: args.reason,
        attemptedAt: args.attemptedAt ?? Date.now(),
      }),
    });
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.probe-failed',
      payload: { surfaceId: surface._id, verdict: args.verdict, reason: args.reason },
      createdAt: Date.now(),
    });
    return true;
  },
});

/**
 * Record that a probe's first call failed in a way worth one more call.
 *
 * Written before the wait, so the card and the trail show the retry while it
 * is pending and keep it after the second call connects. The verdict is left
 * alone: one failed call establishes nothing about the enterprise's system.
 * A provider that rate-limited the retry as well ends the probe here
 * (`endsProbe`), leaving the verdict, so the card is free for the next probe.
 *
 * Returns:
 *   False when a newer probe has taken over, or the row is no longer approved,
 *   and the retry must not run.
 */
export const recordProbeRetry = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    generation: v.number(),
    reason: v.string(),
    retryAfterMs: v.number(),
    attemptedAt: v.number(),
    endsProbe: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    if (surface.probeGeneration !== args.generation) return false;
    if (!PROBEABLE_VERDICTS.includes(surface.verdict)) {
      await ctx.db.patch(surface._id, { probeStartedAt: undefined });
      return false;
    }
    await ctx.db.patch(surface._id, {
      ...(args.endsProbe === true ? { probeStartedAt: undefined } : {}),
      probeAttempts: withProbeAttempt(surface, {
        path: surface.path ?? 'unknown',
        endpoint: surface.endpoint,
        outcome: 'retried',
        reason: args.reason,
        attemptedAt: args.attemptedAt,
        retryAfterMs: args.retryAfterMs,
      }),
    });
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.probe-retried',
      payload: {
        surfaceId: surface._id,
        path: surface.path,
        reason: args.reason,
        retryAfterMs: args.retryAfterMs,
      },
      createdAt: args.attemptedAt,
    });
    return true;
  },
});

/**
 * Move one failed probe to the next route both approvers already saw.
 *
 * A `connected` row is deliberately not demotable. The descent is one-way -
 * nothing climbs back - so demoting on the first failure would let a single
 * provider blip on a route that demonstrably works permanently abandon it for
 * a weaker rung. A connected route's failure is recorded instead, which already
 * closes the gate; the next probe, finding the row no longer connected,
 * descends. Establishing a connection still walks the whole ladder at once,
 * because a freshly approved row is never `connected`.
 *
 * A failed manager lookup never descends either: the route answered, and the
 * person it looked up is what changed. The failure is recorded on the same
 * rung, and Make it you (`agents.adoptManagerAddress`) re-probes it (Q6); a handover cuts the
 * card for the new manager to connect again.
 */
export const demoteAfterProbeFailure = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    generation: v.number(),
    reason: v.string(),
    attemptedAt: v.number(),
  },
  handler: async (ctx, args): Promise<{ surface: Doc<'surfaces'>; generation: number } | null> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (
      !surface ||
      surface.probeGeneration !== args.generation ||
      !['approved', 'ungranted', 'listed-dead'].includes(surface.verdict) ||
      surface.managerApprovedAt === undefined ||
      isManagerLookupFailure(args.reason)
    ) {
      return null;
    }
    // Past the end date there is no rung to fall to: the access ended.
    if (await endedBeforeProbeLanded(ctx, surface)) return null;
    const candidates = (surface.pathCandidates ?? []).slice(0, MAX_LADDER_PATHS);
    const currentIndex = candidates.findIndex(
      (candidate): boolean =>
        candidate.path === surface.path && candidate.endpoint === surface.endpoint,
    );
    const nextCandidate = currentIndex >= 0 ? candidates[currentIndex + 1] : undefined;
    const next = nextCandidate?.path === surface.fallbackPath ? nextCandidate : undefined;
    if (!next) return null;
    const generation = args.generation + 1;
    const reason =
      `${surface.path ?? 'Current'} probe failed: ${args.reason}. ` +
      `Day0 is falling back to ${next.path}; that route must pass its own probe before this surface can connect.`;
    const patch = {
      verdict: 'approved' as const,
      path: next.path,
      endpoint: next.endpoint,
      fallbackPath: candidates[currentIndex + 2]?.path ?? 'escalate',
      reason: reason.slice(0, 500),
      credentialLanded: false,
      probeGeneration: generation,
      // The same probe goes on to the next rung under the new generation.
      probeStartedAt: Date.now(),
      toolAllowlist: undefined,
      withheldTools: undefined,
      approvedToolAllowlist: undefined,
      toolAllowlistApprovedAt: undefined,
      toolArguments: undefined,
      managerDmChannelId: undefined,
      managerUserId: undefined,
      managerName: undefined,
      providerIdentityId: undefined,
      providerWorkspaceId: undefined,
      channelsNotJoined: undefined,
      lastVerifiedAt: undefined,
      probeAttempts: withProbeAttempt(surface, {
        path: surface.path ?? 'unknown',
        endpoint: surface.endpoint,
        outcome: 'demoted',
        reason: args.reason,
        attemptedAt: args.attemptedAt,
      }),
    };
    await ctx.db.patch(surface._id, patch);
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.probe-demoted',
      payload: {
        surfaceId: surface._id,
        from: surface.path,
        to: next.path,
        reason: args.reason,
      },
      createdAt: args.attemptedAt,
    });
    return { surface: { ...surface, ...patch }, generation };
  },
});

/**
 * Return work parked on this surface to the evaluator.
 *
 * Evaluation defers a candidate whose provider is not connected, or whose
 * read grant is missing, and nothing re-evaluates a deferred row on its
 * own. When the surface connects, and the grant lands with it, those rows go
 * back to `discovered` to be evaluated again: by the server in real mode,
 * by the dashboard's queue in mock mode.
 *
 * Args:
 *   ctx: Mutation context of the connecting write.
 *   surface: The surface that just became connected.
 *
 * Returns:
 *   Ids of the work items requeued.
 */
interface DeferredSurfaceVerdict {
  reason?: string;
  missingSurface?: string;
  missingPermissions?: string[];
}

async function requeueDeferredWork(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  shouldRequeue: (verdict: DeferredSurfaceVerdict) => boolean,
  now: number,
): Promise<Id<'workItems'>[]> {
  const deferred = await ctx.db
    .query('workItems')
    .withIndex('by_agent_state', (index) =>
      index.eq('agentId', surface.agentId).eq('state', 'deferred'),
    )
    .collect();
  const requeued: Id<'workItems'>[] = [];
  for (const item of deferred) {
    const verdict = item.verdict as DeferredSurfaceVerdict | undefined;
    if (!verdict || !shouldRequeue(verdict)) continue;
    await ctx.db.patch(item._id, { state: 'discovered', verdict: undefined });
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'work.requeued',
      payload: {
        workItemId: item._id,
        surfaceId: surface._id,
        slug: surface.slug,
        ...(verdict.missingSurface ? { previousMissingSurface: verdict.missingSurface } : {}),
      },
      createdAt: now,
    });
    await scheduleNextStep(ctx, { ...item, state: 'discovered', verdict: undefined });
    requeued.push(item._id);
  }
  return requeued;
}

async function requeueWorkAwaitingAlias(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  aliasSlug: string,
  now: number,
): Promise<Id<'workItems'>[]> {
  if (aliasSlug === surface.slug) return [];
  return await requeueDeferredWork(
    ctx,
    surface,
    (verdict) => verdict.reason === 'awaiting-connection' && verdict.missingSurface === aliasSlug,
    now,
  );
}

async function requeueWorkAfterRejection(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  now: number,
): Promise<Id<'workItems'>[]> {
  const surfaces = await ctx.db
    .query('surfaces')
    .withIndex('by_agent', (index) => index.eq('agentId', surface.agentId))
    .collect();
  if (
    !surfaces.some(
      (candidate) => candidate._id !== surface._id && sameSurfaceSystem(surface, candidate),
    )
  ) {
    return [];
  }
  return await requeueDeferredWork(
    ctx,
    surface,
    (verdict) =>
      verdict.reason === 'awaiting-connection' && verdict.missingSurface === surface.slug,
    now,
  );
}

/** The callable tools one successful probe leaves on a surface, and any it withheld. */
interface ProbedTools {
  readonly allowlist: string[];
  readonly toolArguments: Array<{ tool: string; arguments: string[] }>;
  readonly withheld: string[];
  /** The list the approval covers, which the row keeps. */
  readonly approved: string[];
}

/**
 * Keep a surface's tool list to the one its approval covers.
 *
 * The probe that first connects the approved row fixes the approved list.
 * Any later probe (the hourly one, one after a page names another Slack
 * method, one after a failed probe, or the one a renewal of an ended access
 * schedules) keeps only the approved tools it still finds and withholds any
 * other, so no probe widens what an employee may call; a tool a narrower
 * probe dropped comes back when a probe finds it again. Only the manager's
 * explicit approval widens the list (`approveTools`); a rejection or a
 * demotion to another route clears it, and the next connection starts from
 * its own probe.
 *
 * @param surface - The row before this probe's write.
 * @param probed - What the probe found.
 * @returns The tools to store, their arguments, the tools withheld, and the
 *   approved list the row carries after this probe.
 */
function frozenTools(
  surface: Doc<'surfaces'>,
  probed: { toolAllowlist: string[]; toolArguments: Array<{ tool: string; arguments: string[] }> },
): ProbedTools {
  // A row connected before the approved list existed keeps the list it
  // holds until the `surfaces-approved-tools` migration copies it across.
  const approvedList = surface.approvedToolAllowlist ?? surface.toolAllowlist;
  if (approvedList === undefined) {
    return {
      allowlist: probed.toolAllowlist,
      toolArguments: probed.toolArguments,
      withheld: [],
      approved: probed.toolAllowlist,
    };
  }
  const approved = new Set(approvedList);
  const allowlist = probed.toolAllowlist.filter((tool: string): boolean => approved.has(tool));
  return {
    allowlist,
    toolArguments: probed.toolArguments.filter((entry): boolean => approved.has(entry.tool)),
    withheld: probed.toolAllowlist.filter((tool: string): boolean => !approved.has(tool)),
    approved: approvedList,
  };
}

/**
 * Persist one successful provider probe and its discovered safe metadata.
 *
 * A probe never moves the access end date (Q5): approval starts the clock and
 * only the manager moves it (`setAccessDays`).
 *
 * The first transition to `connected` also grants `<slug>:read` and re-admits
 * the work parked on this surface or skipped as out of scope, in the same
 * transaction, so a connected surface can never exist without its grant and
 * the hourly re-probe never grants again. A reconnect after a failed probe
 * never restores a read scope the manager revoked after the card's approval:
 * only a new approval or the manager's own grant does (Q7). Only parked rows are re-admitted
 * here: a row still being evaluated from a read taken before this write is
 * caught where its verdict lands (`applyVerdict`), under this write's key.
 * No probe widens a stored tool list, a renewal's included (`frozenTools`);
 * the row and the connected event name any tool it withheld. A probe that resolves a
 * different manager than the row held writes `manager.changed` (Q6), so the
 * ledger shows who the approver became and when, and any open request
 * delivered to another DM is sent again to this one. A connection made again
 * after the surface stopped being connected stamps "Re-check due" on the
 * employee's registered skills that act on it (A13, `skill.recheck-due`).
 */
export const recordConnected = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    generation: v.number(),
    toolAllowlist: v.array(v.string()),
    toolArguments: v.array(v.object({ tool: v.string(), arguments: v.array(v.string()) })),
    managerDmChannelId: v.optional(v.string()),
    managerUserId: v.optional(v.string()),
    managerName: v.optional(v.string()),
    providerIdentityId: v.optional(v.string()),
    providerWorkspaceId: v.optional(v.string()),
    channelsNotJoined: v.optional(v.array(v.string())),
    verifiedAt: v.number(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    if (surface.probeGeneration !== args.generation) return false;
    if (!PROBEABLE_VERDICTS.includes(surface.verdict)) {
      await ctx.db.patch(surface._id, { probeStartedAt: undefined });
      return false;
    }
    // A probe in flight across the end date never reconnects the access, and
    // never re-grants its read scope (wave 2 review D4 (a), M20).
    if (await endedBeforeProbeLanded(ctx, surface)) return false;
    const transitioned = surface.verdict !== 'connected';
    const previousManager = surface.managerUserId;
    const managerChange =
      previousManager !== undefined &&
      args.managerUserId !== undefined &&
      previousManager !== args.managerUserId
        ? { previousManagerUserId: previousManager, managerUserId: args.managerUserId }
        : undefined;
    const tools = frozenTools(surface, args);
    await ctx.db.patch(surface._id, {
      verdict: 'connected',
      reason: undefined,
      credentialLanded: true,
      lastVerifiedAt: args.verifiedAt,
      probeStartedAt: undefined,
      toolAllowlist: tools.allowlist,
      toolArguments: tools.toolArguments,
      withheldTools: tools.withheld.length > 0 ? tools.withheld : undefined,
      ...(surface.approvedToolAllowlist === undefined
        ? { approvedToolAllowlist: tools.approved, toolAllowlistApprovedAt: args.verifiedAt }
        : {}),
      managerDmChannelId: args.managerDmChannelId,
      managerUserId: args.managerUserId,
      managerName: args.managerName,
      providerIdentityId: args.providerIdentityId,
      providerWorkspaceId: args.providerWorkspaceId,
      channelsNotJoined:
        args.channelsNotJoined && args.channelsNotJoined.length > 0
          ? args.channelsNotJoined
          : undefined,
      // The last poll's skip reason described a surface that was not connected
      // yet. Leaving it would have a connected card say it was skipped awaiting
      // connection; the next poll writes a fresh one if it skips for a new reason.
      intakeSkipReason: undefined,
    });
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.connected',
      payload:
        tools.withheld.length > 0
          ? { surfaceId: surface._id, withheldTools: tools.withheld }
          : { surfaceId: surface._id },
      createdAt: args.verifiedAt,
    });
    if (managerChange) {
      await appendEvent(ctx, {
        agentId: surface.agentId,
        type: 'manager.changed',
        payload: { surfaceId: surface._id, via: 'probe', ...managerChange },
        createdAt: args.verifiedAt,
      });
    }
    await resendDecisionsAfterManagerChange(ctx, surface, args.managerDmChannelId);
    // On every connection, not only a change of stored verdict: a surface the
    // planner read as dead may never have been stored as anything but connected.
    await redraftPlansDraftedWithout(ctx, surface, args.verifiedAt);
    if (transitioned) {
      // A connection made again may answer differently from the one the employee's skills were
      // checked against (A13): each acting on this surface is due a re-check, and keeps running.
      await stampRecheckDueOnSurfaces(ctx, {
        agentId: surface.agentId,
        slugs: [surface.slug],
        reasonFor: reconnectedReason,
        now: args.verifiedAt,
      });
      const readScope = `${surface.slug}:read`;
      if (!(await readRevokedSinceApproval(ctx, surface, readScope))) {
        await grantScopeInTransaction(ctx, surface.agentId, readScope, 'surface');
      }
      await reevaluatePendingInTransaction(ctx, {
        agentId: surface.agentId,
        trigger: 'surface',
        key: `surface:${surface._id}:${args.verifiedAt}`,
        surfaceId: surface._id,
        now: args.verifiedAt,
      });
      // The work the surface already holds is read now rather than at the
      // next scheduled sweep; the cron remains the steady state.
      await ctx.scheduler.runAfter(0, internal.intakeActions.pollSurface, {
        surfaceId: surface._id,
      });
    }
    return true;
  },
});

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Surfaces one page of the access-clock migration reads. */
const ACCESS_BACKFILL_BATCH = 100;

/** The verdicts of an approved surface, whose access runs on a clock. */
const ACCESS_VERDICTS: ReadonlyArray<Doc<'surfaces'>['verdict']> = [
  'approved',
  'connected',
  'ungranted',
  'listed-dead',
];

/**
 * What an end of the card's own credential did: the rows held for their vendor call, and the rows
 * Day0 obtained but could only stop using (`EndedAtSource.stopped`).
 */
interface OwnCredentialEnded {
  readonly held: readonly Id<'credentials'>[];
  readonly stopped: readonly Id<'credentials'>[];
}

/**
 * The card's own credential and the refresh token paired with it, unless another card binds the
 * credential too: the rows an end that keeps the card's app takes from it.
 *
 * @param db - The ending transaction's reader.
 * @param surface - The card.
 */
async function ownCredentialRows(
  db: QueryCtx['db'],
  surface: Doc<'surfaces'>,
): Promise<Doc<'credentials'>[]> {
  if (surface.credentialId === undefined) return [];
  const credential = await db.get(surface.credentialId);
  if (credential === null) return [];
  const binders = await db
    .query('surfaces')
    .withIndex('by_credentialId', (q) => q.eq('credentialId', credential._id))
    .take(2);
  if (binders.some((binder) => binder._id !== surface._id)) {
    // A key a colleague's card binds too (N1) is never ended by this one. A pasted key and the
    // organisation's shared token are passed on all the same: the end never sends or revokes
    // either, and writes the card's line for its system (the wave 11 review's M7).
    return credential.issuedBy === undefined || sharedByOrganisation(credential)
      ? [credential]
      : [];
  }
  const refresh =
    credential.refreshCredentialId === undefined
      ? null
      : await db.get(credential.refreshCredentialId);
  return refresh === null ? [credential] : [credential, refresh];
}

/**
 * End the card's own credential at its vendor for an end that keeps the card's app (a
 * disconnect, an expiry, an organisation connection's revoke): what Day0 obtained is revoked and
 * held for the vendor call, a pasted key is left where it is and never sent, and the system's
 * ledger line is written (`endAccessAtSource`).
 *
 * @param ctx - The ending transaction.
 * @param surface - The card as it stands before the end.
 * @param end - The end of access.
 * @param now - When it ended.
 */
async function endOwnCredentialAtSource(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  end: AccessEnd,
  now: number,
): Promise<OwnCredentialEnded> {
  const rows = await ownCredentialRows(ctx.db, surface);
  if (rows.length === 0) return { held: [], stopped: [] };
  const ended = await endAccessAtSource(ctx, {
    agentId: surface.agentId,
    surfaceId: surface._id,
    surfaceName: surface.displayName,
    credentials: rows,
    end,
    now,
  });
  return { held: ended.held, stopped: ended.stopped };
}

/** Who set an access end date: the approval that started it, the manager, or the upgrade. */
type AccessSetBy = NonNullable<Doc<'surfaces'>['accessSetBy']>;

/** Whether an approved surface's access end date has passed; renewal moves the date. */
function accessEndDatePassed(surface: Doc<'surfaces'>, now: number): boolean {
  return (
    ACCESS_VERDICTS.includes(surface.verdict) &&
    surface.expiresAt !== undefined &&
    surface.expiresAt <= now
  );
}

/**
 * End a surface's access: back to `approved` with the reason, and the event. A credential Day0
 * itself obtained is revoked at its vendor and leaves the card (D4, A26; S1: a Slack bot token is
 * revoked and the app kept, so the renewal reinstalls the same app); a pasted key stays on the
 * card for the renewal and is never sent to a vendor (A27, D5). Either way the card's system gets
 * its ledger line.
 *
 * Args:
 *   ctx: Mutation context.
 *   surface: A surface whose end date has passed.
 *   now: When the end was observed.
 */
async function endAccessInTransaction(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  now: number,
): Promise<void> {
  const ended = await endOwnCredentialAtSource(ctx, surface, 'expiry', now);
  await ctx.db.patch(surface._id, {
    verdict: 'approved',
    reason: 'expired',
    credentialLanded: false,
    lastVerifiedAt: undefined,
    // The end of access ends the probe in flight: whatever it finds lands on
    // no generation, so neither it nor a renewal after it can reconnect the
    // card on an answer taken before the end (wave 2 review M20, m9).
    probeGeneration: (surface.probeGeneration ?? 0) + 1,
    probeStartedAt: undefined,
    ...(ended.held.length > 0 || ended.stopped.length > 0
      ? { credentialId: undefined, credentialKind: undefined, credentialLocation: undefined }
      : {}),
  });
  // The end date is on the event so the upgrade can tell this release's end
  // of a proposal-started clock from an end the older code recorded.
  await appendEvent(ctx, {
    agentId: surface.agentId,
    type: 'surface.expired',
    payload: {
      surfaceId: surface._id,
      expiresAt: surface.expiresAt,
      ...(ended.held.length > 0 ? { revokedAtSource: true } : {}),
    },
    createdAt: now,
  });
}

/**
 * Refuse a probe result that lands on or after the access end date.
 *
 * `beginProbe` refuses a probe that starts after the date; one reserved
 * before it can land after it. The access is ended here if the sweep has not
 * ended it yet, so the refusal leaves the row as the sweep would.
 *
 * Args:
 *   ctx: Mutation context of the probe's result.
 *   surface: The surface the probe reserved.
 *
 * Returns:
 *   True when the end date has passed and the result must not be written.
 */
async function endedBeforeProbeLanded(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
): Promise<boolean> {
  const now = Date.now();
  if (!accessEndDatePassed(surface, now)) return false;
  if (surface.reason !== 'expired') await endAccessInTransaction(ctx, surface, now);
  return true;
}

/**
 * Whether this release's code ended the surface's access, rather than the code
 * before it: the latest `surface.expired` event for it carries the end date.
 */
async function endedByThisRelease(ctx: MutationCtx, surface: Doc<'surfaces'>): Promise<boolean> {
  for await (const event of eventsOfType(ctx, surface.agentId, 'surface.expired').order('desc')) {
    const payload = event.payload as { surfaceId?: unknown; expiresAt?: unknown } | undefined;
    if (payload?.surfaceId === surface._id) return typeof payload.expiresAt === 'number';
  }
  return false;
}

/**
 * Record who set a surface's access end date, and to what.
 *
 * The one event type is also the backfill's marker: a surface with one has a
 * clock this release started, which the upgrade must not restart.
 */
async function logAccessSet(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  entry: { by: AccessSetBy; days: number; expiresAt: number; at: number } & Record<string, unknown>,
): Promise<void> {
  const { at, ...payload } = entry;
  await appendEvent(ctx, {
    agentId: surface.agentId,
    type: 'surface.access-set',
    payload: { surfaceId: surface._id, ...payload },
    createdAt: at,
  });
}

/**
 * Whether an event of one type names this surface, and, when asked, this end date.
 *
 * Args:
 *   ctx: Mutation context.
 *   surface: The surface.
 *   type: The event type.
 *   expiresAt: The end date the event must carry, when it matters.
 *
 * Returns:
 *   True when such an event exists.
 */
async function surfaceEventExists(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  type: EventType,
  expiresAt?: number,
): Promise<boolean> {
  for await (const event of eventsOfType(ctx, surface.agentId, type).order('desc')) {
    const payload = event.payload as { surfaceId?: unknown; expiresAt?: unknown } | undefined;
    if (
      payload?.surfaceId === surface._id &&
      (expiresAt === undefined || payload.expiresAt === expiresAt)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the manager revoked this read scope after the card was last approved.
 *
 * Args:
 *   ctx: Mutation context.
 *   surface: The surface reconnecting.
 *   readScope: Its `<slug>:read` scope.
 *
 * Returns:
 *   True when no grant of the scope is active and one was revoked at or
 *   after the manager's approval.
 */
async function readRevokedSinceApproval(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  readScope: string,
): Promise<boolean> {
  const approvedAt = surface.managerApprovedAt ?? 0;
  const grants = await ctx.db
    .query('permissionGrants')
    .withIndex('by_agent_scope', (index) =>
      index.eq('agentId', surface.agentId).eq('scope', readScope),
    )
    .collect();
  if (grants.some((grant) => grant.revokedAt === undefined)) return false;
  return grants.some((grant) => grant.revokedAt !== undefined && grant.revokedAt >= approvedAt);
}

/** Demote a surface whose access has ended until the manager renews it. */
export const recordExpired = internalMutation({
  args: { surfaceId: v.id('surfaces'), now: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface || surface.reason === 'expired' || !accessEndDatePassed(surface, args.now)) return;
    await endAccessInTransaction(ctx, surface, args.now);
  },
});

/** What a renewal needs beyond the new end date (11-AR; A26, A27). */
interface Renewal {
  /**
   * The identity the expiry revoked at the vendor, to be issued again: the install of the Slack
   * app Day0 created for the employee (11-AS), or a new authorisation (an employee's own Linear
   * app through `linearIdentityActions.startAuthorisation`, an MCP server through
   * `mcpOauthActions.startAuthorisation`).
   */
  readonly reissue?: 'install' | 'authorise';
  /** A pasted key whose system has an organisation connection: the move to its own identity. */
  readonly offer?: 'own-identity';
}

/** What `setAccessDays` answers: the end date, and what the renewal needs. */
type AccessDaysSet = { readonly expiresAt: number } & Renewal;

/**
 * How a card's identity is issued again after its expiry revoked it at the vendor: an app Day0
 * created and keeps (Slack's, 11-AS) through its install link; an employee's own Linear app, which
 * an administrator recorded rather than Day0 created, and an MCP authorisation through a new
 * authorisation (`linearIdentityActions.startAuthorisation` mints the Linear app's fresh link).
 */
function reissueOf(surface: Doc<'surfaces'>): 'install' | 'authorise' {
  return surface.provisioning !== undefined && organisationSystemOf(surface) !== 'linear'
    ? 'install'
    : 'authorise';
}

/**
 * What renewing an ended card needs: a card whose expiry revoked its credential at the vendor
 * (its latest `surface.expired` says so) needs it issued again; a card renewing a pasted key whose
 * system has an active organisation connection is offered the move to the employee's own identity.
 * The connection is read for the card's system, as the card reads it, since no path links a card
 * that holds a pasted key to a connection (the wave 11 review's M5).
 *
 * @param ctx - The renewal's transaction.
 * @param surface - The card as it stood before the renewal.
 */
async function renewalOf(ctx: MutationCtx, surface: Doc<'surfaces'>): Promise<Renewal> {
  const { db } = ctx;
  if (surface.credentialId === undefined) {
    for await (const event of eventsOfType(ctx, surface.agentId, 'surface.expired').order('desc')) {
      if (!isEventOf(event, 'surface.expired') || event.payload.surfaceId !== surface._id) continue;
      return event.payload.revokedAtSource === true ? { reissue: reissueOf(surface) } : {};
    }
    return {};
  }
  const credential = await db.get(surface.credentialId);
  if (credential === null || credential.issuedBy !== undefined || credential.holder !== undefined) {
    return {};
  }
  const system = organisationSystemOf(surface);
  if (system === undefined) return {};
  return !servedByIssuer(system) || (await activeConnectionFor(ctx, system)) === null
    ? {}
    : { offer: 'own-identity' };
}

/**
 * Set how long an approved surface's access lasts, from now (Q5).
 *
 * Public, owner-guarded, real mode only; the card's control. Setting the
 * length is also the explicit renewal: an ended access comes back to
 * `approved` with no reason and is probed at once. Writes `expiresAt` and a
 * `surface.access-set` event.
 *
 * The renewal's answer says what else it needs (A26, A27; the access plan,
 * section 4.12): where the expiry revoked at the vendor a credential Day0
 * obtained, there is nothing to probe, and the card asks for the identity to
 * be issued again (`reissue`: the same app's install for one Day0 created,
 * else a new authorisation); where the card renews a pasted key and its system
 * has an active organisation connection, it offers the move to the employee's
 * own identity (`offer`), and the key keeps working meanwhile.
 *
 * @throws ConvexError when the card is not approved yet or the length is not
 * a whole number of days from 1 to 365.
 */
export const setAccessDays = mutation({
  args: { surfaceId: v.id('surfaces'), days: v.number() },
  handler: async (ctx, args): Promise<AccessDaysSet> => {
    assertRealMode('Setting surface access');
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new ConvexError('Surface not found.');
    await assertOwnsAgent(ctx, surface.agentId);
    if (!ACCESS_VERDICTS.includes(surface.verdict)) {
      throw new ConvexError(
        `Access length is set once the card is approved; this one is ${surface.verdict}.`,
      );
    }
    if (!Number.isInteger(args.days) || args.days < 1 || args.days > SURFACE_ACCESS_MAX_DAYS) {
      throw new ConvexError(
        `Access length must be a whole number of days from 1 to ${SURFACE_ACCESS_MAX_DAYS}.`,
      );
    }
    const now = Date.now();
    const expiresAt = now + args.days * DAY_MS;
    const renewed = surface.reason === 'expired';
    await ctx.db.patch(surface._id, {
      expiresAt,
      accessSetBy: 'manager',
      ...(renewed ? { reason: undefined } : {}),
    });
    const renewal = renewed ? await renewalOf(ctx, surface) : {};
    await logAccessSet(ctx, surface, {
      by: 'manager',
      days: args.days,
      expiresAt,
      renewed,
      ...renewal,
      at: now,
    });
    if (renewed && renewal.reissue === undefined) {
      await ctx.scheduler.runAfter(0, internal.surfaceActions.probeInternal, {
        surfaceId: surface._id,
      });
    }
    return { expiresAt, ...renewal };
  },
});

/**
 * Tell the manager, once per end date, that a surface's access ends within a week.
 *
 * Internal; the hourly re-probe sweep's. The week is counted in the agent's
 * zone (N12): the notice is due from the start of the day a week before the
 * end date there, and the event names that day. Writes one `surface.expiring`
 * event per end date, so a date the manager moves is noticed again.
 *
 * Returns:
 *   Whether a notice was written.
 */
export const recordExpiryNotice = internalMutation({
  args: { surfaceId: v.id('surfaces'), now: v.number() },
  handler: async (ctx, args): Promise<boolean> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (
      !surface ||
      !ACCESS_VERDICTS.includes(surface.verdict) ||
      surface.reason === 'expired' ||
      surface.expiresAt === undefined
    ) {
      return false;
    }
    const agent = await ctx.db.get(surface.agentId);
    if (!agent) return false;
    const zone = agentZone(agent);
    if (!expiryNoticeDue(args.now, surface.expiresAt, zone)) return false;
    if (await surfaceEventExists(ctx, surface, 'surface.expiring', surface.expiresAt)) return false;
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.expiring',
      payload: {
        surfaceId: surface._id,
        expiresAt: surface.expiresAt,
        noticeDay: expiryNoticeDay(surface.expiresAt, zone),
      },
      createdAt: args.now,
    });
    return true;
  },
});

/**
 * One page of the `surfaces-access-clock` migration: restart the access clock
 * of every approved card at the default length from the upgrade (Q5).
 *
 * Before this release the clock started at proposal, so an approved,
 * connected, ungranted or listed-dead row's end date is the model's length
 * counted from before the manager approved. Each such row gets
 * `SURFACE_ACCESS_DEFAULT_DAYS` from the upgrade. A row with a
 * `surface.access-set` event already has a clock this release set and is left
 * alone, which also makes a second run a no-op. An access the older code ended
 * stays ended until a manager renews it; one this release's code ended on the
 * proposal-started clock, between the upgrade's push and this page, is
 * restarted and probed again, as if the page had run first. Run by
 * `migrations:runPending`.
 *
 * @param cursor - Where the previous page stopped, or null for the first.
 * @param now - The upgrade's moment, from which the new clocks run.
 * @returns What the page read and changed, and where the next one starts.
 */
export async function restartAccessClocksPage(
  ctx: MutationCtx,
  cursor: string | null,
  now: number,
): Promise<{ read: number; changed: number; cursor: string; isDone: boolean }> {
  const page = await ctx.db.query('surfaces').paginate({ cursor, numItems: ACCESS_BACKFILL_BATCH });
  let changed = 0;
  for (const surface of page.page) {
    if (!ACCESS_VERDICTS.includes(surface.verdict)) continue;
    if (await surfaceEventExists(ctx, surface, 'surface.access-set')) continue;
    const ended = surface.reason === 'expired';
    if (ended && !(await endedByThisRelease(ctx, surface))) continue;
    const expiresAt = now + SURFACE_ACCESS_DEFAULT_DAYS * DAY_MS;
    await ctx.db.patch(surface._id, {
      expiresAt,
      accessSetBy: 'upgrade',
      ...(ended ? { reason: undefined } : {}),
    });
    await logAccessSet(ctx, surface, {
      by: 'upgrade',
      days: SURFACE_ACCESS_DEFAULT_DAYS,
      from: surface.expiresAt,
      expiresAt,
      ...(ended ? { renewed: true } : {}),
      at: now,
    });
    if (ended) {
      await ctx.scheduler.runAfter(0, internal.surfaceActions.probeInternal, {
        surfaceId: surface._id,
      });
    }
    changed += 1;
  }
  return {
    read: page.page.length,
    changed,
    cursor: page.continueCursor,
    isDone: page.isDone,
  };
}

/**
 * One page of the `surfaces-access-set-by` migration: give every card with an
 * access end date the setter its newest `surface.access-set` event names, or
 * `upgrade` when it has none (a date the proposal-started clock left and no
 * event recorded). Run by `migrations:runPending`.
 *
 * @param cursor - Where the previous page stopped, or null for the first.
 * @returns What the page read and changed, and where the next one starts.
 */
export async function backfillAccessSetByPage(
  ctx: MutationCtx,
  cursor: string | null,
): Promise<{ read: number; changed: number; cursor: string; isDone: boolean }> {
  const page = await ctx.db.query('surfaces').paginate({ cursor, numItems: ACCESS_BACKFILL_BATCH });
  let changed = 0;
  for (const surface of page.page) {
    if (surface.expiresAt === undefined || surface.accessSetBy !== undefined) continue;
    await ctx.db.patch(surface._id, {
      accessSetBy: (await latestAccessSetter(ctx, surface)) ?? 'upgrade',
    });
    changed += 1;
  }
  return {
    read: page.page.length,
    changed,
    cursor: page.continueCursor,
    isDone: page.isDone,
  };
}

/** Surfaces one page of the withheld-tools backfill reads; each may walk its agent's events. */
const WITHHELD_BACKFILL_BATCH = 20;

/**
 * The newest `surface.connected` events of one agent a backfill walks for a
 * card's own: the hourly re-probe writes one per connected card an hour, so a
 * connected card's newest is among the agent's last few hundred. A card whose
 * event is further back is left as withholding nothing.
 */
const CONNECTED_EVENT_WALK = 200;

/** A `surface.connected` event as the contract types it. */
type SurfaceConnectedEvent = Doc<'events'> & EventOf<'surface.connected'>;

/**
 * The newest `surface.connected` event of one card among its agent's last
 * `CONNECTED_EVENT_WALK`, or undefined when none is that near: the card then
 * reads as never connected.
 *
 * @param ctx - A migration's context.
 * @param surface - The card.
 */
export async function newestConnectedEvent(
  ctx: Pick<MutationCtx, 'db'>,
  surface: Doc<'surfaces'>,
): Promise<SurfaceConnectedEvent | undefined> {
  const events = await eventsOfType(ctx, surface.agentId, 'surface.connected')
    .order('desc')
    .take(CONNECTED_EVENT_WALK);
  for (const event of events) {
    if (isEventOf(event, 'surface.connected') && event.payload.surfaceId === surface._id) {
      return event;
    }
  }
  return undefined;
}

/**
 * One page of the `surfaces-withheld-tools` migration (K D2 (b)). A connected
 * card's withheld tools were carried only on its newest `surface.connected`
 * event; they are copied onto the row, less any tool the manager approved
 * since, so the card reads the row however busy the feed is. Run by
 * `migrations:runPending`.
 *
 * @param cursor - Where the previous page stopped, or null for the first.
 * @returns What the page read and changed, and where the next one starts.
 */
export async function backfillWithheldToolsPage(
  ctx: MutationCtx,
  cursor: string | null,
): Promise<{ read: number; changed: number; cursor: string; isDone: boolean }> {
  const page = await ctx.db
    .query('surfaces')
    .paginate({ cursor, numItems: WITHHELD_BACKFILL_BATCH });
  let changed = 0;
  for (const surface of page.page) {
    if (surface.verdict !== 'connected' || surface.withheldTools !== undefined) continue;
    const offered: readonly string[] =
      (await newestConnectedEvent(ctx, surface))?.payload.withheldTools ?? [];
    const approved = new Set(surface.approvedToolAllowlist ?? []);
    const withheld = offered.filter((tool) => !approved.has(tool));
    if (withheld.length === 0) continue;
    await ctx.db.patch(surface._id, { withheldTools: withheld });
    changed += 1;
  }
  return {
    read: page.page.length,
    changed,
    cursor: page.continueCursor,
    isDone: page.isDone,
  };
}

/**
 * One page of the `surfaces-single-approval` migration (Q10, N10). The IT
 * approval is gone, so a proposed card an older release left with the
 * manager's stamp alone is approved, as the manager's approval now does it,
 * its access running from the upgrade (`accessSetBy: 'upgrade'`); and no card
 * keeps an IT stamp, so the release after this one can remove the
 * declaration. A card whose approval would now be refused (a documented queue
 * it reads changed, or its browser component is absent) stays proposed
 * without the stamp and says why, so the manager approves it once it can be.
 * Run by `migrations:runPending`.
 *
 * @param cursor - Where the previous page stopped, or null for the first.
 * @param now - The upgrade's moment, from which an approved card's access runs.
 * @returns What the page read and changed, and where the next one starts.
 */
export async function singleApprovalPage(
  ctx: MutationCtx,
  cursor: string | null,
  now: number,
): Promise<{ read: number; changed: number; cursor: string; isDone: boolean }> {
  const page = await ctx.db.query('surfaces').paginate({ cursor, numItems: ACCESS_BACKFILL_BATCH });
  let changed = 0;
  for (const surface of page.page) {
    const approvedAt = surface.verdict === 'proposed' ? surface.managerApprovedAt : undefined;
    if (approvedAt === undefined && surface.itApprovedAt === undefined) continue;
    if (surface.itApprovedAt !== undefined) {
      await ctx.db.patch(surface._id, { itApprovedAt: undefined });
    }
    if (approvedAt !== undefined) {
      const check = await approvalCheck(ctx, surface);
      if (check.refusal === undefined) {
        await approveInTransaction(ctx, surface, {
          approvedAt,
          now,
          by: 'upgrade',
          intakeScope: check.intakeScope,
        });
      } else {
        // A browser card refused for its absent driver stores nothing: the card
        // reads the component live, so it offers Approve again once the driver
        // runs. A stored absence would block it for good (wave 3.5 review M12).
        await ctx.db.patch(surface._id, {
          managerApprovedAt: undefined,
          ...(check.refusal === INTAKE_QUEUE_CHANGED ? { reason: check.refusal } : {}),
        });
      }
    }
    changed += 1;
  }
  return {
    read: page.page.length,
    changed,
    cursor: page.continueCursor,
    isDone: page.isDone,
  };
}

/** Who set a surface's end date last, by its newest `surface.access-set` event. */
async function latestAccessSetter(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
): Promise<AccessSetBy | undefined> {
  for await (const event of eventsOfType(ctx, surface.agentId, 'surface.access-set').order(
    'desc',
  )) {
    if (!isEventOf(event, 'surface.access-set') || event.payload.surfaceId !== surface._id)
      continue;
    const by: unknown = event.payload.by;
    return by === 'approval' || by === 'manager' || by === 'upgrade' ? by : undefined;
  }
  return undefined;
}

/** Record this poll's waterfall position and visible skip outcome. */
export const recordIntake = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    waterfallPosition: v.number(),
    skipReason: v.optional(v.string()),
    polledAt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) return;
    await ctx.db.patch(surface._id, {
      waterfallPosition: args.waterfallPosition,
      intakeSkipReason: args.skipReason,
      lastPolledAt:
        args.polledAt === undefined
          ? surface.lastPolledAt
          : Math.max(surface.lastPolledAt ?? 0, args.polledAt),
    });
  },
});

/** What approving a proposed card would do now: why it is refused, or the scope it stores. */
interface ApprovalCheck {
  /** Why `approve` refuses the card now, or undefined when it can be approved. */
  readonly refusal?: string;
  /** The card's scope with each value pointing at the line that states it now, to store on approval. */
  readonly intakeScope?: Doc<'surfaces'>['intakeScope'];
}

/**
 * Judge a proposed card for approval as its card is listed: every documented intake queue value
 * still stated, read by value from the pages the employee's cards read (the list's own read and
 * rule, so Approve is refused exactly when the list says it would be), and a browser-driven card
 * with the component that drives it.
 */
async function approvalCheck(ctx: QueryCtx, surface: Doc<'surfaces'>): Promise<ApprovalCheck> {
  if (!surface.intakeScope) return { refusal: browserRefusal(surface) };
  const agent = await ctx.db.get(surface.agentId);
  const cards = await ctx.db
    .query('surfaces')
    .withIndex('by_agent', (index) => index.eq('agentId', surface.agentId))
    .take(CARD_SURFACE_LIMIT);
  const pages = agent ? await readCardPages(ctx, agent, cards) : [];
  const restated = restatedScope(surface.intakeScope, pages);
  return {
    refusal: intakeQueueRefusal(restated.drift) ?? browserRefusal(surface),
    intakeScope: restated.scope,
  };
}

/** Why a browser-driven card cannot be approved on this deployment now: its driver is not configured or not listening. */
function browserRefusal(surface: Doc<'surfaces'>): string | undefined {
  return surface.path === 'browser-driven'
    ? browserComponentRefusal(process.env.DAY0_BROWSER_MCP_URL)
    : undefined;
}

/** One approval to apply: when the manager gave it, when access starts, and who set the end date. */
interface Approval {
  /** When the manager approved: now at the card, the older release's stamp at the upgrade. */
  readonly approvedAt: number;
  /** When the access clock starts. */
  readonly now: number;
  /** `approval` for the card's button, `upgrade` for a card an older release left half approved. */
  readonly by: Extract<AccessSetBy, 'approval' | 'upgrade'>;
  /** The scope restated against its pages now, stored so intake reads the lines approved. */
  readonly intakeScope?: Doc<'surfaces'>['intakeScope'];
}

/**
 * Approve a proposed card in the caller's transaction (Q10): the manager's
 * stamp, the verdict, an access end date Q5's 90 days from `now` (the
 * manager moves it with `setAccessDays`), the `surface.access-set` and
 * `surface.approved` events, and a probe at once.
 */
async function approveInTransaction(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  approval: Approval,
): Promise<void> {
  const expiresAt = approval.now + SURFACE_ACCESS_DEFAULT_DAYS * DAY_MS;
  await ctx.db.patch(surface._id, {
    verdict: 'approved',
    managerApprovedAt: approval.approvedAt,
    expiresAt,
    accessSetBy: approval.by,
    ...(approval.intakeScope === undefined ? {} : { intakeScope: approval.intakeScope }),
  });
  await logAccessSet(ctx, surface, {
    by: approval.by,
    days: SURFACE_ACCESS_DEFAULT_DAYS,
    expiresAt,
    at: approval.now,
  });
  await appendEvent(ctx, {
    agentId: surface.agentId,
    type: 'surface.approved',
    payload: { surfaceId: surface._id },
    createdAt: approval.now,
  });
  await ctx.scheduler.runAfter(0, internal.surfaceActions.probeInternal, {
    surfaceId: surface._id,
  });
}

/**
 * Approve a proposed card: the manager's one approval (Q10).
 *
 * Public, owner-guarded, real mode only; the card's Approve button. Only a
 * proposed card can be approved: an absent, declared or already approved card
 * has nothing to approve, and a rejected one is re-proposed from evidence
 * first. Writes `managerApprovedAt`, the verdict `approved`, an access end
 * date Q5's 90 days from now (`accessSetBy: 'approval'`),
 * `surface.access-set` and `surface.approved`, and schedules the probe.
 *
 * @throws ConvexError when the card is not proposed, a documented intake
 *   queue it reads changed, or its browser-driven path has no component.
 */
export const approve = mutation({
  args: { surfaceId: v.id('surfaces') },
  handler: async (ctx, args): Promise<void> => {
    assertRealMode('Surface approval');
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new ConvexError('Surface not found.');
    await assertOwnsAgent(ctx, surface.agentId);
    if (surface.verdict !== 'proposed') {
      throw new ConvexError(
        `Only a proposed surface can be approved; this one is ${surface.verdict}.`,
      );
    }
    const check = await approvalCheck(ctx, surface);
    if (check.refusal !== undefined) throw new ConvexError(check.refusal);
    const now = Date.now();
    await approveInTransaction(ctx, surface, {
      approvedAt: now,
      now,
      by: 'approval',
      intakeScope: check.intakeScope,
    });
  },
});

/**
 * End at the vendor what a rejected card bound (11-AR; D4): every credential it binds that no
 * other card binds, its app's client secret and its token's pair included, so an app Day0 created
 * is deleted (S4) and its tokens revoked. A pasted key is never sent to a vendor and stays in the
 * owner's store, as the rejection always left it; its line says so.
 *
 * @param ctx - The rejection's transaction.
 * @param surface - The card as it stood before the rejection.
 * @param now - The rejection's time.
 */
async function endRejectedAtSource(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  now: number,
): Promise<void> {
  // A token another card still binds is not this card's to end, nor is its pair; a pasted one is
  // listed all the same, for its line, and stays in the owner's store either way.
  const token = surface.credentialId === undefined ? null : await ctx.db.get(surface.credentialId);
  const binders =
    token === null
      ? []
      : await ctx.db
          .query('surfaces')
          .withIndex('by_credentialId', (q) => q.eq('credentialId', token._id))
          .take(2);
  const tokenEndsHere =
    token !== null &&
    (token.issuedBy === undefined || binders.every((binder) => binder._id === surface._id));
  const bound = await credentialsBoundBy(ctx.db, [
    {
      credentialId: tokenEndsHere ? surface.credentialId : undefined,
      provisioning: surface.provisioning,
    },
  ]);
  const rows = (await Promise.all([...bound].map(async (id) => await ctx.db.get(id)))).filter(
    (row): row is Doc<'credentials'> => row !== null,
  );
  if (rows.length === 0) return;
  await endAccessAtSource(ctx, {
    agentId: surface.agentId,
    surfaceId: surface._id,
    surfaceName: surface.displayName,
    credentials: rows,
    end: 'reject',
    now,
  });
}

/**
 * Reject a proposed or approved surface and return it to `declared`.
 *
 * The approval and every connection detail are cleared, so a later
 * re-proposal starts from evidence again and waits for a new approval. What
 * Day0 obtained for it is revoked at the vendor (`endRejectedAtSource`).
 */
export const reject = mutation({
  args: { surfaceId: v.id('surfaces'), reason: v.string() },
  handler: async (ctx, args): Promise<void> => {
    assertRealMode('Surface rejection');
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new ConvexError('Surface not found.');
    await assertOwnsAgent(ctx, surface.agentId);
    if (surface.verdict !== 'proposed' && surface.verdict !== 'approved') {
      throw new ConvexError(
        `Only a proposed or approved surface can be rejected; this one is ${surface.verdict}.`,
      );
    }
    const now = Date.now();
    await endRejectedAtSource(ctx, surface, now);
    await ctx.db.patch(surface._id, {
      verdict: 'declared',
      reason: args.reason,
      // The rejection ends any probe in flight with its generation.
      probeGeneration: (surface.probeGeneration ?? 0) + 1,
      probeStartedAt: undefined,
      request: undefined,
      managerApprovedAt: undefined,
      endpoint: undefined,
      path: undefined,
      fallbackPath: undefined,
      pathCandidates: undefined,
      probeAttempts: undefined,
      credentialId: undefined,
      credentialKind: undefined,
      credentialLocation: undefined,
      managerDmChannelId: undefined,
      managerUserId: undefined,
      managerName: undefined,
      toolAllowlist: undefined,
      withheldTools: undefined,
      approvedToolAllowlist: undefined,
      toolAllowlistApprovedAt: undefined,
      toolArguments: undefined,
      providerIdentityId: undefined,
      providerWorkspaceId: undefined,
      // This deployment forgets the dedicated app, so a re-proposal provisions afresh rather than
      // installing into an app nobody has re-approved; an app Day0 created is deleted at the
      // vendor with it (endRejectedAtSource), so none is left dead in the workspace.
      provisioning: undefined,
      channelsNotJoined: undefined,
      waterfallPosition: undefined,
      intakeSkipReason: undefined,
      intakeScope: undefined,
      lastPolledAt: undefined,
      credentialLanded: false,
      lastVerifiedAt: undefined,
      expiresAt: undefined,
      accessSetBy: undefined,
    });
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.rejected',
      payload: { surfaceId: surface._id, reason: args.reason },
      createdAt: now,
    });
    await requeueWorkAfterRejection(ctx, surface, now);
  },
});

/** The reason a card the manager disconnected shows until it connects again. */
export const DISCONNECTED_REASON = 'Disconnected by the manager.';

/** Who ended a card's connection: the manager on its card, or IT revoking the organisation's. */
type DisconnectedBy = 'manager' | 'organisation';

/**
 * Disconnect a card in the caller's transaction: it keeps its approval and its app and holds no
 * credential, with the reason; any probe in flight ends with its generation. What Day0 obtained is
 * revoked at the vendor and a pasted key left where it is (`endOwnCredentialAtSource`), with the
 * system's ledger line, and `surface.disconnected` says who disconnected it.
 *
 * @param ctx - The disconnecting transaction.
 * @param surface - The card as it stands.
 * @param by - Who disconnected it, the end at the vendor, and the reason the card shows.
 * @param now - When it was disconnected.
 */
async function disconnectInTransaction(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  by: { readonly who: DisconnectedBy; readonly end: AccessEnd; readonly reason: string },
  now: number,
): Promise<void> {
  await endOwnCredentialAtSource(ctx, surface, by.end, now);
  await ctx.db.patch(surface._id, {
    verdict: ACCESS_VERDICTS.includes(surface.verdict) ? 'approved' : surface.verdict,
    reason: by.reason,
    credentialId: undefined,
    credentialKind: undefined,
    credentialLocation: undefined,
    credentialLanded: false,
    lastVerifiedAt: undefined,
    probeGeneration: (surface.probeGeneration ?? 0) + 1,
    probeStartedAt: undefined,
  });
  await appendEvent(ctx, {
    agentId: surface.agentId,
    type: 'surface.disconnected',
    payload: {
      surfaceId: surface._id,
      by: by.who,
      ...(by.who === 'organisation' ? { reason: by.reason } : {}),
    },
    createdAt: now,
  });
}

/**
 * Disconnect a card (11-AR; the access plan, section 4.4): the card's Disconnect, which the card
 * confirms in a dialog before it calls this. Public, owner-guarded, real mode only. The card keeps
 * its approval and its app; what Day0 obtained for it is revoked at the vendor, a pasted key is
 * never sent to one; writes the card, the credentials' revocation, the ledger line and
 * `surface.disconnected`.
 *
 * @throws ConvexError when the card holds no credential.
 */
export const disconnect = mutation({
  args: { surfaceId: v.id('surfaces') },
  handler: async (ctx, args): Promise<void> => {
    assertRealMode('Disconnecting a connection');
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new ConvexError('Surface not found.');
    await assertOwnsAgent(ctx, surface.agentId);
    if (surface.credentialId === undefined) {
      throw new ConvexError('This connection holds no credential to disconnect.');
    }
    await disconnectInTransaction(
      ctx,
      surface,
      { who: 'manager', end: 'disconnect', reason: DISCONNECTED_REASON },
      Date.now(),
    );
  },
});

/** The most cards one organisation connection's revoke ends in its transaction. */
export const CONNECTION_CARD_LIMIT = 1_000;

/**
 * End every card on an organisation connection the administrator revoked (11-AR for 11-AO's
 * revoke; the access plan, section 8, cross-unit test 3): each card linked to it is disconnected
 * with the administrator's reason, what Day0 obtained through it revoked at the vendor, and no
 * card of any other connection is read. Called in the revoke's own transaction.
 *
 * @param ctx - The revoking transaction.
 * @param input - The connection, the reason each card shows, and the revoke's time.
 * @returns The cards ended.
 * @throws ConvexError when more cards are linked than one transaction ends.
 */
export async function endCardsOnConnection(
  ctx: MutationCtx,
  input: {
    readonly organisationConnectionId: Id<'organisationConnections'>;
    readonly reason: string;
    readonly now: number;
  },
): Promise<Id<'surfaces'>[]> {
  const cards = await ctx.db
    .query('surfaces')
    .withIndex('by_organisation_connection', (q) =>
      q.eq('organisationConnectionId', input.organisationConnectionId),
    )
    .take(CONNECTION_CARD_LIMIT + 1);
  if (cards.length > CONNECTION_CARD_LIMIT) {
    throw new ConvexError(
      `More than ${CONNECTION_CARD_LIMIT} connections use this organisation connection; revoke it again once some are removed.`,
    );
  }
  for (const card of cards) {
    await disconnectInTransaction(
      ctx,
      card,
      { who: 'organisation', end: 'organisation-revoked', reason: input.reason },
      input.now,
    );
  }
  return cards.map((card) => card._id);
}

/** The most tools one approved list names; a provider's catalogue is a few dozen. */
const APPROVED_TOOLS_LIMIT = 200;

/**
 * Approve the tools a connected surface may call, by the manager's explicit
 * act: the one way an approved list widens (U10 D2 (b), wave 2 review M2).
 *
 * Public, owner-guarded, real mode only; the card's re-approval control. The
 * list replaces the approved one, is recorded as `surface.tools-approved`
 * with what it added and removed. A tool taken off leaves the stored list at
 * once; the surface is probed at once so the tools the provider offers from
 * the new list reach the row, and no tool the provider does not offer is
 * ever stored. A list that changed stamps "Re-check due" on the employee's
 * registered skills that act on the surface (A13, `skill.recheck-due`).
 *
 * @throws ConvexError when the surface is not connected, or the list is
 *   empty, repeats a tool or passes the limit.
 */
export const approveTools = mutation({
  args: { surfaceId: v.id('surfaces'), tools: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ approved: string[] }> => {
    assertRealMode('Approving surface tools');
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new ConvexError('Surface not found.');
    await assertOwnsAgent(ctx, surface.agentId);
    if (surface.verdict !== 'connected') {
      throw new ConvexError(
        `Tools are approved on a connected card; this one is ${surface.verdict}.`,
      );
    }
    const tools = args.tools.map((tool) => tool.trim());
    if (tools.length === 0 || tools.some((tool) => tool === '')) {
      throw new ConvexError('Name at least one tool, and no empty one.');
    }
    if (new Set(tools).size !== tools.length) {
      throw new ConvexError('Name each tool once.');
    }
    if (tools.length > APPROVED_TOOLS_LIMIT) {
      throw new ConvexError(`Approve at most ${APPROVED_TOOLS_LIMIT} tools on one card.`);
    }
    const before = new Set(surface.approvedToolAllowlist ?? surface.toolAllowlist ?? []);
    const approved = new Set(tools);
    const now = Date.now();
    // A tool the manager took off is uncallable at once; one added waits for
    // the probe, so only a tool the provider offers is ever stored. A withheld
    // tool the manager approved is no longer withheld, only not probed yet.
    const stillWithheld = (surface.withheldTools ?? []).filter((tool) => !approved.has(tool));
    await ctx.db.patch(surface._id, {
      approvedToolAllowlist: tools,
      toolAllowlistApprovedAt: now,
      toolAllowlist: (surface.toolAllowlist ?? []).filter((tool) => approved.has(tool)),
      toolArguments: (surface.toolArguments ?? []).filter((entry) => approved.has(entry.tool)),
      withheldTools: stillWithheld.length > 0 ? stillWithheld : undefined,
    });
    const added = tools.filter((tool) => !before.has(tool));
    const removed = [...before].filter((tool) => !tools.includes(tool));
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.tools-approved',
      payload: { surfaceId: surface._id, tools, added, removed },
      createdAt: now,
    });
    // A changed list is a change the employee's skills on this surface were not checked against
    // (A13): each is due a re-check, and keeps running meanwhile.
    if (added.length > 0 || removed.length > 0) {
      await stampRecheckDueOnSurfaces(ctx, {
        agentId: surface.agentId,
        slugs: [surface.slug],
        reasonFor: allowlistChangedReason,
        now,
      });
    }
    await ctx.scheduler.runAfter(0, internal.surfaceActions.probeInternal, {
      surfaceId: surface._id,
    });
    return { approved: tools };
  },
});

/**
 * Whether this deployment has a public address an OAuth install can return to.
 *
 * The card needs to know before it offers to register an app, and the answer
 * belongs to the deployment that would call the provider rather than to the
 * browser or the Next process. It is a boolean by design: the address itself
 * says where this machine is reachable and is nobody's business but the
 * operator's until an install link carries it.
 */
export const installRedirectConfigured = query({
  args: {},
  handler: async (): Promise<boolean> => publicUrlConfigured(),
});

/** Whether this deployment has a public address for a dedicated app's install to return to. */
function publicUrlConfigured(): boolean {
  return (process.env.DAY0_PUBLIC_URL ?? '').trim() !== '';
}

/**
 * Re-run orientation for the owner's declared surfaces.
 *
 * Orientation otherwise runs only from charter approval, so a rejected
 * surface would have no way back to `proposed` short of re-approving the
 * charter. Real mode only, like the run it triggers.
 */
export const reorient = action({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<{ scheduled: number }> => {
    await assertOwnsAgentAction(ctx, args.agentId);
    assertRealMode('Surface orientation');
    return await ctx.runAction(internal.orientationActions.run, {
      agentId: args.agentId,
      byManager: true,
    });
  },
});

// ---------- The handover's cut (transfer plan 6.3; D5 (a), A25) ----------

/**
 * The credentials surfaces bind: each connection credential and each Slack app's client secret,
 * and, through each bound row, the refresh token paired with it and the client secret of the app
 * it was issued to (11-AK item 1), so a retire or a handover that ends a token ends its pair and
 * its app's secret with it. A pointer whose row is gone is still named, as the card's own are.
 *
 * @param db - The retire's, the handover's or a preview's reader.
 * @param surfaces - Surface rows, of one employee or of several.
 */
export async function credentialsBoundBy(
  db: QueryCtx['db'],
  surfaces: readonly Pick<Doc<'surfaces'>, 'credentialId' | 'provisioning'>[],
): Promise<Set<Id<'credentials'>>> {
  const bound = new Set<Id<'credentials'>>();
  const unread: Id<'credentials'>[] = [];
  const add = (id: Id<'credentials'> | undefined): void => {
    if (id === undefined || bound.has(id)) return;
    bound.add(id);
    unread.push(id);
  };
  for (const surface of surfaces) {
    add(surface.credentialId);
    add(surface.provisioning?.clientSecretCredentialId);
  }
  for (let id = unread.pop(); id !== undefined; id = unread.pop()) {
    const row = await db.get(id);
    add(row?.refreshCredentialId);
    add(row?.issuedBy?.clientSecretCredentialId);
  }
  return bound;
}

/** Why a cut card is back in `proposed`, on the card, when its route is no owner's documentation. */
export const HANDOVER_CUT_REASON =
  'Handed over to a new manager: approve this connection, then land a credential of your own.';

/**
 * Why a cut card is back in `proposed`, on the card, when the address it connected to came from
 * the previous manager's documentation and was cleared with it: approving it as it stands has
 * nowhere to connect, so the new manager proposes it again from their own documentation (a
 * rejection returns it to `declared`, where Propose orients it afresh).
 */
export const HANDOVER_CUT_REPROPOSE_REASON =
  "Handed over to a new manager: the address the previous manager's documentation gave for this connection did not come with it. Reject this card, then propose it again from your own documentation.";

/**
 * Where the card tells the new manager the credential is, in place of the old owner's documented
 * one: its label, page and finding are the old owner's documentation.
 */
export const HANDOVER_CREDENTIAL_LOCATION =
  "Land a credential of your own: the previous manager's was not handed over.";

/**
 * Why a card that kept the employee's own identity at a handover is back in `proposed`, on the
 * card (A25): the new manager re-approves it, with no credential to land.
 */
export const HANDOVER_REAPPROVE_REASON =
  "Handed over to a new manager: approve this connection again. It keeps acting as the employee's own identity, so there is no credential to land.";

/**
 * Why a card whose kept identity ended unapproved is in `proposed` with no credential, on the card
 * (the wave 11 review's m8): the new manager approves it and connects it afresh.
 */
export const KEPT_IDENTITY_ENDED_REASON =
  'Handed over and not approved again within 14 days, so the identity it kept was ended: approve this connection, then connect it again.';

/**
 * End the identity a handover kept on a card the new manager has not approved again within the
 * wait (`KEPT_IDENTITY_WAIT_MS`; A25, the wave 11 review's m8), in the caller's transaction: what
 * Day0 obtained is revoked at the vendor with the `transfer` end and the system's ledger line, as a
 * Disconnect revokes it, and the card keeps its app and waits at `proposed` with no credential and
 * no identity, for an approval that connects it afresh.
 *
 * @param ctx - The sweep's mutation context.
 * @param surface - A `proposed` card holding the identity a handover kept.
 * @param now - When the wait was found passed.
 */
export async function endKeptIdentity(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  now: number,
): Promise<void> {
  await endOwnCredentialAtSource(ctx, surface, 'transfer', now);
  await ctx.db.patch(surface._id, {
    reason: KEPT_IDENTITY_ENDED_REASON,
    credentialId: undefined,
    credentialKind: undefined,
    credentialLocation: undefined,
    credentialLanded: false,
    providerIdentityId: undefined,
    actsAs: undefined,
    lastVerifiedAt: undefined,
    probeGeneration: (surface.probeGeneration ?? 0) + 1,
    probeStartedAt: undefined,
  });
}

/** The most surfaces one employee's handover reads, the card's own bound. */
const HANDOVER_SURFACE_LIMIT = CARD_SURFACE_LIMIT;

/**
 * Every surface of an employee with what a handover would do to it, each decided with the
 * credential rows it binds.
 *
 * @param db - The move's or its preview's reader.
 * @param agentId - The employee.
 * @throws ConvexError, in words the acceptance dialog shows, when the employee has more surfaces
 *   than a handover reads.
 */
export async function surfaceHandoversOf(
  db: QueryCtx['db'],
  agentId: Id<'agents'>,
): Promise<{ surface: Doc<'surfaces'>; handover: SurfaceHandover }[]> {
  const surfaces = await db
    .query('surfaces')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .take(HANDOVER_SURFACE_LIMIT + 1);
  if (surfaces.length > HANDOVER_SURFACE_LIMIT) {
    throw new ConvexError(
      `This employee has more than ${HANDOVER_SURFACE_LIMIT} connections, more than one handover can move.`,
    );
  }
  return await Promise.all(
    surfaces.map(async (surface) => {
      const rows = await Promise.all(
        [...(await credentialsBoundBy(db, [surface]))].map(async (id) => await db.get(id)),
      );
      const bound = rows.filter((row): row is Doc<'credentials'> => row !== null);
      return { surface, handover: surfaceHandoverOf(surface, bound) };
    }),
  );
}

/** The documentation source a quote or an evidence entry names, when it names one. */
function namedSourceId(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const sourceId = (entry as { sourceId?: unknown }).sourceId;
  return typeof sourceId === 'string' ? sourceId : undefined;
}

/**
 * Every documentation source the quotes on these surfaces name: their evidence, their route
 * evidence, their intake scope and their drafted request.
 */
function quotedSourceIds(
  surfaces: readonly Pick<
    Doc<'surfaces'>,
    'discoveryEvidence' | 'whereFound' | 'intakeScope' | 'request'
  >[],
): Set<string> {
  const named = new Set<string>();
  const add = (entry: unknown): void => {
    const sourceId = namedSourceId(entry);
    if (sourceId !== undefined) named.add(sourceId);
  };
  for (const surface of surfaces) {
    for (const entry of surface.discoveryEvidence ?? []) add(entry);
    for (const entry of surface.whereFound) add(entry);
    const scope = surface.intakeScope;
    if (scope) {
      for (const entry of [
        scope.team,
        scope.project,
        ...(scope.projects ?? []),
        ...(scope.channels ?? []),
      ]) {
        add(entry);
      }
    }
    const evidence: unknown = (surface.request as { evidence?: unknown } | undefined)?.evidence;
    if (Array.isArray(evidence)) for (const entry of evidence) add(entry);
  }
  return named;
}

/**
 * A surface's quotes with every one of a documentation source the new owner does not hold left
 * out (the transfer plan, section 6.3): its documentation evidence, the documentation entries of
 * its route evidence and of its drafted request, and the intake scope values documentation
 * stated. The charter's evidence and the manager's own scope values stay. The request's
 * credential finding names the old owner's documented credential, so it becomes the new
 * manager's to land.
 *
 * @param surface - The surface before the move.
 * @param readable - The quoted sources the new owner holds.
 */
function withoutDepartedQuotes(
  surface: Doc<'surfaces'>,
  readable: ReadonlySet<string>,
): Pick<Doc<'surfaces'>, 'discoveryEvidence' | 'whereFound' | 'intakeScope' | 'request'> {
  const kept = (entry: unknown): boolean => {
    const sourceId = namedSourceId(entry);
    return sourceId === undefined || readable.has(sourceId);
  };
  const evidence = (surface.discoveryEvidence ?? []).filter(
    (entry) =>
      entry.kind === 'charter' || (entry.sourceId !== undefined && readable.has(entry.sourceId)),
  );
  const scope = surface.intakeScope;
  // The scope's notes are the model's words about the pages it read; they go when any did.
  const departed = [...quotedSourceIds([surface])].some((sourceId) => !readable.has(sourceId));
  return {
    discoveryEvidence: evidence.length > 0 ? evidence : undefined,
    whereFound: surface.whereFound.filter(kept),
    intakeScope: scope && {
      ...(scope.team && kept(scope.team) ? { team: scope.team } : {}),
      ...(scope.project && kept(scope.project) ? { project: scope.project } : {}),
      ...(scope.projects ? { projects: scope.projects.filter(kept) } : {}),
      ...(scope.channels ? { channels: scope.channels.filter(kept) } : {}),
      ...(scope.notes && !departed ? { notes: scope.notes } : {}),
    },
    request: requestWithoutDepartedQuotes(surface.request, kept),
  };
}

/**
 * A drafted request with the old owner's documentation left out: its evidence filtered, and its
 * credential finding replaced by the new manager's own landing.
 *
 * @param request - The surface's request, as orientation drafted it.
 * @param kept - Whether an evidence entry stays.
 */
function requestWithoutDepartedQuotes(
  request: unknown,
  kept: (entry: unknown) => boolean,
): unknown {
  if (typeof request !== 'object' || request === null) return request;
  const { evidence, credential, ...drafted } = request as Record<string, unknown>;
  const departed = Array.isArray(evidence) && !evidence.every(kept);
  const rest = departed ? withoutDraftedProse(drafted) : drafted;
  const method =
    typeof credential === 'object' && credential !== null
      ? (credential as { method?: unknown }).method
      : undefined;
  return {
    ...rest,
    ...(Array.isArray(evidence) ? { evidence: evidence.filter(kept) } : {}),
    ...(credential === undefined
      ? {}
      : {
          credential: {
            ...(method === undefined ? {} : { method }),
            found: 'location',
            location: HANDOVER_CREDENTIAL_LOCATION,
          },
        }),
  };
}

/** The words of a drafted request that the model wrote from the pages its evidence quotes. */
const DRAFTED_PROSE_FIELDS: ReadonlySet<string> = new Set([
  'openQuestions',
  'blastRadius',
  'rollback',
]);

/** The target's fields the model wrote from those pages: its reasoning and its ladder of addresses. */
const DRAFTED_TARGET_FIELDS: ReadonlySet<string> = new Set(['reasoning', 'ladder']);

/**
 * An object without the named fields.
 *
 * @param record - The object.
 * @param left - The fields to leave out.
 */
function withoutFields(
  record: Readonly<Record<string, unknown>>,
  left: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([field]) => !left.has(field)));
}

/**
 * A drafted request without the prose the model wrote from its evidence: the target's reasoning
 * and its ladder of documented addresses, the open questions, the blast radius and the rollback.
 * What remains names the system, the path chosen and the scopes, none of it a page's words.
 *
 * @param drafted - The request, its evidence and credential finding set aside by the caller.
 */
function withoutDraftedProse(drafted: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const kept = withoutFields(drafted, DRAFTED_PROSE_FIELDS);
  const target = drafted.target;
  if (typeof target !== 'object' || target === null) return kept;
  return {
    ...kept,
    target: withoutFields(target as Record<string, unknown>, DRAFTED_TARGET_FIELDS),
  };
}

/**
 * The route a handed-over card keeps (the wave 9 review's section 3): a documented address is
 * the old owner's documentation, a tenant's host among it, so the endpoint and the ladder go with
 * the quotes. An address Day0 fixes itself (`isDay0FixedEndpoint`: Slack's Web API base, the
 * Linear MCP server) is the same for every workspace and nobody's documentation, so it stays: the
 * new manager's chat card reconnects on it, which re-sends the decisions still open (the transfer
 * plan, section 6.4), and intake reads Linear only there.
 *
 * @param surface - The surface before the move.
 */
function routeAfterHandover(
  surface: Doc<'surfaces'>,
): Pick<Doc<'surfaces'>, 'endpoint' | 'pathCandidates'> {
  if (!isDay0FixedEndpoint(surface.endpoint)) {
    return { endpoint: undefined, pathCandidates: undefined };
  }
  const ladder = (surface.pathCandidates ?? []).filter((rung) =>
    isDay0FixedEndpoint(rung.endpoint),
  );
  return { endpoint: surface.endpoint, pathCandidates: ladder.length > 0 ? ladder : undefined };
}

/**
 * A drafted request without its target's ladder of documented addresses, for a cut card whose
 * route went with the old owner's documentation.
 *
 * @param request - The request with the departed quotes already left out.
 */
function requestWithoutLadder(request: unknown): unknown {
  if (typeof request !== 'object' || request === null) return request;
  const target = (request as Record<string, unknown>).target;
  if (typeof target !== 'object' || target === null) return request;
  return {
    ...request,
    target: withoutFields(target as Record<string, unknown>, new Set(['ladder'])),
  };
}

/**
 * The fields a cut clears: the credential, the provider's identities, the old manager's chat
 * binding and decision poll, the approval with the tools and the access clock it set, any probe
 * in flight with its generation, the probe attempts (their reasons quote the old manager's
 * address and the old owner's pages), and the documented route ({@link routeAfterHandover}). The path
 * stays; a card whose address went says so, since approving it as it stands connects nowhere.
 *
 * @param surface - The surface before the cut.
 */
function cutPatch(surface: Doc<'surfaces'>): Partial<Doc<'surfaces'>> {
  const route = routeAfterHandover(surface);
  const addressWent = surface.endpoint !== undefined && route.endpoint === undefined;
  return {
    verdict: 'proposed',
    reason: addressWent ? HANDOVER_CUT_REPROPOSE_REASON : HANDOVER_CUT_REASON,
    ...route,
    probeAttempts: undefined,
    probeGeneration: (surface.probeGeneration ?? 0) + 1,
    probeStartedAt: undefined,
    managerApprovedAt: undefined,
    credentialId: undefined,
    credentialKind: undefined,
    credentialLocation: undefined,
    credentialLanded: false,
    providerIdentityId: undefined,
    providerBotId: undefined,
    providerWorkspaceId: undefined,
    managerDmChannelId: undefined,
    managerUserId: undefined,
    managerName: undefined,
    lastDecisionPolledAt: undefined,
    lastDecisionError: undefined,
    toolAllowlist: undefined,
    withheldTools: undefined,
    approvedToolAllowlist: undefined,
    toolAllowlistApprovedAt: undefined,
    toolArguments: undefined,
    // The dedicated app stays in the old owner's workspace, which only its administrator can
    // change; this deployment forgets it, so the new manager's approval provisions afresh.
    provisioning: undefined,
    channelsNotJoined: undefined,
    intakeSkipReason: undefined,
    lastVerifiedAt: undefined,
    expiresAt: undefined,
    accessSetBy: undefined,
  };
}

/**
 * The fields a handover's re-approval clears (A25): everything {@link cutPatch} clears save the
 * employee's own identity, which stays on the card: its credential, the provider's identities, its
 * app and the channels its bot is in. A card whose address went says so, as a cut one does.
 *
 * @param surface - The surface before the move.
 */
function reapprovePatch(surface: Doc<'surfaces'>): Partial<Doc<'surfaces'>> {
  const patch = cutPatch(surface);
  return {
    ...patch,
    reason: patch.reason === HANDOVER_CUT_REASON ? HANDOVER_REAPPROVE_REASON : patch.reason,
    credentialId: surface.credentialId,
    credentialKind: surface.credentialKind,
    credentialLocation: surface.credentialLocation,
    providerIdentityId: surface.providerIdentityId,
    providerBotId: surface.providerBotId,
    providerWorkspaceId: surface.providerWorkspaceId,
    provisioning: surface.provisioning,
    channelsNotJoined: surface.channelsNotJoined,
  };
}

/**
 * Revoke the read grant a connection gave (`recordConnected`'s `<slug>:read`, source `surface`,
 * or no source on a row from before sources), so the scope comes back when the new manager's
 * connection lands. No `permission.revoked` event: that event is the manager's own revoke; the
 * handover's record names the scopes (`manager.transferred`).
 *
 * @returns The scope, when an active grant was revoked.
 */
async function revokeConnectionGrant(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  now: number,
): Promise<string | undefined> {
  const scope = `${surface.slug}:read`;
  const grants = await ctx.db
    .query('permissionGrants')
    .withIndex('by_agent_scope', (q) => q.eq('agentId', surface.agentId).eq('scope', scope))
    .collect();
  const active = grants.filter(
    (grant) =>
      grant.revokedAt === undefined && (grant.source === 'surface' || grant.source === undefined),
  );
  await Promise.all(active.map(async (grant) => await ctx.db.patch(grant._id, { revokedAt: now })));
  return active.length > 0 ? scope : undefined;
}

/** One surface a handover cut, as it stood before the cut. */
export interface CutSurface {
  readonly surfaceId: Id<'surfaces'>;
  readonly slug: string;
  readonly displayName: string;
  /** The credentials it bound, which the move sorts by the retire's rule. */
  readonly boundCredentials: readonly Id<'credentials'>[];
}

/** One surface a handover returned for re-approval with the employee's own identity kept (A25). */
export interface ReapprovedSurface {
  readonly surfaceId: Id<'surfaces'>;
  readonly slug: string;
  readonly displayName: string;
}

/** What {@link handOverSurfaces} did. */
export interface HandedOverSurfaces {
  readonly cut: readonly CutSurface[];
  /** The surfaces that kept the employee's own identity and wait for the new manager's approval. */
  readonly reapproved: readonly ReapprovedSurface[];
  /** The read scopes the cut connections had granted, revoked with them. */
  readonly scopesRevoked: readonly string[];
}

/**
 * Cut the employee's surfaces at a handover, in the move's transaction (the transfer plan,
 * section 6.3): each surface {@link surfaceHandoverOf} cuts goes back to `proposed` with the old
 * manager's credential, chat binding and approval cleared, its connection's read grant revoked
 * and a `surface.proposed` event, so the new manager's inbox asks for it; each surface that acts
 * as the employee's own identity obtained through IT's organisation connection goes back to
 * `proposed` the same way with that identity kept, for the new manager to re-approve (A25); every
 * surface loses the quotes of documentation the new owner does not hold. The credentials themselves, and the
 * pending jobs naming a cut surface, are the caller's: it sorts the first by the retire's rule
 * and cancels the second (`convex/reset.ts`), which this module cannot import.
 *
 * @param ctx - The move's mutation context.
 * @param input - The employee, the new owner's key, and the move's time.
 * @returns The cut surfaces with the credentials they bound, and the scopes revoked.
 */
export async function handOverSurfaces(
  ctx: MutationCtx,
  input: { readonly agentId: Id<'agents'>; readonly toOwnerKey: string; readonly now: number },
): Promise<HandedOverSurfaces> {
  const planned = await surfaceHandoversOf(ctx.db, input.agentId);
  const quoted = [...quotedSourceIds(planned.map(({ surface }) => surface))];
  const readable = new Set<string>();
  for (const sourceId of quoted) {
    const id = ctx.db.normalizeId('docSources', sourceId);
    const source = id === null ? null : await ctx.db.get(id);
    if (source?.userId === input.toOwnerKey) readable.add(sourceId);
  }
  const cut: CutSurface[] = [];
  const reapproved: ReapprovedSurface[] = [];
  const scopesRevoked: string[] = [];
  for (const { surface, handover } of planned) {
    const quotes = withoutDepartedQuotes(surface, readable);
    switch (handover) {
      case 'carry': {
        // The credential's documented location is the old owner's page text, up to 500
        // characters of it; a carried card was never probed, so its attempts are empty or stale;
        // its reason is the old manager's rejection or an orientation's words, save an absent
        // system's, which names only what was searched for.
        const route = routeAfterHandover(surface);
        await ctx.db.patch(surface._id, {
          ...quotes,
          ...route,
          request:
            route.endpoint === undefined ? requestWithoutLadder(quotes.request) : quotes.request,
          credentialLocation: undefined,
          probeAttempts: undefined,
          ...(surface.verdict === 'absent' ? {} : { reason: undefined }),
        });
        break;
      }
      case 'cut': {
        const patch = cutPatch(surface);
        await ctx.db.patch(surface._id, {
          ...patch,
          ...quotes,
          request:
            patch.endpoint === undefined ? requestWithoutLadder(quotes.request) : quotes.request,
        });
        const scope = await revokeConnectionGrant(ctx, surface, input.now);
        if (scope !== undefined) scopesRevoked.push(scope);
        await appendEvent(ctx, {
          agentId: surface.agentId,
          type: 'surface.proposed',
          payload: { surfaceId: surface._id, ...(surface.path ? { path: surface.path } : {}) },
          createdAt: input.now,
        });
        cut.push({
          surfaceId: surface._id,
          slug: surface.slug,
          displayName: surface.displayName,
          boundCredentials: [...(await credentialsBoundBy(ctx.db, [surface]))],
        });
        break;
      }
      case 'reapprove': {
        const patch = reapprovePatch(surface);
        await ctx.db.patch(surface._id, {
          ...patch,
          ...quotes,
          request:
            patch.endpoint === undefined ? requestWithoutLadder(quotes.request) : quotes.request,
        });
        const scope = await revokeConnectionGrant(ctx, surface, input.now);
        if (scope !== undefined) scopesRevoked.push(scope);
        await appendEvent(ctx, {
          agentId: surface.agentId,
          type: 'surface.proposed',
          payload: { surfaceId: surface._id, ...(surface.path ? { path: surface.path } : {}) },
          createdAt: input.now,
        });
        reapproved.push({
          surfaceId: surface._id,
          slug: surface.slug,
          displayName: surface.displayName,
        });
        break;
      }
      default: {
        const unknown: never = handover;
        throw new Error(`unhandled surface handover ${String(unknown)}`);
      }
    }
  }
  return { cut, reapproved, scopesRevoked };
}
