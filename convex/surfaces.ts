import { ConvexError, v } from 'convex/values';
import { action, internalMutation, mutation, query, type MutationCtx } from './_generated/server';
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
import { reevaluatePendingInTransaction, resendDecisionsAfterManagerChange } from './work';
import schema from './schema';
import { scheduleNextStep } from './workLoop';
import { intakeScopeValues } from '../src/surfaces/intake-scope';
import { isManagerLookupFailure } from '../src/surfaces/manager-lookup';
import { appendEvent } from './eventLog';
import { isEventOf } from '../src/events/contract';
import { agentZone, expiryNoticeDay, expiryNoticeDue } from '../src/lib/zone';

const surfaceVerdict = v.union(
  v.literal('declared'),
  v.literal('proposed'),
  v.literal('approved'),
  v.literal('connected'),
  v.literal('ungranted'),
  v.literal('absent'),
  v.literal('listed-dead'),
);

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

/** List connection verdicts for one owned agent. */
export const listForAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'surfaces'>[]> => {
    await assertOwnsAgent(ctx, args.agentId);
    const surfaces = await ctx.db
      .query('surfaces')
      .withIndex('by_agent', (index) => index.eq('agentId', args.agentId))
      .collect();
    const refusal = browserComponentRefusal(process.env.DAY0_BROWSER_MCP_URL);
    return surfaces.map((surface) => withBrowserComponentState(surface, refusal));
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

/**
 * Store an evidence-backed connect request.
 *
 * A work-bearing card carries the queues its employee will read; they are
 * approved with the rest of the card and replaced only by a new proposal.
 * A proposal names no access length and sets no end date: the approval
 * starts Q5's 90 days and the manager is the only other source (Q5, U3 D2 (b)).
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
      credentialId: args.credentialId,
      credentialKind: args.credentialId ? args.credentialKind : undefined,
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

/** Record that documentation explicitly provides no approved surface. */
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
  args: { surfaceId: v.id('surfaces') },
  handler: async (ctx, args): Promise<boolean> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) return false;
    return await scheduleOrientationFor(ctx, surface);
  },
});

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
    if (!surface) throw new Error('Surface not found.');
    await assertOwnsAgent(ctx, surface.agentId);
    if (surface.verdict !== 'declared') {
      throw new Error(`Only a declared system can be proposed; this one is ${surface.verdict}.`);
    }
    if (surface.orientationJobId) {
      const job = await ctx.db.system.get(surface.orientationJobId);
      if (job?.state.kind === 'inProgress') {
        throw new Error('Orientation is already running for this system; its card follows.');
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

/** Set a surface verdict from a server-side probe or lifecycle action. */
export const setStatus = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    verdict: surfaceVerdict,
    reason: v.optional(v.string()),
    credentialLanded: v.optional(v.boolean()),
    lastVerifiedAt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    await ctx.db.patch(surface._id, {
      verdict: args.verdict,
      reason: args.reason,
      credentialLanded: args.credentialLanded ?? surface.credentialLanded,
      lastVerifiedAt: args.lastVerifiedAt ?? surface.lastVerifiedAt,
    });
  },
});

/** Attach an encrypted credential reference without exposing its value. */
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
    const approved = surface.managerApprovedAt !== undefined;
    await ctx.db.patch(surface._id, {
      credentialId: args.credentialId,
      credentialKind: args.credentialKind,
      credentialLocation: args.credentialLocation,
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
 * Record the dedicated app this employee just registered for itself.
 *
 * The app and its install link are stored together with the single-use nonce
 * that binds the link to this surface, so provisioning again simply replaces
 * the link and invalidates the previous one.
 */
export const recordProvisionedApp = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    appId: v.string(),
    appName: v.string(),
    clientId: v.string(),
    clientSecretCredentialId: v.id('credentials'),
    installUrl: v.string(),
    redirectUrl: v.string(),
    scopes: v.array(v.string()),
    stateNonce: v.string(),
    stateExpiresAt: v.number(),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    await ctx.db.patch(surface._id, {
      provisioning: {
        appId: args.appId,
        appName: args.appName,
        clientId: args.clientId,
        clientSecretCredentialId: args.clientSecretCredentialId,
        installUrl: args.installUrl,
        redirectUrl: args.redirectUrl,
        scopes: args.scopes,
        createdAt: args.now,
        stateNonce: args.stateNonce,
        stateExpiresAt: args.stateExpiresAt,
      },
    });
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.app-provisioned',
      payload: { surfaceId: surface._id, appId: args.appId, appName: args.appName },
      createdAt: args.now,
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
 * Attach the bot token an install delivered and retire a shared one.
 *
 * The two writes belong together: the moment the dedicated identity is the
 * surface's credential, the shared token it replaces must stop being usable,
 * or a run could still reach the provider as the workspace's shared app.
 */
export const recordInstalledApp = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    credentialId: v.id('credentials'),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<{ retiredCredentialId?: Id<'credentials'> }> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    const previous = surface.credentialId;
    if (previous && previous !== args.credentialId && surface.credentialKind === 'oauth') {
      throw new Error('This surface already has a dedicated identity.');
    }
    const retired =
      previous && previous !== args.credentialId && surface.credentialKind !== 'oauth'
        ? previous
        : undefined;
    await ctx.db.patch(surface._id, {
      credentialId: args.credentialId,
      credentialKind: 'oauth',
      credentialLanded: false,
      reason: undefined,
      verdict:
        surface.verdict === 'ungranted' || surface.verdict === 'listed-dead'
          ? 'approved'
          : surface.verdict,
      provisioning: surface.provisioning
        ? {
            ...surface.provisioning,
            installedAt: args.now,
            stateNonce: undefined,
            stateExpiresAt: undefined,
            lastError: undefined,
          }
        : undefined,
    });
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
      payload: { surfaceId: surface._id, appId: surface.provisioning?.appId },
      createdAt: args.now,
    });
    return { retiredCredentialId: retired };
  },
});

/** Reserve the next probe generation for an approved connection candidate. */
export const beginProbe = internalMutation({
  args: { surfaceId: v.id('surfaces') },
  handler: async (ctx, args): Promise<{ surface: Doc<'surfaces'>; generation: number } | null> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (
      !surface ||
      !['approved', 'connected', 'ungranted', 'listed-dead'].includes(surface.verdict)
    ) {
      return null;
    }
    // A probe that found the provider working would otherwise reconnect an
    // access whose end date has passed; only the manager's renewal does that.
    const now = Date.now();
    if (accessEndDatePassed(surface, now)) {
      if (surface.reason !== 'expired') await endAccessInTransaction(ctx, surface, now);
      return null;
    }
    const generation = (surface.probeGeneration ?? 0) + 1;
    await ctx.db.patch(surface._id, { probeGeneration: generation });
    return { surface: { ...surface, probeGeneration: generation }, generation };
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
    if (!['approved', 'connected', 'ungranted', 'listed-dead'].includes(surface.verdict)) {
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
      toolArguments: undefined,
      managerDmChannelId: undefined,
      managerName: undefined,
      providerIdentityId: undefined,
      providerWorkspaceId: undefined,
      channelsNotJoined: undefined,
      lastVerifiedAt: undefined,
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
  },
  handler: async (ctx, args): Promise<boolean> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    if (surface.probeGeneration !== args.generation) return false;
    if (!['approved', 'connected', 'ungranted', 'listed-dead'].includes(surface.verdict)) {
      return false;
    }
    await ctx.db.patch(surface._id, {
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
 * rung, and changing the manager (`agents.setBossEmail`) re-probes it (Q6).
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
      toolAllowlist: undefined,
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
type DeferredSurfaceVerdict = {
  reason?: string;
  missingSurface?: string;
  missingPermissions?: string[];
};

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
 * the connected event names any tool it withheld. A probe that resolves a
 * different manager than the row held writes `manager.changed` (Q6), so the
 * ledger shows who the approver became and when, and any open request
 * delivered to another DM is sent again to this one.
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
    if (!['approved', 'connected', 'ungranted', 'listed-dead'].includes(surface.verdict)) {
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
      toolAllowlist: tools.allowlist,
      toolArguments: tools.toolArguments,
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
    if (transitioned) {
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

/** Q5's access length at approval, in days; only the manager sets another (`setAccessDays`). */
export const SURFACE_ACCESS_DEFAULT_DAYS = 90;

/** The longest access the manager can set, in days. */
export const SURFACE_ACCESS_MAX_DAYS = 365;

/** Surfaces one page of the access-clock migration reads. */
const ACCESS_BACKFILL_BATCH = 100;

/** The verdicts of an approved surface, whose access runs on a clock. */
const ACCESS_VERDICTS: ReadonlyArray<Doc<'surfaces'>['verdict']> = [
  'approved',
  'connected',
  'ungranted',
  'listed-dead',
];

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
 * End a surface's access: back to `approved` with the reason, and the event.
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
  await ctx.db.patch(surface._id, {
    verdict: 'approved',
    reason: 'expired',
    credentialLanded: false,
    lastVerifiedAt: undefined,
  });
  // The end date is on the event so the upgrade can tell this release's end
  // of a proposal-started clock from an end the older code recorded.
  await appendEvent(ctx, {
    agentId: surface.agentId,
    type: 'surface.expired',
    payload: { surfaceId: surface._id, expiresAt: surface.expiresAt },
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
  for await (const event of ctx.db
    .query('events')
    .withIndex('by_agent_type', (index) =>
      index.eq('agentId', surface.agentId).eq('type', 'surface.expired'),
    )
    .order('desc')) {
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
  type: string,
  expiresAt?: number,
): Promise<boolean> {
  for await (const event of ctx.db
    .query('events')
    .withIndex('by_agent_type', (index) => index.eq('agentId', surface.agentId).eq('type', type))
    .order('desc')) {
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

/**
 * Set how long an approved surface's access lasts, from now (Q5).
 *
 * Public, owner-guarded, real mode only; the card's control. Setting the
 * length is also the explicit renewal: an ended access comes back to
 * `approved` with no reason and is probed at once. Writes `expiresAt` and a
 * `surface.access-set` event.
 *
 * @throws ConvexError when the card is not approved yet or the length is not
 * a whole number of days from 1 to 365.
 */
export const setAccessDays = mutation({
  args: { surfaceId: v.id('surfaces'), days: v.number() },
  handler: async (ctx, args): Promise<{ expiresAt: number }> => {
    assertRealMode('Setting surface access');
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
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
    await logAccessSet(ctx, surface, {
      by: 'manager',
      days: args.days,
      expiresAt,
      renewed,
      at: now,
    });
    if (renewed) {
      await ctx.scheduler.runAfter(0, internal.surfaceActions.probeInternal, {
        surfaceId: surface._id,
      });
    }
    return { expiresAt };
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
      const refusal = await approvalRefusal(ctx, surface);
      if (refusal === undefined) {
        await approveInTransaction(ctx, surface, { approvedAt, now, by: 'upgrade' });
      } else {
        await ctx.db.patch(surface._id, { managerApprovedAt: undefined, reason: refusal });
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
  for await (const event of ctx.db
    .query('events')
    .withIndex('by_agent_type', (index) =>
      index.eq('agentId', surface.agentId).eq('type', 'surface.access-set'),
    )
    .order('desc')) {
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

/**
 * Why a proposed card cannot be approved now, or undefined when it can.
 *
 * Every documented intake queue the card reads must still read as quoted,
 * and a browser-driven card needs the component that drives it.
 */
async function approvalRefusal(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
): Promise<string | undefined> {
  for (const value of surface.intakeScope ? intakeScopeValues(surface.intakeScope) : []) {
    if (!value.sourceId) continue;
    const page = await ctx.db
      .query('docPages')
      .withIndex('by_source_ref', (index) =>
        index.eq('sourceId', value.sourceId as Id<'docSources'>).eq('ref', value.ref),
      )
      .unique();
    if (!page?.markdown.split(/\r?\n/).some((line) => line.trim() === value.quote)) {
      return 'A documented intake queue changed; reject this card and re-run orientation before approval.';
    }
  }
  return surface.path === 'browser-driven'
    ? browserComponentRefusal(process.env.DAY0_BROWSER_MCP_URL)
    : undefined;
}

/** Who approved a card, as its access end date records it. */
interface Approval {
  /** When the manager approved: now at the card, the older release's stamp at the upgrade. */
  readonly approvedAt: number;
  /** When the access clock starts. */
  readonly now: number;
  /** `approval` for the card's button, `upgrade` for a card an older release left half approved. */
  readonly by: Extract<AccessSetBy, 'approval' | 'upgrade'>;
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
    const refusal = await approvalRefusal(ctx, surface);
    if (refusal !== undefined) throw new ConvexError(refusal);
    const now = Date.now();
    await approveInTransaction(ctx, surface, { approvedAt: now, now, by: 'approval' });
  },
});

/**
 * Reject a proposed or approved surface and return it to `declared`.
 *
 * The approval and every connection detail are cleared, so a later
 * re-proposal starts from evidence again and waits for a new approval.
 */
export const reject = mutation({
  args: { surfaceId: v.id('surfaces'), reason: v.string() },
  handler: async (ctx, args): Promise<void> => {
    assertRealMode('Surface rejection');
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    await assertOwnsAgent(ctx, surface.agentId);
    if (surface.verdict !== 'proposed' && surface.verdict !== 'approved') {
      throw new Error(
        `Only a proposed or approved surface can be rejected; this one is ${surface.verdict}.`,
      );
    }
    const now = Date.now();
    await ctx.db.patch(surface._id, {
      verdict: 'declared',
      reason: args.reason,
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
      approvedToolAllowlist: undefined,
      toolAllowlistApprovedAt: undefined,
      toolArguments: undefined,
      providerIdentityId: undefined,
      providerWorkspaceId: undefined,
      // The dedicated app itself survives a rejection - it exists in the
      // provider's workspace and only an administrator can delete it there -
      // but this deployment forgets it, so a re-proposal provisions afresh
      // rather than installing into an app nobody has re-approved.
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
 * ever stored.
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
    // the probe, so only a tool the provider offers is ever stored.
    await ctx.db.patch(surface._id, {
      approvedToolAllowlist: tools,
      toolAllowlistApprovedAt: now,
      toolAllowlist: (surface.toolAllowlist ?? []).filter((tool) => approved.has(tool)),
      toolArguments: (surface.toolArguments ?? []).filter((entry) => approved.has(entry.tool)),
    });
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.tools-approved',
      payload: {
        surfaceId: surface._id,
        tools,
        added: tools.filter((tool) => !before.has(tool)),
        removed: [...before].filter((tool) => !tools.includes(tool)),
      },
      createdAt: now,
    });
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
  handler: async (): Promise<boolean> => (process.env.DAY0_PUBLIC_URL ?? '').trim() !== '',
});

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
    return await ctx.runAction(internal.orientationActions.run, { agentId: args.agentId });
  },
});
