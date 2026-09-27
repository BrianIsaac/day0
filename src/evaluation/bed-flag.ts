/**
 * The deployment flag that lets the evaluation harness run.
 *
 * The harness and the baseline arm seed rows, approve stub charters and spend
 * model calls on the deployment owner's keys, so a deployment serves them
 * only when its environment names the evaluation bed it is (decision N9). The
 * hosted demo never sets it; a bed sets it with
 * `npx convex env set DAY0_EVALUATION_BED <bed name>`.
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
    `On a bed, run \`npx convex env set ${EVALUATION_BED_FLAG} <bed name>\` first.`
  );
}
