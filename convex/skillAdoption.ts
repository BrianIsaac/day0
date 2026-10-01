import { ConvexError, v } from 'convex/values';
import {
  internalQuery,
  mutation,
  query,
  type DatabaseReader,
  type MutationCtx,
} from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgent, assertOwnsSkill } from './ownership';
import { appendEvent } from './eventLog';
import { grantScopeInTransaction } from './agents';
import { ownerVersions, sharedSkillsOn } from './skillVersions';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { browserComponentRefusal, withBrowserComponentState } from '../src/surfaces/browser';
import { skillApprovalRefusal } from '../src/surfaces/policy';
import { toSurfaceRecord } from '../src/surfaces/records';
import { verdictFor } from '../src/surfaces/verdict';
import {
  adoptionCardState,
  adoptionFit,
  chooseOffer,
  isOfferedTo,
  missingScopes,
  type Adopter,
  type AdopterSurface,
} from '../src/work/skill-adoption';

/*
 * Adoption (the enhancements plan, section 4.1; A3; 10-A).
 *
 * At `needs-skill` the evaluation asks `offerFor` for a sibling's verified version of the shape
 * before it proposes, and the proposal carries the answer (`offeredVersionId`, written by
 * `recordOffer`). The card then offers three things: Adopt for the employee (`adopt`: the
 * approval of the scopes it lacks, and the stored verification under its own contract), Write a
 * new one instead (`setOfferAside`, then today's approve-and-author), and Decline (today's
 * `skills.reject`). The library is read only through `skillVersions.ownerVersions`, so an offer
 * can only ever come from the employee's own owner; the switch is `DAY0_SHARED_SKILLS` (K4).
 * Execution authority is unchanged: what the adopted skill emits is gated against the adopter's
 * own grants, as every run is.
 */

/** The most charter versions read for the one in force: an employee's charters are few. */
const CHARTER_SCAN = 50;

/** The most grants read for one employee: a handful per connected system. */
const GRANT_SCAN = 500;

/** The newest approved charter's named systems' classes, or none before one is approved. */
async function charterClassesOf(db: DatabaseReader, agentId: Id<'agents'>): Promise<string[]> {
  const charters = await db
    .query('charters')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .order('desc')
    .take(CHARTER_SCAN);
  const body = charters.find((row) => row.approved)?.body as
    | { readonly namedSystems?: unknown }
    | null
    | undefined;
  if (!Array.isArray(body?.namedSystems)) return [];
  return body.namedSystems.flatMap((system: unknown): string[] => {
    const named = system as { readonly class?: unknown } | null;
    return typeof named?.class === 'string' ? [named.class] : [];
  });
}

/** One surface as the compatibility check reads it: live verdict, approved tools, charter evidence. */
function adopterSurface(row: Doc<'surfaces'>, now: number): AdopterSurface {
  const record = toSurfaceRecord(
    withBrowserComponentState(row, browserComponentRefusal(process.env.DAY0_BROWSER_MCP_URL)),
  );
  return {
    slug: row.slug,
    displayName: row.displayName,
    class: row.class,
    connected: verdictFor(record, now) === 'connected',
    approvedTools: row.approvedToolAllowlist ?? [],
    charterEvidence: (row.discoveryEvidence ?? []).some(
      (evidence) => evidence.kind === 'charter' && evidence.current,
    ),
  };
}

/**
 * The employee as an adoption reads it: its surfaces (none in mock mode), its charter's systems
 * and the deployment's mode.
 */
async function adopterOf(db: DatabaseReader, agent: Doc<'agents'>, now: number): Promise<Adopter> {
  const [surfaces, charterClasses] = await Promise.all([
    SURFACE_MODE === 'real'
      ? db
          .query('surfaces')
          .withIndex('by_agent', (q) => q.eq('agentId', agent._id))
          .collect()
      : Promise.resolve([]),
    charterClassesOf(db, agent._id),
  ]);
  return {
    agentId: agent._id,
    mode: SURFACE_MODE,
    surfaces: surfaces.map((row) => adopterSurface(row, now)),
    charterClasses,
  };
}

/** What an offer is looked up by: the proposal's name and shape. */
export interface OfferLookup {
  readonly name: string;
  readonly surfaceClass: string;
  readonly operation: string;
}

/**
 * The version an employee is offered for a shape (A3): with sharing on, the newest of the owner's
 * versions of the name that is offerable, another employee's, and fits the employee's own
 * contract (`chooseOffer`). Undefined when sharing is off, the employee has no owner, or nothing
 * passes.
 *
 * @param db - A query's or a mutation's database.
 * @param agent - The employee the proposal is for.
 * @param lookup - The proposal's name and shape.
 * @param now - The clock the surfaces' liveness is read against.
 */
export async function offerOf(
  db: DatabaseReader,
  agent: Doc<'agents'>,
  lookup: OfferLookup,
  now: number,
): Promise<Doc<'skillVersions'> | undefined> {
  if (!sharedSkillsOn() || !agent.userId) return undefined;
  const versions = await ownerVersions(db, agent.userId, {
    by: 'shape',
    surfaceClass: lookup.surfaceClass,
    operation: lookup.operation,
  });
  if (versions.length === 0) return undefined;
  return chooseOffer(versions, lookup.name, await adopterOf(db, agent, now));
}

/**
 * Internal: the version `needs-skill` offers the employee for the shape it proposes, read before
 * the proposal (`workActions`, the needs-skill region). Reads only.
 *
 * @returns The offered version's id, or null when none is offered.
 */
export const offerFor = internalQuery({
  args: {
    agentId: v.id('agents'),
    name: v.string(),
    surfaceClass: v.string(),
    operation: v.string(),
  },
  handler: async (ctx, args): Promise<Id<'skillVersions'> | null> => {
    const agent = await ctx.db.get(args.agentId);
    if (agent === null) return null;
    const offered = await offerOf(ctx.db, agent, args, Date.now());
    return offered?._id ?? null;
  },
});

/**
 * Keep a proposal's offer as the latest evaluation found it, in the proposal's transaction
 * (`skills.propose`): a new offer is written with a `skill.adoption-offered` event, an offer the
 * evaluation no longer makes is cleared. A version that is not the employee's owner's, or not of
 * the proposal's name (a handover between the lookup and the proposal), is not attached.
 *
 * @param ctx - The proposal's mutation context.
 * @param row - The proposed row, as the proposal wrote it.
 * @param offeredVersionId - The version `offerFor` answered, or undefined for none.
 * @returns Whether the row now carries an offer.
 */
export async function recordOffer(
  ctx: MutationCtx,
  row: Doc<'skills'>,
  offeredVersionId: Id<'skillVersions'> | undefined,
): Promise<boolean> {
  const version = offeredVersionId === undefined ? null : await ctx.db.get(offeredVersionId);
  const agent = await ctx.db.get(row.agentId);
  const attachable =
    version !== null && agent?.userId === version.userId && version.name === row.name;
  const next = attachable ? version._id : undefined;
  if (row.offeredVersionId === next) return next !== undefined;
  await ctx.db.patch(row._id, { offeredVersionId: next });
  if (attachable && row.proposedFor !== undefined) {
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'skill.adoption-offered',
      payload: {
        skillId: row._id,
        name: row.name,
        versionId: version._id,
        version: version.version,
        authorName: version.authorName,
        forWorkItem: row.proposedFor,
      },
      createdAt: Date.now(),
    });
  }
  return next !== undefined;
}

/** The employee's live grants, as scope names. */
async function grantedScopes(db: DatabaseReader, agentId: Id<'agents'>): Promise<string[]> {
  const grants = await db
    .query('permissionGrants')
    .withIndex('by_agent_scope', (q) => q.eq('agentId', agentId))
    .take(GRANT_SCAN);
  return grants.filter((grant) => grant.revokedAt === undefined).map((grant) => grant.scope);
}

/** Why the proposal's target surface refuses an approval now, as `skills.approve` reads it. */
async function targetRefusal(
  db: DatabaseReader,
  row: Doc<'skills'>,
  now: number,
): Promise<string | undefined> {
  if (!row.targetSurface) return undefined;
  const surface = await db
    .query('surfaces')
    .withIndex('by_agent_slug', (q) => q.eq('agentId', row.agentId).eq('slug', row.targetSurface!))
    .unique();
  return skillApprovalRefusal(
    row.targetSurface,
    surface
      ? toSurfaceRecord(
          withBrowserComponentState(
            surface,
            browserComponentRefusal(process.env.DAY0_BROWSER_MCP_URL),
          ),
        )
      : undefined,
    now,
  );
}

/** An offer as it stands now: the version, or why it may no longer be adopted. */
type StandingOffer =
  | { readonly kind: 'ready'; readonly version: Doc<'skillVersions'>; readonly connection?: string }
  | {
      readonly kind: 'refused';
      readonly reason: string;
      readonly version: Doc<'skillVersions'> | null;
    };

/**
 * The row's offer checked again as it stands now, everything `offerOf` asked and the approval's
 * own check of the target surface: sharing on, the version the owner's and of the row's name,
 * offerable and another employee's, fitting the employee's contract, and the target connected.
 */
async function standingOffer(
  db: DatabaseReader,
  row: Doc<'skills'>,
  agent: Doc<'agents'>,
  now: number,
): Promise<StandingOffer> {
  const version = row.offeredVersionId === undefined ? null : await db.get(row.offeredVersionId);
  const refused = (reason: string): StandingOffer => ({ kind: 'refused', reason, version });
  if (version === null) return refused('the offered skill no longer exists');
  if (version.userId !== agent.userId || version.name !== row.name) {
    return refused("the offered skill is not one of this employee's owner's");
  }
  if (!sharedSkillsOn()) return refused('sharing skills between employees is switched off');
  const adopter = await adopterOf(db, agent, now);
  if (!isOfferedTo(version, adopter)) {
    return refused(
      version.revokedAt !== undefined
        ? 'the offered skill was withdrawn from every employee'
        : version.supersededAt !== undefined
          ? 'a revision replaced the offered skill'
          : 'the offered skill cannot be offered now',
    );
  }
  const fit = adoptionFit(version, adopter);
  if (!fit.fits) return refused(fit.detail);
  const target = await targetRefusal(db, row, now);
  if (target !== undefined) return refused(target);
  return {
    kind: 'ready',
    version,
    ...(fit.connection !== undefined ? { connection: fit.connection.displayName } : {}),
  };
}

/**
 * Public, guarded by `assertOwnsSkill`: adopt the version offered to a proposal (Adopt for
 * {name}). Checks the offer again as it stands, then in one transaction approves the row, grants
 * only the scopes the employee lacks (the approval path's own grant, with its `skill.approved`
 * and `permission.granted` events), records `skill.adopted` with the version, and schedules
 * `skillActions.verifyStoredSkill`, which re-verifies the version in the sandbox under the
 * employee's own connection and tool allowlist and registers it only on a pass.
 *
 * @returns The scopes the adoption granted.
 * @throws ConvexError, in words for the manager, when the row is not an offered proposal or the
 *   offer no longer stands.
 */
export const adopt = mutation({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args): Promise<{ scopes: string[] }> => {
    const row = await assertOwnsSkill(ctx, args.skillId);
    if (row.state !== 'proposed' || row.offeredVersionId === undefined) {
      throw new ConvexError(`${row.name} has no skill offered to adopt.`);
    }
    const agent = await ctx.db.get(row.agentId);
    if (agent === null) throw new ConvexError(`${row.name} has no employee to adopt it for.`);
    const now = Date.now();
    const offer = await standingOffer(ctx.db, row, agent, now);
    if (offer.kind === 'refused') {
      throw new ConvexError(`${row.name} cannot be adopted: ${offer.reason}.`);
    }
    const scopes = missingScopes(row.requiredScopes, await grantedScopes(ctx.db, row.agentId));
    await ctx.db.patch(row._id, { state: 'approved' });
    for (const scope of scopes) {
      await grantScopeInTransaction(ctx, row.agentId, scope, 'skill');
    }
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'skill.approved',
      payload: { skillId: row._id, name: row.name, scopes },
      createdAt: now,
    });
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'skill.adopted',
      payload: {
        skillId: row._id,
        name: row.name,
        versionId: offer.version._id,
        version: offer.version.version,
        authorName: offer.version.authorName,
      },
      createdAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.skillActions.verifyStoredSkill, {
      skillId: row._id,
    });
    return { scopes };
  },
});

/**
 * Public, guarded by `assertOwnsSkill`: set a proposal's offer aside for Write a new one instead,
 * so the authoring the card starts next (`skills.approve` and `skillActions.authorAndRegisterSkill`
 * on a proposal, the authoring alone on a failed adoption) writes the employee's own skill and the
 * card stops saying an adoption is under way. Writes the row only; the approval and the authoring
 * write their own events.
 *
 * @throws ConvexError when the row is neither an offered proposal nor a failed adoption.
 */
export const setOfferAside = mutation({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const row = await assertOwnsSkill(ctx, args.skillId);
    const state = adoptionCardState(row);
    if (state !== 'offered' && state !== 'failed') {
      throw new ConvexError(`${row.name} has no adoption to set aside.`);
    }
    await ctx.db.patch(row._id, { offeredVersionId: undefined });
    return { ok: true };
  },
});

/** One adoption the Skills tab draws a card for. */
export interface AdoptionView {
  readonly skillId: Id<'skills'>;
  readonly name: string;
  readonly description: string;
  /** The item the proposal was first made for. */
  readonly proposedFor?: Id<'workItems'>;
  readonly state: 'offered' | 'verifying' | 'failed';
  readonly versionId: Id<'skillVersions'>;
  readonly version: number;
  readonly authorName: string;
  readonly verifiedAt: number;
  /** The employee's connection the sandbox runs under, by name; absent in mock mode. */
  readonly connection?: string;
  /** The scopes Adopt would grant, for an offer. */
  readonly missingScopes: string[];
  /** Why Adopt is withheld now, for an offer that no longer stands. */
  readonly refusal?: string;
  /** The failed re-verification's log. */
  readonly log?: string;
}

/** The rows that can carry an offer the card draws, by state. */
const ADOPTION_ROW_STATES = ['proposed', 'approved', 'authoring', 'verified', 'failed'] as const;

/**
 * Public, guarded by `assertOwnsAgent`: the employee's adoptions the Skills tab draws, an offer on
 * a proposal, a verification in flight and a failed one, each with the version offered. Reads
 * only; a version that is not the employee's owner's is never shown.
 */
export const adoptions = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<AdoptionView[]> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const rows = (
      await Promise.all(
        ADOPTION_ROW_STATES.map((state) =>
          ctx.db
            .query('skills')
            .withIndex('by_agent_state', (q) => q.eq('agentId', agent._id).eq('state', state))
            .collect(),
        ),
      )
    ).flat();
    const granted = await grantedScopes(ctx.db, agent._id);
    const now = Date.now();
    const views: AdoptionView[] = [];
    for (const row of rows) {
      const state = adoptionCardState(row);
      if (state === undefined) continue;
      const view = await adoptionView(ctx.db, { row, agent, state, granted, now });
      if (view !== undefined) views.push(view);
    }
    return views.sort((left, right) => left.name.localeCompare(right.name));
  },
});

/** One row's card, or undefined when its version is not the employee's owner's to show. */
async function adoptionView(
  db: DatabaseReader,
  input: {
    readonly row: Doc<'skills'>;
    readonly agent: Doc<'agents'>;
    readonly state: AdoptionView['state'];
    readonly granted: readonly string[];
    readonly now: number;
  },
): Promise<AdoptionView | undefined> {
  const { row, agent, state, now } = input;
  const offer =
    state === 'offered'
      ? await standingOffer(db, row, agent, now)
      : await connectionOffer(db, row, agent, now);
  const { version } = offer;
  if (version === null || version.userId !== agent.userId) return undefined;
  return {
    skillId: row._id,
    name: row.name,
    description: row.description,
    ...(row.proposedFor !== undefined ? { proposedFor: row.proposedFor } : {}),
    state,
    versionId: version._id,
    version: version.version,
    authorName: version.authorName,
    verifiedAt: version.verifiedAt,
    ...(offer.kind === 'ready' && offer.connection !== undefined
      ? { connection: offer.connection }
      : {}),
    missingScopes: state === 'offered' ? missingScopes(row.requiredScopes, input.granted) : [],
    ...(state === 'offered' && offer.kind === 'refused' ? { refusal: offer.reason } : {}),
    ...(state === 'failed' && row.verificationLog ? { log: row.verificationLog } : {}),
  };
}

/**
 * The version of a row past its offer (verifying or failed), with the connection the sandbox runs
 * under: the decision is made, so nothing is checked again here.
 */
async function connectionOffer(
  db: DatabaseReader,
  row: Doc<'skills'>,
  agent: Doc<'agents'>,
  now: number,
): Promise<StandingOffer> {
  const version = row.offeredVersionId === undefined ? null : await db.get(row.offeredVersionId);
  if (version === null) {
    return { kind: 'refused', reason: 'the offered skill no longer exists', version };
  }
  const fit = adoptionFit(version, await adopterOf(db, agent, now));
  return {
    kind: 'ready',
    version,
    ...(fit.fits && fit.connection !== undefined ? { connection: fit.connection.displayName } : {}),
  };
}
