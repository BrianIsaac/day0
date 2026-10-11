import { v, type ObjectType } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { appendEvent } from './eventLog';
import { requeueWaitingWork } from './waitingWork';
import { recordRegisteredVersion, storedVersionRefusal } from './skillVersions';
import { readRefValidator, surfaceToolsValidator } from './schema';
import { redactTokenShapes } from '../src/surfaces/redact';
import { claimHolder, RELEASED } from './skillAuthoringClaim';
import { offerToPlainProposals } from './skillAdoption';

/*
 * A skill's registration, in the authoring run's one transaction: the verified body stored, the
 * row callable, the owner's library recording it, a revision's original superseded and the work
 * waiting for the skill queued again. The registered `skills.completeRegistration` (whose block
 * says why it is one transaction) validates and calls it; no Convex function lives here.
 */

/** What a registration takes: the run, the checked body, its log and what the check ran. */
export const completeRegistrationArgs = {
  skillId: v.id('skills'),
  runId: v.id('events'),
  body: v.string(),
  verificationLog: v.string(),
  /** The smoke test that passed, as the sandbox ran it before the harness wrapped it. */
  smokeTest: v.optional(v.string()),
  /** The tools SKILL.md names that the harness's surfaces allowed. */
  harnessTools: v.optional(v.array(v.string())),
  /** The same tools surface by surface, with each surface's class. */
  harnessToolsBySurface: v.optional(v.array(surfaceToolsValidator)),
  /**
   * The stored version a verification ran (`storedVerification.verifyStoredSkill`), checked again
   * here: one withdrawn, or no longer the employee's owner's, while the run held the row is
   * refused, and the run fails the row with the reason.
   */
  storedVersionId: v.optional(v.id('skillVersions')),
  /** The pages the authoring run read (`linkedRunbookPages`). */
  readRefs: v.optional(v.array(readRefValidator)),
};

/**
 * Take the row a registering revision replaces out of use: the employee's own registered row
 * named by `revisionOf` becomes `superseded` in the revision's transaction, and stops being
 * picked once the revision is callable. Any run holding it is released, as every transition
 * out of `registered` releases it, so a re-check in flight cannot register it again.
 *
 * @returns The superseded row, or undefined when the row is no revision or its original has
 *   already left `registered`.
 */
async function supersedeReplacedRow(
  ctx: MutationCtx,
  row: Doc<'skills'>,
): Promise<Id<'skills'> | undefined> {
  if (row.revisionOf === undefined) return undefined;
  const replaced = await ctx.db.get(row.revisionOf);
  if (replaced?.agentId !== row.agentId || replaced.state !== 'registered') return undefined;
  // Released, so a re-check of the replaced row still in flight is fenced out of it.
  await ctx.db.patch(replaced._id, { state: 'superseded', ...RELEASED });
  return replaced._id;
}

/**
 * Register a checked skill for the run holding it, in the caller's transaction
 * (`skills.completeRegistration`).
 *
 * @returns Whether it registered, and the refusal a stored version met, if any: no refusal and
 *   not registered means the run no longer held the skill, or it was taken out of use.
 */
export async function completeRegistrationInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof completeRegistrationArgs>,
): Promise<{ registered: boolean; refusal?: string }> {
  const row = await claimHolder(ctx, args.skillId, args.runId, 'register');
  if (!row) return { registered: false };
  // Taken out of use while the run held it: nothing brings it back but its own control.
  if (row.state === 'retired' || row.state === 'superseded') return { registered: false };
  if (args.storedVersionId !== undefined) {
    const refusal = await storedVersionRefusal(ctx.db, row, args.storedVersionId);
    if (refusal !== undefined) return { registered: false, refusal };
  }
  const now = Date.now();
  const body = redactTokenShapes(args.body);
  const library = await recordRegisteredVersion(ctx, row, {
    body,
    smokeTest: args.smokeTest === undefined ? undefined : redactTokenShapes(args.smokeTest),
    harnessTools: args.harnessTools ?? [],
    ...(args.harnessToolsBySurface !== undefined
      ? { harnessToolsBySurface: args.harnessToolsBySurface }
      : {}),
    readRefs: args.readRefs ?? [],
    now,
    stampsOlderHolders: true,
  });
  // A trigger that stamped the chip while this run was checking is about a change the run
  // never saw, so its chip stays.
  const stampedDuringRun =
    row.recheckDueAt !== undefined &&
    row.authoringClaimedAt !== undefined &&
    row.recheckDueAt >= row.authoringClaimedAt;
  const held = library.kind === 'outside' ? undefined : library;
  await ctx.db.patch(args.skillId, {
    state: 'registered',
    body,
    verificationLog: redactTokenShapes(args.verificationLog),
    refusedBody: undefined,
    refusedSmokeTest: undefined,
    pendingSmokeTest: undefined,
    registeredAt: row.registeredAt ?? now,
    authoringDeferrals: undefined,
    // "Attempt n of 3" counts the draft being written; a registered body starts the next
    // draft afresh (the record keeps the history; the wave 10 review, K-m4).
    authoringAttempts: undefined,
    versionId: held?.versionId,
    adoptedAt: held?.adopted ? (row.adoptedAt ?? now) : undefined,
    // The offer is answered once the row registers, whichever way.
    offeredVersionId: undefined,
    ...(stampedDuringRun
      ? {}
      : { recheckDueAt: undefined, recheckReason: undefined, recheckPage: undefined }),
    ...RELEASED,
  });
  // A colleague's proposal of the name filed before this version existed is offered it now.
  if (held !== undefined) await offerToPlainProposals(ctx, row, now);
  const replaced = await supersedeReplacedRow(ctx, row);
  if (replaced !== undefined) {
    // The replaced row's own line on the record: it stopped running in this transaction.
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'skill.superseded',
      payload: {
        skillId: replaced,
        name: row.name,
        revisionId: args.skillId,
        ...(held !== undefined ? { version: held.version } : {}),
      },
      createdAt: now,
    });
  }
  if (row.state === 'registered') {
    // A row registered before its claim passed a re-check (Re-check now, or a stored check
    // moving it onto a newer version): the record says so beside the registration.
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'skill.rechecked',
      payload: {
        skillId: args.skillId,
        name: row.name,
        ...(held !== undefined ? { version: held.version, versionId: held.versionId } : {}),
        ...(stampedDuringRun ? { stillDue: true as const } : {}),
      },
      createdAt: now,
    });
  }
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'skill.registered',
    payload: {
      skillId: args.skillId,
      name: row.name,
      ...(held !== undefined ? { version: held.version, versionId: held.versionId } : {}),
      ...(held?.adopted ? { adopted: true as const } : {}),
      ...(replaced !== undefined && held?.superseded !== undefined
        ? { supersedes: { skillId: replaced, version: held.superseded.version } }
        : {}),
    },
    createdAt: now,
  });
  await requeueWaitingWork(
    ctx,
    row,
    { decision: 'pending-reevaluation', reason: 'skill registered, ready to retry' },
    { sameName: true },
  );
  return { registered: true };
}
