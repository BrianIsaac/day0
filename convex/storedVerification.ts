'use node';

import { v } from 'convex/values';
import type { z } from 'zod';
import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { agentJson } from '../src/lib/mastra';
import { authorAndVerifySkill } from '../src/lib/skill-sandbox';
import { authoredSkillIssues, clipRefusedDraft } from '../src/work/authored-skill';
import { unwrapMarkdownFence } from '../src/work/smoke-test';
import { smokeHarnessContract } from '../src/work/smoke-harness';
import { toSurfaceRecord } from '../src/surfaces/records';
import type { SurfaceRecord } from '../src/surfaces/types';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { errorMessage } from '../src/lib/errors';
import {
  harnessToolsBySurface,
  harnessToolsNamed,
  type SurfaceTools,
} from '../src/work/skill-library';
import { parkedCheckLog } from '../src/work/skill-adoption';
import {
  authorSchema,
  authorSchemaFor,
  buildAuthorPrompt,
  FAILED_VERIFICATION_LOG_CHARS,
  holdSandboxLease,
  linkedRunbookExcerpts,
  namedHarnessSurfaces,
  recordAuthoringFailure,
  recordingAuthoringCalls,
  redactAuthoringTexts,
  skillAuthorAgent,
  storedCopyRefusedReason,
  SUPERSEDED,
  verifyAuthoredSkill,
  type AuthorPromptSkill,
  type AuthorRunbookPage,
} from './skillActions';

/*
 * The stored verification (10-K; the enhancements plan, section 4.1): a version already in the
 * owner's library checked again in the sandbox under one employee's own contract, for an adoption
 * (10-A) or a Re-check now (10-C). Kept apart from `convex/skillActions.ts`, the authoring run,
 * whose claim, lease, gates, redaction and failure path it shares; nothing here writes a body.
 */

/** What the re-check's author is told when a version's passing check was never kept (K3). */
const KEEP_CHECK_INSTRUCTION =
  'This skill is already registered with the SKILL.md below, and it stays exactly as it is. ' +
  'Write smoke.py for it as the rules above say, and return this SKILL.md unchanged as the body.';

/** What a re-check's author prompt is built from. */
export interface KeepCheckPromptInput {
  /** The holder row, as the author prompt reads it. */
  readonly skill: AuthorPromptSkill;
  /** The registered SKILL.md, which stays as it is. */
  readonly body: string;
  /** The holder's surfaces. */
  readonly surfaces: readonly SurfaceRecord[];
  /** Clock for the connection verdict. */
  readonly now: number;
  /** The holder's redacted documentation. */
  readonly pages: readonly AuthorRunbookPage[];
}

/**
 * The author prompt for a re-check whose version has no kept smoke test: the authoring prompt
 * for the same skill, with the registered body fixed and only the smoke test asked for.
 */
export function buildKeepCheckPrompt(input: KeepCheckPromptInput): string {
  const { skill, body, surfaces, now, pages } = input;
  return [
    buildAuthorPrompt(skill, surfaces, now, pages, SURFACE_MODE),
    '',
    KEEP_CHECK_INSTRUCTION,
    '',
    'Registered SKILL.md:',
    body,
  ].join('\n');
}

/** Where a stored verification stops short of a verdict on the body. */
type StoredVerificationStop =
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string; readonly log: string };

/**
 * Verify a stored body and smoke test in the sandbox under the holding employee's contract, and
 * register the row on a pass or fail it with the log (the enhancements plan, section 4.1).
 * Internal: adoption (10-A) and Re-check now (10-C) schedule it after their own owner-guarded
 * mutations, and the backfill's re-check is a Re-check now.
 *
 * The version is the row's own (a re-check) or the one offered to it (an adoption). The run takes
 * the row's authoring claim for a stored verification, which leaves a registered row in use, then
 * the one global sandbox lease (`holdSandboxLease`). A version whose passing check was not kept
 * (K3) has a smoke test written for its unchanged body first, through the authoring gates. On a
 * pass, `skills.completeRegistration` links the row to the version, keeps a missing check and
 * clears "Re-check due"; on a failure the row is `failed` with the sandbox's log, its waiting work
 * parked as any failed skill's is. When no sandbox ran, the smoke test for a missing check could
 * not be written, or the registration refused the version (a handover or a withdrawal while the
 * run held the row), a registered row is released unchanged, still due; any other row is parked
 * with the stored body for Retry, or failed with the refusal.
 *
 * @returns Whether the row registered, or why not.
 */
export const verifyStoredSkill = internalAction({
  args: {
    skillId: v.id('skills'),
    /** A newer version of the row's name to verify it as, in place of its own (10-C). */
    versionId: v.optional(v.id('skillVersions')),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    const target = await ctx.runQuery(internal.skillVersions.storedVerificationTarget, {
      skillId: args.skillId,
      ...(args.versionId !== undefined ? { versionId: args.versionId } : {}),
    });
    if (target.kind === 'refused') return { ok: false, reason: target.reason };
    const claim = await ctx.runMutation(internal.skills.claimAuthoringRun, {
      skillId: args.skillId,
      purpose: 'verify-stored',
    });
    if (!claim.claimed) return { ok: false, reason: claim.reason };
    const { skill, version } = target;
    const { runId } = claim;
    const [surfaceRows, pageRows]: [Doc<'surfaces'>[], Doc<'docPages'>[]] = await Promise.all([
      ctx.runQuery(internal.orientationData.surfacesForAgent, { agentId: skill.agentId }),
      ctx.runQuery(internal.orientationData.pagesForAgent, { agentId: skill.agentId }),
    ]);
    const surfaces = surfaceRows.map(toSurfaceRecord);
    const smokeTest =
      version.smokeTest ??
      (await writeKeptCheck(ctx, { skill, body: version.body, surfaces, pages: pageRows }));
    const stop =
      typeof smokeTest === 'string'
        ? await runStoredVerification(ctx, {
            skill,
            runId,
            body: version.body,
            smokeTest,
            surfaces,
          })
        : smokeTest;
    if (stop.kind === 'passed') {
      const { registered, refusal } = await ctx.runMutation(internal.skills.completeRegistration, {
        skillId: args.skillId,
        runId,
        body: version.body,
        verificationLog: stop.log,
        smokeTest: stop.smokeTest,
        harnessTools: stop.harnessTools,
        harnessToolsBySurface: stop.harnessToolsBySurface,
        readRefs: version.readRefs,
        storedVersionId: version._id,
      });
      if (registered) return { ok: true };
      if (refusal === undefined) return { ok: false, reason: SUPERSEDED };
      // A row registered before the claim keeps running the body it was verified with: the
      // refusal is of the version (handed over, withdrawn), not of the employee's skill, so no
      // verdict on it takes the row out of use (10-K's rule; the wave 10 review, K-m1).
      if (skill.state === 'registered') {
        return await releaseRegisteredRow(ctx, { skillId: args.skillId, runId, reason: refusal });
      }
      return await recordAuthoringFailure(ctx, args.skillId, runId, {
        rowReason: storedCopyRefusedReason(refusal),
        reason: refusal,
        eventType: 'skill.verification-failed',
        // A row that is not callable may hold a copy an earlier stop parked.
        dropsStoredCopy: true,
      });
    }
    if (stop.kind === 'failed') {
      return await recordAuthoringFailure(ctx, args.skillId, runId, {
        rowReason: stop.log,
        reason: stop.reason,
        eventType: 'skill.verification-failed',
        // A row that is not callable may hold a copy an earlier stop parked; it goes with the
        // verdict (the second pass). A registered row's body is its own verified one.
        dropsStoredCopy: skill.state !== 'registered',
      });
    }
    return await stopShortOfVerdict(ctx, {
      skill,
      runId,
      body: version.body,
      smokeTest: typeof smokeTest === 'string' ? smokeTest : undefined,
      reason: stop.reason,
    });
  },
});

/**
 * Write the smoke test a version's missing check needs (K3): the author is asked for smoke.py
 * against the registered body, which stays as it is, and the authoring gates read both.
 *
 * @returns The smoke test, or why none could be written.
 */
async function writeKeptCheck(
  ctx: ActionCtx,
  input: {
    readonly skill: Doc<'skills'>;
    readonly body: string;
    readonly surfaces: readonly SurfaceRecord[];
    readonly pages: readonly Doc<'docPages'>[];
  },
): Promise<string | { readonly kind: 'skipped'; readonly reason: string }> {
  const { skill, body, surfaces, pages } = input;
  let authored: z.infer<typeof authorSchema>;
  try {
    authored = await recordingAuthoringCalls(ctx, skill, () =>
      agentJson<z.infer<typeof authorSchema>>({
        agent: skillAuthorAgent,
        user: buildKeepCheckPrompt({ skill, body, surfaces, now: Date.now(), pages }),
        schema: authorSchemaFor(SURFACE_MODE),
      }),
    );
  } catch (err) {
    return {
      kind: 'skipped',
      reason: `the smoke test for its unchanged body could not be written: ${errorMessage(err)}`,
    };
  }
  const smokeTest = unwrapMarkdownFence(authored.smokeTest.trim()).source.trim();
  const instance: Doc<'workItems'> | null = skill.proposedFor
    ? await ctx.runQuery(internal.work.getInternal, { workItemId: skill.proposedFor })
    : null;
  const issues = smokeTest
    ? authoredSkillIssues({
        body,
        smokeTest,
        instance,
        documentedProcedure:
          SURFACE_MODE === 'real'
            ? linkedRunbookExcerpts(skill, surfaces, pages)
                .map((linked) => linked.excerpt)
                .join('\n')
            : '',
      })
    : ['the model returned an empty smoke test'];
  if (issues.length > 0) {
    return {
      kind: 'skipped',
      reason: `the smoke test written for its unchanged body was refused: ${issues.join('; ')}`,
    };
  }
  return smokeTest;
}

/** A stored verification that passed: the log, the program kept and the tools the body names. */
interface StoredVerificationPass {
  readonly kind: 'passed';
  readonly log: string;
  readonly smokeTest: string;
  readonly harnessTools: string[];
  readonly harnessToolsBySurface: SurfaceTools[];
}

/**
 * Run a stored body and smoke test in the sandbox under the holder's contract, holding the one
 * global lease for the run and releasing it whichever way the run went.
 */
async function runStoredVerification(
  ctx: ActionCtx,
  args: {
    readonly skill: Doc<'skills'>;
    readonly runId: Id<'events'>;
    readonly body: string;
    readonly smokeTest: string;
    readonly surfaces: readonly SurfaceRecord[];
  },
): Promise<StoredVerificationPass | StoredVerificationStop> {
  const { skill, runId } = args;
  const lease = await holdSandboxLease(ctx, {
    skillId: skill._id,
    agentId: skill.agentId,
    name: skill.name,
    runId,
  });
  if (!lease.held) {
    return {
      kind: 'skipped',
      reason: `the verification sandbox was busy with another skill for ${Math.round(lease.waitedMs / 60_000)} minutes`,
    };
  }
  const contract = smokeHarnessContract(args.body, args.surfaces, skill.targetSurface, Date.now());
  try {
    const verification = await verifyAuthoredSkill(
      { skillName: skill.name, skillBody: args.body, smokeTest: args.smokeTest },
      authorAndVerifySkill,
      SURFACE_MODE,
      contract,
    );
    if (!verification.ok) {
      return { kind: 'failed', reason: verification.reason, log: verification.reason };
    }
    const result = verification.result;
    if (result.skipped) {
      return { kind: 'skipped', reason: result.skipReason ?? 'no sandbox available' };
    }
    const backend = result.backend === 'local' ? 'the local sandbox' : 'Daytona';
    const [stdout, stderr] = await redactAuthoringTexts(ctx, skill.agentId, [
      result.stdout,
      result.stderr,
    ]);
    if (!result.ok) {
      const failure = result.failureReason ?? 'sandbox verification failed';
      return {
        kind: 'failed',
        reason: `the stored skill failed its check - ${failure}`,
        log:
          `verification in ${backend} (${result.sandboxId}) failed - ${failure}\n\n` +
          clipRefusedDraft(
            `stderr:\n${stderr!.trim()}\n\nstdout:\n${stdout!.trim()}`,
            FAILED_VERIFICATION_LOG_CHARS,
          ),
      };
    }
    return {
      kind: 'passed',
      log: `ran in ${backend} (${result.sandboxId})\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}\nok: true`,
      smokeTest: verification.smokeTest,
      harnessTools: harnessToolsNamed(args.body, contract.surfaces),
      harnessToolsBySurface: harnessToolsBySurface(
        args.body,
        namedHarnessSurfaces(contract, args.surfaces),
      ),
    };
  } catch (err) {
    return { kind: 'skipped', reason: `the sandbox threw: ${errorMessage(err)}` };
  } finally {
    await ctx.runMutation(internal.sandboxLease.release, { skillId: skill._id, runId });
  }
}

/**
 * End a stored verification that reached no verdict on the body. A registered row stays in use,
 * still due its re-check, and the claim is released; any other row is parked with the stored
 * body and smoke test, so Retry checks them without authoring.
 */
async function stopShortOfVerdict(
  ctx: ActionCtx,
  args: {
    readonly skill: Doc<'skills'>;
    readonly runId: Id<'events'>;
    readonly body: string;
    readonly smokeTest: string | undefined;
    readonly reason: string;
  },
): Promise<{ ok: false; reason: string }> {
  const { skill, runId, reason } = args;
  if (skill.state === 'registered' || args.smokeTest === undefined) {
    return await releaseRegisteredRow(ctx, { skillId: skill._id, runId, reason });
  }
  const { recorded } = await ctx.runMutation(internal.skills.parkUnverified, {
    skillId: skill._id,
    runId,
    sandboxId: '(skipped)',
    body: args.body,
    smokeTest: args.smokeTest,
    verificationLog: parkedCheckLog(reason),
    reason,
  });
  return { ok: false, reason: recorded ? reason : SUPERSEDED };
}

/**
 * End a stored verification that leaves its row as it was: the claim released, the row still
 * registered and still due its re-check, the skip on the record
 * (`skillVersions.releaseStoredVerification`).
 */
async function releaseRegisteredRow(
  ctx: ActionCtx,
  release: {
    readonly skillId: Id<'skills'>;
    readonly runId: Id<'events'>;
    readonly reason: string;
  },
): Promise<{ ok: false; reason: string }> {
  const { released } = await ctx.runMutation(internal.skillVersions.releaseStoredVerification, {
    skillId: release.skillId,
    runId: release.runId,
    reason: release.reason,
  });
  return { ok: false, reason: released ? release.reason : SUPERSEDED };
}
