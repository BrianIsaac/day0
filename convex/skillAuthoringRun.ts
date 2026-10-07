'use node';

import type { z } from 'zod';
import type { ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { agentJson } from '../src/lib/mastra';
import { authorAndVerifySkill } from '../src/lib/skill-sandbox';
import { authoredSkillIssues, clipRefusedDraft } from '../src/work/authored-skill';
import { declaredInputsNote, declareUndeclaredInputs } from '../src/work/skill-inputs';
import { FENCE_REMOVED_NOTE, unwrapMarkdownFence } from '../src/work/smoke-test';
import { smokeHarnessContract, type SmokeHarnessContract } from '../src/work/smoke-harness';
import { toSurfaceRecord } from '../src/surfaces/records';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { itemBoundModelFailure } from '../src/lib/structured-fallback';
import { errorMessage } from '../src/lib/errors';
import { harnessToolsBySurface, harnessToolsNamed } from '../src/work/skill-library';
import { holdsParkedStoredCopy, parkedCheckLog } from '../src/work/skill-adoption';
import {
  authorSchema,
  authorSchemaFor,
  buildAuthorPrompt,
  linkedRunbookExcerpts,
  skillAuthorAgent,
  type LinkedRunbookPage,
} from './skillAuthorPrompt';
import { holdSandboxLease, namedHarnessSurfaces, verifyAuthoredSkill } from './skillSandboxCheck';
import { linkedRunbookPages } from './documentationWindows';
import {
  FAILED_VERIFICATION_LOG_CHARS,
  keepRefusedDraft,
  parkedCopyRefusal,
  recordAuthoringFailure,
  recordingAuthoringCalls,
  redactAuthoredDraft,
  redactAuthoringTexts,
  storedCopyRefusedReason,
  SUPERSEDED,
} from './skillAuthoringRecord';

/**
 * Autonomous skill authoring action. Demo headline:
 *
 *   1. Boss has approved the proposed skill row.
 *   2. Mastra Agent (GPT-5.6 Terra) authors the SKILL.md body from
 *      name/description/rationale + a short Python smoke test that
 *      exercises the skill behaviour.
 *   3. A sandbox runs the smoke test - Daytona where a key is configured,
 *      the bundled local service otherwise. `src/lib/skill-sandbox.ts`
 *      picks, and reports the same shape whichever ran.
 *   4. If the sandbox exits 0 having printed one line per representative
 *      input set, we register the skill so it becomes available to the
 *      agent. If no sandbox ran at all, the skill stops at `authoring` and
 *      stays uncallable: the register step is what claims the body was
 *      checked.
 *
 * Before the sandbox, a static gate (`src/work/authored-skill.ts`) refuses a
 * body or smoke test that repeats the first work item's values or breaks the
 * placeholder contract; the reasons land on the row for the retry.
 *
 * In real mode the author writes `run()` and its `CASES` and nothing else
 * decides: the sandbox runs `src/work/smoke-harness.ts` around them, so an
 * assertion the author wrote about its own output can never fail the check.
 *
 * The Python smoke is a Voyager-style execution-success signal -
 * sandbox exit 0 means the body is internally consistent. Plan 2 / 3
 * adds environment + critic signals.
 *
 * The run is one phase after another, each returning where the run stops
 * or what the next phase reads: the draft, its preparation, the static gate,
 * the sandbox check, a check that fell short, and the registration. The
 * registered actions that start it are in `convex/skillActions.ts`.
 */

/** What an authoring run answers the action that started it. */
export interface AuthoringResult {
  readonly ok: boolean;
  readonly reason?: string;
  /** A pause held the run at its claim (D-8 (b)): it starts at the resume, and has not failed. */
  readonly held?: true;
}

/** The author's answer: the SKILL.md body and its smoke test. */
type AuthoredSkill = z.infer<typeof authorSchema>;

/** The run's claim and what every phase reads: the skill as claimed, the employee's surfaces and pages. */
interface AuthoringRun {
  readonly ctx: ActionCtx;
  readonly skillId: Id<'skills'>;
  readonly runId: Id<'events'>;
  readonly skill: Doc<'skills'>;
  readonly surfaceRows: readonly Doc<'surfaces'>[];
  readonly pageRows: readonly Doc<'docPages'>[];
}

/** A phase's answer when the run stops there, with what the run answers. */
interface RunEnded {
  readonly kind: 'ended';
  readonly result: AuthoringResult;
}

/** The draft the run goes on to check. */
interface DraftInHand {
  readonly kind: 'drafted';
  readonly authored: AuthoredSkill;
  /**
   * The stored version a parked copy registers under, or nothing: a parked copy of a stored
   * version registers under that version's checks or not at all (the wave 10 review, B1).
   */
  readonly storedVersionId: Id<'skillVersions'> | undefined;
}

/** The draft as the gate and the sandbox read it, with what Day0 changed in it. */
interface PreparedDraft {
  readonly body: string;
  readonly smokeTest: string;
  /** The stored version a parked copy registers under, as the draft in hand names it. */
  readonly storedVersionId: Id<'skillVersions'> | undefined;
  /** Placeholders whose names say they are credentials, which the gate refuses. */
  readonly credentials: readonly string[];
  /** A log with Day0's notes on the draft (a fence removed, inputs declared) ahead of it. */
  readonly noted: (log: string) => string;
}

/** What the sandbox check came to, when the run goes on past it. */
interface SandboxChecked {
  readonly kind: 'checked';
  readonly contract: SmokeHarnessContract;
  readonly sandboxId: string;
  /** Which sandbox said so, named in every message, since a verdict means different things. */
  readonly backend: string;
  readonly verificationLog: string;
  /** Why no sandbox ran the check, or null when one did. */
  readonly skipReason: string | null;
  /** Why the sandbox said no, or null when it said yes or did not run. */
  readonly verificationFailure: string | null;
  readonly failedVerificationLog: string;
}

/**
 * One authoring run: claim the skill, author it, gate it, verify it in a
 * sandbox and register it, or record why not.
 *
 * @param ctx - The action's context.
 * @param skillId - The skill to author.
 */
export async function authorAndRegister(
  ctx: ActionCtx,
  skillId: Id<'skills'>,
): Promise<AuthoringResult> {
  // One exclusive run at a time, and one id every write below carries. The
  // state this run acts on is the state the claim took, not a state read
  // before it: nothing can have moved between the two.
  const claim = await ctx.runMutation(internal.skills.claimAuthoringRun, {
    skillId: skillId,
  });
  if (!claim.claimed) {
    return { ok: false, reason: claim.reason, ...(claim.held === true ? { held: true } : {}) };
  }

  const surfaceRows: Doc<'surfaces'>[] = await ctx.runQuery(
    internal.orientationData.surfacesForAgent,
    { agentId: claim.skill.agentId },
  );
  // Read a window at a time, keeping only the pages the run can link (F2 D5).
  const pageRows = await linkedRunbookPages(
    ctx,
    claim.skill.agentId,
    claim.skill,
    surfaceRows.map(toSurfaceRecord),
    'skill-authoring',
  );
  const run: AuthoringRun = {
    ctx,
    skillId,
    runId: claim.runId,
    skill: claim.skill,
    surfaceRows,
    pageRows,
  };

  const drafted = await obtainDraft(run);
  if (drafted.kind === 'ended') return drafted.result;
  const draft = prepareDraft(drafted);
  if (!draft.body || !draft.smokeTest) {
    const reason = 'the model returned an empty SKILL.md body or smoke test';
    return await recordAuthoringFailure(ctx, skillId, run.runId, {
      rowReason: reason,
      reason,
      eventType: 'skill.author-failed',
    });
  }

  // The pages the prompt carried: the gate reads their text, and the
  // registration records which they were (`readRefs`).
  const linkedPages = linkedRunbookExcerpts(run.skill, surfaceRows.map(toSurfaceRecord), pageRows);
  const refused = await gateDraft(run, draft, linkedPages);
  if (refused !== undefined) return refused.result;

  const checked = await checkInSandbox(run, draft);
  if (checked.kind === 'ended') return checked.result;
  const shortfall = await recordShortfall(run, draft, checked);
  if (shortfall !== undefined) return shortfall.result;
  return await register(run, draft, checked, linkedPages);
}

/**
 * The draft the run checks: a parked one kept on the row (its body and the smoke test no sandbox
 * has run), or one the author writes now. A parked copy of a stored version whose offer no longer
 * stands fails the row here; a model failure that is not the skill's defers the run.
 */
async function obtainDraft(run: AuthoringRun): Promise<DraftInHand | RunEnded> {
  const { ctx, skillId, runId, skill } = run;
  if (skill.state === 'authoring' && skill.pendingSmokeTest && skill.body) {
    let storedVersionId: Id<'skillVersions'> | undefined;
    if (holdsParkedStoredCopy(skill)) {
      const refusal = await parkedCopyRefusal(ctx, skill);
      if (refusal !== undefined) {
        return ended(
          await recordAuthoringFailure(ctx, skillId, runId, {
            rowReason: storedCopyRefusedReason(refusal),
            reason: refusal,
            eventType: 'skill.verification-failed',
            dropsStoredCopy: true,
          }),
        );
      }
      storedVersionId = skill.offeredVersionId;
    }
    return {
      kind: 'drafted',
      authored: { body: skill.body, smokeTest: skill.pendingSmokeTest },
      storedVersionId,
    };
  }
  const userPrompt = buildAuthorPrompt(
    {
      ...skill,
      previousAuthoringFailure: skill.verificationLog,
      previousAuthoringDraft:
        skill.refusedBody || skill.refusedSmokeTest
          ? { body: skill.refusedBody ?? '', smokeTest: skill.refusedSmokeTest ?? '' }
          : undefined,
    },
    run.surfaceRows.map(toSurfaceRecord),
    Date.now(),
    run.pageRows,
    SURFACE_MODE,
  );
  // The model layer rethrows failures prompt injection cannot fix, which is
  // right - but the dashboard fires this action and forgets it, so an
  // uncaught throw would leave the row at `approved`, in none of the skill
  // panels, with nothing to press. Record the failure instead: `failed` is
  // listed, carries the reason, and offers Retry.
  try {
    const authored = await recordingAuthoringCalls(ctx, skill, () =>
      agentJson<AuthoredSkill>({
        agent: skillAuthorAgent,
        user: userPrompt,
        schema: authorSchemaFor(SURFACE_MODE),
      }),
    );
    return { kind: 'drafted', authored, storedVersionId: undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A failure that is not the skill's (an outage, a rate limit, a
    // timeout) is waited out and tried again, as a plan draft's is; one
    // about the skill fails it now (U9 step 20).
    if (SURFACE_MODE === 'real' && itemBoundModelFailure(err) === undefined) {
      const deferral = await ctx.runMutation(internal.skills.deferAuthoringRun, {
        skillId: skillId,
        runId,
        reason: `authoring failed before any sandbox ran: ${message}`,
      });
      return ended({ ok: false, reason: deferral.reason });
    }
    const reason = `authoring failed before any sandbox ran: ${message}`;
    return ended(
      await recordAuthoringFailure(ctx, skillId, runId, {
        rowReason: reason,
        reason,
        eventType: 'skill.author-failed',
      }),
    );
  }
}

/** The run stops here, answering this. */
function ended(result: AuthoringResult): RunEnded {
  return { kind: 'ended', result };
}

/**
 * The draft as the gate reads it: trimmed, its smoke test out of a markdown fence, and, in real
 * mode, its undeclared placeholders declared.
 *
 * In real mode a placeholder the author used without declaring it is
 * declared for it, in the words the executor binds such an input by,
 * rather than refusing a procedure the executor can run; the line says
 * Day0 added it. A name that says it is a credential is never declared:
 * the gate refuses it and points at `{{secret}}`. Mock mode refuses every
 * undeclared placeholder as the recorded runs did.
 */
function prepareDraft({ authored, storedVersionId }: DraftInHand): PreparedDraft {
  const inputs =
    SURFACE_MODE === 'real'
      ? declareUndeclaredInputs(authored.body.trim())
      : { body: authored.body.trim(), declared: [], credentials: [] };
  // A fenced smoke test is a program with a wrapper, not a refusal: the
  // wrapper comes off here, before the gate reads it, and every log written
  // after this point says so.
  const fence = unwrapMarkdownFence(authored.smokeTest.trim());
  const notes: string[] = fence.unwrapped ? [FENCE_REMOVED_NOTE] : [];
  if (inputs.declared.length > 0) notes.push(declaredInputsNote(inputs.declared));
  return {
    body: inputs.body,
    smokeTest: fence.source.trim(),
    storedVersionId,
    credentials: inputs.credentials,
    noted: (log: string): string => (notes.length > 0 ? `${notes.join('\n')}\n\n${log}` : log),
  };
}

/**
 * The static gate before any sandbox spends a run: a body that repeats
 * the first work item's values, or breaks the placeholder contract the
 * executor binds by, is not a reusable procedure whatever its smoke test
 * prints. The reasons go on the row, so the retry is told what to change.
 *
 * @returns Where the run stops, or undefined when the draft passed.
 */
async function gateDraft(
  run: AuthoringRun,
  draft: PreparedDraft,
  linkedPages: readonly LinkedRunbookPage<Doc<'docPages'>>[],
): Promise<RunEnded | undefined> {
  const { ctx, skill } = run;
  const { body, smokeTest } = draft;
  const instance: Doc<'workItems'> | null = skill.proposedFor
    ? await ctx.runQuery(internal.work.getInternal, { workItemId: skill.proposedFor })
    : null;
  const issues = authoredSkillIssues({
    body,
    smokeTest,
    instance,
    credentialInputs: [...draft.credentials],
    // The pages alone, without the prompt's framing, whose own words would
    // otherwise read as documented controls.
    documentedProcedure:
      SURFACE_MODE === 'real' ? linkedPages.map((linked) => linked.excerpt).join('\n') : '',
  });
  if (issues.length === 0) return undefined;
  const reason = `the authored skill is not a reusable procedure: ${issues.join('; ')}`;
  return ended(
    await recordAuthoringFailure(ctx, run.skillId, run.runId, {
      rowReason: draft.noted(reason),
      reason,
      eventType: 'skill.author-failed',
      refusedDraft: await keepRefusedDraft(ctx, skill.agentId, { body, smokeTest }),
    }),
  );
}

/** A parked row's log: a stored copy parked again keeps the mark that says it is one (holdsParkedStoredCopy). */
function parkedLog(draft: PreparedDraft, log: string, reason: string): string {
  return draft.storedVersionId !== undefined ? parkedCheckLog(reason) : draft.noted(log);
}

/**
 * The sandbox check, under the sandbox lease.
 *
 * Sandbox verification is optional, so the loop survives without it - but
 * a skill nothing ran is not a verified skill. Whether no backend is
 * available or the one chosen falls over, the skill stops at `authoring`
 * with the body kept, the work item stays `needs-skill`, and the skip goes
 * to the event feed so the demo shows what was and was not checked.
 *
 * @returns Where the run stops (the lease never held, a preflight refusal, a lost claim), or what
 *   the check came to.
 */
async function checkInSandbox(
  run: AuthoringRun,
  draft: PreparedDraft,
): Promise<SandboxChecked | RunEnded> {
  const { ctx, skillId, runId, skill } = run;
  const { body, smokeTest } = draft;
  let sandboxId = '(skipped)';
  let verificationLog = '(no sandbox available)';
  let skipReason: string | null = null;
  let verificationFailure: string | null = null;
  let failedVerificationLog = '';
  let backend = 'the sandbox';
  // One verification at a time across every employee: the sandbox is serial
  // and the client's wait is finite, so the queue is a lease here rather
  // than a backlog on its socket.
  const lease = await holdSandboxLease(ctx, {
    skillId: skillId,
    agentId: skill.agentId,
    name: skill.name,
    runId,
  });
  if (!lease.held) {
    const pendingDraft = await redactAuthoredDraft(ctx, skill.agentId, { body, smokeTest });
    const waitedFor = `${Math.round(lease.waitedMs / 60_000)} minutes`;
    const reason =
      `the verification sandbox was busy with another skill for ${waitedFor}; ` +
      'the body is kept and Retry runs the smoke test when it is free';
    const { recorded } = await ctx.runMutation(internal.skills.parkUnverified, {
      skillId: skillId,
      runId,
      sandboxId: '(skipped)',
      body: pendingDraft.body,
      smokeTest: pendingDraft.smokeTest,
      verificationLog: parkedLog(draft, reason, reason),
      reason,
    });
    if (!recorded) return ended({ ok: false, reason: SUPERSEDED });
    return ended({ ok: false, reason: `sandbox verification unavailable: ${reason}` });
  }
  const contract = smokeHarnessContract(
    body,
    run.surfaceRows.map(toSurfaceRecord),
    skill.targetSurface,
    Date.now(),
  );
  try {
    const verification = await verifyAuthoredSkill(
      { skillName: skill.name, skillBody: body, smokeTest },
      authorAndVerifySkill,
      SURFACE_MODE,
      contract,
    );
    if (!verification.ok) {
      return ended(
        await recordAuthoringFailure(ctx, skillId, runId, {
          rowReason: draft.noted(verification.reason),
          reason: verification.reason,
          eventType: 'skill.author-failed',
          refusedDraft: await keepRefusedDraft(ctx, skill.agentId, { body, smokeTest }),
        }),
      );
    }
    const result = verification.result;
    if (result.skipped) {
      skipReason = result.skipReason ?? 'no sandbox available';
      verificationLog = `sandbox verification skipped - ${skipReason}`;
    } else {
      backend = result.backend === 'local' ? 'the local sandbox' : 'Daytona';
      sandboxId = result.sandboxId;
      // Store the body as soon as a sandbox exists: whichever way the check
      // goes, the boss can read what was written and decide about a retry.
      // A run that has already lost its claim stops here rather than spending
      // the rest of the ladder on a result nothing will accept.
      const progress = await ctx.runMutation(internal.skills.recordAuthoringProgress, {
        skillId: skillId,
        runId,
        sandboxId,
        body,
      });
      if (!progress.held) return ended({ ok: false, reason: SUPERSEDED });
      // What the sandbox printed is the author's: its cases' values and the
      // lines of its source a traceback quotes. It is redacted as a draft
      // is, and only it: the frame around it is this action's own words,
      // and a span model that reads a sandbox id as a secret should not get
      // the chance.
      const [stdout, stderr] = await redactAuthoringTexts(ctx, skill.agentId, [
        result.stdout,
        result.stderr,
      ]);
      verificationLog = `ran in ${backend} (${sandboxId})\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}\nok: ${result.ok}`;
      if (!result.ok) {
        verificationFailure = result.failureReason ?? 'sandbox verification failed';
        failedVerificationLog = `stderr:\n${stderr!.trim()}\n\nstdout:\n${stdout!.trim()}`;
      }
    }
  } catch (err) {
    skipReason = `${backend} threw: ${errorMessage(err)}`;
    verificationLog = skipReason;
  } finally {
    // Released whichever way the check went, so the next employee's
    // authoring run does not wait out the lease for a run that is over.
    // `release` only frees a lease this run holds, so the hosted path,
    // which took none, frees nobody else's.
    await ctx.runMutation(internal.sandboxLease.release, { skillId: skillId, runId });
  }
  return {
    kind: 'checked',
    contract,
    sandboxId,
    backend,
    verificationLog,
    skipReason,
    verificationFailure,
    failedVerificationLog,
  };
}

/**
 * A check that fell short, recorded outside the sandbox's try: a failure while recording a
 * failure must not be reported as the sandbox throwing. A sandbox that said no fails the row; one
 * that did not run parks it, the body kept.
 *
 * @returns Where the run stops, or undefined when the check passed.
 */
async function recordShortfall(
  run: AuthoringRun,
  draft: PreparedDraft,
  checked: SandboxChecked,
): Promise<RunEnded | undefined> {
  const { ctx, skillId, runId, skill } = run;
  const { body, smokeTest } = draft;
  const { backend, sandboxId, verificationLog, verificationFailure, skipReason } = checked;
  if (verificationFailure) {
    // Mock mode records what the recorded runs recorded. Real mode keeps the
    // attempt whole: the draft through the refused-draft path, so the row
    // can be read and exported and the retry corrects it, and the log with
    // stderr first, because the harness's reason and the traceback are
    // there and 400 characters of stdout used to push them off the row.
    if (SURFACE_MODE !== 'real') {
      return ended(
        await recordAuthoringFailure(ctx, skillId, runId, {
          rowReason: draft.noted(
            `verification in ${backend} failed - ${verificationFailure}. ${verificationLog.slice(0, 400)}`,
          ),
          reason: `skill authored but verification failed - ${verificationFailure}`,
          eventType: 'skill.verification-failed',
        }),
      );
    }
    return ended(
      await recordAuthoringFailure(ctx, skillId, runId, {
        rowReason: draft.noted(
          `verification in ${backend} (${sandboxId}) failed - ${verificationFailure}\n\n` +
            clipRefusedDraft(checked.failedVerificationLog, FAILED_VERIFICATION_LOG_CHARS),
        ),
        reason: `skill authored but verification failed - ${verificationFailure}`,
        eventType: 'skill.verification-failed',
        refusedDraft: await keepRefusedDraft(ctx, skill.agentId, { body, smokeTest }),
      }),
    );
  }
  if (!skipReason) return undefined;
  const pendingDraft = await redactAuthoredDraft(ctx, skill.agentId, { body, smokeTest });
  const { recorded } = await ctx.runMutation(internal.skills.parkUnverified, {
    skillId: skillId,
    runId,
    sandboxId,
    body: pendingDraft.body,
    smokeTest: pendingDraft.smokeTest,
    verificationLog: parkedLog(draft, verificationLog, skipReason),
    reason: skipReason,
  });
  if (!recorded) return ended({ ok: false, reason: SUPERSEDED });
  return ended({ ok: false, reason: `sandbox verification unavailable: ${skipReason}` });
}

/**
 * Register the checked skill.
 *
 * One call, one transaction: the verified body, the callable row and the
 * requeue of the work item that asked for the skill either all land or none
 * of them do. Anything that fails here leaves the row in a state the skills
 * panel lists and the next claim accepts.
 */
async function register(
  run: AuthoringRun,
  draft: PreparedDraft,
  checked: SandboxChecked,
  linkedPages: readonly LinkedRunbookPage<Doc<'docPages'>>[],
): Promise<AuthoringResult> {
  const { ctx, skillId, runId } = run;
  const { body, storedVersionId } = draft;
  const { contract } = checked;
  const { registered, refusal } = await ctx.runMutation(internal.skills.completeRegistration, {
    skillId: skillId,
    runId,
    body,
    verificationLog: draft.noted(checked.verificationLog),
    smokeTest: draft.smokeTest,
    harnessTools: harnessToolsNamed(body, contract.surfaces),
    harnessToolsBySurface: harnessToolsBySurface(
      body,
      namedHarnessSurfaces(contract, run.surfaceRows.map(toSurfaceRecord)),
    ),
    readRefs: linkedPages.map(({ page }) => ({
      sourceId: page.sourceId,
      ref: page.ref,
      title: page.title,
    })),
    ...(storedVersionId !== undefined ? { storedVersionId } : {}),
  });
  if (registered) return { ok: true };
  if (refusal === undefined) return { ok: false, reason: SUPERSEDED };
  return await recordAuthoringFailure(ctx, skillId, runId, {
    rowReason: storedCopyRefusedReason(refusal),
    reason: refusal,
    eventType: 'skill.verification-failed',
    dropsStoredCopy: true,
  });
}
