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
import { CHECK_RETRY_DELAYS_MS, type ProposalInputs } from './workingAgreements';

/*
 * The model passes of working agreements (wave 13, 13-W; F10 and F11): the proposal run over an
 * employee's corrections, and the check of an agreement the manager kept. Internal actions, each
 * scheduled by the mutation that recorded what the manager or the work did; the decisions they
 * make are written back by `convex/workingAgreements.ts`. Real mode only: nothing reads an
 * agreement in mock mode, and no correction is kept there.
 */

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

/**
 * The proposals one run drafts: each group of corrections the judgement found alike (oldest
 * first), in the newest correction's own words; and each correction now applied to a second item that no group holds.
 */
function proposalDrafts(inputs: ProposalInputs, groups: readonly string[][]): ProposalDraft[] {
  const byId = new Map<string, ProposalInputs['corrections'][number]>(
    inputs.corrections.map((correction) => [correction.id, correction]),
  );
  const grouped = new Set<string>(groups.flat());
  const alike = groups.flatMap((group): ProposalDraft[] => {
    const members = group.flatMap((id) => {
      const correction = byId.get(id);
      return correction ? [correction] : [];
    });
    const newest = members[members.length - 1];
    return newest ? [{ correctionIds: members.map((member) => member.id), text: newest.text }] : [];
  });
  const promoted = inputs.corrections
    .filter((correction) => correction.itemsGoverned >= 2 && !grouped.has(correction.id))
    .map((correction) => ({ correctionIds: [correction.id], text: correction.text }));
  return [...alike, ...promoted];
}

/**
 * Internal: an employee's proposal run. Proposes a working agreement from each correction applied
 * to a second item and from each group of corrections the model judges alike (F10, at most once per
 * new correction), each checked against the charter before it is shown (F11): a refused one is kept
 * refused with its clause, and one whose check could not be had is not shown, its corrections left
 * for the next run. Kept agreements whose check never answered are checked again. Scheduled where a
 * correction is kept and where a plan is stored.
 */
export const proposeFromCorrections = internalAction({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<void> => {
    if (SURFACE_MODE !== 'real') return;
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
    const sameness = await judgeSameness(inputs.corrections);
    if (sameness.outcome === 'unavailable') {
      log.warn('working agreements: the sameness judgement was unavailable; asked again later', {
        agentId: args.agentId,
        reason: sameness.reason,
      });
    }
    const groups = sameness.outcome === 'judged' ? sameness.groups : [];
    const drafts = proposalDrafts(inputs, groups);
    const known = drafts.length > 0 ? await knownValuesOf(ctx, inputs.userId) : [];
    const proposals: Array<{
      correctionIds: Id<'corrections'>[];
      statement: string;
      refusal?: { reason: CheckedRefusal['reason']; clause?: string };
    }> = [];
    // A group whose check could not be had is judged again next run, so its corrections stay new.
    const unshown = new Set<Id<'corrections'>>();
    for (const draft of drafts) {
      const outcome = await checked(draft.text, [inputs.charter], known);
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
    if (judged.length === 0 && proposals.length === 0) return;
    await ctx.runMutation(internal.workingAgreements.recordProposals, {
      agentId: args.agentId,
      judged,
      proposals,
    });
  },
});

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
    const inputs = await ctx.runQuery(internal.workingAgreements.checkInputs, {
      agreementId: args.agreementId,
    });
    if (inputs === null) return;
    const outcome = await checked(
      inputs.agreement.statement,
      inputs.charters,
      await knownValuesOf(ctx, inputs.agreement.userId),
    );
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
