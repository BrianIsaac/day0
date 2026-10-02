'use node';

import type { ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import {
  authorAndVerifySkill,
  configuredSkillSandboxBackend,
  type AuthorSkillArgs,
  type SkillSandboxRun,
} from '../src/lib/skill-sandbox';
import { smokeTestPreflightReason, unwrapMarkdownFence } from '../src/work/smoke-test';
import {
  harnessedSmokeTest,
  smokeHarnessContract,
  type SmokeHarnessContract,
} from '../src/work/smoke-harness';
import type { SurfaceMode, SurfaceRecord } from '../src/surfaces/types';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { SANDBOX_LEASE_RETRY_MS } from './sandboxLease';
import { logEvent } from './eventLog';
import type { NamedHarnessSurface } from '../src/work/skill-library';

/*
 * The sandbox check of an authored or stored skill: the preflight and the harness around the
 * author's program, the lease that keeps the bundled sandbox to one verification at a time, and
 * the harness's surfaces as a version records them. Shared by the authoring run
 * (`convex/skillActions.ts`) and the stored verification (`convex/storedVerification.ts`); no
 * Convex function lives here.
 */

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
