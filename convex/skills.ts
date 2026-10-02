import { v } from 'convex/values';
import { mutation, query, internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgent, assertOwnsSkill } from './ownership';
import { applyVerdict } from './work';
import {
  moveWaitingWork,
  requeueWaitingWork,
  waitingMove,
  waitingProgress,
  waitingRows,
  waitingScope,
} from './waitingWork';
import { skillApprovalRefusal } from '../src/surfaces/policy';
import { toSurfaceRecord } from '../src/surfaces/records';
import { browserComponentRefusal, withBrowserComponentState } from '../src/surfaces/browser';
import { grantScopeInTransaction } from './agents';
import { redactTokenShapes } from '../src/surfaces/redact';
import { appendEvent } from './eventLog';
import { assertNotBeingHandedOver } from './handoverFence';
import { STORED_COPY_CLEARED } from './skillVersions';
import { holdsParkedStoredCopy } from '../src/work/skill-adoption';
import { openRevision } from './skillControls';
import {
  claimAuthoringRunInTransaction,
  claimHolder,
  RELEASED,
  type AuthoringClaim,
} from './skillAuthoringClaim';
import { completeRegistrationArgs, completeRegistrationInTransaction } from './skillRegistration';
import { proposeArgs, proposeInTransaction } from './skillProposal';

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
 * requeue of every work item waiting for the skill all land in
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
 *     unless the skill still carries it, so a run that lost its claim - to a
 *     takeover, or to the boss rejecting the skill underneath it - cannot write
 *     a result the current state has moved past.
 */

/** Where the boss may still reject. `registered` is out: a callable skill whose
 * source work has already been requeued is not a proposal any more. */
const REJECTABLE_STATES = ['proposed', 'approved', 'authoring', 'verified', 'failed'] as const;

/** The event beside `skill.failed` that says which half of an authoring run failed. */
export const authoringFailureEventValidator = v.union(
  v.literal('skill.author-failed'),
  v.literal('skill.verification-failed'),
);

/** How long a deferred authoring waits before it is tried again. */
export const AUTHORING_DEFERRAL_MS = 5 * 60 * 1000;

/**
 * How many authoring runs in a row may be deferred for the model provider
 * before the skill fails for the manager's Retry: a provider outage longer
 * than a quarter of an hour is the manager's to see.
 */
export const MAX_AUTHORING_DEFERRALS = 3;

/**
 * The next batch of a walk over the rows waiting for a skill.
 *
 * Internal; scheduled by `waitingWork.moveWaitingWork` only, under this path, which every batch
 * already scheduled names. Does nothing once the skill
 * has left the state the walk began in.
 */
export const continueWaitingWork = internalMutation({
  args: {
    skillId: v.id('skills'),
    skillState: v.string(),
    move: waitingMove,
    scope: waitingScope,
    from: waitingProgress,
  },
  handler: async (ctx, args): Promise<{ moved: number }> => {
    const skill = await ctx.db.get(args.skillId);
    if (!skill || skill.state !== args.skillState) return { moved: 0 };
    return { moved: await moveWaitingWork(ctx, skill, args.move, args.scope, args.from) };
  },
});

/** Public, owner-guarded: an employee's registered skills. */
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

/** Internal: an employee's registered skills, for a scheduled step with no caller. */
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

/** Public, owner-guarded: an employee's proposed skills awaiting the manager. */
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

/** Public, owner-guarded: one skill. */
export const get = query({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args) => {
    return await assertOwnsSkill(ctx, args.skillId);
  },
});

/** Public, owner-guarded: an employee's skill by name. */
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

/** Internal: registers a built-in skill for an employee at deployment. */
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
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'skill.builtin-installed',
      payload: { skillId: id, name: args.name },
      createdAt: Date.now(),
    });
    return id;
  },
});

/**
 * Internal: proposes a skill for the manager, from the work that needed it. With
 * `startedUnder`, the owner the evaluation read the employee under, the proposal is refused once
 * the employee is gone or another owner's (the wave 9 review's U3-m2): it would land, out of the
 * old owner's evaluation, as the new manager's to approve. The refused evaluation's verdict has
 * already committed `needs-skill`, so the evaluating action stops the item at once
 * (`work.stopUnproposedSkill`, the real-Linear walk's m7), with `work.recoverUnproposedSkill` a
 * step lease later behind it should the action itself die, each naming the skill it needed; the
 * new manager's Retry evaluates it again under the owner the employee has now (the wave 10
 * review, FR-m3).
 *
 * @throws Error with `PROPOSAL_AFTER_HANDOVER` (`convex/skillProposal.ts`).
 */
export const propose = internalMutation({
  args: proposeArgs,
  handler: async (ctx, args): Promise<Id<'skills'>> => await proposeInTransaction(ctx, args),
});

/**
 * Public, owner-guarded: approves a proposed skill whose target surface is
 * connected, grants its required scopes and records the approval. Nothing is
 * scheduled here; the dashboard starts the authoring once this returns.
 * Refused once a new manager has accepted the employee and it waits for its
 * runs (U3-m3): the skill and its scopes would move with it after the new
 * manager's preview, and the approval is theirs to give.
 */
export const approve = mutation({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args) => {
    const row = await assertOwnsSkill(ctx, args.skillId);
    await assertNotBeingHandedOver(ctx.db, row.agentId);
    if (row.state !== 'proposed') {
      throw new Error(`cannot approve "${row.name}": it is ${row.state}, not proposed`);
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
      await grantScopeInTransaction(ctx, row.agentId, scope, 'skill');
    }
    await appendEvent(ctx, {
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
    // A declined adoption keeps nothing of the version it was offered (the second pass).
    const adoption = row.offeredVersionId !== undefined || holdsParkedStoredCopy(row);
    await ctx.db.patch(args.skillId, {
      state: 'rejected',
      ...RELEASED,
      ...(adoption ? { offeredVersionId: undefined, ...STORED_COPY_CLEARED } : {}),
    });
    // Every row still waiting for this proposal leaves `needs-skill` with the
    // reason on its card, a batch at a time. A row that has moved on, or is
    // now linked to a different proposal, is not this rejection's to cancel.
    await moveWaitingWork(ctx, row, { kind: 'cancel' });
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'skill.rejected',
      payload: { skillId: args.skillId, name: row.name },
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});

/**
 * Ask for a revision of an agent-authored skill (the enhancements plan, section 4.1, item 6).
 * Public; the caller must own the skill. The name the Skills tab has always called; the control
 * itself is `skillControls.askForRevision`, and both open the revision the same way
 * (`skillControls.openRevision`).
 *
 * A revision is a new version, never an overwrite: a new row in `approved` with `revisionOf`
 * this one is written and checked while this row keeps running, and at its registration this row
 * becomes `superseded` in the same transaction. History is kept, so a skill an execution has
 * already claimed can be revised, whatever its source work is doing. Writes
 * `skill.revision-requested` naming the new row.
 */
export const requestRevision = mutation({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args): Promise<{ ok: true; revisionId: Id<'skills'> }> => {
    const row = await assertOwnsSkill(ctx, args.skillId);
    return { ok: true, revisionId: await openRevision(ctx, row) };
  },
});

/**
 * One-off: re-queue the rows an earlier registration left at `needs-skill`.
 *
 * Until registration reached every waiting row, a deployment could register a
 * skill and leave every item but the first parked behind it. Nothing re-reads
 * such a row: the registration that should have moved it has already happened.
 * This applies, for every registered skill, the re-queue its registration
 * would apply today.
 *
 *   npx convex run skills:requeueStranded
 *
 * Safe to run twice: a re-queued row is no longer at `needs-skill`.
 */
export const requeueStranded = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ requeued: number }> => {
    let requeued = 0;
    for (const agent of await ctx.db.query('agents').collect()) {
      const registeredSkills = await ctx.db
        .query('skills')
        .withIndex('by_agent_state', (q) => q.eq('agentId', agent._id).eq('state', 'registered'))
        .collect();
      for (const skill of registeredSkills) {
        for (const row of await waitingRows(ctx, skill, { sameName: true })) {
          if (row.state !== 'needs-skill') continue;
          await applyVerdict(ctx, row._id, {
            decision: 'pending-reevaluation',
            reason: 'skill registered, ready to retry',
          });
          requeued += 1;
        }
      }
    }
    return { requeued };
  },
});

/**
 * Retire a registered skill that predates shapes.
 *
 * A skill proposed before shapes existed carries no `surfaceClass` and was
 * named after the work item that first needed it (`linear-action-revops-7`),
 * with that item's values in its body. The matcher still serves such a row
 * through the name-token path while no shaped skill covers the shape, so it
 * keeps working; it also keeps the reusable procedure from being proposed for
 * that shape. Retiring it is the operator's decision, made once per row:
 *
 *   npx convex run skills:retireUnshaped '{"skillId":"<id>"}'
 *
 * Nothing is deleted. The row moves to `rejected`, which no panel lists and
 * the executor never picks from, its history stays readable under every run
 * that named it, and the next work item of its shape proposes the shaped
 * skill. A shaped row and a builtin row are refused: the first is the
 * reusable procedure for its shape, the second is installed, not authored.
 */
export const retireUnshaped = internalMutation({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args): Promise<{ retired: boolean; reason?: string }> => {
    const row = await ctx.db.get(args.skillId);
    if (!row) throw new Error('skill not found');
    if (row.state === 'rejected') return { retired: false, reason: 'already retired' };
    if (row.state !== 'registered') {
      throw new Error(`skill state is ${row.state}; only a registered skill is retired`);
    }
    if (row.sourceType !== 'agent-authored') {
      throw new Error('a builtin skill is installed, not authored, and is not retired');
    }
    if (row.surfaceClass !== undefined && row.operation !== undefined) {
      throw new Error(
        `skill ${row.name} is the reusable procedure for ${row.surfaceClass}/${row.operation}, not a legacy row`,
      );
    }
    await ctx.db.patch(args.skillId, { state: 'rejected', ...RELEASED });
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'skill.retired',
      payload: {
        skillId: args.skillId,
        name: row.name,
        reason:
          'proposed before skills were shaped; the next work item of its shape proposes the reusable procedure',
      },
      createdAt: Date.now(),
    });
    return { retired: true };
  },
});

/**
 * Take exclusive ownership of a skill for one authoring run, or report that
 * somebody else has it.
 *
 * This is the whole of the concurrency control for authoring, and it is the
 * same shape as `work.claimForExecution`: a mutation is a transaction, so the
 * state check and the move to `authoring` cannot be split by a second caller,
 * where an action that reads the state and writes it back as two calls can be -
 * and both callers then author, verify and write a result for the same skill.
 *
 * The winner gets a `runId`: the id of the claim event, durable, unique per
 * claim and derived from nothing the caller supplies. Every later write on this
 * path presents it and is refused once it is no longer the id on the row.
 *
 * A claim that has outlived the lease is taken over rather than honoured. The
 * skill stays listed and retryable throughout, so a run that dies mid-flight
 * costs a lease rather than the skill.
 *
 * An authoring claim that writes a body counts an attempt
 * (`authoringAttempts`, "Attempt n of 3"); one that carries on an attempt
 * already counted does not (`countsAsAuthoringAttempt`). A stored
 * verification (`purpose: 'verify-stored'`, `storedVerification.verifyStoredSkill`)
 * writes no body and counts nothing; it may also take a registered row, for a
 * re-check, which stays registered and keeps running its verified body while
 * the check runs.
 */
export const claimAuthoringRun = internalMutation({
  args: {
    skillId: v.id('skills'),
    /** Authoring (the default) or a stored body's verification. */
    purpose: v.optional(v.union(v.literal('author'), v.literal('verify-stored'))),
  },
  handler: async (ctx, args): Promise<AuthoringClaim> =>
    await claimAuthoringRunInTransaction(ctx, args),
});

/**
 * Store the authored body as soon as a sandbox exists, so the boss can read
 * what was written whichever way the check goes. The run keeps its claim: this
 * is progress, not a result.
 *
 * Every authoring write below applies the structural floor to the text it
 * keeps, as `parkUnverified` does: the body, the log and the reasons are model
 * output and sandbox output, and a provider token in any of them has no
 * business on a row, an event or a work item whatever the action did first.
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
    await ctx.db.patch(args.skillId, {
      sandboxId: args.sandboxId,
      body: redactTokenShapes(args.body),
      refusedBody: undefined,
      refusedSmokeTest: undefined,
    });
    await appendEvent(ctx, {
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
 * the verified body is stored, the row becomes callable, the owner's library
 * records it, and every work item waiting for the skill goes back into the
 * queue.
 *
 * These used to be three mutations. A failure between the first and the second
 * left a `verified` row that no panel listed and no retry accepted; a failure
 * before the third left a callable skill whose work item stayed terminal at
 * `needs-skill`, which nothing auto-progresses. One transaction has no gap to
 * fail in: either the skill is callable and its work item is queued, or
 * neither happened and the row is still where the retry can pick it up.
 *
 * The run releases its claim here, which is what lets the next run - a retry
 * after a later problem - start at all.
 *
 * The library (K1): the passing smoke test is kept on the version, not thrown
 * away, so the body can be verified again; the row is linked to the version it
 * was verified as or to the next version of its name
 * (`skillVersions.recordRegisteredVersion`), with the pages the authoring read.
 * A pass is a passing re-check, so it clears "Re-check due". A revision that
 * registers supersedes the row it replaces in this same transaction, so one of
 * the two is callable at every moment. The smoke test is optional only for a
 * run that began before this release; such a version is kept without its check
 * and is not offerable until a re-check keeps one.
 */
export const completeRegistration = internalMutation({
  args: completeRegistrationArgs,
  handler: async (ctx, args): Promise<{ registered: boolean; refusal?: string }> =>
    await completeRegistrationInTransaction(ctx, args),
});

/**
 * The run failed, and the skill is parked where the boss can see why: `failed`
 * is listed with a Retry, the feed carries the reason, and the work item that
 * asked for the skill says what it is still waiting for.
 *
 * A refusal before the sandbox keeps the draft it turned away, already
 * redacted and bounded by the action, so the row carries something to read
 * and the retry something to correct; in real mode a sandbox that said no
 * keeps its draft the same way, so a failed first attempt can be read and
 * exported afterwards. A failure with no draft to keep clears whatever an
 * earlier refusal left: the row describes its latest attempt only. The draft
 * never goes in `pendingSmokeTest`: that field means "not yet run", and a
 * Retry that found it would run a program already known to fail.
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
    eventType: authoringFailureEventValidator,
    refusedBody: v.optional(v.string()),
    refusedSmokeTest: v.optional(v.string()),
    /**
     * The row's body is a parked copy of a stored version that may not register (the wave 10
     * review, B1): it goes, so no later press checks it again.
     */
    dropsStoredCopy: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ recorded: boolean }> => {
    const row = await claimHolder(ctx, args.skillId, args.runId, 'fail');
    if (!row) return { recorded: false };
    const reason = redactTokenShapes(args.reason);
    await ctx.db.patch(args.skillId, {
      state: 'failed',
      ...(args.dropsStoredCopy === true ? { body: '' } : {}),
      verificationLog: redactTokenShapes(args.rowReason),
      refusedBody: args.refusedBody === undefined ? undefined : redactTokenShapes(args.refusedBody),
      refusedSmokeTest:
        args.refusedSmokeTest === undefined ? undefined : redactTokenShapes(args.refusedSmokeTest),
      pendingSmokeTest: undefined,
      authoringDeferrals: undefined,
      ...RELEASED,
    });
    for (const type of ['skill.failed', args.eventType] as const) {
      await appendEvent(ctx, {
        agentId: row.agentId,
        type,
        payload: { skillId: args.skillId, name: row.name, reason },
        createdAt: Date.now(),
      });
    }
    await requeueWaitingWork(ctx, row, { decision: 'needs-skill', reason });
    return { recorded: true };
  },
});

/**
 * Defer an authoring run the model provider could not answer (U9 step 20): an
 * outage, a rate limit, a timeout. Internal; the authoring action calls it
 * with the run's own id. The skill stays at `authoring` - listed, uncallable,
 * retryable - with the claim released and the reason on the row, and the run
 * is tried again after `AUTHORING_DEFERRAL_MS`. After
 * `MAX_AUTHORING_DEFERRALS` in a row it fails for the manager's Retry, as
 * any authoring failure does.
 *
 * @returns Whether the run was deferred (false once it failed, or when the
 *   run no longer holds the skill), and the reason the caller reports.
 */
export const deferAuthoringRun = internalMutation({
  args: { skillId: v.id('skills'), runId: v.id('events'), reason: v.string() },
  handler: async (ctx, args): Promise<{ deferred: boolean; reason: string }> => {
    const row = await claimHolder(ctx, args.skillId, args.runId, 'defer');
    if (!row) return { deferred: false, reason: 'another authoring run holds this skill' };
    const reason = redactTokenShapes(args.reason);
    const attempt = (row.authoringDeferrals ?? 0) + 1;
    if (attempt > MAX_AUTHORING_DEFERRALS) {
      const failed = `the model provider could not be reached through ${MAX_AUTHORING_DEFERRALS + 1} tries: ${reason}`;
      await ctx.db.patch(args.skillId, {
        state: 'failed',
        verificationLog: failed,
        pendingSmokeTest: undefined,
        authoringDeferrals: undefined,
        ...RELEASED,
      });
      for (const type of ['skill.failed', 'skill.author-failed'] as const) {
        await appendEvent(ctx, {
          agentId: row.agentId,
          type,
          payload: { skillId: args.skillId, name: row.name, reason: failed },
          createdAt: Date.now(),
        });
      }
      await requeueWaitingWork(ctx, row, { decision: 'needs-skill', reason: failed });
      return { deferred: false, reason: failed };
    }
    const minutes = Math.round(AUTHORING_DEFERRAL_MS / 60_000);
    const deferred = `${reason}. The model provider could not be reached, so authoring is tried again in ${minutes} minutes (${attempt} of ${MAX_AUTHORING_DEFERRALS}).`;
    await ctx.db.patch(args.skillId, {
      state: 'authoring',
      verificationLog: deferred,
      authoringDeferrals: attempt,
      ...RELEASED,
    });
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'skill.authoring-deferred',
      payload: {
        skillId: args.skillId,
        name: row.name,
        reason,
        retryInMs: AUTHORING_DEFERRAL_MS,
        attempt,
      },
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(
      AUTHORING_DEFERRAL_MS,
      internal.skillActions.authorAndRegisterSkillInternal,
      { skillId: args.skillId },
    );
    return { deferred: true, reason: deferred };
  },
});

/**
 * No sandbox ran, so the body is all there is to keep. The skill stops at
 * `authoring` - listed, uncallable, retryable - because registering is what
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
    smokeTest: v.string(),
    verificationLog: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args): Promise<{ recorded: boolean }> => {
    const row = await claimHolder(ctx, args.skillId, args.runId, 'park-unverified');
    if (!row) return { recorded: false };
    const reason = redactTokenShapes(args.reason);
    await ctx.db.patch(args.skillId, {
      state: 'authoring',
      body: redactTokenShapes(args.body),
      pendingSmokeTest: redactTokenShapes(args.smokeTest),
      sandboxId: args.sandboxId,
      verificationLog: redactTokenShapes(args.verificationLog),
      refusedBody: undefined,
      refusedSmokeTest: undefined,
      authoringDeferrals: undefined,
      ...RELEASED,
    });
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'skill.sandbox-skipped',
      payload: { skillId: args.skillId, name: row.name, reason },
      createdAt: Date.now(),
    });
    await requeueWaitingWork(ctx, row, {
      decision: 'needs-skill',
      reason: `skill authored but not verified - ${reason}`,
    });
    return { recorded: true };
  },
});
