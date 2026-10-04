import { ConvexError, v, type Infer } from 'convex/values';
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import {
  assertOwnsAgent,
  getCallerOrThrow,
  ownedAgentOrNull,
  verifiedAddressOf,
  type Caller,
} from './ownership';
import { assertRealMode, SURFACE_MODE } from '../src/lib/surface-mode';
import { AUTONOMY_CHANGE_REASON, autonomousActionsOn } from '../src/work/autonomy';
import {
  isPaused,
  isPauseReasonWithinBound,
  PAUSE_REASON_TOO_LONG,
  pauseReasonOf,
} from '../src/work/pause';
import { resumeAgentStepsInTransaction, wakeQueuedWork } from './workLoop';
import { isEvaluationAgent } from './metrics';
import { isManagerLookupFailure } from '../src/surfaces/manager-lookup';
import {
  UNVERIFIED_FOR_DEPLOY,
  isEvaluationShapedAddress,
  normaliseManagerAddress,
} from '../src/agent/manager-address';
import {
  EVALUATION_ADDRESS_FIXED,
  UNVERIFIED_FOR_ADOPTION,
  managerStandingOf,
  type ManagerStanding,
} from '../src/agent/manager-standing';
import { evaluationBedName, evaluationBedRefusal } from '../src/evaluation/bed-flag';
import { AVATAR_ID_MAX_CHARS, AVATAR_ID_TOO_LONG } from '../src/agent/avatar-pets';
import { characterCount } from '../src/lib/visible-text';
import {
  clippedEmployeeName,
  EMPLOYEE_NAME_TOO_LONG,
  isEmployeeNameWithinBound,
  visibleEmployeeName,
} from '../src/agent/employee-name';
import {
  managerNotificationMode,
  NOTIFICATIONS_CHANGE_REASON,
  type ManagerNotificationMode,
} from '../src/work/manager-notes';
import { agentZone, canonicalZone, deploymentZone } from '../src/lib/zone';
import { appendEvent } from './eventLog';
import { assertNoHandoverOpen, assertNotBeingHandedOver } from './handoverFence';
import schema from './schema';
import { ROSTER_SCAN_LIMIT, rosterOf, rosterRowValidator, type RosterRow } from './roster';

/** Where a permission grant came from: deployment, the manager, a skill or a surface. */
export const PERMISSION_GRANT_SOURCES = ['deploy', 'manager', 'skill', 'surface'] as const;
/** One source of a permission grant. */
export type PermissionGrantSource = (typeof PERMISSION_GRANT_SOURCES)[number];

const permissionGrantSource = v.union(
  v.literal('deploy'),
  v.literal('manager'),
  v.literal('skill'),
  v.literal('surface'),
);

/**
 * Agent CRUD + state transitions. Each agent is owned by one caller subject -
 * a Clerk user, or the single synthetic user in no-auth dev mode;
 * `listForUser` filters by the signed-in user so concurrent demos stay
 * isolated. All other public functions that take an `agentId` enforce
 * ownership via `assertOwnsAgent` before reading or writing.
 */

export const listForUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await getCallerOrThrow(ctx);
    return await ctx.db
      .query('agents')
      .withIndex('by_userId', (q) => q.eq('userId', identity.ownerKey))
      .order('desc')
      .take(20);
  },
});

/**
 * The owner's employees, one row each, for the landing page ({@link rosterOf}, `convex/roster.ts`).
 *
 * Owner-scoped like `listForUser`; a caller with no identity is refused (12-G). Writes nothing.
 *
 * @returns At most twenty rows, newest first.
 */
export const rosterForUser = query({
  args: {},
  returns: v.array(rosterRowValidator),
  handler: async (ctx): Promise<RosterRow[]> => {
    const identity = await getCallerOrThrow(ctx);
    // A token with an empty subject keys nobody's rows, the malformed ones keyed '' included.
    if (identity.ownerKey === '') return [];
    return await rosterOf(ctx, identity.ownerKey);
  },
});

/**
 * Public, owner-guarded by `ownedAgentOrNull`: one employee, or null once it is gone (retired,
 * or never there), so the employee page can say so. Another owner's employee is refused. The id
 * is taken as the address gave it, so a malformed or truncated link reads as no employee rather
 * than as a validation failure the page could only show as a crash.
 */
export const get = query({
  args: { agentId: v.string() },
  handler: async (ctx, args) => {
    const agentId = ctx.db.normalizeId('agents', args.agentId);
    if (agentId === null) {
      await getCallerOrThrow(ctx);
      return null;
    }
    return await ownedAgentOrNull(ctx, agentId);
  },
});

/**
 * Internal-only fetch used by action-side ownership assertions; bypasses
 * the public `get` so that `assertOwnsAgentAction` doesn't recurse through
 * its own ownership check before it can compare userId.
 */
export const getInternal = internalQuery({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.agentId);
  },
});

/** What a deploy is asked for that decides the employee's address. */
interface DeployAddressArgs {
  readonly evaluationAddress?: string;
  readonly name: string;
  readonly arm: 'day0' | 'baseline';
}

/**
 * The address a new employee reports to: the deploying caller's verified
 * address, since the account that owns an employee is its manager (the
 * transfer plan, section 3.3, D1 (b) and D2 (a)). The evaluation harness
 * names a reserved address instead, its evaluation marker, taken only on an
 * evaluation bed and only when the row it makes reads as an evaluation
 * employee; the caller must still have a verified address of its own.
 *
 * @throws ConvexError for a caller without a verified address, an evaluation
 *   address off a bed, or one that would not mark an evaluation employee.
 */
function deployAddress(caller: Caller, args: DeployAddressArgs): string {
  const callerAddress = verifiedAddressOf(caller);
  if (callerAddress === undefined) throw new ConvexError(UNVERIFIED_FOR_DEPLOY);
  if (args.evaluationAddress === undefined) return callerAddress;
  if (evaluationBedName() === undefined) {
    throw new ConvexError(evaluationBedRefusal('agents.deploy with an evaluation address'));
  }
  const evaluationAddress = normaliseManagerAddress(args.evaluationAddress);
  if (
    evaluationAddress === undefined ||
    !isEvaluationShapedAddress(evaluationAddress) ||
    !isEvaluationAgent({ bossEmail: evaluationAddress, name: args.name, arm: args.arm })
  ) {
    throw new ConvexError(
      "An evaluation address must be the harness's reserved eval-<run>@day0.local address of " +
        'an employee named as an evaluation one.',
    );
  }
  return evaluationAddress;
}

/**
 * The name a deploy stores: the visible name, one line and trimmed, or `Day0` when none is given.
 *
 * @throws ConvexError with {@link EMPLOYEE_NAME_TOO_LONG} past the bound: the name is copied into
 *   every handover request and every inbox entry that names the employee, so an unbounded one
 *   could fill another person's inbox past a read's limit.
 */
function deployName(name: string | undefined): string {
  if (name === undefined) return 'Day0';
  if (!isEmployeeNameWithinBound(name)) throw new ConvexError(EMPLOYEE_NAME_TOO_LONG);
  // A name of nothing visible names no one: the default, as with no name given.
  return visibleEmployeeName(name) || 'Day0';
}

/**
 * Public, signed in with a verified address: creates an employee for the
 * caller, reporting to that address (or, from the evaluation harness on a
 * bed, to its reserved `evaluationAddress`), in the caller's zone with its
 * deployment grants; records both, and schedules the mirror of the caller's
 * already-synced documentation sources to it. The workspace is written
 * later, when the charter is committed. Refuses a name past 80 characters.
 */
export const deploy = mutation({
  args: {
    /** The harness's reserved address; refused off an evaluation bed. */
    evaluationAddress: v.optional(v.string()),
    name: v.optional(v.string()),
    avatarId: v.optional(v.string()),
    arm: v.optional(v.union(v.literal('day0'), v.literal('baseline'))),
    excludedDocSourceIds: v.optional(v.array(v.id('docSources'))),
    /** The manager's browser zone (N12); one the backend does not know reads as the deployment's. */
    zone: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<'agents'>> => {
    const identity = await getCallerOrThrow(ctx);
    const name = deployName(args.name);
    // The row is read whole wherever the employee is named (the inbox of a handover's named
    // account among them), so nothing on it is left unbounded (the wave 9 review's B2).
    if (args.avatarId !== undefined && characterCount(args.avatarId) > AVATAR_ID_MAX_CHARS) {
      throw new ConvexError(AVATAR_ID_TOO_LONG);
    }
    const arm = args.arm ?? 'day0';
    const bossEmail = deployAddress(identity, {
      evaluationAddress: args.evaluationAddress,
      name,
      arm,
    });
    // The control arm exists only for the mock-mode comparison. Nothing on the
    // real path reads the arm, so a baseline row there would be a day0 agent
    // wearing the wrong label in the evidence.
    if (arm === 'baseline' && SURFACE_MODE !== 'mock') {
      throw new Error('the baseline comparison arm can only be deployed in mock mode');
    }
    for (const sourceId of args.excludedDocSourceIds ?? []) {
      const source = await ctx.db.get(sourceId);
      if (!source || source.userId !== identity.ownerKey) {
        throw new Error('Documentation source not found or owned by another user.');
      }
    }
    const zone = canonicalZone(args.zone) ?? deploymentZone();
    const agentId = await ctx.db.insert('agents', {
      bossEmail,
      name,
      avatarId: args.avatarId,
      excludedDocSourceIds: args.excludedDocSourceIds?.length
        ? args.excludedDocSourceIds
        : undefined,
      userId: identity.ownerKey,
      state: 'deployed',
      arm,
      zone,
      mode: SURFACE_MODE,
      createdAt: Date.now(),
    });
    await appendEvent(ctx, {
      agentId,
      type: 'agent.deployed',
      payload: { bossEmail, arm, zone, mode: SURFACE_MODE },
      createdAt: Date.now(),
    });
    const initialScopes =
      SURFACE_MODE === 'mock'
        ? [
            'boss:message',
            'docs:read',
            'spreadsheet:read',
            'social:read',
            'ticket:read',
            'slack:read',
          ]
        : ['boss:message', 'docs:read'];
    for (const scope of initialScopes) {
      const createdAt = Date.now();
      await ctx.db.insert('permissionGrants', {
        agentId,
        scope,
        source: 'deploy',
        createdAt,
      });
      await appendEvent(ctx, {
        agentId,
        type: 'permission.granted',
        payload: { scope, source: 'deploy' },
        createdAt,
      });
    }
    await ctx.scheduler.runAfter(0, internal.docSyncActions.mirrorForAgent, { agentId });
    return agentId;
  },
});

/**
 * Public, any signed-in caller (`getCallerOrThrow`, 12-G): the verified address a deploy by this
 * caller would store, so the deploy form shows the server's address and not the browser's. Writes
 * nothing.
 *
 * @returns The address, or null for a caller whose sign-in asserts none verified.
 */
export const myManagerAddress = query({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx): Promise<string | null> => {
    const caller = await getCallerOrThrow(ctx);
    return verifiedAddressOf(caller) ?? null;
  },
});

/**
 * One employee's standing against an owner's verified address, the employee
 * read as an evaluation one by its own row.
 *
 * @param callerAddress - The owner's verified address, or undefined when the sign-in asserts none.
 */
function standingOf(agent: Doc<'agents'>, callerAddress: string | undefined): ManagerStanding {
  return managerStandingOf({
    bossEmail: agent.bossEmail,
    callerAddress,
    evaluation: isEvaluationAgent(agent),
  });
}

/** What `managerStanding` returns: {@link ManagerStanding}, as a validator. */
const managerStandingValidator = v.union(
  v.object({ standing: v.literal('you') }),
  v.object({ standing: v.literal('other'), bossEmail: v.string() }),
  v.object({ standing: v.literal('unverified') }),
  v.object({ standing: v.literal('evaluation') }),
);

/**
 * Public, owner-guarded: whether the employee reports to the caller's own
 * verified address (`you`), to someone else's (`other`, with the stored
 * address, which the People card offers to hand over to or make the
 * caller's), or cannot be compared (`unverified`); an evaluation employee is
 * never flagged (`evaluation`). Compared case-insensitively through the one
 * address comparison, so an older row's spelling is still the owner's
 * (D17 (a), the transfer plan section 11.2). Writes nothing.
 */
export const managerStanding = query({
  args: { agentId: v.id('agents') },
  returns: managerStandingValidator,
  handler: async (ctx, args): Promise<ManagerStanding> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    return standingOf(agent, verifiedAddressOf(await getCallerOrThrow(ctx)));
  },
});

/** One employee that reports to an address other than its owner's, for the home's line. */
const reportingElsewhereValidator = v.object({ agentId: v.id('agents'), name: v.string() });

/**
 * Public, any signed-in caller (`getCallerOrThrow`, 12-G): the caller's company employees that
 * report to an
 * address that is not the caller's verified one, newest first as the roster
 * reads them, for the home's one line while any does, each linked to its
 * People tab (the transfer plan section 11.2). Evaluation employees are left
 * out, as the roster leaves them out, within the rows the roster reads
 * (`ROSTER_SCAN_LIMIT`). Writes nothing.
 *
 * @returns The employees, or null for a caller whose sign-in asserts no verified address.
 */
export const employeesReportingElsewhere = query({
  args: {},
  returns: v.union(v.array(reportingElsewhereValidator), v.null()),
  handler: async (ctx): Promise<Infer<typeof reportingElsewhereValidator>[] | null> => {
    const caller = await getCallerOrThrow(ctx);
    const callerAddress = verifiedAddressOf(caller);
    if (callerAddress === undefined) return null;
    const agents = await ctx.db
      .query('agents')
      .withIndex('by_userId', (q) => q.eq('userId', caller.ownerKey))
      .order('desc')
      .take(ROSTER_SCAN_LIMIT);
    return agents
      .filter((agent) => standingOf(agent, callerAddress).standing === 'other')
      .map((agent) => ({ agentId: agent._id, name: clippedEmployeeName(agent.name) }));
  },
});

/**
 * Public, owner-guarded: **Make it you**. The employee reports to the
 * caller's verified address from now on: writes `bossEmail` and a
 * `manager.changed` event (`via: 'adopted'`), then, in real mode, schedules a
 * probe of every chat surface the change can mend, so the manager DM moves to
 * the owner at once and the open decision requests delivered to the previous
 * DM are sent again to the owner's (the probe's `recordConnected`). The one
 * writer of `bossEmail` besides deploy and an accepted handover (D1 (b),
 * D17 (a)). Refused while a handover of the employee is open (U5-m4): the
 * request names who the employee goes to, and its move would overwrite the
 * address written here.
 *
 * @returns Whether the address changed, and how many surfaces were re-probed.
 * @throws ConvexError for a caller without a verified address, an evaluation employee, or an
 *   employee with a handover open.
 */
export const adoptManagerAddress = mutation({
  args: { agentId: v.id('agents') },
  returns: v.object({ changed: v.boolean(), reprobed: v.number() }),
  handler: async (ctx, args): Promise<{ changed: boolean; reprobed: number }> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    await assertNoHandoverOpen(ctx.db, agent._id, Date.now());
    const caller = await getCallerOrThrow(ctx);
    const standing = standingOf(agent, verifiedAddressOf(caller));
    switch (standing.standing) {
      case 'evaluation':
        throw new ConvexError(EVALUATION_ADDRESS_FIXED);
      case 'unverified':
        throw new ConvexError(UNVERIFIED_FOR_ADOPTION);
      case 'you':
        return { changed: false, reprobed: 0 };
      case 'other':
        return { changed: true, reprobed: await adoptAddress(ctx, agent, caller) };
      default: {
        const unknown: never = standing;
        throw new Error(`unhandled manager standing ${String(unknown)}`);
      }
    }
  },
});

/**
 * Make the caller's verified address the employee's, record it, and re-probe
 * what the change can mend.
 *
 * @returns How many surfaces were re-probed.
 */
async function adoptAddress(
  ctx: MutationCtx,
  agent: Doc<'agents'>,
  caller: Caller,
): Promise<number> {
  const bossEmail = verifiedAddressOf(caller);
  if (bossEmail === undefined) throw new ConvexError(UNVERIFIED_FOR_ADOPTION);
  await ctx.db.patch(agent._id, { bossEmail });
  await appendEvent(ctx, {
    agentId: agent._id,
    type: 'manager.changed',
    payload: { via: 'adopted', bossEmail },
    createdAt: Date.now(),
  });
  return await reprobeForManagerChange(ctx, agent._id);
}

/** The verdicts a surface keeps while its approval and credential stand. */
const MANAGER_REPROBE_VERDICTS: ReadonlyArray<Doc<'surfaces'>['verdict']> = [
  'connected',
  'ungranted',
  'listed-dead',
];

/**
 * Whether changing the manager can change what a probe of this surface finds.
 *
 * Only a chat surface looks the manager up. A connected one is re-probed so
 * the DM moves to the new manager at once; a failed one only when the manager
 * lookup, not the credential, is what failed (Q6).
 */
function reprobedForManagerChange(surface: Doc<'surfaces'>): boolean {
  return (
    surface.class === 'chat' &&
    surface.credentialId !== undefined &&
    surface.managerApprovedAt !== undefined &&
    MANAGER_REPROBE_VERDICTS.includes(surface.verdict) &&
    (surface.verdict === 'connected' || isManagerLookupFailure(surface.reason))
  );
}

/**
 * Schedule a probe of every chat surface a change of manager address can
 * mend, so the manager DM moves to the new person at once and a surface that
 * failed on the old person's lookup comes back (Q6). A probe that resolves a
 * different Slack user writes `manager.changed` (`via: 'probe'`) and re-sends
 * the open decision requests delivered to the previous DM
 * (`resendDecisionsAfterManagerChange`). Mock mode has no provider to probe.
 *
 * @returns How many surfaces were scheduled for a probe.
 */
async function reprobeForManagerChange(ctx: MutationCtx, agentId: Id<'agents'>): Promise<number> {
  if (SURFACE_MODE === 'mock') return 0;
  const surfaces = (
    await ctx.db
      .query('surfaces')
      .withIndex('by_agent', (q) => q.eq('agentId', agentId))
      .collect()
  ).filter(reprobedForManagerChange);
  await Promise.all(
    surfaces.map(
      async (surface) =>
        await ctx.scheduler.runAfter(0, internal.surfaceActions.probeInternal, {
          surfaceId: surface._id,
        }),
    ),
  );
  return surfaces.length;
}

/**
 * Public, owner-guarded: grants permission scopes to an employee as the manager. Refused once a
 * new manager has accepted the employee and it waits for its runs (U3-m3): the scopes would move
 * with it after the new manager's preview.
 */
export const grantScopes = mutation({
  args: { agentId: v.id('agents'), scopes: v.array(v.string()) },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    await assertNotBeingHandedOver(ctx.db, args.agentId);
    let added = 0;
    for (const scope of args.scopes) {
      if (scope.trim() === '') throw new Error('permission scope must not be empty');
      const result = await grantScopeInTransaction(ctx, args.agentId, scope, 'manager');
      if (result.added) added += 1;
    }
    return { added };
  },
});

/** Revoke every active copy of one scope and leave its audit history intact. */
export const revokeScope = mutation({
  args: {
    agentId: v.id('agents'),
    scope: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ revoked: number }> => {
    await assertOwnsAgent(ctx, args.agentId);
    if (args.scope.trim() === '') throw new Error('permission scope must not be empty');
    const grants = await ctx.db
      .query('permissionGrants')
      .withIndex('by_agent_scope', (q) => q.eq('agentId', args.agentId).eq('scope', args.scope))
      .collect();
    const active = grants.filter((grant) => grant.revokedAt === undefined);
    if (active.length === 0) return { revoked: 0 };
    const revokedAt = Date.now();
    for (const grant of active) await ctx.db.patch(grant._id, { revokedAt });
    const reason = args.reason?.replace(/\s+/g, ' ').trim().slice(0, 200);
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'permission.revoked',
      payload: {
        scope: args.scope,
        by: 'manager',
        ...(reason ? { reason } : {}),
      },
      createdAt: revokedAt,
    });
    return { revoked: active.length };
  },
});

/** Active and revoked scopes, collapsed to the latest edge for the dashboard. */
export const permissionScopes = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    const [grants, surfaces, skills] = await Promise.all([
      ctx.db
        .query('permissionGrants')
        .withIndex('by_agent_scope', (q) => q.eq('agentId', args.agentId))
        .collect(),
      ctx.db
        .query('surfaces')
        .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
        .collect(),
      ctx.db
        .query('skills')
        .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId))
        .collect(),
    ]);
    const baseline = new Set([
      'boss:message',
      'docs:read',
      'spreadsheet:read',
      'social:read',
      'ticket:read',
    ]);
    const inferredSource = (scope: string): PermissionGrantSource => {
      if (baseline.has(scope)) return 'deploy';
      if (surfaces.some((surface) => scope === `${surface.slug}:read`)) return 'surface';
      if (skills.some((skill) => skill.requiredScopes?.includes(scope))) return 'skill';
      return 'manager';
    };
    const byScope = new Map<string, Doc<'permissionGrants'>[]>();
    for (const grant of grants) {
      const rows = byScope.get(grant.scope) ?? [];
      rows.push(grant);
      byScope.set(grant.scope, rows);
    }
    return [...byScope.entries()]
      .map(([scope, rows]) => {
        const newestFirst = [...rows].sort((left, right) => right.createdAt - left.createdAt);
        const active = newestFirst.find((row) => row.revokedAt === undefined);
        const latest = active ?? newestFirst[0];
        return {
          scope,
          active: active !== undefined,
          source: latest.source ?? inferredSource(scope),
          grantedAt: latest.createdAt,
          revokedAt: latest.revokedAt ?? null,
        };
      })
      .sort((left, right) => left.scope.localeCompare(right.scope));
  },
});

/** Internal: sets an employee's lifecycle state. */
export const setState = internalMutation({
  args: {
    agentId: v.id('agents'),
    state: schema.tables.agents.validator.fields.state,
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.agentId, { state: args.state });
  },
});

/** Public, owner-guarded: an employee's most recent events, newest first. */
export const recentEvents = query({
  args: { agentId: v.id('agents'), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    const limit = args.limit ?? 50;
    return await ctx.db
      .query('events')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .order('desc')
      .take(limit);
  },
});

/** Internal: an employee's active permission grants. */
export const grantedScopes = internalQuery({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'permissionGrants'>[]> => {
    const all = await ctx.db
      .query('permissionGrants')
      .withIndex('by_agent_scope', (q) => q.eq('agentId', args.agentId))
      .collect();
    return all.filter((g) => !g.revokedAt);
  },
});

/**
 * Grant one scope inside the caller's transaction, once.
 *
 * Exported as a plain helper so that the write which makes a surface
 * `connected` can grant its read scope in the same transaction, rather than
 * from a second call that may never run.
 *
 * Args:
 *   ctx: Mutation context of the caller.
 *   agentId: Agent receiving the grant.
 *   scope: Scope string such as `linear:read`.
 *
 * Returns:
 *   Whether a new grant row was inserted; an active grant is left alone.
 */
export async function grantScopeInTransaction(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  scope: string,
  source: PermissionGrantSource,
): Promise<{ added: boolean }> {
  const existing = (
    await ctx.db
      .query('permissionGrants')
      .withIndex('by_agent_scope', (index) => index.eq('agentId', agentId).eq('scope', scope))
      .collect()
  ).find((grant) => grant.revokedAt === undefined);
  if (existing) return { added: false };
  const createdAt = Date.now();
  await ctx.db.insert('permissionGrants', { agentId, scope, source, createdAt });
  await appendEvent(ctx, {
    agentId,
    type: 'permission.granted',
    payload: { scope, source },
    createdAt,
  });
  return { added: true };
}

/** Grant one read or write scope idempotently after a provider connection succeeds. */
export const grantScope = internalMutation({
  args: { agentId: v.id('agents'), scope: v.string(), source: permissionGrantSource },
  handler: async (ctx, args): Promise<{ added: boolean }> =>
    await grantScopeInTransaction(ctx, args.agentId, args.scope, args.source),
});

/**
 * Choose how the manager hears about run outcomes: as each run finishes, or
 * in one digest on the hour in the agent's zone. Decision requests are sent
 * at once either way; notes kept for a digest are sent when the manager
 * switches back to per run.
 */
export const setManagerNotifications = mutation({
  args: { agentId: v.id('agents'), mode: v.union(v.literal('per-run'), v.literal('digest')) },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: true; managerNotifications: ManagerNotificationMode; changed: boolean }> => {
    await getCallerOrThrow(ctx);
    assertRealMode('Manager notifications');
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const from = managerNotificationMode(agent);
    if (from === args.mode) return { ok: true, managerNotifications: from, changed: false };
    await ctx.db.patch(args.agentId, { managerNotifications: args.mode });
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'agent.notifications-changed',
      payload: { from, to: args.mode, reason: NOTIFICATIONS_CHANGE_REASON },
      createdAt: Date.now(),
    });
    // The notes kept for the next digest would otherwise wait for an hour
    // that per run never has: send them now.
    if (args.mode === 'per-run') {
      await ctx.scheduler.runAfter(0, internal.managerChannelActions.sendManagerDigests, {});
    }
    return { ok: true, managerNotifications: args.mode, changed: true };
  },
});

/**
 * Set the zone the agent's day is measured in, from the card (N12).
 *
 * Public, owner-guarded, both modes. Every day boundary the server draws for
 * the agent and every stamp the dashboard prints move with it; setting the
 * zone the row already has records nothing. Writes `agents.zone` and an
 * `agent.zone-changed` event.
 *
 * @throws ConvexError when the zone is not one the backend knows.
 */
export const setZone = mutation({
  args: { agentId: v.id('agents'), zone: v.string() },
  handler: async (ctx, args): Promise<{ zone: string; changed: boolean }> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const zone = canonicalZone(args.zone);
    if (zone === undefined) throw new ConvexError(`${args.zone} is not a time zone.`);
    const from = agentZone(agent);
    if (agent.zone === zone) return { zone, changed: false };
    await ctx.db.patch(args.agentId, { zone });
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'agent.zone-changed',
      payload: { from, to: zone },
      createdAt: Date.now(),
    });
    return { zone, changed: true };
  },
});

/**
 * The manager's switch: whether the agent may act on connected systems
 * without asking.
 *
 * Owner-scoped, real mode only: the hosted mock has no gate for the switch
 * to change, so it is refused there before the ownership check, and the
 * header keeps its static label. Off is the deploy default (an absent field
 * reads as off). Every change that changes anything is an event; setting
 * the value the row already has records nothing. Switching it on is refused
 * once a new manager has accepted the employee and it waits for its runs
 * (U3-m3): a run already executing would apply under it unapproved until the
 * move; switching it off is always allowed.
 */
export const setAutonomousActions = mutation({
  args: { agentId: v.id('agents'), on: v.boolean() },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: true; autonomousActions: boolean; changed: boolean }> => {
    await getCallerOrThrow(ctx);
    assertRealMode('Autonomous actions');
    const agent = await assertOwnsAgent(ctx, args.agentId);
    if (args.on) await assertNotBeingHandedOver(ctx.db, args.agentId);
    const from = autonomousActionsOn(agent);
    if (from === args.on) return { ok: true, autonomousActions: from, changed: false };
    await ctx.db.patch(args.agentId, { autonomousActions: args.on });
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'agent.autonomy-changed',
      payload: { from, to: args.on, reason: AUTONOMY_CHANGE_REASON },
      createdAt: Date.now(),
    });
    // On raises the cap without moving a row; the work queued at the old cap gets the new slots.
    if (args.on) await wakeQueuedWork(ctx, args.agentId);
    return { ok: true, autonomousActions: args.on, changed: true };
  },
});

/** What a pause or a resume answers: whether the employee is paused now, and whether this call changed it. */
interface PauseOutcome {
  readonly ok: true;
  readonly paused: boolean;
  readonly changed: boolean;
}

/**
 * Pause one employee (wave 12, 12-P; G1 / A15): it takes no intake and starts no step until the
 * manager resumes it. Every decision it already asked stays answerable, from the dashboard, the
 * typed code, a Slack button and the batch code; the step an approval queues waits for the resume.
 * A step already under way runs to its next gate, where the pause holds it (`stepMayRun`).
 *
 * Public: the anonymous-caller guard first, then real mode only (the hosted office's steps are
 * driven by the page, not the server), then the owner's guard. Writes `pausedAt`, `pausedBy` (the
 * caller's owner key) and `pauseReason` (trimmed, absent when blank) and an `agent.paused` event;
 * pausing a paused employee keeps the first pause and records nothing.
 *
 * @throws ConvexError with {@link PAUSE_REASON_TOO_LONG} past the reason's bound.
 */
export const pause = mutation({
  args: { agentId: v.id('agents'), reason: v.optional(v.string()) },
  handler: async (ctx, args): Promise<PauseOutcome> => {
    const caller = await getCallerOrThrow(ctx);
    assertRealMode('Pause');
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const reason = pauseReasonOf(args.reason);
    if (reason !== undefined && !isPauseReasonWithinBound(reason)) {
      throw new ConvexError(PAUSE_REASON_TOO_LONG);
    }
    if (isPaused(agent)) return { ok: true, paused: true, changed: false };
    const now = Date.now();
    await ctx.db.patch(args.agentId, {
      pausedAt: now,
      pausedBy: caller.ownerKey,
      pauseReason: reason,
    });
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'agent.paused',
      payload: reason === undefined ? {} : { reason },
      createdAt: now,
    });
    return { ok: true, paused: true, changed: true };
  },
});

/**
 * Resume a paused employee (12-P): the pause's three fields cleared, an `agent.resumed` event,
 * and in the same transaction one pass of the stalled-step sweep for this employee, so every step
 * the pause held is queued again at once (`resumeAgentStepsInTransaction`).
 *
 * Public: the anonymous-caller guard first, then real mode only, then the owner's guard. Resuming
 * an employee that is not paused records nothing.
 */
export const resume = mutation({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<PauseOutcome> => {
    await getCallerOrThrow(ctx);
    assertRealMode('Pause');
    const agent = await assertOwnsAgent(ctx, args.agentId);
    if (agent.pausedAt === undefined) return { ok: true, paused: false, changed: false };
    const now = Date.now();
    await ctx.db.patch(args.agentId, {
      pausedAt: undefined,
      pausedBy: undefined,
      pauseReason: undefined,
    });
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'agent.resumed',
      payload: { pausedAt: agent.pausedAt },
      createdAt: now,
    });
    await resumeAgentStepsInTransaction(ctx, args.agentId, now);
    return { ok: true, paused: false, changed: true };
  },
});
