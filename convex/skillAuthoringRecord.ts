'use node';

import type { ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { observeModelCalls, type ModelCallReport } from '../src/lib/model-call-telemetry';
import { clipRefusedDraft } from '../src/work/authored-skill';
import { redactOutcome } from '../src/surfaces/redact';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { logEvent } from './eventLog';
import { spanModelFromEnv } from '../src/redaction/span-model-env';
import { ownerKnownValues } from '../src/redaction/known-values';

/*
 * What an authoring run keeps of itself: the fenced failure that parks a skill short of
 * `registered`, a refused draft and the sandbox's output made safe to keep, the model calls on
 * the ledger, and the stored copy's refusals. Shared by the authoring run
 * (`convex/skillAuthoringRun.ts`) and the stored verification (`convex/storedVerification.ts`); no
 * Convex function lives here.
 */

/**
 * What a run reports when the skill it was authoring is no longer its own. The
 * result is discarded rather than written, so the state the boss sees is
 * whichever decision replaced this run: another run's, or the boss's own
 * rejection.
 */
export const SUPERSEDED =
  'this authoring run no longer holds the skill - it was rejected or taken over, ' +
  "so this run's result was discarded";

/**
 * Park a skill that did not reach `registered`. Every no-registration exit goes
 * through here so the boss is never left guessing: the row lands in `failed`
 * (listed, with a Retry, in the skills panel), the event feed carries the
 * reason, and the work item that asked for the skill says why it is still
 * waiting. All three in one fenced transaction - a failing run that has lost
 * its claim writes none of them.
 */
export async function recordAuthoringFailure(
  ctx: ActionCtx,
  skillId: Id<'skills'>,
  runId: Id<'events'>,
  args: {
    rowReason: string;
    reason: string;
    eventType: 'skill.author-failed' | 'skill.verification-failed';
    refusedDraft?: { body: string; smokeTest: string };
    /** The row's body is a parked copy of a stored version that may not register: it goes. */
    dropsStoredCopy?: boolean;
  },
): Promise<{ ok: false; reason: string }> {
  const { refusedDraft, ...failure } = args;
  const { recorded } = await ctx.runMutation(internal.skills.failAuthoringRun, {
    skillId,
    runId,
    ...failure,
    ...(refusedDraft
      ? { refusedBody: refusedDraft.body, refusedSmokeTest: refusedDraft.smokeTest }
      : {}),
  });
  return { ok: false, reason: recorded ? args.reason : SUPERSEDED };
}

/**
 * A draft turned away before any sandbox ran, made safe to keep on the row.
 *
 * The draft is model output about the owner's own systems, so it goes through
 * the outcome redactor like a provider outcome would: the owner's stored
 * values exactly, the structural grammar, and the span model where one is
 * configured. Bounded afterwards, so a cut can never expose what the redactor
 * removed. Never registered: it is there to be read and corrected.
 */
export async function keepRefusedDraft(
  ctx: ActionCtx,
  agentId: Id<'agents'>,
  draft: { body: string; smokeTest: string },
): Promise<{ body: string; smokeTest: string }> {
  const redacted = await redactAuthoredDraft(ctx, agentId, draft);
  return {
    body: clipRefusedDraft(redacted.body),
    smokeTest: clipRefusedDraft(redacted.smokeTest),
  };
}

/** A draft through the outcome redactor (`redactAuthoringTexts`), unbounded, for a parked row. */
export async function redactAuthoredDraft(
  ctx: ActionCtx,
  agentId: Id<'agents'>,
  draft: { body: string; smokeTest: string },
): Promise<{ body: string; smokeTest: string }> {
  const [body, smokeTest] = await redactAuthoringTexts(ctx, agentId, [draft.body, draft.smokeTest]);
  return { body: body!, smokeTest: smokeTest! };
}

/**
 * Authoring output made safe to keep: a draft, or what the sandbox printed.
 *
 * The outcome redactor, as a provider outcome gets: the owner's stored values
 * exactly and the span model in real mode, the structural grammar in both. A
 * smoke test's cases are the author's inventions and its traceback quotes its
 * source, so a verification log is model output as much as a draft is.
 *
 * Args:
 *   ctx: Convex action context.
 *   agentId: The employee whose owner's stored values are removed exactly.
 *   texts: The texts to redact.
 *
 * Returns:
 *   The redacted texts, in the order given.
 */
export async function redactAuthoringTexts(
  ctx: ActionCtx,
  agentId: Id<'agents'>,
  texts: readonly string[],
): Promise<string[]> {
  let known: readonly string[] = [];
  let model = undefined;
  if (SURFACE_MODE === 'real') {
    const agent: Doc<'agents'> | null = await ctx.runQuery(internal.agents.getInternal, {
      agentId,
    });
    if (agent?.userId) known = await ownerKnownValues(ctx, agent.userId);
    model = spanModelFromEnv();
  }
  const redacted = await Promise.all(
    texts.map((text: string): Promise<{ text: string }> => redactOutcome(text, '', model, known)),
  );
  return redacted.map((outcome): string => outcome.text);
}

/**
 * How much of a failed verification the row keeps in real mode. Enough for the
 * harness's reason and the author's frames of a traceback, which is what a
 * first-try failure is diagnosed from; bounded because the retry prompt
 * carries it back beside the refused draft.
 */
export const FAILED_VERIFICATION_LOG_CHARS = 2_000;

/**
 * Run the authoring call with its model-call report on the ledger, in real
 * mode: a `work.model-call` event with stage `authoring`, the skill and the
 * work item it was proposed for, the same record the loop stages write, so
 * the bill counts authoring too (P8-10). Mock mode writes nothing: its event
 * feed is what the frozen harness and the hosted demo read.
 *
 * @param ctx - The authoring action's context.
 * @param skill - The skill being authored.
 * @param fn - The authoring call.
 * @returns What the call returned.
 */
export async function recordingAuthoringCalls<T>(
  ctx: ActionCtx,
  skill: Pick<Doc<'skills'>, '_id' | 'agentId' | 'proposedFor'>,
  fn: () => Promise<T>,
): Promise<T> {
  if (SURFACE_MODE !== 'real') return await fn();
  return await observeModelCalls(async (report: ModelCallReport): Promise<void> => {
    await logEvent(ctx, {
      agentId: skill.agentId,
      type: 'work.model-call',
      payload: {
        ...(skill.proposedFor ? { workItemId: skill.proposedFor } : {}),
        skillId: skill._id,
        stage: 'authoring',
        ...report,
      },
    });
  }, fn);
}

/**
 * Why a row's parked copy of a stored version may not be checked: its offer is gone (a handover,
 * a Withdraw or a later evaluation took it), or the version offered is no longer one the row may
 * register as. Undefined when the copy may be checked, under the version's checks again at
 * registration.
 */
export async function parkedCopyRefusal(
  ctx: ActionCtx,
  skill: Doc<'skills'>,
): Promise<string | undefined> {
  if (skill.offeredVersionId === undefined) return 'the skill it copied is no longer offered';
  const target = await ctx.runQuery(internal.skillVersions.storedVerificationTarget, {
    skillId: skill._id,
    versionId: skill.offeredVersionId,
  });
  return target.kind === 'refused' ? target.reason : undefined;
}

/** The row's line for a stored version's copy that was refused, around the refusal. */
export function storedCopyRefusedReason(refusal: string): string {
  return `the stored skill was not registered: ${refusal}`;
}
