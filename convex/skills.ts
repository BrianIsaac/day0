import { v } from 'convex/values';
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgent, assertOwnsSkill } from './ownership';
import { applyVerdict, skillRejectedReason } from './work';
import { AUTHORING_LEASE_MS } from '../src/lib/skill-authoring';
import { skillApprovalRefusal } from '../src/surfaces/policy';
import { toSurfaceRecord } from '../src/surfaces/records';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import {
  browserComponentRefusal,
  withBrowserComponentState,
} from '../src/surfaces/browser';

/**
 * Skill registry + propose-author-register lifecycle. Public surfaces
 * enforce per-account ownership; internal transitions called by actions
 * skip the check.
 *
 * State machine:
 *   proposed → approved → authoring → registered
 *                       ↓           ↓
 *                   rejected     failed
 *
 * `builtin` skills come straight in at `registered`. `agent-authored`
 * skills walk the full path.
 *
 * `verified` is no longer a resting state: verification, registration and the
 * requeue of the work item that asked for the skill all land in
 * `completeRegistration`, one transaction. Rows written by the earlier
 * three-mutation path can still be sitting in it, so it is listed alongside
 * `authoring` and accepted as a retry.
 *
 * `authoring`, `verified` and `failed` are all resumable: none has ever been
 * registered, so a new authoring run may claim them (see `claimAuthoringRun`).
 * That is the way back for a skill authored before either sandbox backend was
 * available, or one whose sandbox check failed.
 *
 * Authoring is an exclusive, fenced run, because the transitions above are made
 * by an action that spends minutes in a model and a sandbox between reading the
 * state and writing its result:
 *
 *   - exclusive: `claimAuthoringRun` decides and takes the skill in one
 *     transaction, so a second run cannot start alongside the first;
 *   - fenced: every mutation on that path carries the run's id and is refused
 *     unless the skill still carries it, so a run that lost its claim — to a
 *     takeover, or to the boss rejecting the skill underneath it — cannot write
 *     a result the current state has moved past.
 */

/**
 * Where an authoring run may start. `approved` is the boss's first go-ahead;
 * `authoring`, `verified` and `failed` are retries of a skill that never
 * registered, so re-authoring cannot pull the ground out from under an executor
 * already calling it.
 *
 * `registered` and `rejected` are absent on purpose. Both are decisions —
 * one the sandbox made, one the boss made — and a run that could reopen either
 * is the race this claim exists to close.
 */
const CLAIMABLE_STATES = ['approved', 'authoring', 'verified', 'failed'] as const;

/** Where the boss may still reject. `registered` is out: a callable skill whose
 * source work has already been requeued is not a proposal any more. */
const REJECTABLE_STATES = ['proposed', 'approved', 'authoring', 'verified', 'failed'] as const;

type AuthoringClaim =
  | { claimed: true; runId: Id<'events'>; skill: Doc<'skills'> }
  | { claimed: false; reason: string };

/**
 * The fence. A run's write is applied only while the skill still carries that
 * run's id; anything else is a late writer whose result describes a skill that
 * has since moved on, and is refused.
 *
 * The refusal is recorded rather than silent. A discarded result is a real
 * thing that happened to a skill the boss is watching, and the alternative is a
 * run that reports failure with nothing in the feed to say why.
 */
async function claimHolder(
  ctx: MutationCtx,
  skillId: Id<'skills'>,
  runId: Id<'events'>,
  attempted: string,
): Promise<Doc<'skills'> | null> {
  const row = await ctx.db.get(skillId);
  if (!row) return null;
  if (row.authoringRunId === runId) return row;
  await ctx.db.insert('events', {
    agentId: row.agentId,
    type: 'skill.authoring-refused',
    payload: { skillId, name: row.name, attempted, state: row.state },
    createdAt: Date.now(),
  });
  return null;
}

/** Everything a run releases when it stops holding the skill. */
const RELEASED = { authoringRunId: undefined, authoringClaimedAt: undefined } as const;

/**
 * Put the work item that asked for this skill back where the boss can see what
 * it is waiting for. Always inside the same transaction as the skill write that
 * caused it: a callable skill whose work item is still parked, or a parked work
 * item whose skill never landed, is a state nothing in the product knows how to
 * leave.
 */
async function requeueSourceWork(
  ctx: MutationCtx,
  skill: Doc<'skills'>,
  verdict: { decision: string; reason: string },
): Promise<void> {
  if (!skill.proposedFor) return;
  const item = await ctx.db.get(skill.proposedFor);
  if (item && item.agentId !== skill.agentId) {
    throw new Error('skill and work item belong to different agents');
  }
  await applyVerdict(ctx, skill.proposedFor, verdict);
}

/**
 * The target surface named by the work, falling back to its intake source.
 *
 * Args:
 *   ctx: Mutation context.
 *   agentId: The agent.
 *   workItemId: The work item the skill is proposed for.
 *
 * Returns:
 *   The source plus the literal target slug in real mode.
 */
async function surfaceForWork(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  workItemId: Id<'workItems'>,
): Promise<{ sourceSystem: string; targetSurface?: string }> {
  const item = await ctx.db.get(workItemId);
  if (!item) throw new Error('work item for skill proposal not found');
  if (item.agentId !== agentId) {
    throw new Error('skill and work item belong to different agents');
  }
  if (SURFACE_MODE !== 'real') return { sourceSystem: item.sourceSystem };
  const surfaces = await ctx.db
    .query('surfaces')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .collect();
  const workTokens = new Set(
    `${item.title}\n${item.contentSummary}`
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? [],
  );
  const named = surfaces.filter((surface: Doc<'surfaces'>): boolean => {
    const nameTokens = surface.displayName.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    return (
      nameTokens.length > 0 &&
      nameTokens.every((token: string): boolean => workTokens.has(token))
    );
  });
  const namedSlugs = [...new Set(named.map((surface: Doc<'surfaces'>): string => surface.slug))];
  if (namedSlugs.length > 1) {
    throw new Error(`work evidence names more than one target surface: ${namedSlugs.join(', ')}`);
  }
  const targetSurface = namedSlugs[0] ?? item.sourceSystem;
  if (
    surfaces.filter((surface: Doc<'surfaces'>): boolean => surface.slug === targetSurface).length >
    1
  ) {
    throw new Error(`more than one surface is listed with slug ${targetSurface}`);
  }
  return { sourceSystem: item.sourceSystem, targetSurface };
}

export const registered = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'skills'>[]> => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('skills')
      .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId).eq('state', 'registered'))
      .collect();
  },
});

export const registeredInternal = internalQuery({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'skills'>[]> =>
    await ctx.db
      .query('skills')
      .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId).eq('state', 'registered'))
      .collect(),
});

/**
 * Authored but not callable: the sandbox could not run, so the body exists and
 * nothing has attested that it works. A skill an authoring run is holding right
 * now is here too, which is what keeps a run that dies mid-flight from taking
 * the skill out of every panel with it. Deliberately not part of `registered`,
 * which is what the executor picks from.
 *
 * `verified` rows join them. Nothing writes that state any more, but a row
 * stranded there by the earlier split registration path would otherwise appear
 * in no panel at all, which is how it stayed invisible and unrecoverable.
 */
export const awaitingVerification = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'skills'>[]> => {
    await assertOwnsAgent(ctx, args.agentId);
    const byState = await Promise.all(
      (['authoring', 'verified'] as const).map((state) =>
        ctx.db
          .query('skills')
          .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId).eq('state', state))
          .collect(),
      ),
    );
    return byState.flat();
  },
});

/**
 * Authored and checked, and the check said no. Kept out of `registered` for the
 * same reason as `awaitingVerification`, and retryable for the same reason:
 * nothing has ever called this body.
 */
export const verificationFailed = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'skills'>[]> => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('skills')
      .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId).eq('state', 'failed'))
      .collect();
  },
});

export const proposed = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'skills'>[]> => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('skills')
      .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId).eq('state', 'proposed'))
      .collect();
  },
});

export const get = query({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args) => {
    return await assertOwnsSkill(ctx, args.skillId);
  },
});

export const findByAgentName = query({
  args: { agentId: v.id('agents'), name: v.string() },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('skills')
      .withIndex('by_agent_name', (q) => q.eq('agentId', args.agentId).eq('name', args.name))
      .first();
  },
});

export const installBuiltin = internalMutation({
  args: {
    agentId: v.id('agents'),
    name: v.string(),
    description: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args): Promise<Id<'skills'>> => {
    const existing = await ctx.db
      .query('skills')
      .withIndex('by_agent_name', (q) => q.eq('agentId', args.agentId).eq('name', args.name))
      .first();
    if (existing) return existing._id;
    const id = await ctx.db.insert('skills', {
      agentId: args.agentId,
      name: args.name,
      description: args.description,
      body: args.body,
      sourceType: 'builtin',
      state: 'registered',
      createdAt: Date.now(),
      registeredAt: Date.now(),
    });
    await ctx.db.insert('events', {
      agentId: args.agentId,
      type: 'skill.builtin-installed',
      payload: { skillId: id, name: args.name },
      createdAt: Date.now(),
    });
    return id;
  },
});

export const propose = internalMutation({
  args: {
    agentId: v.id('agents'),
    workItemId: v.id('workItems'),
    name: v.string(),
    description: v.string(),
    rationale: v.string(),
    requiredScopes: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<Id<'skills'>> => {
    const target = await surfaceForWork(ctx, args.agentId, args.workItemId);
    const targetSurface = target.targetSurface;
    const requestedScopes =
      targetSurface && targetSurface !== target.sourceSystem
        ? args.requiredScopes.filter(
            (scope: string): boolean => scope !== `${target.sourceSystem}:write`,
          )
        : args.requiredScopes;
    const proposedScopes = targetSurface
      ? [...new Set([...requestedScopes, `${targetSurface}:read`, `${targetSurface}:write`])]
      : requestedScopes;
    const existing = await ctx.db
      .query('skills')
      .withIndex('by_agent_name', (q) =>
        q.eq('agentId', args.agentId).eq('name', args.name),
      )
      .first();
    if (existing && existing.state !== 'rejected' && existing.state !== 'failed') {
      if (existing.state === 'proposed') {
        if (
          existing.targetSurface &&
          targetSurface &&
          existing.targetSurface !== targetSurface &&
          existing.proposedFor !== args.workItemId
        ) {
          throw new Error(
            `skill ${args.name} is already proposed for surface ${existing.targetSurface}`,
          );
        }
        const targetChanged =
          existing.targetSurface !== undefined && existing.targetSurface !== targetSurface;
        await ctx.db.patch(existing._id, {
          targetSurface: existing.targetSurface ?? targetSurface,
          ...(targetChanged ? { targetSurface } : {}),
          requiredScopes: targetChanged
            ? proposedScopes
            : [...new Set([...(existing.requiredScopes ?? []), ...proposedScopes])],
        });
      }
      return existing._id;
    }
    // A skill proposed for work that came in from a discovered surface acts on
    // that surface: it is named on the row so approval can insist the surface
    // is connected, and its scopes are the surface's read and write pair.
    const id = await ctx.db.insert('skills', {
      agentId: args.agentId,
      name: args.name,
      description: args.description,
      body: '',
      sourceType: 'agent-authored',
      state: 'proposed',
      proposedFor: args.workItemId,
      rationale: args.rationale,
      requiredScopes: proposedScopes,
      targetSurface,
      createdAt: Date.now(),
    });
    await ctx.db.insert('events', {
      agentId: args.agentId,
      type: 'skill.proposed',
      payload: {
        skillId: id,
        name: args.name,
        rationale: args.rationale,
        forWorkItem: args.workItemId,
      },
      createdAt: Date.now(),
    });
    return id;
  },
});

export const approve = mutation({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args) => {
    const row = await assertOwnsSkill(ctx, args.skillId);
    if (row.state !== 'proposed') {
      throw new Error(`skill state is ${row.state}; expected proposed`);
    }
    // A skill may only target a connected surface. The sandbox stays offline,
    // so approval is the first point at which the target is checked, and the
    // refusal reads the same on the button and in the thrown error.
    if (row.targetSurface) {
      const surface = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) =>
          q.eq('agentId', row.agentId).eq('slug', row.targetSurface!),
        )
        .unique();
      const refusal = skillApprovalRefusal(
        row.targetSurface,
        surface
          ? toSurfaceRecord(
              withBrowserComponentState(
                surface,
                browserComponentRefusal(process.env.DAY0_BROWSER_MCP_URL),
              ),
            )
          : undefined,
        Date.now(),
      );
      if (refusal) throw new Error(`cannot approve "${row.name}": ${refusal}`);
    }
    await ctx.db.patch(args.skillId, { state: 'approved' });
    for (const scope of row.requiredScopes ?? []) {
      const existing = await ctx.db
        .query('permissionGrants')
        .withIndex('by_agent_scope', (q) => q.eq('agentId', row.agentId).eq('scope', scope))
        .first();
      if (!existing) {
        await ctx.db.insert('permissionGrants', {
          agentId: row.agentId,
          scope,
          createdAt: Date.now(),
        });
      }
    }
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'skill.approved',
      payload: { skillId: args.skillId, name: row.name, scopes: row.requiredScopes ?? [] },
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});

/**
 * The boss's refusal, and the end of the line for this skill.
 *
 * Rejecting releases any authoring run holding the skill, which is what makes
 * the refusal final: the released run is fenced out of its own result, so a
 * sandbox that finishes after this cannot register the skill the boss just
 * turned down and leave its source work cancelled underneath it.
 */
export const reject = mutation({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args) => {
    const row = await assertOwnsSkill(ctx, args.skillId);
    if (row.state === 'rejected') return { ok: true };
    if (!REJECTABLE_STATES.includes(row.state as (typeof REJECTABLE_STATES)[number])) {
      throw new Error(
        `skill state is ${row.state}; expected one of ${REJECTABLE_STATES.join(', ')}`,
      );
    }
    await ctx.db.patch(args.skillId, { state: 'rejected', ...RELEASED });
    if (row.proposedFor) {
      const sourceWork = await ctx.db.get(row.proposedFor);
      if (sourceWork && sourceWork.agentId !== row.agentId) {
        throw new Error('skill and work item belong to different agents');
      }
      const stillWaitingForThisProposal =
        sourceWork?.state === 'needs-skill' &&
        (!sourceWork.proposedSkillId || sourceWork.proposedSkillId === args.skillId);
      if (stillWaitingForThisProposal) {
        await ctx.db.patch(row.proposedFor, {
          state: 'cancelled',
          skipReason: skillRejectedReason(row.name),
        });
      }
    }
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'skill.rejected',
      payload: { skillId: args.skillId, name: row.name },
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});

/**
 * Send an agent-authored skill back through authoring before its first use.
 *
 * Registration makes a skill callable, so revision is deliberately narrower
 * than rejection: the manager may reopen only the proposal's own skill while
 * its source work is still waiting and no execution has ever claimed it. Once
 * a work row names the skill under `skillId`, its body is part of a durable run
 * and this transition is permanently closed.
 */
export const requestRevision = mutation({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const row = await assertOwnsSkill(ctx, args.skillId);
    if (row.sourceType !== 'agent-authored' || row.state !== 'registered') {
      throw new Error('only a registered agent-authored skill can be revised');
    }
    const executed = await ctx.db
      .query('workItems')
      .withIndex('by_skill', (q) => q.eq('skillId', args.skillId))
      .first();
    if (executed) {
      throw new Error('cannot revise a skill after an execution has claimed it');
    }
    if (!row.proposedFor) {
      throw new Error('cannot revise an authored skill without its source work');
    }
    const sourceWork = await ctx.db.get(row.proposedFor);
    if (
      !sourceWork ||
      sourceWork.agentId !== row.agentId ||
      !(['discovered', 'needs-skill'] as const).includes(
        sourceWork.state as 'discovered' | 'needs-skill',
      )
    ) {
      throw new Error('cannot revise while the source work has moved on');
    }

    await ctx.db.patch(args.skillId, {
      state: 'approved',
      body: '',
      sandboxId: undefined,
      daytonaSandboxId: undefined,
      verificationLog: undefined,
      registeredAt: undefined,
      ...RELEASED,
    });
    await requeueSourceWork(ctx, row, {
      decision: 'needs-skill',
      reason: 'registered skill sent back for revision before first execution',
    });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'skill.revision-requested',
      payload: { skillId: args.skillId, name: row.name },
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});

/**
 * One-off: move what `daytonaSandboxId` holds onto `sandboxId`.
 *
 * The field was named after the only sandbox there was. The local one writes
 * `local:<run id>` into it, so the name is wrong on the row as much as it was
 * on the screen. Renaming the declaration is not enough by itself: Convex
 * checks every stored document against the schema when it is pushed, so a
 * deployment holding rows under the old name refuses the new schema before any
 * migration could run. Hence both names are declared for now, this moves the
 * rows, and the old declaration comes out afterwards.
 *
 *   npx convex run skills:migrateSandboxIdField
 *
 * Safe to run twice: a row with nothing under the old name is left alone.
 */
export const migrateSandboxIdField = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ moved: number }> => {
    const rows = await ctx.db.query('skills').collect();
    let moved = 0;
    for (const row of rows) {
      if (row.daytonaSandboxId === undefined) continue;
      await ctx.db.patch(row._id, {
        sandboxId: row.sandboxId ?? row.daytonaSandboxId,
        daytonaSandboxId: undefined,
      });
      moved += 1;
    }
    return { moved };
  },
});

/**
 * Take exclusive ownership of a skill for one authoring run, or report that
 * somebody else has it.
 *
 * This is the whole of the concurrency control for authoring, and it is the
 * same shape as `work.claimForExecution`: a mutation is a transaction, so the
 * state check and the move to `authoring` cannot be split by a second caller,
 * where an action that reads the state and writes it back as two calls can be —
 * and both callers then author, verify and write a result for the same skill.
 *
 * The winner gets a `runId`: the id of the claim event, durable, unique per
 * claim and derived from nothing the caller supplies. Every later write on this
 * path presents it and is refused once it is no longer the id on the row.
 *
 * A claim that has outlived the lease is taken over rather than honoured. The
 * skill stays listed and retryable throughout, so a run that dies mid-flight
 * costs a lease rather than the skill.
 */
export const claimAuthoringRun = internalMutation({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args): Promise<AuthoringClaim> => {
    const row = await ctx.db.get(args.skillId);
    if (!row) throw new Error('skill not found');
    if (!CLAIMABLE_STATES.includes(row.state as (typeof CLAIMABLE_STATES)[number])) {
      return {
        claimed: false,
        reason:
          row.state === 'registered'
            ? 'this skill is already registered'
            : row.state === 'rejected'
              ? 'this skill was rejected'
              : `skill state is ${row.state}; expected one of ${CLAIMABLE_STATES.join(', ')}`,
      };
    }
    if (row.authoringRunId) {
      const heldFor = Date.now() - (row.authoringClaimedAt ?? 0);
      if (heldFor < AUTHORING_LEASE_MS) {
        return {
          claimed: false,
          reason: `another authoring run has held this skill for ${Math.round(heldFor / 1000)}s; it can be taken over after ${Math.round(AUTHORING_LEASE_MS / 60000)} minutes`,
        };
      }
      await ctx.db.insert('events', {
        agentId: row.agentId,
        type: 'skill.authoring-superseded',
        payload: { skillId: args.skillId, name: row.name, heldForMs: heldFor },
        createdAt: Date.now(),
      });
    }
    const runId = await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'skill.authoring-claimed',
      payload: { skillId: args.skillId, name: row.name, fromState: row.state },
      createdAt: Date.now(),
    });
    await ctx.db.patch(args.skillId, {
      state: 'authoring',
      authoringRunId: runId,
      authoringClaimedAt: Date.now(),
    });
    return { claimed: true, runId, skill: row };
  },
});

/**
 * Store the authored body as soon as a sandbox exists, so the boss can read
 * what was written whichever way the check goes. The run keeps its claim: this
 * is progress, not a result.
 */
export const recordAuthoringProgress = internalMutation({
  args: {
    skillId: v.id('skills'),
    runId: v.id('events'),
    sandboxId: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args): Promise<{ held: boolean }> => {
    const row = await claimHolder(ctx, args.skillId, args.runId, 'authoring-progress');
    if (!row) return { held: false };
    await ctx.db.patch(args.skillId, { sandboxId: args.sandboxId, body: args.body });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'skill.authoring',
      payload: { skillId: args.skillId, sandboxId: args.sandboxId },
      createdAt: Date.now(),
    });
    return { held: true };
  },
});

/**
 * Everything that has to be true at once for a skill to count as registered:
 * the verified body is stored, the row becomes callable, and the work item
 * that asked for the skill goes back into the queue.
 *
 * These used to be three mutations. A failure between the first and the second
 * left a `verified` row that no panel listed and no retry accepted; a failure
 * before the third left a callable skill whose work item stayed terminal at
 * `needs-skill`, which nothing auto-progresses. One transaction has no gap to
 * fail in: either the skill is callable and its work item is queued, or
 * neither happened and the row is still where the retry can pick it up.
 *
 * The run releases its claim here, which is what lets the next run — a retry
 * after a later problem — start at all.
 */
export const completeRegistration = internalMutation({
  args: {
    skillId: v.id('skills'),
    runId: v.id('events'),
    body: v.string(),
    verificationLog: v.string(),
  },
  handler: async (ctx, args): Promise<{ registered: boolean }> => {
    const row = await claimHolder(ctx, args.skillId, args.runId, 'register');
    if (!row) return { registered: false };
    await ctx.db.patch(args.skillId, {
      state: 'registered',
      body: args.body,
      verificationLog: args.verificationLog,
      registeredAt: row.registeredAt ?? Date.now(),
      ...RELEASED,
    });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'skill.registered',
      payload: { skillId: args.skillId, name: row.name },
      createdAt: Date.now(),
    });
    await requeueSourceWork(ctx, row, {
      decision: 'pending-reevaluation',
      reason: 'skill registered, ready to retry',
    });
    return { registered: true };
  },
});

/**
 * The run failed, and the skill is parked where the boss can see why: `failed`
 * is listed with a Retry, the feed carries the reason, and the work item that
 * asked for the skill says what it is still waiting for.
 *
 * One transaction for the same reason as registration. A failing run that could
 * write the skill and the work item separately is a failing run that can put
 * the work item back at `needs-skill` after somebody else has already moved it
 * on.
 */
export const failAuthoringRun = internalMutation({
  args: {
    skillId: v.id('skills'),
    runId: v.id('events'),
    /** Kept on the row, so it is what the skills panel shows. */
    rowReason: v.string(),
    /** The shorter form for the event feed and the work item. */
    reason: v.string(),
    eventType: v.string(),
  },
  handler: async (ctx, args): Promise<{ recorded: boolean }> => {
    const row = await claimHolder(ctx, args.skillId, args.runId, 'fail');
    if (!row) return { recorded: false };
    await ctx.db.patch(args.skillId, {
      state: 'failed',
      verificationLog: args.rowReason,
      ...RELEASED,
    });
    for (const type of ['skill.failed', args.eventType]) {
      await ctx.db.insert('events', {
        agentId: row.agentId,
        type,
        payload: { skillId: args.skillId, name: row.name, reason: args.reason },
        createdAt: Date.now(),
      });
    }
    await requeueSourceWork(ctx, row, { decision: 'needs-skill', reason: args.reason });
    return { recorded: true };
  },
});

/**
 * No sandbox ran, so the body is all there is to keep. The skill stops at
 * `authoring` — listed, uncallable, retryable — because registering is what
 * claims the body was checked, and nothing checked it.
 *
 * The claim is released: this run is over, and the retry that follows a sandbox
 * appearing - a DAYTONA_API_KEY, or `pnpm sandbox:up` - must be able to start.
 */
export const parkUnverified = internalMutation({
  args: {
    skillId: v.id('skills'),
    runId: v.id('events'),
    sandboxId: v.string(),
    body: v.string(),
    verificationLog: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args): Promise<{ recorded: boolean }> => {
    const row = await claimHolder(ctx, args.skillId, args.runId, 'park-unverified');
    if (!row) return { recorded: false };
    await ctx.db.patch(args.skillId, {
      state: 'authoring',
      body: args.body,
      sandboxId: args.sandboxId,
      verificationLog: args.verificationLog,
      ...RELEASED,
    });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'skill.sandbox-skipped',
      payload: { skillId: args.skillId, name: row.name, reason: args.reason },
      createdAt: Date.now(),
    });
    await requeueSourceWork(ctx, row, {
      decision: 'needs-skill',
      reason: `skill authored but not verified - ${args.reason}`,
    });
    return { recorded: true };
  },
});
