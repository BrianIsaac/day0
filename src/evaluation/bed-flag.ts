/**
 * The deployment flag that lets the evaluation harness run.
 *
 * The harness and the baseline arm seed rows, approve stub charters and spend
 * model calls on the deployment owner's keys, so a deployment serves them
 * only when its environment names the evaluation bed it is (decision N9). The
 * hosted demo never sets it; a bed names itself in `.env.local`
 * (`DAY0_EVALUATION_BED=<bed name>`) and `pnpm sync:env` pushes it, and
 * removes it from a deployment whose file no longer names one.
 */
export const EVALUATION_BED_FLAG = 'DAY0_EVALUATION_BED';

/**
 * The bed this deployment names, or `undefined` when it names none.
 *
 * Read at call time, not at import, so a deployment's env change applies to
 * the next call without a push.
 *
 * @param env - The deployment environment; the process's own by default.
 */
export function evaluationBedName(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const name = env[EVALUATION_BED_FLAG]?.trim();
  return name ? name : undefined;
}

/**
 * The refusal a harness caller reads when the deployment is not a bed.
 *
 * @param what - The harness function refused, as the caller named it.
 */
export function evaluationBedRefusal(what: string): string {
  return (
    `${what} runs only on an evaluation bed: this deployment does not set ${EVALUATION_BED_FLAG}. ` +
    `On a bed, set ${EVALUATION_BED_FLAG}=<bed name> in .env.local and run \`pnpm sync:env\` first.`
  );
}

/**
 * Stop a harness script before its first write when the deployment it drives
 * names no bed, rather than at whichever mutation is gated first.
 *
 * @param bed - The bed the deployment reports (`config.modelSettings`), or null.
 * @param what - The command refused, as its user typed it.
 * @throws Error carrying the refusal when the deployment names no bed.
 */
export function refuseUnlessBed(bed: string | null, what: string): void {
  if (bed === null) throw new Error(evaluationBedRefusal(what));
}
