'use node';

import { v } from 'convex/values';
import type { z } from 'zod';
import { action, internalAction, type ActionCtx } from './_generated/server';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { agentJson } from '../src/lib/mastra';
import { observeModelCalls, type ModelCallReport } from '../src/lib/model-call-telemetry';
import {
  authorAndVerifySkill,
  configuredSkillSandboxBackend,
  type AuthorSkillArgs,
  type SkillSandboxRun,
} from '../src/lib/skill-sandbox';
import { authoredSkillIssues, clipRefusedDraft } from '../src/work/authored-skill';
import { declaredInputsNote, declareUndeclaredInputs } from '../src/work/skill-inputs';
import {
  FENCE_REMOVED_NOTE,
  smokeTestPreflightReason,
  unwrapMarkdownFence,
} from '../src/work/smoke-test';
import {
  harnessedSmokeTest,
  smokeHarnessContract,
  type SmokeHarnessContract,
} from '../src/work/smoke-harness';
import { toSurfaceRecord } from '../src/surfaces/records';
import { redactOutcome } from '../src/surfaces/redact';
import type { SurfaceMode, SurfaceRecord } from '../src/surfaces/types';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { SANDBOX_LEASE_RETRY_MS } from './sandboxLease';
import { logEvent } from './eventLog';
import { spanModelFromEnv } from '../src/redaction/span-model-env';
import { ownerKnownValues } from '../src/redaction/known-values';
import { itemBoundModelFailure } from '../src/lib/structured-fallback';
import { errorMessage } from '../src/lib/errors';
import {
  harnessToolsBySurface,
  harnessToolsNamed,
  type NamedHarnessSurface,
} from '../src/work/skill-library';
import { holdsParkedStoredCopy, parkedCheckLog } from '../src/work/skill-adoption';
import {
  authorSchema,
  authorSchemaFor,
  buildAuthorPrompt,
  linkedRunbookExcerpts,
  skillAuthorAgent,
} from './skillAuthorPrompt';

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
 */

/*
 * The author prompt's names `convex/storedVerification.ts` reads from this module; they live in
 * `convex/skillAuthorPrompt.ts`.
 */
export {
  authorSchema,
  authorSchemaFor,
  buildAuthorPrompt,
  linkedRunbookExcerpts,
  skillAuthorAgent,
  type AuthorPromptSkill,
  type AuthorRunbookPage,
} from './skillAuthorPrompt';

type SkillVerifier = (args: AuthorSkillArgs) => Promise<SkillSandboxRun>;

/**
 * Reject malformed model output before either verification backend spends a
 * run. A smoke test that arrived wrapped in a markdown fence is unwrapped
 * first rather than refused; the result says so, and carries the author's
 * program as it will be kept.
 *
 * In real mode the sandbox runs the harness around that program, so the
 * verdict is the harness's reading of what `run()` returned and never an
 * assertion the author wrote; mock mode runs the author's program as written,
 * as the recorded runs did.
 *
 * Args:
 *   args: The skill and the author's smoke test.
 *   verify: The sandbox call, injected for tests.
 *   mode: The deployment's surface mode.
 *   contract: What the real-mode harness holds the actions against. Without
 *     one the harness knows no connected surface, so every action is refused:
 *     a caller that forgets it cannot register a skill unchecked.
 *
 * Returns:
 *   The preflight refusal, or the sandbox's result with the author's program.
 */
export async function verifyAuthoredSkill(
  args: AuthorSkillArgs,
  verify: SkillVerifier = authorAndVerifySkill,
  mode: SurfaceMode = SURFACE_MODE,
  contract?: SmokeHarnessContract,
): Promise<
  | { ok: true; result: SkillSandboxRun; smokeTest: string; unwrapped: boolean }
  | { ok: false; reason: string }
> {
  const fence = unwrapMarkdownFence(args.smokeTest);
  const reason = smokeTestPreflightReason(fence.source, mode);
  if (reason) return { ok: false, reason: `smoke test rejected before sandbox: ${reason}` };
  const program =
    mode === 'real'
      ? harnessedSmokeTest(
          fence.source,
          contract ?? smokeHarnessContract(args.skillBody, [], undefined, Date.now()),
        )
      : fence.source;
  const result = await verify({ ...args, smokeTest: program });
  return { ok: true, result, smokeTest: fence.source, unwrapped: fence.unwrapped };
}

/**
 * How long a run waits for the sandbox lease before giving the skill back.
 *
 * Long enough to outlast a verification that runs to the sandbox's 60 s cap
 * with a couple of others ahead of it; short enough that the manager is not
 * left with a skill stuck in authoring when the sandbox has stopped serving.
 */
const SANDBOX_WAIT_LIMIT_MS = 5 * 60_000;

/**
 * Hold the verification sandbox for this run, waiting for whoever has it.
 *
 * Three employees authoring together used to queue on the sandbox's own
 * socket, where a smoke test at the 60 s cap makes every request behind it
 * wait and a second one pushes them past the client's 75 s wait - which reads
 * as "the sandbox threw" and parks a skill whose own smoke test was never
 * run. Waiting here instead costs the same time and says what it is waiting
 * for: the wait is a row, an event and a reason on the skill, and each
 * request still reaches the sandbox alone.
 *
 * Only the bundled sandbox is serial. Daytona runs one per verification, so
 * a deployment configured for it takes no lease and waits for nobody.
 *
 * Args:
 *   ctx: Convex action context.
 *   skill: The skill being verified, its agent and the authoring run.
 *
 * Returns:
 *   Whether this run holds the lease, and how long it waited.
 */
export async function holdSandboxLease(
  ctx: ActionCtx,
  skill: { skillId: Id<'skills'>; agentId: Id<'agents'>; name: string; runId: Id<'events'> },
): Promise<{ held: boolean; waitedMs: number }> {
  if (configuredSkillSandboxBackend() !== 'local') return { held: true, waitedMs: 0 };
  const startedAt = Date.now();
  let waiting = false;
  for (;;) {
    if (waiting && Date.now() - startedAt >= SANDBOX_WAIT_LIMIT_MS) {
      return { held: false, waitedMs: Date.now() - startedAt };
    }
    const attempt = await ctx.runMutation(internal.sandboxLease.take, {
      skillId: skill.skillId,
      runId: skill.runId,
    });
    if (attempt.taken) {
      const waitedMs = Date.now() - startedAt;
      if (waitedMs >= SANDBOX_WAIT_LIMIT_MS) {
        await ctx.runMutation(internal.sandboxLease.release, {
          skillId: skill.skillId,
          runId: skill.runId,
        });
        return { held: false, waitedMs };
      }
      return { held: true, waitedMs };
    }
    if (!waiting) {
      waiting = true;
      await logEvent(ctx, {
        agentId: skill.agentId,
        type: 'skill.sandbox-waiting',
        payload: {
          skillId: skill.skillId,
          name: skill.name,
          heldForMs: attempt.heldForMs ?? 0,
          retryInMs: SANDBOX_LEASE_RETRY_MS,
        },
      });
    }
    if (Date.now() - startedAt >= SANDBOX_WAIT_LIMIT_MS) {
      return { held: false, waitedMs: Date.now() - startedAt };
    }
    await new Promise((resolve) => setTimeout(resolve, SANDBOX_LEASE_RETRY_MS));
  }
}

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
async function keepRefusedDraft(
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

async function redactAuthoredDraft(
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

export const authorAndRegisterSkill = action({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    // Ownership first, so a caller who does not own the skill cannot even learn
    // whether a run is holding it.
    await ctx.runQuery(api.skills.get, { skillId: args.skillId });
    return await authorAndRegister(ctx, args.skillId);
  },
});

/**
 * The retry a deferred authoring scheduled for itself (`skills.deferAuthoringRun`).
 * Internal: the scheduler has no caller identity to check ownership against,
 * and the skill was the owner's when its first run was asked for.
 */
export const authorAndRegisterSkillInternal = internalAction({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> =>
    await authorAndRegister(ctx, args.skillId),
});

/**
 * One authoring run: claim the skill, author it, gate it, verify it in a
 * sandbox and register it, or record why not.
 */
async function authorAndRegister(
  ctx: ActionCtx,
  skillId: Id<'skills'>,
): Promise<{ ok: boolean; reason?: string }> {
  // One exclusive run at a time, and one id every write below carries. The
  // state this run acts on is the state the claim took, not a state read
  // before it: nothing can have moved between the two.
  const claim = await ctx.runMutation(internal.skills.claimAuthoringRun, {
    skillId: skillId,
  });
  if (!claim.claimed) return { ok: false, reason: claim.reason };
  const { runId, skill } = claim;

  const surfaceRows: Doc<'surfaces'>[] = await ctx.runQuery(
    internal.orientationData.surfacesForAgent,
    { agentId: skill.agentId },
  );
  const pageRows: Doc<'docPages'>[] = await ctx.runQuery(internal.orientationData.pagesForAgent, {
    agentId: skill.agentId,
  });
  type AuthoredSkill = z.infer<typeof authorSchema>;
  // The model layer rethrows failures prompt injection cannot fix, which is
  // right - but the dashboard fires this action and forgets it, so an
  // uncaught throw would leave the row at `approved`, in none of the skill
  // panels, with nothing to press. Record the failure instead: `failed` is
  // listed, carries the reason, and offers Retry.
  let authored: AuthoredSkill;
  // A parked copy of a stored version registers under that version's checks or not at all (the
  // wave 10 review, B1): its own draft is the employee's, the copy is the library's.
  let storedVersionId: Id<'skillVersions'> | undefined;
  if (skill.state === 'authoring' && skill.pendingSmokeTest && skill.body) {
    if (holdsParkedStoredCopy(skill)) {
      const refusal = await parkedCopyRefusal(ctx, skill);
      if (refusal !== undefined) {
        return await recordAuthoringFailure(ctx, skillId, runId, {
          rowReason: storedCopyRefusedReason(refusal),
          reason: refusal,
          eventType: 'skill.verification-failed',
          dropsStoredCopy: true,
        });
      }
      storedVersionId = skill.offeredVersionId;
    }
    authored = { body: skill.body, smokeTest: skill.pendingSmokeTest };
  } else {
    const userPrompt = buildAuthorPrompt(
      {
        ...skill,
        previousAuthoringFailure: skill.verificationLog,
        previousAuthoringDraft:
          skill.refusedBody || skill.refusedSmokeTest
            ? { body: skill.refusedBody ?? '', smokeTest: skill.refusedSmokeTest ?? '' }
            : undefined,
      },
      surfaceRows.map(toSurfaceRecord),
      Date.now(),
      pageRows,
      SURFACE_MODE,
    );
    try {
      authored = await recordingAuthoringCalls(ctx, skill, () =>
        agentJson<AuthoredSkill>({
          agent: skillAuthorAgent,
          user: userPrompt,
          schema: authorSchemaFor(SURFACE_MODE),
        }),
      );
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
        return { ok: false, reason: deferral.reason };
      }
      const reason = `authoring failed before any sandbox ran: ${message}`;
      return await recordAuthoringFailure(ctx, skillId, runId, {
        rowReason: reason,
        reason,
        eventType: 'skill.author-failed',
      });
    }
  }

  // In real mode a placeholder the author used without declaring it is
  // declared for it, in the words the executor binds such an input by,
  // rather than refusing a procedure the executor can run; the line says
  // Day0 added it. A name that says it is a credential is never declared:
  // the gate refuses it and points at `{{secret}}`. Mock mode refuses every
  // undeclared placeholder as the recorded runs did.
  const inputs =
    SURFACE_MODE === 'real'
      ? declareUndeclaredInputs(authored.body.trim())
      : { body: authored.body.trim(), declared: [], credentials: [] };
  const body = inputs.body;
  // A fenced smoke test is a program with a wrapper, not a refusal: the
  // wrapper comes off here, before the gate reads it, and every log written
  // after this point says so.
  const fence = unwrapMarkdownFence(authored.smokeTest.trim());
  const smokeTest = fence.source.trim();
  const notes: string[] = fence.unwrapped ? [FENCE_REMOVED_NOTE] : [];
  if (inputs.declared.length > 0) notes.push(declaredInputsNote(inputs.declared));
  const noted = (log: string): string => (notes.length > 0 ? `${notes.join('\n')}\n\n${log}` : log);
  if (!body || !smokeTest) {
    const reason = 'the model returned an empty SKILL.md body or smoke test';
    return await recordAuthoringFailure(ctx, skillId, runId, {
      rowReason: reason,
      reason,
      eventType: 'skill.author-failed',
    });
  }

  // The pages the prompt carried: the gate reads their text, and the
  // registration records which they were (`readRefs`).
  const linkedPages = linkedRunbookExcerpts(skill, surfaceRows.map(toSurfaceRecord), pageRows);

  // The static gate before any sandbox spends a run: a body that repeats
  // the first work item's values, or breaks the placeholder contract the
  // executor binds by, is not a reusable procedure whatever its smoke test
  // prints. The reasons go on the row, so the retry is told what to change.
  const instance: Doc<'workItems'> | null = skill.proposedFor
    ? await ctx.runQuery(internal.work.getInternal, { workItemId: skill.proposedFor })
    : null;
  const issues = authoredSkillIssues({
    body,
    smokeTest,
    instance,
    credentialInputs: inputs.credentials,
    // The pages alone, without the prompt's framing, whose own words would
    // otherwise read as documented controls.
    documentedProcedure:
      SURFACE_MODE === 'real' ? linkedPages.map((linked) => linked.excerpt).join('\n') : '',
  });
  if (issues.length > 0) {
    const reason = `the authored skill is not a reusable procedure: ${issues.join('; ')}`;
    return await recordAuthoringFailure(ctx, skillId, runId, {
      rowReason: noted(reason),
      reason,
      eventType: 'skill.author-failed',
      refusedDraft: await keepRefusedDraft(ctx, skill.agentId, { body, smokeTest }),
    });
  }

  // Sandbox verification is optional, so the loop survives without it - but
  // a skill nothing ran is not a verified skill. Whether no backend is
  // available or the one chosen falls over, the skill stops at `authoring`
  // with the body kept, the work item stays `needs-skill`, and the skip goes
  // to the event feed so the demo shows what was and was not checked.
  let sandboxId = '(skipped)';
  let verificationLog = '(no sandbox available)';
  let skipReason: string | null = null;
  let verificationFailure: string | null = null;
  let failedVerificationLog = '';
  // Named in every message below, because "verification failed" means
  // different things to a boss depending on which sandbox said so.
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
  // A stored copy parked again keeps the mark that says it is one (holdsParkedStoredCopy).
  const parkedLog = (log: string, reason: string): string =>
    storedVersionId !== undefined ? parkedCheckLog(reason) : noted(log);
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
      verificationLog: parkedLog(reason, reason),
      reason,
    });
    if (!recorded) return { ok: false, reason: SUPERSEDED };
    return { ok: false, reason: `sandbox verification unavailable: ${reason}` };
  }
  const contract = smokeHarnessContract(
    body,
    surfaceRows.map(toSurfaceRecord),
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
      return await recordAuthoringFailure(ctx, skillId, runId, {
        rowReason: noted(verification.reason),
        reason: verification.reason,
        eventType: 'skill.author-failed',
        refusedDraft: await keepRefusedDraft(ctx, skill.agentId, { body, smokeTest }),
      });
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
      if (!progress.held) return { ok: false, reason: SUPERSEDED };
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

  // Recorded outside the try: a failure while recording a failure must not be
  // reported as the sandbox throwing.
  if (verificationFailure) {
    // Mock mode records what the recorded runs recorded. Real mode keeps the
    // attempt whole: the draft through the refused-draft path, so the row
    // can be read and exported and the retry corrects it, and the log with
    // stderr first, because the harness's reason and the traceback are
    // there and 400 characters of stdout used to push them off the row.
    if (SURFACE_MODE !== 'real') {
      return await recordAuthoringFailure(ctx, skillId, runId, {
        rowReason: noted(
          `verification in ${backend} failed - ${verificationFailure}. ${verificationLog.slice(0, 400)}`,
        ),
        reason: `skill authored but verification failed - ${verificationFailure}`,
        eventType: 'skill.verification-failed',
      });
    }
    return await recordAuthoringFailure(ctx, skillId, runId, {
      rowReason: noted(
        `verification in ${backend} (${sandboxId}) failed - ${verificationFailure}\n\n` +
          clipRefusedDraft(failedVerificationLog, FAILED_VERIFICATION_LOG_CHARS),
      ),
      reason: `skill authored but verification failed - ${verificationFailure}`,
      eventType: 'skill.verification-failed',
      refusedDraft: await keepRefusedDraft(ctx, skill.agentId, { body, smokeTest }),
    });
  }

  if (skipReason) {
    const pendingDraft = await redactAuthoredDraft(ctx, skill.agentId, { body, smokeTest });
    const { recorded } = await ctx.runMutation(internal.skills.parkUnverified, {
      skillId: skillId,
      runId,
      sandboxId,
      body: pendingDraft.body,
      smokeTest: pendingDraft.smokeTest,
      verificationLog: parkedLog(verificationLog, skipReason),
      reason: skipReason,
    });
    if (!recorded) return { ok: false, reason: SUPERSEDED };
    return { ok: false, reason: `sandbox verification unavailable: ${skipReason}` };
  }

  // One call, one transaction: the verified body, the callable row and the
  // requeue of the work item that asked for the skill either all land or none
  // of them do. Anything that fails here leaves the row in a state the skills
  // panel lists and the next claim accepts.
  const { registered, refusal } = await ctx.runMutation(internal.skills.completeRegistration, {
    skillId: skillId,
    runId,
    body,
    verificationLog: noted(verificationLog),
    smokeTest,
    harnessTools: harnessToolsNamed(body, contract.surfaces),
    harnessToolsBySurface: harnessToolsBySurface(
      body,
      namedHarnessSurfaces(contract, surfaceRows.map(toSurfaceRecord)),
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

/**
 * Why a row's parked copy of a stored version may not be checked: its offer is gone (a handover,
 * a Withdraw or a later evaluation took it), or the version offered is no longer one the row may
 * register as. Undefined when the copy may be checked, under the version's checks again at
 * registration.
 */
async function parkedCopyRefusal(
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

/**
 * The harness contract's connected surfaces with each one's class, for the per-surface tools a
 * version records.
 *
 * @param contract - The harness contract the verification ran under.
 * @param surfaces - The employee's surfaces, for their classes.
 */
export function namedHarnessSurfaces(
  contract: SmokeHarnessContract,
  surfaces: readonly SurfaceRecord[],
): NamedHarnessSurface[] {
  return contract.surfaces.map((surface) => {
    const surfaceClass = surfaces.find((record) => record.slug === surface.slug)?.class;
    return {
      slug: surface.slug,
      allowedTools: surface.allowedTools,
      ...(surfaceClass !== undefined ? { surfaceClass } : {}),
    };
  });
}
