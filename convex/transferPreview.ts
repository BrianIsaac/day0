import { ConvexError, v, type Infer } from 'convex/values';
import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { clipRoleLine } from './roster';
import { readableDocs } from './mock';
import { RETIRE_PREVIEW_ROW_LIMIT } from './reset';
import { surfaceHandoversOf } from './surfaces';
import { runsInFlight } from './transferInFlight';
import { needsYouOfEmployee, type NeedsYouEntry } from './work';
import type { CharterConstraint } from '../src/agent/charter-constraints';
import { clippedEmployeeName } from '../src/agent/employee-name';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { shownEmployeeState } from '../src/work/state-labels';

/*
 * What the named manager reads before accepting a handover (the transfer plan, section 6.1): the
 * employee, the request, what comes with it and what does not, as counts and names, each read by
 * index and bounded. A request is not a grant of read access (section 4.4), so nothing here
 * answers a row's content. The public query that serves it is `transferAcceptance.transferPreview`,
 * beside the acceptance it previews; this module holds no registered function.
 */

/**
 * The refusal for an employee that is gone, or no longer belongs to the manager who asked: a
 * request is a hand-over of what that manager had.
 */
export const EMPLOYEE_LEFT_ASKER =
  'The employee in this handover no longer works for the manager who asked.';

/** The most of an employee's rows of one kind the preview reads, as the retire's preview does. */
const PREVIEW_ROW_LIMIT = RETIRE_PREVIEW_ROW_LIMIT;

/** The most of the acceptor's own documentation sources the preview lists for the ticks. */
const PREVIEW_SOURCE_LIMIT = 100;

/** One state of a work item. */
export type WorkItemState = Doc<'workItems'>['state'];

/**
 * Whether work in each state is still open, rather than the record. Keyed over every state, so a
 * state the schema gains does not compile until it is placed.
 */
export const WORK_IS_OPEN: Readonly<Record<WorkItemState, boolean>> = {
  discovered: true,
  claimed: true,
  'plan-pending': true,
  'plan-approved': true,
  executing: true,
  'actions-pending': true,
  deferred: true,
  'needs-skill': true,
  completed: false,
  cancelled: false,
  failed: false,
  skipped: false,
};

/** The states of open work, read one index range each. */
const OPEN_WORK_STATES = (Object.keys(WORK_IS_OPEN) as WorkItemState[]).filter(
  (state) => WORK_IS_OPEN[state],
);

/**
 * The employee a request hands over, while it still belongs to the manager who asked.
 *
 * @throws ConvexError with {@link EMPLOYEE_LEFT_ASKER} otherwise.
 */
export async function departingEmployee(
  db: QueryCtx['db'],
  transfer: Doc<'managerTransfers'>,
): Promise<Doc<'agents'>> {
  const agent = await db.get(transfer.agentId);
  if (agent === null || agent.userId !== transfer.fromOwnerKey) {
    throw new ConvexError(EMPLOYEE_LEFT_ASKER);
  }
  return agent;
}

/** The employee's newest approved charter, the one in force, or null before one is approved. */
async function approvedCharterOf(
  db: QueryCtx['db'],
  agentId: Id<'agents'>,
): Promise<Doc<'charters'> | null> {
  const charters = db
    .query('charters')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .order('desc');
  for await (const charter of charters) if (charter.approved) return charter;
  return null;
}

/** The role line the roster would show from an approved charter, or null when it states none. */
function roleLineOf(charter: Doc<'charters'> | null): string | null {
  const proposed = (charter?.body as { proposedFunction?: unknown } | null | undefined)
    ?.proposedFunction;
  return typeof proposed === 'string' && proposed.trim() !== '' ? clipRoleLine(proposed) : null;
}

/**
 * The charter's reporting-line rules the manager has not struck, quoted: the old manager's own
 * words about whom the employee reports to, for the new manager to confirm or amend.
 */
function reportingLinesOf(charter: Doc<'charters'> | null): string[] {
  const constraints = (charter?.body as { constraints?: unknown } | null | undefined)?.constraints;
  if (!Array.isArray(constraints)) return [];
  return (constraints as Partial<CharterConstraint>[])
    .filter((rule) => rule.kind === 'reporting-line' && rule.struck !== true)
    .flatMap((rule) => (typeof rule.quote === 'string' ? [rule.quote] : []));
}

/** One connection the handover cuts, by the name the Surfaces tab gives it. */
const previewSurface = v.object({ slug: v.string(), displayName: v.string() });

/** One permission scope the employee holds, with the path that granted it. */
const previewScope = v.object({
  scope: v.string(),
  source: v.optional(
    v.union(v.literal('deploy'), v.literal('manager'), v.literal('skill'), v.literal('surface')),
  ),
});

/** What `transferPreview` answers. */
export const transferPreviewValidator = v.object({
  transferId: v.id('managerTransfers'),
  mode: v.union(v.literal('mock'), v.literal('real')),
  /** Who the employee is: never a charter clause or a work item's content. */
  employee: v.object({
    agentId: v.id('agents'),
    name: v.string(),
    avatarId: v.optional(v.string()),
    state: v.union(
      v.literal('deployed'),
      v.literal('day-one-in-progress'),
      v.literal('charter-pending'),
      v.literal('active'),
    ),
    /** The approved charter's role line, clipped as the roster shows it; null before one. */
    roleLine: v.union(v.string(), v.null()),
  }),
  fromAddress: v.string(),
  note: v.optional(v.string()),
  requestedAt: v.number(),
  expiresAt: v.number(),
  /** What the new manager takes on, as counts and names. */
  takesOn: v.object({
    /**
     * The decisions waiting on the manager now, by the inbox's kinds, as counts. A validator's
     * field name must be a backend identifier, so the `one-to-one` kind is `oneToOne` here.
     */
    waiting: v.object({
      oneToOne: v.number(),
      charter: v.number(),
      plan: v.number(),
      held: v.number(),
      skill: v.number(),
      parked: v.number(),
      stopped: v.number(),
      surface: v.number(),
    }),
    /** Work items not yet closed (completed, cancelled, skipped or failed). */
    openWork: v.number(),
    openWorkAtLeast: v.boolean(),
    registeredSkills: v.number(),
    /** The newest charter's version and whether it is approved; null before one is drafted. */
    charter: v.union(v.null(), v.object({ version: v.string(), approved: v.boolean() })),
    /** The scopes that move (D9), the ones the cut revokes left out. */
    scopes: v.array(previewScope),
    recordLength: v.number(),
    recordAtLeast: v.boolean(),
  }),
  /** What does not come with the employee. */
  leavesBehind: v.object({
    /** The connections cut, which the new manager approves and connects again. */
    surfaces: v.array(previewSurface),
    /** The read scopes those connections had granted. */
    scopesRevoked: v.array(v.string()),
    /** Pages mirrored from the old manager's documentation that the employee stops reading. */
    mirroredPages: v.number(),
    mirroredPagesAtLeast: v.boolean(),
    /** Whether the autonomy switch is on now; it is off after the move. */
    autonomousActions: v.boolean(),
  }),
  /** The charter's reporting-line rules, quoted, for the new manager to check. */
  reportingLines: v.array(v.string()),
  /** The acceptor's own documentation sources, which the employee inherits unless unticked. */
  documentation: v.array(v.object({ sourceId: v.id('docSources'), label: v.string() })),
  /** Runs executing or applying now. */
  runsInFlight: v.number(),
});

/** The preview's answer. */
export type TransferPreview = Infer<typeof transferPreviewValidator>;

/**
 * The decisions waiting on the manager, by the inbox's kinds: `needsYouOfEmployee`'s entries,
 * the same rows the home and the employee's tab list, counted.
 */
function waitingByKind(entries: readonly NeedsYouEntry[]): TransferPreview['takesOn']['waiting'] {
  const count = (kind: NeedsYouEntry['kind']): number =>
    entries.filter((entry) => entry.kind === kind).length;
  return {
    oneToOne: count('one-to-one'),
    charter: count('charter'),
    plan: count('plan'),
    held: count('held'),
    skill: count('skill'),
    parked: count('parked'),
    stopped: count('stopped'),
    surface: count('surface'),
  };
}

/**
 * What the employee takes to the new manager, as counts: its open work, its registered skills,
 * its charter, its scopes and its record, each read by index and bounded.
 */
async function takenOn(
  ctx: QueryCtx,
  agent: Doc<'agents'>,
  revokedScopes: ReadonlySet<string>,
): Promise<TransferPreview['takesOn']> {
  const agentId = agent._id;
  const [waiting, open, skills, newest, grants, events] = await Promise.all([
    needsYouOfEmployee(ctx, agent, Date.now()),
    Promise.all(
      OPEN_WORK_STATES.map(
        async (state) =>
          await ctx.db
            .query('workItems')
            .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', state))
            .take(PREVIEW_ROW_LIMIT),
      ),
    ),
    ctx.db
      .query('skills')
      .withIndex('by_agent_name', (q) => q.eq('agentId', agentId))
      .take(PREVIEW_ROW_LIMIT),
    ctx.db
      .query('charters')
      .withIndex('by_agent', (q) => q.eq('agentId', agentId))
      .order('desc')
      .first(),
    ctx.db
      .query('permissionGrants')
      .withIndex('by_agent_scope', (q) => q.eq('agentId', agentId))
      .take(PREVIEW_ROW_LIMIT),
    ctx.db
      .query('events')
      .withIndex('by_agent', (q) => q.eq('agentId', agentId))
      .take(PREVIEW_ROW_LIMIT),
  ]);
  return {
    waiting: waitingByKind(waiting),
    openWork: open.reduce((total, rows) => total + rows.length, 0),
    openWorkAtLeast: open.some((rows) => rows.length >= PREVIEW_ROW_LIMIT),
    registeredSkills: skills.filter((skill) => skill.state === 'registered').length,
    charter: newest && { version: newest.version, approved: newest.approved },
    scopes: grants
      .filter((grant) => grant.revokedAt === undefined && !revokedScopes.has(grant.scope))
      .map((grant) => ({
        scope: grant.scope,
        ...(grant.source === undefined ? {} : { source: grant.source }),
      })),
    recordLength: events.length,
    recordAtLeast: events.length >= PREVIEW_ROW_LIMIT,
  };
}

/**
 * The read scopes the cut would revoke: each cut connection's `<slug>:read` that a connection
 * granted, as `handOverSurfaces` revokes them.
 */
async function scopesTheCutRevokes(
  db: QueryCtx['db'],
  agentId: Id<'agents'>,
  cutSlugs: readonly string[],
): Promise<string[]> {
  const revoked = await Promise.all(
    cutSlugs.map(async (slug) => {
      const scope = `${slug}:read`;
      const grants = await db
        .query('permissionGrants')
        .withIndex('by_agent_scope', (q) => q.eq('agentId', agentId).eq('scope', scope))
        .collect();
      const active = grants.some(
        (grant) =>
          grant.revokedAt === undefined &&
          (grant.source === 'surface' || grant.source === undefined),
      );
      return active ? [scope] : [];
    }),
  );
  return revoked.flat();
}

/**
 * The mirrored pages the employee stops reading: one paged read at the mirrors' own bound, so a
 * long-lived employee's pages are counted as "at least" rather than read in full.
 */
async function departingMirrors(
  ctx: QueryCtx,
  agent: Doc<'agents'>,
  toOwnerKey: string,
): Promise<{ count: number; atLeast: boolean }> {
  const page = await ctx.db
    .query('mockDocs')
    .withIndex('by_agent_slug', (q) => q.eq('agentId', agent._id))
    .paginate({ numItems: PREVIEW_ROW_LIMIT, maximumBytesRead: 4 * 1024 * 1024, cursor: null });
  const readable = new Set(
    (await readableDocs(ctx.db, { ...agent, userId: toOwnerKey }, page.page)).map((doc) => doc._id),
  );
  return {
    count: page.page.filter((doc) => !readable.has(doc._id)).length,
    atLeast: !page.isDone,
  };
}

/**
 * What accepting an asked handover would bring and leave (the transfer plan, section 6.1), for
 * the account it names: bounded reads by index, at most `RETIRE_PREVIEW_ROW_LIMIT` rows of each
 * kind, counts and names only, never the content of a work item, a charter or a record. Reads
 * the employee's mirrors with one paged read, so one query builds one preview.
 *
 * @param ctx - Any query context; the caller has already checked the account is the one named.
 * @param transfer - The request, `asked`.
 * @param acceptorKey - The named account's owner key, whose documentation the ticks list.
 * @throws ConvexError with {@link EMPLOYEE_LEFT_ASKER} when the employee is no longer the asker's.
 */
export async function transferPreviewOf(
  ctx: QueryCtx,
  transfer: Doc<'managerTransfers'>,
  acceptorKey: string,
): Promise<TransferPreview> {
  const agent = await departingEmployee(ctx.db, transfer);
  const planned = await surfaceHandoversOf(ctx.db, agent._id);
  const cut = planned.filter(({ handover }) => handover === 'cut').map(({ surface }) => surface);
  const scopesRevoked = await scopesTheCutRevokes(
    ctx.db,
    agent._id,
    cut.map((surface) => surface.slug),
  );
  const [charter, takesOn, mirrors, sources, inFlight] = await Promise.all([
    approvedCharterOf(ctx.db, agent._id),
    takenOn(ctx, agent, new Set(scopesRevoked)),
    departingMirrors(ctx, agent, acceptorKey),
    ctx.db
      .query('docSources')
      .withIndex('by_user', (q) => q.eq('userId', acceptorKey))
      .take(PREVIEW_SOURCE_LIMIT),
    runsInFlight(ctx.db, agent._id),
  ]);
  return {
    transferId: transfer._id,
    mode: SURFACE_MODE,
    employee: {
      agentId: agent._id,
      name: clippedEmployeeName(agent.name),
      ...(agent.avatarId === undefined ? {} : { avatarId: agent.avatarId }),
      state: shownEmployeeState(agent.state, takesOn.charter),
      roleLine: roleLineOf(charter),
    },
    fromAddress: transfer.fromAddress,
    ...(transfer.note === undefined ? {} : { note: transfer.note }),
    requestedAt: transfer.requestedAt,
    expiresAt: transfer.expiresAt,
    takesOn,
    leavesBehind: {
      surfaces: cut.map((surface) => ({ slug: surface.slug, displayName: surface.displayName })),
      scopesRevoked,
      mirroredPages: mirrors.count,
      mirroredPagesAtLeast: mirrors.atLeast,
      autonomousActions: agent.autonomousActions === true,
    },
    reportingLines: reportingLinesOf(charter),
    documentation: sources.map((source) => ({ sourceId: source._id, label: source.label })),
    runsInFlight: inFlight,
  };
}
