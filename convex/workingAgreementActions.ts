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
  checkStatement,
  judgeSameness,
  type CheckedStatement,
} from '../src/work/agreement-judgements';
import type { CharterBounds } from '../src/work/agreements';
import { CHECK_RETRY_DELAYS_MS } from '../src/work/agreement-vocabulary';
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
 */
async function checkedOrUnavailable(
  ctx: ActionCtx,
  inputs: CheckInputs,
): Promise<CheckedStatement> {
  const statement = inputs.agreement.statement;
  if (inputs.charters.length === 0) {
    return { outcome: 'unavailable', statement, reason: 'no approved charter to check against' };
  }
  try {
    const known = await knownValuesOf(ctx, inputs.agreement.userId);
    return await checked(statement, inputs.charters, known);
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
    const outcome = await checkedOrUnavailable(ctx, inputs);
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

/**
 * Internal: check an employee's newly approved charter against its owner's active agreements for
 * every employee (13-W's gap; scheduled by `charters.approve`), each as the keep's check would have:
 * one the charter refuses is refused on its row (`settleCharterCheck`); once the owner has more
 * employees than the check reads, every one is held for this employee alone and stays in effect for
 * the others (`holdForEmployee`, W14-R15). A check that could not be had is tried again after each
 * of `CHECK_RETRY_DELAYS_MS`, for the agreements whose check could not be had alone; after the
 * last, each of those is held for this employee too, since nothing checked it against the charter
 * (15-FX: it stayed binding unchecked, with nothing on a row to say so). An agreement held for the
 * employee that the check allows is in effect for it from then (`liftHold`): the hold's lift, by
 * this check, the employee's next stored plan, its resume, the stalled-step sweep
 * (`scheduleDueHoldChecks`), or Check now on its card. A check held by a pause asks no model and
 * holds each agreement too, so the end of a pause of the whole deployment, which resumes no
 * employee by name, still finds what to check.
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
    // Past the check, the agreements stay in effect for the employees they were checked against,
    // and are held for this one alone (W14-R15): ended for everyone, the fiftieth's agreement went
    // with the fifty-first's hire. A check a pause holds asks no model either, and holds them the
    // same way (15-FX): the pause's end has no record of a check it held, so the hold is the
    // record, and the sweep, the resume or the next plan lifts it.
    if (inputs.pastTheCheck || paused) {
      for (const agreement of inputs.agreements) {
        await ctx.runMutation(internal.workingAgreements.holdForEmployee, {
          agreementId: agreement._id,
          agentId: args.agentId,
        });
      }
      return;
    }
    const unavailable: Id<'workingAgreements'>[] = [];
    for (const agreement of inputs.agreements) {
      const outcome = await checkedOrUnavailable(ctx, {
        agreement,
        charters: [inputs.charter],
        pastTheCheck: false,
      });
      if (outcome.outcome === 'unavailable') {
        unavailable.push(agreement._id);
        log.warn('working agreements: a new charter waits on its check', {
          agreementId: agreement._id,
          attempt: args.attempt,
          reason: outcome.reason,
        });
        continue;
      }
      if (outcome.outcome !== 'refused') {
        if (inputs.held.includes(agreement._id)) {
          await ctx.runMutation(internal.workingAgreements.liftHold, {
            agreementId: agreement._id,
            agentId: args.agentId,
          });
        }
        continue;
      }
      await ctx.runMutation(internal.workingAgreements.settleCharterCheck, {
        agreementId: agreement._id,
        agentId: args.agentId,
        refusal: outcome.refusal,
      });
    }
    const delay = CHECK_RETRY_DELAYS_MS[args.attempt];
    if (unavailable.length === 0) return;
    if (delay !== undefined) {
      await ctx.scheduler.runAfter(delay, internal.workingAgreementActions.checkForCharter, {
        agentId: args.agentId,
        attempt: args.attempt + 1,
        agreementIds: unavailable,
      });
      return;
    }
    for (const agreementId of unavailable) {
      await ctx.runMutation(internal.workingAgreements.holdForEmployee, {
        agreementId,
        agentId: args.agentId,
      });
    }
  },
});
