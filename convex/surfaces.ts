import { v } from 'convex/values';
import { action, internalMutation, mutation, query, type MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import { assertOwnsAgent, assertOwnsAgentAction } from './ownership';
import { grantScopeInTransaction } from './agents';
import { assertRealMode } from '../src/lib/surface-mode';
import type { Doc, Id } from './_generated/dataModel';
import {
  browserComponent,
  browserComponentRefusal,
  withBrowserComponentState,
} from '../src/surfaces/browser';
import {
  documentedSystemIdentity,
  sameDocumentedSystem,
  sameSystemForHostlessMention,
  stableSlug,
  type DocumentedSystemIdentity,
} from '../src/docs/system-discovery';

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
 * Convert a declared system name to its stable per-agent key.
 *
 * Args:
 *   name: Manager-provided system name.
 *
 * Returns:
 *   A lowercase URL-safe surface slug.
 */
export function surfaceSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'system'
  );
}

function surfaceIdentity(surface: Doc<'surfaces'>): DocumentedSystemIdentity {
  return documentedSystemIdentity({
    name: surface.displayName,
    quotes: (surface.discoveryEvidence ?? []).map((item) => item.quote),
    endpoints: surface.endpoint ? [surface.endpoint] : [],
  });
}

function charterMatches(
  surfaces: readonly Doc<'surfaces'>[],
  system: CharterSystemSeed,
): Doc<'surfaces'>[] {
  const mention = documentedSystemIdentity({
    name: system.name,
    quotes: [system.whereMentioned],
  });
  return surfaces.filter((surface) =>
    sameSystemForHostlessMention(system.class, mention, surface.class, surfaceIdentity(surface)),
  );
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
  await ctx.db.insert('events', {
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
    const surfaces = await ctx.db
      .query('surfaces')
      .withIndex('by_agent', (index) => index.eq('agentId', args.agentId))
      .collect();
    for (const system of args.namedSystems) {
      if (system.class === 'docs') continue;
      const slug = surfaceSlug(system.name);
      const matches = charterMatches(surfaces, system);
      if (matches.length > 1) {
        await recordCharterMatchAmbiguity(ctx, {
          agentId: args.agentId,
          system,
          matches,
          now,
        });
        continue;
      }
      const existing = matches[0];
      if (existing) {
        const discoveryEvidence = await attachCharterEvidence(ctx, existing, system, now);
        existing.discoveryEvidence = discoveryEvidence;
        surfaceIds.push(existing._id);
        continue;
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
        slug,
        displayName: system.name,
        class: system.class,
        verdict: 'declared',
        whereFound: [{ ref: 'manager 1:1', quote: system.whereMentioned }],
        discoveryEvidence: [evidence],
        credentialLanded: false,
        createdAt: now,
      });
      const inserted = await ctx.db.get(surfaceId);
      if (inserted) surfaces.push(inserted);
      surfaceIds.push(surfaceId);
    }
    return surfaceIds;
  },
});

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
    const existing = direct && sameIdentity(direct) ? direct : matches.length === 1 ? matches[0] : undefined;
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

/** Store an evidence-backed connect request. */
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
    expiresInDays: v.number(),
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
      credentialRef: undefined,
      expiresAt: now + args.expiresInDays * 24 * 60 * 60 * 1_000,
      reason: undefined,
    });
    await ctx.db.insert('events', {
      agentId: surface.agentId,
      type: 'surface.proposed',
      payload: { surfaceId: surface._id, path: args.path },
      createdAt: now,
    });
    await ctx.db.insert('events', {
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
    await ctx.db.insert('events', {
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
    if (!surface || surface.verdict !== 'declared') return false;
    if (surface.orientationJobId) {
      const job = await ctx.db.system.get(surface.orientationJobId);
      if (job && (job.state.kind === 'pending' || job.state.kind === 'inProgress')) return false;
    }
    const orientationJobId = await ctx.scheduler.runAfter(
      0,
      internal.orientationActions.orientOne,
      { surfaceId: surface._id },
    );
    await ctx.db.patch(surface._id, { orientationJobId });
    return true;
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
    await ctx.db.insert('events', {
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
    const approved = surface.managerApprovedAt !== undefined && surface.itApprovedAt !== undefined;
    await ctx.db.patch(surface._id, {
      credentialId: args.credentialId,
      credentialKind: args.credentialKind,
      credentialLocation: args.credentialLocation,
      credentialRef: undefined,
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
    await ctx.db.insert('events', {
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
    await ctx.db.insert('events', {
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
      credentialRef: undefined,
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
      await ctx.db.insert('events', {
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
    await ctx.db.insert('events', {
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
    await ctx.db.patch(surface._id, {
      verdict: args.verdict,
      reason: args.reason,
      credentialLanded: false,
      toolAllowlist: undefined,
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
        outcome: args.verdict,
        reason: args.reason,
        attemptedAt: args.attemptedAt ?? Date.now(),
      }),
    });
    await ctx.db.insert('events', {
      agentId: surface.agentId,
      type: 'surface.probe-failed',
      payload: { surfaceId: surface._id, verdict: args.verdict, reason: args.reason },
      createdAt: Date.now(),
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
      surface.itApprovedAt === undefined
    ) {
      return null;
    }
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
    await ctx.db.insert('events', {
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
 * back to `discovered` so the dashboard's queue evaluates them again.
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

function sameSurfaceSystem(left: Doc<'surfaces'>, right: Doc<'surfaces'>): boolean {
  const leftIdentity = surfaceIdentity(left);
  const rightIdentity = surfaceIdentity(right);
  return (
    sameSystemForHostlessMention(left.class, leftIdentity, right.class, rightIdentity) ||
    sameSystemForHostlessMention(right.class, rightIdentity, left.class, leftIdentity)
  );
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
    await ctx.db.insert('events', {
      agentId: surface.agentId,
      type: 'work.requeued',
      payload: {
        workItemId: item._id,
        surfaceId: surface._id,
        slug: surface.slug,
        ...(verdict.missingSurface
          ? { previousMissingSurface: verdict.missingSurface }
          : {}),
      },
      createdAt: now,
    });
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
    (verdict) =>
      verdict.reason === 'awaiting-connection' && verdict.missingSurface === aliasSlug,
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

async function requeueWorkAwaitingSurface(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  now: number,
): Promise<Id<'workItems'>[]> {
  const readScope = `${surface.slug}:read`;
  const surfaces = await ctx.db
    .query('surfaces')
    .withIndex('by_agent', (index) => index.eq('agentId', surface.agentId))
    .collect();
  const missingSurfaceResolvesHere = (missingSlug: string): boolean => {
    if (missingSlug === surface.slug) return true;
    const persisted = surfaces.find((candidate) => candidate.slug === missingSlug);
    if (persisted) return sameSurfaceSystem(persisted, surface);
    const mention = documentedSystemIdentity({ name: missingSlug.replace(/-/g, ' ') });
    return sameSystemForHostlessMention(
      surface.class,
      mention,
      surface.class,
      surfaceIdentity(surface),
    );
  };
  return await requeueDeferredWork(
    ctx,
    surface,
    (verdict) =>
      (verdict.reason === 'awaiting-connection' &&
        verdict.missingSurface !== undefined &&
        missingSurfaceResolvesHere(verdict.missingSurface)) ||
      (verdict.reason === 'awaiting-permission' &&
        (verdict.missingPermissions ?? []).includes(readScope)),
    now,
  );
}

/**
 * Persist one successful provider probe and its discovered safe metadata.
 *
 * The first transition to `connected` also grants `<slug>:read` and requeues
 * the work that was deferred on this surface, in the same transaction, so a
 * connected surface can never exist without its grant and the hourly
 * re-probe never grants again.
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
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    if (surface.probeGeneration !== args.generation) return false;
    if (!['approved', 'connected', 'ungranted', 'listed-dead'].includes(surface.verdict)) {
      return false;
    }
    const transitioned = surface.verdict !== 'connected';
    await ctx.db.patch(surface._id, {
      verdict: 'connected',
      reason: undefined,
      credentialLanded: true,
      lastVerifiedAt: args.verifiedAt,
      toolAllowlist: args.toolAllowlist,
      toolArguments: args.toolArguments,
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
      expiresAt: args.expiresAt ?? surface.expiresAt,
    });
    await ctx.db.insert('events', {
      agentId: surface.agentId,
      type: 'surface.connected',
      payload: { surfaceId: surface._id },
      createdAt: args.verifiedAt,
    });
    if (transitioned) {
      await grantScopeInTransaction(ctx, surface.agentId, `${surface.slug}:read`, 'surface');
      await requeueWorkAwaitingSurface(ctx, surface, args.verifiedAt);
    }
    return true;
  },
});

/** Demote an expired connected surface until its approval is renewed. */
export const recordExpired = internalMutation({
  args: { surfaceId: v.id('surfaces'), now: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (
      !surface ||
      surface.verdict !== 'connected' ||
      surface.expiresAt === undefined ||
      surface.expiresAt > args.now
    ) {
      return;
    }
    await ctx.db.patch(surface._id, {
      verdict: 'approved',
      reason: 'expired',
      credentialLanded: false,
      lastVerifiedAt: undefined,
    });
    await ctx.db.insert('events', {
      agentId: surface.agentId,
      type: 'surface.expired',
      payload: { surfaceId: surface._id },
      createdAt: args.now,
    });
  },
});

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
 * Record manager or IT approval; both are required for `approved`.
 *
 * Only a proposed surface can be approved: an absent, declared or already
 * approved surface has nothing to approve, and a rejected surface must be
 * re-proposed from evidence before either stamp can be placed again.
 */
export const approve = mutation({
  args: { surfaceId: v.id('surfaces'), role: v.union(v.literal('manager'), v.literal('it')) },
  handler: async (ctx, args): Promise<void> => {
    assertRealMode('Surface approval');
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    await assertOwnsAgent(ctx, surface.agentId);
    if (surface.verdict !== 'proposed') {
      throw new Error(`Only a proposed surface can be approved; this one is ${surface.verdict}.`);
    }
    if (surface.path === 'browser-driven') {
      const component = browserComponent(process.env.DAY0_BROWSER_MCP_URL);
      if (!component.present) throw new Error(component.reason);
    }
    const now = Date.now();
    const patch = args.role === 'manager' ? { managerApprovedAt: now } : { itApprovedAt: now };
    const both =
      (args.role === 'manager' || surface.managerApprovedAt !== undefined) &&
      (args.role === 'it' || surface.itApprovedAt !== undefined);
    await ctx.db.patch(surface._id, { ...patch, verdict: both ? 'approved' : 'proposed' });
    if (both) {
      await ctx.db.insert('events', {
        agentId: surface.agentId,
        type: 'surface.approved',
        payload: { surfaceId: surface._id },
        createdAt: now,
      });
      await ctx.scheduler.runAfter(0, internal.surfaceActions.probeInternal, {
        surfaceId: surface._id,
      });
    }
  },
});

/**
 * Reject a proposed or approved surface and return it to `declared`.
 *
 * Both approval stamps and every connection detail are cleared, so a later
 * re-proposal starts from evidence again and a single approval can never
 * complete it on the strength of a stamp placed before the rejection.
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
      itApprovedAt: undefined,
      endpoint: undefined,
      path: undefined,
      fallbackPath: undefined,
      pathCandidates: undefined,
      probeAttempts: undefined,
      credentialRef: undefined,
      credentialId: undefined,
      credentialKind: undefined,
      credentialLocation: undefined,
      managerDmChannelId: undefined,
      managerUserId: undefined,
      managerName: undefined,
      toolAllowlist: undefined,
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
      lastPolledAt: undefined,
      credentialLanded: false,
      lastVerifiedAt: undefined,
      expiresAt: undefined,
    });
    await ctx.db.insert('events', {
      agentId: surface.agentId,
      type: 'surface.rejected',
      payload: { surfaceId: surface._id, reason: args.reason },
      createdAt: now,
    });
    await requeueWorkAfterRejection(ctx, surface, now);
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
