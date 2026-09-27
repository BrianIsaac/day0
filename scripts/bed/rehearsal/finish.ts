/**
 * How a rehearsal ends: the ceiling that stops the phases at their next wait,
 * and the clean-up that runs once after them, whatever they did.
 */
import { rmSync } from 'node:fs';
import { composeDown } from './bed';
import type { RehearsalContext } from './run';

/** The error a wait raises once the run's ceiling has passed. */
export class CeilingPassed extends Error {
  /**
   * @param minutes - The ceiling the run was given.
   */
  constructor(minutes: number) {
    super(`the ${minutes}-minute ceiling passed`);
    this.name = 'CeilingPassed';
  }
}

/**
 * A sleep that ends the run at its first wait past the ceiling.
 *
 * The phases' waits for provider and backend state go through the context's
 * sleep, so the phase that is running when the ceiling passes fails there and
 * the clean-up runs after it, once, rather than beside a phase that is still
 * writing. The bring-up and chat waits have bounds of their own.
 *
 * @param sleep - The real sleep.
 * @param now - The clock.
 * @param deadline - When the ceiling passes, in epoch milliseconds.
 * @param minutes - The ceiling, for the error.
 * @returns A sleep that never waits past the deadline and throws once it has passed.
 */
export function sleepUntilCeiling(
  sleep: (ms: number) => Promise<void>,
  now: () => number,
  deadline: number,
  minutes: number,
): (ms: number) => Promise<void> {
  return async (ms: number): Promise<void> => {
    const left = deadline - now();
    if (left <= 0) throw new CeilingPassed(minutes);
    await sleep(Math.min(ms, left));
  };
}

/**
 * Put the workspaces back, then take the bed down, whatever the run did.
 *
 * A failed teardown keeps the clone, whose `.env.local` the hand teardown
 * reads, and makes the exit code non-zero, so a bed left polling live
 * providers is never reported as a clean run.
 *
 * @param ctx - The run.
 * @param code - The exit code the phases earned.
 * @returns The exit code: non-zero when an undo step or the teardown failed.
 */
export async function finish(ctx: RehearsalContext, code: number): Promise<number> {
  const { record, out, log, state, options } = ctx;
  log(`cleanup: ${ctx.ledger.pending().length} undo step(s)`);
  record.cleanup = await ctx.ledger.runAll();
  for (const step of record.cleanup) {
    log(`  ${step.ok ? 'ok' : 'FAILED'} ${step.label}${step.error ? `: ${step.error}` : ''}`);
  }
  out.writeRecord(record);

  if (state.dashboard) {
    await state.dashboard.close().catch((error: unknown) => {
      log(`browser close: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  if (state.server) {
    await state.server.stop();
    out.appendLog(`--- next dev output ---\n${state.server.output()}`);
  }
  let tornDown = true;
  if (state.bed && !options.keep) {
    try {
      composeDown(ctx.runner, state.bed, true);
      log(`compose project ${state.bed.project} removed with its volumes`);
    } catch (error) {
      tornDown = false;
      log(`teardown: ${error instanceof Error ? error.message : String(error)}`);
      record.notes.push(
        `Teardown failed; the clone ${record.clone} is kept for its .env.local. Run: docker compose -p ${state.bed.project} down -v`,
      );
    }
    if (tornDown) rmSync(record.clone, { recursive: true, force: true });
  } else if (state.bed) {
    record.notes.push(
      `--keep: the stack ${state.bed.project} and the clone ${record.clone} are left up.`,
    );
  }
  out.writeRecord(record);
  log(`${record.status}; record at ${out.path}/summary.md`);
  return record.cleanup.some((step) => !step.ok) || !tornDown ? 1 : code;
}
