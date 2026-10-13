'use node';

import { v } from 'convex/values';
import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { log } from '../src/lib/logger';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { ownerKnownValues } from '../src/redaction/known-values';
import { spanModelFromEnv } from '../src/redaction/span-model-env';
import {
  checkAgainstCharter,
  checkStatement,
  judgeSameness,
  type CharterChecked,
  type CheckedStatement,
} from '../src/work/agreement-judgements';
import type { CharterBounds } from '../src/work/agreements';
import {
  CHECK_BATCH,
  CHECK_OUTLIVED_MS,
  CHECK_RETRY_DELAYS_MS,
} from '../src/work/agreement-vocabulary';
import type { CheckInputs, ProposalInputs } from './workingAgreements';

/*
 * The model passes of working agreements (wave 13, 13-W; F10 and F11): the proposal run over an
 * employee's corrections, and the check of an agreement the manager kept. Internal actions, each
 * scheduled by the mutation that recorded what the manager or the work did; the decisions they
 * make are written back by `convex/workingAgreements.ts`. Real mode only: nothing reads an
 * agreement in mock mode, and no correction is kept there.
 */

/** Whether a step of the employee may start now (`workLoop.stepMayRun`): no pause holds it. */
async function mayRun(ctx: ActionCtx, agentId: Id<'agents'>): Promise<boolean> {
  const permission = await ctx.runQuery(internal.workLoop.stepPermission, { agentId });
  if (!permission.mayRun) {
    log.info('working agreements: held while the work is paused', {
      agentId,
      reason: permission.reason,
    });
  }
  return permission.mayRun;
}

/** The owner's stored values for the exact layer, resolved once per action. */
async function knownValuesOf(ctx: ActionCtx, userId: string): Promise<readonly string[]> {
  return await ownerKnownValues(ctx, userId);
}

/** The statement checked against the charters it would bind, with the owner's values and the span model. */
async function checked(
  text: string,
  charters: readonly CharterBounds[],
  known: readonly string[],
): Promise<CheckedStatement> {
  return await checkStatement(text, { charters, model: spanModelFromEnv(), known });
}

/**
 * An agreement in effect for every employee checked against one employee's charter, a refusal
 * judged a second time (RM32 (a)), with the owner's values and the span model.
 */
async function checkedTwice(
  text: string,
  charters: readonly CharterBounds[],
  known: readonly string[],
): Promise<CharterChecked> {
  return await checkAgainstCharter(text, { charters, model: spanModelFromEnv(), known });
}

/** One proposal the run would show: the corrections it came from and the words it would keep. */
interface ProposalDraft {
  readonly correctionIds: Id<'corrections'>[];
  readonly text: string;
}

/** Corrections that repeat a proposal still waiting on the manager, which they join. */
interface ProposalJoin {
  readonly agreementId: Id<'workingAgreements'>;
  readonly correctionIds: Id<'corrections'>[];
}

/**
 * What one run does with the judgement's groups and the corrections applied to a second item: a
 * group holding a correction already in a proposal still waiting on the manager joins its other
 * members to that proposal; any other group is a new proposal in its newest correction's own
 * words (members oldest first); and each correction now applied to a second item that no group
 * holds and no proposal holds is a proposal of its own.
 */
function proposalWork(
  inputs: ProposalInputs,
  groups: readonly string[][],
): { drafts: ProposalDraft[]; joins: ProposalJoin[] } {
  const byId = new Map<string, ProposalInputs['corrections'][number]>(
    inputs.corrections.map((correction) => [correction.id, correction]),
  );
  const grouped = new Set<string>(groups.flat());
  const drafts: ProposalDraft[] = [];
  const joins: ProposalJoin[] = [];
  for (const group of groups) {
    const members = group.flatMap((id) => {
      const correction = byId.get(id);
      return correction ? [correction] : [];
    });
    const proposed = members.find((member) => member.openAgreementId !== undefined);
    const fresh = members.filter((member) => member.openAgreementId === undefined);
    if (proposed?.openAgreementId !== undefined) {
      if (fresh.length > 0) {
        joins.push({
          agreementId: proposed.openAgreementId,
          correctionIds: fresh.map((member) => member.id),
        });
      }
      continue;
    }
    const newest = members[members.length - 1];
    if (newest)
      drafts.push({ correctionIds: members.map((member) => member.id), text: newest.text });
  }
  for (const correction of inputs.corrections) {
    if (correction.openAgreementId !== undefined || grouped.has(correction.id)) continue;
    if (correction.itemsGoverned >= 2) {
      drafts.push({ correctionIds: [correction.id], text: correction.text });
    }
  }
  return { drafts, joins };
}

/**
 * Internal: an employee's proposal run. Proposes a working agreement from each correction applied
 * to a second item and from each group of corrections the model judges alike (F10, at most once per
 * new correction), or adds a correction that repeats a proposal still waiting on the manager to
 * that proposal, each checked against the charter before it is shown (F11): a refused one is kept
 * refused with its clause, and one whose check could not be had is not shown, its corrections left
 * for the next run. Kept agreements whose check never answered are checked again. Scheduled where a
 * correction is kept and where a plan is stored.
 */
export const proposeFromCorrections = internalAction({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<void> => {
    if (SURFACE_MODE !== 'real') return;
    // A paused employee, or the deployment's paused work, starts no model call (W13-R45); its
    // corrections stay new for the run after the work resumes.
    if (!(await mayRun(ctx, args.agentId))) return;
    const inputs = await ctx.runQuery(internal.workingAgreements.proposalInputs, {
      agentId: args.agentId,
    });
    if (inputs === null) return;
    for (const agreementId of inputs.staleChecks) {
      await ctx.scheduler.runAfter(0, internal.workingAgreementActions.settleKept, {
        agreementId,
        agentId: args.agentId,
        attempt: 0,
      });
    }
    // Nothing to judge, propose or join: the owner's values are never read (the first pre-tag's
    // item for wave 14, read lazily).
    if (inputs.corrections.length === 0) return;
    // The owner's values are resolved before the judgement, whose prompt carries the manager's
    // own words (W13-R4).
    const known = await knownValuesOf(ctx, inputs.userId);
    const sameness = await judgeSameness(inputs.corrections, {
      model: spanModelFromEnv(),
      known,
    });
    if (sameness.outcome === 'unavailable') {
      log.warn('working agreements: the sameness judgement was unavailable; asked again later', {
        agentId: args.agentId,
        reason: sameness.reason,
      });
    }
    const groups = sameness.outcome === 'judged' ? sameness.groups : [];
    const { drafts, joins } = proposalWork(inputs, groups);
    const proposals: Array<{
      correctionIds: Id<'corrections'>[];
      statement: string;
      refusal?: { reason: CheckedRefusal['reason']; clause?: string };
    }> = [];
    // A group whose check could not be had is judged again next run, so its corrections stay new.
    const unshown = new Set<Id<'corrections'>>();
    // Each draft's check is its own redaction and model call: they run together.
    const outcomes = await Promise.all(
      drafts.map(async (draft) => await checked(draft.text, [inputs.charter], known)),
    );
    for (const [at, draft] of drafts.entries()) {
      const outcome = outcomes[at]!;
      if (outcome.outcome === 'unavailable') {
        log.warn('working agreements: a proposal was not shown, its check was unavailable', {
          agentId: args.agentId,
          reason: outcome.reason,
        });
        for (const id of draft.correctionIds) unshown.add(id);
        continue;
      }
      proposals.push({
        correctionIds: draft.correctionIds,
        statement: outcome.statement,
        ...(outcome.outcome === 'refused' ? { refusal: outcome.refusal } : {}),
      });
    }
    const judged =
      sameness.outcome === 'judged'
        ? inputs.corrections
            .filter((correction) => correction.isNew && !unshown.has(correction.id))
            .map((correction) => correction.id)
        : [];
    if (judged.length === 0 && proposals.length === 0 && joins.length === 0) return;
    await ctx.runMutation(internal.workingAgreements.recordProposals, {
      agentId: args.agentId,
      judged,
      proposals,
      joins,
    });
  },
});

/**
 * The check of a kept agreement, or `unavailable` when it could not be had: no charter to check
 * against (it fails closed), the owner's values unreadable, or the redaction or the model failing.
 *
 * @param check - The check itself: one judgement for a keep ({@link checked}), a refusal judged
 * twice for an agreement already in effect for every employee ({@link checkedTwice}).
 */
async function checkedOrUnavailable<Outcome extends CharterChecked>(
  ctx: ActionCtx,
  inputs: CheckInputs,
  check: (
    text: string,
    charters: readonly CharterBounds[],
    known: readonly string[],
  ) => Promise<Outcome>,
): Promise<Outcome | Extract<CheckedStatement, { outcome: 'unavailable' }>> {
  const statement = inputs.agreement.statement;
  if (inputs.charters.length === 0) {
    return { outcome: 'unavailable', statement, reason: 'no approved charter to check against' };
  }
  try {
    const known = await knownValuesOf(ctx, inputs.agreement.userId);
    return await check(statement, inputs.charters, known);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return { outcome: 'unavailable', statement, reason };
  }
}

/** The refusal a check answered. */
type CheckedRefusal = Extract<CheckedStatement, { outcome: 'refused' }>['refusal'];

/**
 * Internal: check an agreement the manager kept against the charters it would bind (F11), then
 * make it active or refused through `settleCheck`. A check that could not be had is tried again
 * after each of `CHECK_RETRY_DELAYS_MS`; after the last, the employee's next proposal run tries it.
 */
export const settleKept = internalAction({
  args: {
    agreementId: v.id('workingAgreements'),
    agentId: v.id('agents'),
    attempt: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    if (SURFACE_MODE !== 'real') return;
    // Held while the employee or the deployment's work is paused (W13-R45): no model call and no
    // retry spent; the row stays kept and waiting, and the employee's next proposal run, which a
    // stored plan or a kept correction schedules once the work resumes, checks it as a stale one.
    if (!(await mayRun(ctx, args.agentId))) return;
    const inputs = await ctx.runQuery(internal.workingAgreements.checkInputs, {
      agreementId: args.agreementId,
    });
    if (inputs === null) return;
    if (inputs.pastTheCheck) {
      await ctx.runMutation(internal.workingAgreements.settleCheck, {
        agreementId: args.agreementId,
        agentId: args.agentId,
        statement: inputs.agreement.statement,
        refusal: { reason: 'every-employee-too-many' },
      });
      return;
    }
    const outcome = await checkedOrUnavailable(ctx, inputs, checked);
    if (outcome.outcome === 'unavailable') {
      const delay = CHECK_RETRY_DELAYS_MS[args.attempt];
      log.warn('working agreements: a kept agreement waits on its check', {
        agreementId: args.agreementId,
        attempt: args.attempt,
        reason: outcome.reason,
      });
      if (delay !== undefined) {
        await ctx.scheduler.runAfter(delay, internal.workingAgreementActions.settleKept, {
          ...args,
          attempt: args.attempt + 1,
        });
      }
      return;
    }
    await ctx.runMutation(internal.workingAgreements.settleCheck, {
      agreementId: args.agreementId,
      agentId: args.agentId,
      statement: outcome.statement,
      ...(outcome.outcome === 'refused' ? { refusal: outcome.refusal } : {}),
    });
  },
});

/** What one run of a charter's check is asked: the employee, the attempt, the agreements. */
interface CharterCheckArgs {
  readonly agentId: Id<'agents'>;
  readonly attempt: number;
  readonly agreementIds?: Id<'workingAgreements'>[];
}

/**
 * Keep a watch on a run of a charter's check (W15-R34): what the run would do were the model unable
 * to answer for the agreements it has not settled, scheduled past the longest a run may last
 * (`CHECK_OUTLIVED_MS`), so a run that dies, at its time limit or otherwise, is taken as such a run
 * and leaves its record: the next attempt, or, after the last, `settleUncheckable`. The run cancels
 * the watch as it settles each agreement and keeps a new one over the rest.
 *
 * @returns The watch, or nothing when no agreement is left unsettled.
 */
async function watchOver(
  ctx: ActionCtx,
  args: CharterCheckArgs,
  unsettled: readonly Id<'workingAgreements'>[],
): Promise<Id<'_scheduled_functions'> | null> {
  if (unsettled.length === 0) return null;
  const delay = CHECK_RETRY_DELAYS_MS[args.attempt];
  return delay === undefined
    ? await ctx.scheduler.runAfter(
        CHECK_OUTLIVED_MS,
        internal.workingAgreements.settleUncheckable,
        {
          agentId: args.agentId,
          agreementIds: [...unsettled],
          tried: true,
        },
      )
    : await ctx.scheduler.runAfter(
        Math.max(delay, CHECK_OUTLIVED_MS),
        internal.workingAgreementActions.checkForCharter,
        { agentId: args.agentId, attempt: args.attempt + 1, agreementIds: [...unsettled] },
      );
}

/** Cancel a run's watch, if it keeps one. */
async function endWatch(ctx: ActionCtx, watch: Id<'_scheduled_functions'> | null): Promise<void> {
  if (watch !== null) await ctx.scheduler.cancel(watch);
}

/**
 * Internal: check an employee's newly approved charter against its owner's active agreements for
 * every employee (13-W's gap; scheduled by `charters.approve`), each as the keep's check would have:
 * one the charter refuses is refused on its row (`settleCharterCheck`). A check that could not be
 * had is tried again after each of `CHECK_RETRY_DELAYS_MS`, for the agreements whose check could
 * not be had alone; after the last, `settleUncheckable` records it: on a first charter each such
 * agreement is held for the employee, and stays in effect for the others (15-FX: it stayed binding
 * unchecked, with nothing on a row to say so); on an amendment of an established employee's
 * charter each stays in effect, since it was checked against the charter amended (W15-R12; D-2
 * (c)), and its check is owed (`agreement.check-owed`, RM28 (b)), which the Agreements card says
 * with Check now. Past the employees the check reads, or under a pause, no model is asked and the
 * same record is written at once for a first charter (W14-R15) and past the bound for an amendment;
 * under a pause an amendment's check is asked again after each wait. An agreement held for the
 * employee that the check allows is in effect for it from then (`liftHold`): the hold's lift, by
 * this check, the employee's next stored plan, its resume, the stalled-step sweep
 * (`scheduleDueHoldChecks`), or Check now on its card; an owed check one allows is ended
 * (`recordChecked`).
 *
 * A refusal here would end an agreement for every employee on one model call, so it is judged a
 * second time (RM32 (a); 16-FX's F1: the hosted model allowed one statement against one charter
 * and refused it against another with the same body): the agreement ends for everyone only when
 * both judgements refuse, on a first charter and on an amendment alike. One refusal of two holds
 * it for this employee alone and says so (`holdDisputed`), until an act of the manager's judges it
 * again (Check now, the next approved charter, the employee's resume); a second judgement that
 * could not be had is a check that could not be had.
 *
 * One run reads at most `CHECK_BATCH` agreements with the model, one at a time, and hands the rest
 * to the next run, and it keeps a watch on itself ({@link watchOver}), so a run that dies mid-way
 * leaves the record a run the model could not answer leaves (W15-R34: it wrote neither the retry
 * nor the hold, and the agreements stayed in force unchecked).
 */
export const checkForCharter = internalAction({
  args: {
    agentId: v.id('agents'),
    attempt: v.number(),
    /** On a retry, the agreements whose check could not be had; absent, every one (the second pass). */
    agreementIds: v.optional(v.array(v.id('workingAgreements'))),
  },
  handler: async (ctx, args): Promise<void> => {
    if (SURFACE_MODE !== 'real') return;
    const paused = !(await mayRun(ctx, args.agentId));
    const inputs = await ctx.runQuery(internal.workingAgreements.charterCheckInputs, {
      agentId: args.agentId,
      ...(args.agreementIds === undefined ? {} : { agreementIds: args.agreementIds }),
    });
    if (inputs === null) return;
    const asked = inputs.agreements.map((agreement) => agreement._id);
    // Past the check no model is asked: a first charter's agreements are held for this employee
    // alone and stay in effect for the others (W14-R15), and an amendment's are owed their check.
    // A pause holds a first charter's the same way (15-FX): its end has no record of a check it
    // held, so the hold is the record, and the sweep, the resume or the next plan lifts it. Under
    // a pause an amendment's check is asked again after each wait, as one the model could not
    // answer is (W15-R12; D-2 (c)).
    if (inputs.pastTheCheck || (paused && !inputs.established)) {
      await ctx.runMutation(internal.workingAgreements.settleUncheckable, {
        agentId: args.agentId,
        agreementIds: asked,
        tried: false,
      });
      return;
    }
    const batch = inputs.agreements.slice(0, CHECK_BATCH);
    const rest = asked.slice(CHECK_BATCH);
    const unavailable: Id<'workingAgreements'>[] = [];
    let watch = await watchOver(ctx, args, asked);
    for (const [at, agreement] of batch.entries()) {
      const outcome: CharterChecked = paused
        ? { outcome: 'unavailable', statement: agreement.statement, reason: 'the work is paused' }
        : await checkedOrUnavailable(
            ctx,
            { agreement, charters: [inputs.charter], pastTheCheck: false },
            checkedTwice,
          );
      if (outcome.outcome === 'unavailable') {
        unavailable.push(agreement._id);
        log.warn('working agreements: a charter waits on its check', {
          agreementId: agreement._id,
          attempt: args.attempt,
          reason: outcome.reason,
        });
      } else if (outcome.outcome === 'refused') {
        // Both judgements refused it (RM32 (a)): only then does it end for every employee.
        await ctx.runMutation(internal.workingAgreements.settleCharterCheck, {
          agreementId: agreement._id,
          agentId: args.agentId,
          refusal: outcome.refusal,
        });
      } else if (outcome.outcome === 'disputed') {
        await ctx.runMutation(internal.workingAgreements.holdDisputed, {
          agreementId: agreement._id,
          agentId: args.agentId,
          refusal: outcome.refusal,
        });
      } else if (outcome.outcome === 'kept') {
        const settled = { agreementId: agreement._id, agentId: args.agentId };
        if (inputs.held.includes(agreement._id)) {
          await ctx.runMutation(internal.workingAgreements.liftHold, settled);
        }
        // Held and owed both since a disputed check can hold an established employee's (RM32
        // (a)): the check that lifts the hold is also the owed one, had.
        if (inputs.owed.includes(agreement._id)) {
          await ctx.runMutation(internal.workingAgreements.recordChecked, settled);
        }
      } else {
        // The value is not printed: it would carry the agreement's statement into the log.
        const unknown: never = outcome;
        throw new Error(`unhandled check outcome ${String(unknown)}`);
      }
      // The new watch first, then the old one ended: no moment is left unwatched (the second
      // pass).
      const next = await watchOver(ctx, args, [...unavailable, ...asked.slice(at + 1)]);
      await endWatch(ctx, watch);
      watch = next;
    }
    if (rest.length > 0) {
      await ctx.scheduler.runAfter(0, internal.workingAgreementActions.checkForCharter, {
        agentId: args.agentId,
        attempt: args.attempt,
        agreementIds: rest,
      });
    }
    const delay = CHECK_RETRY_DELAYS_MS[args.attempt];
    if (unavailable.length > 0 && delay !== undefined) {
      await ctx.scheduler.runAfter(delay, internal.workingAgreementActions.checkForCharter, {
        agentId: args.agentId,
        attempt: args.attempt + 1,
        agreementIds: unavailable,
      });
    } else if (unavailable.length > 0) {
      await ctx.runMutation(internal.workingAgreements.settleUncheckable, {
        agentId: args.agentId,
        agreementIds: unavailable,
        tried: !paused,
      });
    }
    // Ended only once what follows the run is scheduled or written.
    await endWatch(ctx, watch);
  },
});
