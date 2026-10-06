import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { appendEvent } from './eventLog';
import type { SkillAuthoringRefusedPayload } from '../src/events/contract';
import { AUTHORING_LEASE_MS } from '../src/lib/skill-authoring';
import { recordAuthoringHeld, startHoldOf } from './heldStarts';
import {
  AUTHORING_CLAIMABLE_STATES,
  countsAsAuthoringAttempt,
  MAX_AUTHORING_ATTEMPTS,
} from '../src/work/skill-library';
import { skillWaitingStamp } from '../src/work/needs-manager';

/*
 * The exclusive, fenced authoring run (`convex/skills.ts`'s state machine): which states a run
 * may take, the claim that takes one in a transaction, and the fence every later write of the run
 * passes. The registered `skills.claimAuthoringRun` calls the claim; no Convex function lives here.
 */

/**
 * Where a stored body's verification may start (`storedVerification.verifyStoredSkill`): the claimable
 * states, for an adoption approved and a retry of one, and `registered`, for a re-check of a
 * callable skill, which is checked again without being taken out of use.
 */
const STORED_VERIFICATION_STATES = [...AUTHORING_CLAIMABLE_STATES, 'registered'] as const;

/**
 * Why a claim found a row in a state it may not take, in the words the run reports.
 *
 * @param state - The row's state.
 * @param claimable - The states the claim could take.
 */
function unclaimableReason(
  state: Doc<'skills'>['state'],
  claimable: readonly Doc<'skills'>['state'][],
): string {
  switch (state) {
    case 'registered':
      return 'this skill is already registered';
    case 'rejected':
      return 'this skill was rejected';
    case 'retired':
      return 'this skill was retired';
    case 'superseded':
      return 'this skill was superseded by a revision';
    case 'proposed':
    case 'approved':
    case 'authoring':
    case 'verified':
    case 'failed':
      return `skill state is ${state}; expected one of ${claimable.join(', ')}`;
  }
}

/** A claim's answer: the run's id and the skill as it took it, or why it did not. */
export type AuthoringClaim =
  | { claimed: true; runId: Id<'events'>; skill: Doc<'skills'> }
  | {
      claimed: false;
      reason: string;
      /** A pause held the authoring (D-8 (b)): it starts at the resume, and has not failed. */
      held?: true;
    };

/**
 * The fence. A run's write is applied only while the skill still carries that
 * run's id; anything else is a late writer whose result describes a skill that
 * has since moved on, and is refused.
 *
 * The refusal is recorded rather than silent. A discarded result is a real
 * thing that happened to a skill the boss is watching, and the alternative is a
 * run that reports failure with nothing in the feed to say why.
 */
export async function claimHolder(
  ctx: MutationCtx,
  skillId: Id<'skills'>,
  runId: Id<'events'>,
  attempted: SkillAuthoringRefusedPayload['attempted'],
): Promise<Doc<'skills'> | null> {
  const row = await ctx.db.get(skillId);
  if (!row) return null;
  if (row.authoringRunId === runId) return row;
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'skill.authoring-refused',
    payload: { skillId, name: row.name, attempted, state: row.state },
    createdAt: Date.now(),
  });
  return null;
}

/** Everything a run releases when it stops holding the skill. */
export const RELEASED = { authoringRunId: undefined, authoringClaimedAt: undefined } as const;

/**
 * Take exclusive ownership of a skill for one authoring run, or report that somebody else has it,
 * in the caller's transaction (`skills.claimAuthoringRun`, whose block says the rule).
 *
 * @param args - The skill, and the run's purpose: authoring (the default) or a stored body's
 *   verification.
 * @throws Error when the skill does not exist.
 */
export async function claimAuthoringRunInTransaction(
  ctx: MutationCtx,
  args: { readonly skillId: Id<'skills'>; readonly purpose?: 'author' | 'verify-stored' },
): Promise<AuthoringClaim> {
  const row = await ctx.db.get(args.skillId);
  if (!row) throw new Error('skill not found');
  const verifying = args.purpose === 'verify-stored';
  const claimable: readonly Doc<'skills'>['state'][] = verifying
    ? STORED_VERIFICATION_STATES
    : AUTHORING_CLAIMABLE_STATES;
  if (!claimable.includes(row.state)) {
    return { claimed: false, reason: unclaimableReason(row.state, claimable) };
  }
  // "Attempt 3 of 3": a failed draft that has spent its attempts is not authored again; the
  // manager gives it up or asks for a revision (10-C). A stored verification writes no body.
  if (
    !verifying &&
    row.state === 'failed' &&
    (row.authoringAttempts ?? 0) >= MAX_AUTHORING_ATTEMPTS
  ) {
    return {
      claimed: false,
      reason: `all ${MAX_AUTHORING_ATTEMPTS} attempts at this skill failed; give it up instead`,
    };
  }
  const heldFor = Date.now() - (row.authoringClaimedAt ?? 0);
  if (row.authoringRunId && heldFor < AUTHORING_LEASE_MS) {
    return {
      claimed: false,
      reason: `another authoring run has held this skill for ${Math.round(heldFor / 1000)}s; it can be taken over after ${Math.round(AUTHORING_LEASE_MS / 60000)} minutes`,
    };
  }
  // A pause holds a skill's authoring as it holds a step (D-8 (b)): no claim, no attempt and no
  // takeover of a lapsed run, recorded, and started again at the resume (`heldStarts.ts`). A stored
  // version's check is a manager's press on a body already written, and runs.
  if (!verifying) {
    const held = await startHoldOf(ctx.db, row.agentId);
    if (held !== undefined) {
      return { claimed: false, reason: await recordAuthoringHeld(ctx, row, held), held: true };
    }
  }
  if (row.authoringRunId) {
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'skill.authoring-superseded',
      payload: { skillId: args.skillId, name: row.name, heldForMs: heldFor },
      createdAt: Date.now(),
    });
  }
  const runId = await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'skill.authoring-claimed',
    payload: {
      skillId: args.skillId,
      name: row.name,
      fromState: row.state,
      purpose: verifying ? 'verify-stored' : 'author',
    },
    createdAt: Date.now(),
  });
  const state = verifying && row.state === 'registered' ? 'registered' : 'authoring';
  await ctx.db.patch(args.skillId, {
    state,
    ...skillWaitingStamp(state, Date.now()),
    authoringRunId: runId,
    authoringClaimedAt: Date.now(),
    ...(!verifying && countsAsAuthoringAttempt(row)
      ? { authoringAttempts: (row.authoringAttempts ?? 0) + 1 }
      : {}),
  });
  return { claimed: true, runId, skill: row };
}
