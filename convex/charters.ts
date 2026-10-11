import { ConvexError, v, type Infer } from 'convex/values';
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { assertOwnsAgent, assertOwnsCharter } from './ownership';
import { assertNotBeingHandedOver } from './handoverFence';
import { writeFileImpl } from './workspace';
import { declareCharterSystem, retireCharterSystem, scheduleOrientationFor } from './surfaces';
import type { Charter } from '../src/agent/charter';
import {
  applyCharterChanges,
  charterDiff,
  nextCharterVersion,
  type CharterChange,
} from '../src/agent/charter-amendment';
import {
  CONSTRAINT_KINDS,
  STRIKE_CHANGES_NOTHING,
  clauseChanges,
  strikeOutcome,
  strikePreview,
  type CharterConstraint,
} from '../src/agent/charter-constraints';
import {
  identityFromCharter,
  toolsFromCharter,
  userFromManager,
} from '../src/agent/charter-workspace';
import { SYSTEM_CLASSES } from '../src/agent/system-classes';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { appendEvent } from './eventLog';
import { scheduleCharterCheck } from './workingAgreements';
import { questionKey } from '../src/agent/manager-questions';
import type { AmendmentVia } from '../src/events/contract';

/**
 * Charter CRUD + binary-plus-edit approval mutation. Every public
 * function asserts the caller owns the agent the charter belongs to.
 */

/** One of the eight workspace files, rendered by the caller before the commit. */
export const workspaceFileValidator = v.object({
  fileName: v.string(),
  content: v.string(),
});

/** One workspace file as a charter commit writes it. */
export interface WorkspaceFile {
  fileName: string;
  content: string;
}

/**
 * Everything a drafted charter writes, as one transaction: the charter row, the
 * workspace files rendered from it, and the event that announces it. Callers
 * that also finalise a voice session (`voice.finaliseSession`) reuse this so the
 * session, its charter and its workspace can never disagree about whether the
 * Day-1 1:1 produced anything.
 */
export async function commitCharterAndWorkspace(
  ctx: MutationCtx,
  args: {
    agentId: Id<'agents'>;
    version: string;
    body: unknown;
    workspaceFiles: WorkspaceFile[];
  },
): Promise<Id<'charters'>> {
  const charterId = await ctx.db.insert('charters', {
    agentId: args.agentId,
    version: args.version,
    body: args.body,
    approved: false,
    createdAt: Date.now(),
  });
  for (const file of args.workspaceFiles) {
    await writeFileImpl(ctx, {
      agentId: args.agentId,
      fileName: file.fileName,
      content: file.content,
    });
  }
  await appendEvent(ctx, {
    agentId: args.agentId,
    type: 'charter.drafted',
    payload: { charterId, version: args.version },
    createdAt: Date.now(),
  });
  return charterId;
}

/** Public, owner-guarded: an employee's latest charter version. */
export const latest = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('charters')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .order('desc')
      .first();
  },
});

/** Internal: an employee's latest charter version, for a scheduled step with no caller. */
export const latestInternal = internalQuery({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) =>
    await ctx.db
      .query('charters')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .order('desc')
      .first(),
});

/** Public, owner-guarded: every version of an employee's charter. */
export const listForAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('charters')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .order('desc')
      .collect();
  },
});

/**
 * Commit a charter that has no voice session behind it - the chat-mode 1:1 and
 * the answers-first entry point. A run that does have one goes through
 * `voice.finaliseSession`, which adds the session transition to this same
 * transaction.
 *
 * The agent moves to `charter-pending` here for the same reason it does there:
 * the 1:1 is over the moment a charter exists. Without it the chat route left
 * the row at `day-one-in-progress` for good - a dashboard still showing the
 * 1:1 in progress under the charter it produced, and an avatar still working
 * on the landing page.
 */
export const commit = internalMutation({
  args: {
    agentId: v.id('agents'),
    version: v.string(),
    body: v.any(),
    workspaceFiles: v.array(workspaceFileValidator),
  },
  handler: async (ctx, args): Promise<Id<'charters'>> => {
    const charterId = await commitCharterAndWorkspace(ctx, {
      agentId: args.agentId,
      version: args.version,
      body: args.body,
      workspaceFiles: args.workspaceFiles,
    });
    await ctx.db.patch(args.agentId, { state: 'charter-pending' });
    return charterId;
  },
});

/**
 * Re-render the two workspace files a charter body decides.
 *
 * Args:
 *   ctx: Mutation context.
 *   agentId: Agent whose workspace to write.
 *   charter: The body to render from.
 */
export async function renderWorkspaceFromCharter(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  charter: Charter,
): Promise<void> {
  const agent = await ctx.db.get(agentId);
  await writeFileImpl(ctx, {
    agentId,
    fileName: 'IDENTITY.md',
    content: identityFromCharter(charter, agent?.bossEmail),
  });
  await writeFileImpl(ctx, { agentId, fileName: 'TOOLS.md', content: toolsFromCharter(charter) });
}

/**
 * Render IDENTITY.md (and TOOLS.md with it, through {@link renderWorkspaceFromCharter}) and USER.md
 * again for the manager the employee row names now, from its newest approved charter: a handover
 * writes the new manager's address to the row (the transfer plan, section 6.2), and both files
 * name the manager, so neither keeps the old one's (the wave 9 review, section 3). An employee
 * whose charter was never approved keeps its files, since a draft is rendered without a manager
 * and the handover discards it (D8).
 *
 * @param ctx - The handover's mutation context.
 * @param agentId - The employee, already under its new manager.
 * @returns Whether the file was rendered.
 */
export async function renderIdentityForManager(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
): Promise<boolean> {
  const charters = ctx.db
    .query('charters')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .order('desc');
  for await (const charter of charters) {
    if (!charter.approved) continue;
    await renderWorkspaceFromCharter(ctx, agentId, charter.body as Charter);
    const agent = await ctx.db.get(agentId);
    if (agent) {
      await writeFileImpl(ctx, {
        agentId,
        fileName: 'USER.md',
        content: userFromManager(agent.bossEmail),
      });
    }
    return true;
  }
  return false;
}

/**
 * The workspace files a draft writes in its manager's words: the two rendered from the charter,
 * and the one that names the manager. The draft's other files are the deployment's defaults.
 */
const DRAFT_MANAGER_FILES = ['IDENTITY.md', 'TOOLS.md', 'USER.md'] as const;

/** The most charter versions of one employee a handover discards. */
const DRAFT_DISCARD_LIMIT = 100;

/**
 * What a handover does with an employee's charter (decision D8 (a)): an approved one is carried;
 * a charter never approved is discarded, every draft version of it; and an employee with more
 * versions than one move discards is refused.
 */
export type CharterAtHandover =
  | { readonly kind: 'carried' }
  | { readonly kind: 'discarded'; readonly drafts: readonly Doc<'charters'>[] }
  | { readonly kind: 'refused'; readonly refusal: string };

/**
 * Decide what a handover does with the employee's charter ({@link CharterAtHandover}), reading
 * at most one move's bound of versions.
 *
 * @param db - Any reader.
 * @param agent - The employee.
 */
export async function charterAtHandover(
  db: QueryCtx['db'],
  agent: Doc<'agents'>,
): Promise<CharterAtHandover> {
  if (agent.state === 'active') return { kind: 'carried' };
  const versions = await db
    .query('charters')
    .withIndex('by_agent', (q) => q.eq('agentId', agent._id))
    .take(DRAFT_DISCARD_LIMIT + 1);
  if (versions.some((charter) => charter.approved)) return { kind: 'carried' };
  if (versions.length > DRAFT_DISCARD_LIMIT) {
    return {
      kind: 'refused',
      refusal: `This employee has more than ${DRAFT_DISCARD_LIMIT} draft charters, more than one handover can discard.`,
    };
  }
  return { kind: 'discarded', drafts: versions };
}

/**
 * Discard an employee's charter that was never approved, at a handover's move (decision D8 (a)):
 * the draft is its manager's own words, and the new manager holds the Day-1 one-to-one. Every
 * draft version is deleted, with the workspace files written in the old manager's words
 * ({@link DRAFT_MANAGER_FILES}), and the employee returns to `deployed`. A charter the manager
 * approved is carried as it is. The events that recorded the drafts stay in the record (D10).
 *
 * @param ctx - The move's mutation context.
 * @param agent - The employee, as the move read it.
 * @returns Whether the employee returned to `deployed` (its charter was never approved), and
 *   whether a draft was discarded with it.
 * @throws ConvexError when the employee has more draft versions than one move discards.
 */
export async function discardUnapprovedCharter(
  ctx: MutationCtx,
  agent: Doc<'agents'>,
): Promise<{ readonly returnedToDeployed: boolean; readonly discarded: boolean }> {
  const decided = await charterAtHandover(ctx.db, agent);
  switch (decided.kind) {
    case 'carried':
      return { returnedToDeployed: false, discarded: false };
    case 'refused':
      throw new ConvexError(decided.refusal);
    case 'discarded':
      break;
    default: {
      const unknown: never = decided;
      throw new Error(`unhandled charter decision ${String(unknown)}`);
    }
  }
  for (const draft of decided.drafts) await ctx.db.delete(draft._id);
  for (const fileName of DRAFT_MANAGER_FILES) {
    const file = await ctx.db
      .query('workspace')
      .withIndex('by_agent_file', (q) => q.eq('agentId', agent._id).eq('fileName', fileName))
      .first();
    if (file !== null) await ctx.db.delete(file._id);
  }
  if (agent.state !== 'deployed') await ctx.db.patch(agent._id, { state: 'deployed' });
  return { returnedToDeployed: true, discarded: decided.drafts.length > 0 };
}

/** A strike or an approval either lands or names the reason it was refused. */
const strikeResultValidator = v.union(
  v.object({ ok: v.literal(true) }),
  v.object({ ok: v.literal(false), reason: v.string() }),
);

/** Whether a strike went through, and why not when it was refused. */
export type StrikeResult = { ok: true } | { ok: false; reason: string };

/**
 * Strike or restore one constraint on a drafted charter.
 *
 * The draft's clauses are left as synthesised until approval, so a strike
 * costs nothing to reverse and the manager reads the same draft throughout;
 * `approve` is where the struck wording leaves the clauses. The effective
 * charter is computed here all the same, with the function approval uses,
 * so a strike approval could not honour is refused now, with the reason,
 * and the flag is never set; so is a strike that would change no clause.
 */
export const setConstraintStruck = mutation({
  args: { charterId: v.id('charters'), index: v.number(), struck: v.boolean() },
  returns: strikeResultValidator,
  handler: async (ctx, args): Promise<StrikeResult> => {
    const charter = await assertOwnsCharter(ctx, args.charterId);
    if (charter.approved) {
      throw new Error('the charter is approved; amend it to strike a constraint');
    }
    const body = charter.body as Charter;
    const constraints = [...(body.constraints ?? [])];
    const target = constraints[args.index];
    if (!Number.isInteger(args.index) || !target) {
      throw new Error(`no constraint at index ${args.index}`);
    }
    constraints[args.index] = { ...target, struck: args.struck };
    const toggled: Charter = { ...body, constraints };
    if (args.struck && target.struck !== true) {
      // The card's own preview: a strike approval would refuse, or one that changes no clause,
      // is refused here with the same reason and the flag never set (the production walk's 6c).
      const preview = strikePreview(body, args.index);
      if (preview.refusal !== undefined) return { ok: false, reason: preview.refusal };
      if (!preview.changes) return { ok: false, reason: STRIKE_CHANGES_NOTHING };
    }
    await ctx.db.patch(args.charterId, { body: toggled });
    return { ok: true };
  },
});

/**
 * Approve the draft, applying its strikes to the clauses, and seed the work
 * it implies.
 *
 * Public, owner-guarded (`assertOwnsCharter`). Writes the approval, the
 * agent's `active` state and `charter.approved`, and in the same transaction
 * schedules `onboarding.postCharterApproval`, so the seeding no longer rests
 * on the page staying open (P5-6, P9-10), and schedules the `charter`
 * re-evaluation that returns work parked while the charter waited. Approving an approved charter
 * changes nothing and seeds nothing again: a second tab's click is a no-op.
 *
 * A strike is refused by `setConstraintStruck` before it is ever flagged,
 * so the refusal here is a last guard for a body that reached the table
 * some other way; it returns the reason rather than throwing, and leaves
 * the row as it was. Refused with a `ConvexError`, in the accepted
 * handover's words, once a new manager has accepted the employee and it
 * waits for its runs: the approved charter would move with it after the new
 * manager's preview (decision 9; the wave 10 review, FR-m6).
 */
export const approve = mutation({
  args: { charterId: v.id('charters') },
  returns: strikeResultValidator,
  handler: async (ctx, args): Promise<StrikeResult> => {
    const charter = await assertOwnsCharter(ctx, args.charterId);
    await assertNotBeingHandedOver(ctx.db, charter.agentId);
    if (charter.approved) return { ok: true };
    const drafted = charter.body as Charter;
    const struck = (drafted.constraints ?? []).filter(
      (constraint: CharterConstraint): boolean => constraint.struck === true,
    );
    // A strike changes the body, and the body is what every downstream
    // reader and the two workspace files are rendered from. With nothing
    // struck the row is patched for approval only and the draft stays
    // byte-identical.
    if (struck.length > 0) {
      const outcome = strikeOutcome(drafted);
      if (!outcome.ok) return { ok: false, reason: outcome.reason };
      // The clauses the strikes took out are kept on the body, so the approved
      // record can show them struck.
      const changed = clauseChanges(drafted, outcome.charter);
      const approved: Charter =
        changed.length > 0 ? { ...outcome.charter, struckClauses: changed } : outcome.charter;
      await ctx.db.patch(args.charterId, {
        body: approved,
        approved: true,
        approvedAt: Date.now(),
      });
      await renderWorkspaceFromCharter(ctx, charter.agentId, approved);
    } else {
      await ctx.db.patch(args.charterId, {
        approved: true,
        approvedAt: Date.now(),
      });
    }
    await ctx.db.patch(charter.agentId, { state: 'active' });
    await appendEvent(ctx, {
      agentId: charter.agentId,
      type: 'charter.approved',
      payload: {
        charterId: args.charterId,
        version: charter.version,
        ...(struck.length > 0
          ? {
              struckConstraints: struck.map(
                (constraint: CharterConstraint): string => constraint.quote,
              ),
            }
          : {}),
      },
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.onboarding.postCharterApproval, {
      agentId: charter.agentId,
      charterId: args.charterId,
    });
    // Work parked while the charter waited (`awaiting-charter`) returns now.
    await scheduleReevaluation(ctx, charter.agentId, args.charterId);
    // An employee hired after an agreement for every employee is checked against it now (13-W).
    await scheduleCharterCheck(ctx, charter.agentId);
    return { ok: true };
  },
});

const listClauseField = v.union(
  v.literal('willDo'),
  v.literal('willNotDo'),
  v.literal('escalationTriggers'),
);

const literals = <T extends string>(values: readonly T[]) =>
  v.union(...(values.map((value) => v.literal(value)) as [ReturnType<typeof v.literal<T>>]));

/** One typed change to an approved charter; see `src/agent/charter-amendment.ts`. */
export const charterChangeValidator = v.union(
  v.object({ kind: v.literal('edit-function'), text: v.string() }),
  v.object({
    kind: v.literal('edit-clause'),
    field: listClauseField,
    index: v.number(),
    text: v.string(),
  }),
  v.object({ kind: v.literal('answer-question'), question: v.string(), answer: v.string() }),
  v.object({
    kind: v.literal('add-constraint'),
    constraint: v.object({
      kind: literals(CONSTRAINT_KINDS),
      quote: v.string(),
      clause: listClauseField,
    }),
  }),
  v.object({ kind: v.literal('strike-constraint'), index: v.number() }),
  v.object({
    kind: v.literal('add-system'),
    system: v.object({
      name: v.string(),
      class: literals(SYSTEM_CLASSES),
      whereMentioned: v.string(),
    }),
  }),
  v.object({ kind: v.literal('remove-system'), name: v.string() }),
  v.object({
    kind: v.literal('edit-adjacent-role'),
    index: v.number(),
    role: v.object({ who: v.string(), staysOutOfTheirLaneBy: v.string() }),
  }),
  v.object({
    kind: v.literal('edit-collaborator'),
    index: v.number(),
    collaborator: v.object({
      name: v.string(),
      topic: v.string(),
      introPath: v.union(v.literal('manager'), v.literal('self'), v.literal('tbd')),
    }),
  }),
);

/**
 * Amend the agent's approved charter: one new version, one event, the
 * workspace re-rendered, orientation for an added system, and a
 * re-evaluation of parked work, all in this transaction.
 *
 * Every row is kept. The new row is approved on insert (the manager sent the
 * change) and supersedes the previous one, so `latest` switches the whole
 * app to the new version in one write. The event carries the changes as
 * sent and the per-field diff, because no store gives actor, reason and diff
 * for free.
 *
 * Args:
 *   ctx: Mutation context.
 *   args: The agent, the changes, who sent them and an optional reason.
 *
 * Returns:
 *   The new charter row's id and version.
 *
 * Raises:
 *   ConvexError: In the accepted handover's words, while a new manager's
 *     acceptance of the employee waits for its runs (decision 9).
 *   Error: When the agent has no approved charter, a change names something
 *     the charter lacks, or the changes leave the body as it was.
 */
export async function amendCharterInTransaction(
  ctx: MutationCtx,
  args: {
    agentId: Id<'agents'>;
    changes: readonly CharterChange[];
    via: AmendmentVia;
    reason?: string;
  },
): Promise<{ charterId: Id<'charters'>; version: string; previousVersion: string }> {
  // Every path that amends (the card, a question's answer, a plan approved with answers, the
  // DMs) waits out an accepted handover: the amendment would move with the employee after the
  // new manager's preview (decision 9; the second pass).
  await assertNotBeingHandedOver(ctx.db, args.agentId);
  const previous = await ctx.db
    .query('charters')
    .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
    .order('desc')
    .first();
  if (!previous) throw new Error('the agent has no charter to amend');
  if (!previous.approved) {
    throw new Error('the charter is not approved yet; approve it or request changes instead');
  }
  const now = Date.now();
  const before = previous.body as Charter;
  const version = nextCharterVersion(previous.version);
  const applied = applyCharterChanges(before, args.changes, new Date(now));
  const after: Charter = { ...applied.charter, version };
  const diff = charterDiff(before, after);
  if (diff.length === 0) throw new Error('the amendment changes nothing');

  const charterId = await ctx.db.insert('charters', {
    agentId: args.agentId,
    version,
    body: after,
    approved: true,
    approvedAt: now,
    supersedes: previous._id,
    createdAt: now,
  });
  await renderWorkspaceFromCharter(ctx, args.agentId, after);
  await appendEvent(ctx, {
    agentId: args.agentId,
    type: 'charter.amended',
    payload: {
      charterId,
      previousCharterId: previous._id,
      version,
      previousVersion: previous.version,
      via: args.via,
      ...(args.reason?.trim() ? { reason: args.reason.trim() } : {}),
      changes: args.changes,
      diff,
    },
    createdAt: now,
  });

  // Systems become surfaces in real mode only, as at approval; the hosted
  // mock keeps its synthetic surfaces and files no orientation.
  if (SURFACE_MODE === 'real') {
    for (const system of applied.systemsAdded) {
      const declared = await declareCharterSystem(ctx, { agentId: args.agentId, system, now });
      if (!declared.surfaceId) continue;
      const surface = await ctx.db.get(declared.surfaceId);
      if (surface) await scheduleOrientationFor(ctx, surface);
    }
    for (const system of applied.systemsRemoved) {
      await retireCharterSystem(ctx, { agentId: args.agentId, system, now });
    }
  }

  await scheduleReevaluation(ctx, args.agentId, charterId);
  // An amended charter is checked against the agreements for every employee, as an approved one is.
  await scheduleCharterCheck(ctx, args.agentId);
  return { charterId, version, previousVersion: previous.version };
}

/**
 * Send the work parked under the previous version back for evaluation.
 *
 * The new charter row is the trigger's idempotency key: one amendment
 * re-admits a parked row once, and the row's verdict is judged again
 * against the current charter, never reconciled against the diff.
 */
async function scheduleReevaluation(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  charterId: Id<'charters'>,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.work.reevaluatePending, {
    agentId,
    trigger: 'charter',
    key: charterId,
  });
}

/**
 * Amend the owner's approved charter from the dashboard.
 *
 * Public, owner-guarded. A refused change (an edit that removes a boundary a
 * confirmed rule stands on, a change that changes nothing, a draft) is thrown
 * as a `ConvexError` whose data is the refusal, so the card can show it; so is
 * any change once a new manager has accepted the employee and it waits for its
 * runs (decision 9).
 */
export const amend = mutation({
  args: {
    agentId: v.id('agents'),
    changes: v.array(charterChangeValidator),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ charterId: Id<'charters'>; version: string }> => {
    await assertOwnsAgent(ctx, args.agentId);
    try {
      const result = await amendCharterInTransaction(ctx, {
        agentId: args.agentId,
        changes: args.changes,
        via: 'dashboard',
        reason: args.reason,
      });
      await recordCardAnswers(ctx, args.agentId, args.changes, result.charterId);
      return { charterId: result.charterId, version: result.version };
    } catch (error: unknown) {
      // A refused change is the card's to show; in production the backend
      // strips every other error's text before it reaches the page (6.3).
      if (error instanceof ConvexError) throw error;
      throw new ConvexError(error instanceof Error ? error.message : String(error));
    }
  },
});

/**
 * Record each question the charter card answered as one reorientation the
 * manager settled (U12, A9): the question a plan asked, if one did, takes the
 * answer, so the plan's approval card no longer asks it and it is counted
 * once; one `charter.question-answered` event per answer either way. Only the
 * card comes here: a plan-approval answer amends through
 * `answerQuestionInTransaction`, which records its own.
 *
 * @param changes - The card's changes, of which the answers are recorded.
 * @param charterId - The version the answers landed in.
 */
async function recordCardAnswers(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  changes: readonly CharterChange[],
  charterId: Id<'charters'>,
): Promise<void> {
  for (const change of changes) {
    if (change.kind !== 'answer-question') continue;
    const asked = await ctx.db
      .query('managerQuestions')
      .withIndex('by_agent_key', (q) =>
        q.eq('agentId', agentId).eq('key', questionKey(change.question)),
      )
      .first();
    const now = Date.now();
    if (asked && !asked.answer) {
      await ctx.db.patch(asked._id, {
        answer: {
          text: change.answer.replace(/\s+/g, ' ').trim(),
          answeredAt: now,
          via: 'dashboard',
          amendedCharterId: charterId,
        },
      });
    }
    await appendEvent(ctx, {
      agentId,
      type: 'charter.question-answered',
      payload: {
        ...(asked ? { questionId: asked._id } : {}),
        via: 'dashboard',
        amended: true,
        charterId,
      },
      createdAt: now,
    });
  }
}

/** The most characters a note sending a draft back may carry; the prompt carries every one. */
export const CHANGE_REQUEST_MAX_CHARS = 2000;

/** How many sessions back the draft's own is looked for; a one-to-one is held once or twice. */
const SESSIONS_SEARCHED = 20;

/** How many amendments back the first version is looked for; a bound, not an expected depth. */
const VERSIONS_WALKED = 500;

/**
 * The session a draft was written from, when it is on the row: the chat and voice rooms end
 * theirs by naming it, and the answers-first entry point has none.
 */
async function sessionOfCharter(
  ctx: QueryCtx,
  charter: Pick<Doc<'charters'>, '_id' | 'agentId'>,
): Promise<Doc<'voiceSessions'> | null> {
  const sessions = await ctx.db
    .query('voiceSessions')
    .withIndex('by_agent', (q) => q.eq('agentId', charter.agentId))
    .order('desc')
    .take(SESSIONS_SEARCHED);
  return sessions.find((session) => session.charterId === charter._id) ?? null;
}

/**
 * The first version of a charter: amendments supersede a row, so the chain ends at the draft the
 * one-to-one wrote.
 */
async function firstVersionOf(ctx: QueryCtx, charter: Doc<'charters'>): Promise<Doc<'charters'>> {
  let current = charter;
  for (let hops = 0; current.supersedes && hops < VERSIONS_WALKED; hops += 1) {
    const previous = await ctx.db.get(current.supersedes);
    if (!previous) break;
    current = previous;
  }
  return current;
}

/** How many of an employee's accepted handovers are read to find who held its one-to-one. */
const HANDOVERS_SEARCHED = 50;

/** What `transcriptOf` answers: the transcript kept, or whose one-to-one it was. */
const transcriptOfValidator = v.union(
  v.null(),
  v.object({ transcript: v.string(), endedAt: v.union(v.number(), v.null()) }),
  v.object({ heldBy: v.string() }),
);

/**
 * The address of the manager who held the one-to-one a charter was drafted before a handover:
 * the asker of the first handover accepted after the draft, whose move cleared the transcript.
 * Undefined when no handover followed the draft.
 */
async function oneToOneHolderBefore(
  ctx: QueryCtx,
  draft: Doc<'charters'>,
): Promise<string | undefined> {
  const accepted = await ctx.db
    .query('managerTransfers')
    .withIndex('by_agent_state', (q) => q.eq('agentId', draft.agentId).eq('state', 'accepted'))
    .take(HANDOVERS_SEARCHED);
  const after = accepted
    .filter((transfer) => (transfer.decidedAt ?? transfer.requestedAt) >= draft.createdAt)
    .sort(
      (left, right) =>
        (left.decidedAt ?? left.requestedAt) - (right.decidedAt ?? right.requestedAt),
    );
  return after[0]?.fromAddress;
}

/**
 * Public, owner-guarded (`assertOwnsCharter`): the one-to-one a charter was drafted from, as the
 * room recorded it, kept beside every version it led to. When a handover has moved the employee
 * since, the old manager's words left with them (decision 1 (a) of the wave 9 review), and the
 * answer is whose one-to-one it was. Null for a charter drafted from answers handed straight in,
 * which has no transcript. Writes nothing.
 */
export const transcriptOf = query({
  args: { charterId: v.id('charters') },
  returns: transcriptOfValidator,
  handler: async (ctx, args): Promise<Infer<typeof transcriptOfValidator>> => {
    const charter = await assertOwnsCharter(ctx, args.charterId);
    const draft = await firstVersionOf(ctx, charter);
    const session = await sessionOfCharter(ctx, draft);
    if (session?.transcriptText) {
      return { transcript: session.transcriptText, endedAt: session.endedAt ?? null };
    }
    const heldBy = session ? await oneToOneHolderBefore(ctx, draft) : undefined;
    return heldBy === undefined ? null : { heldBy };
  },
});

/**
 * Send the current unapproved draft back.
 *
 * Public, owner-guarded (`assertOwnsCharter`). Refuses an approved charter (amend it) and any
 * draft but the latest. The draft is deleted either way, and `charter.request_changes` carries
 * the manager's note.
 *
 * With a note and the transcript the draft was written from, the employee redrafts: the note and
 * the rules struck on the draft join the session's change requests, the session is handed back
 * with its transcript as a claim's material, and the deployment's own re-drive
 * (`onboarding.recoverFinalisation`) is scheduled in this transaction, so the redraft has the
 * claim, the retries and the sweep every finalisation has. An approved charter beneath the draft
 * stays in force either way; with none, the employee stays in its one-to-one until the new draft
 * lands, or, with no note or no transcript, returns to Day-1 for another one-to-one.
 *
 * @returns Whether a redraft was queued.
 * @throws ConvexError with the refusal, which the card shows.
 */
export const requestChanges = mutation({
  args: { charterId: v.id('charters'), reason: v.optional(v.string()) },
  returns: v.object({ ok: v.literal(true), redrafting: v.boolean() }),
  handler: async (ctx, args): Promise<{ ok: true; redrafting: boolean }> => {
    const charter = await assertOwnsCharter(ctx, args.charterId);
    const agentId = charter.agentId;
    if (charter.approved) {
      throw new ConvexError('An approved charter cannot be sent back; amend it instead.');
    }
    const latest = await ctx.db
      .query('charters')
      .withIndex('by_agent', (q) => q.eq('agentId', agentId))
      .order('desc')
      .first();
    if (latest?._id !== charter._id) {
      throw new ConvexError('Only the latest draft can be sent back.');
    }
    const reason = (args.reason ?? '').replace(/\s+/g, ' ').trim();
    if (reason.length > CHANGE_REQUEST_MAX_CHARS) {
      throw new ConvexError(`Keep the note under ${CHANGE_REQUEST_MAX_CHARS} characters.`);
    }
    const session = reason ? await sessionOfCharter(ctx, charter) : null;
    const redrafting = session?.transcriptText !== undefined && session.transcriptText !== '';
    const now = Date.now();

    await ctx.db.delete(args.charterId);
    await appendEvent(ctx, {
      agentId,
      type: 'charter.request_changes',
      payload: { charterId: args.charterId, notes: reason, redrafting },
      createdAt: now,
    });
    let approvedCharterRemains = false;
    for await (const previous of ctx.db
      .query('charters')
      .withIndex('by_agent', (q) => q.eq('agentId', agentId))
      .order('desc')) {
      if (previous.approved) {
        approvedCharterRemains = true;
        break;
      }
    }
    if (session && redrafting) await queueRedraft(ctx, { session, charter, reason, now });
    await ctx.db.patch(agentId, {
      state: approvedCharterRemains ? 'active' : redrafting ? 'day-one-in-progress' : 'deployed',
    });
    return { ok: true, redrafting };
  },
});

/**
 * Hand a session back to be finalised again with the manager's note and the rules struck on the
 * draft: its transcript becomes the pending material, its record of a charter is cleared, its
 * re-drive budget restarts, and the re-drive is scheduled now.
 */
async function queueRedraft(
  ctx: MutationCtx,
  args: {
    session: Doc<'voiceSessions'>;
    charter: Doc<'charters'>;
    reason: string;
    now: number;
  },
): Promise<void> {
  const { session, charter, reason, now } = args;
  const struck = ((charter.body as Charter).constraints ?? [])
    .filter((constraint: CharterConstraint): boolean => constraint.struck === true)
    .map((constraint: CharterConstraint): string => constraint.quote);
  const agent = await ctx.db.get(charter.agentId);
  await ctx.db.patch(session._id, {
    state: 'active',
    pendingTranscript: session.transcriptText,
    pendingBossLabel: session.pendingBossLabel ?? agent?.bossEmail ?? 'boss',
    changeRequests: [...(session.changeRequests ?? []), { reason, struck, requestedAt: now }],
    charterId: undefined,
    charterVersion: undefined,
    endedAt: undefined,
    claimToken: undefined,
    claimedAt: undefined,
    recoveryAttempts: 0,
    finalisationError: undefined,
    // Stamped as a handed-back session is, so the sweep's missed-retry arm re-drives the redraft
    // should the run scheduled below never claim it.
    finalisationFailedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.onboarding.recoverFinalisation, {
    sessionId: session._id,
  });
}
