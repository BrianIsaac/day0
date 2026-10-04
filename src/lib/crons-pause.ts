/**
 * The deployment switch that pauses every scheduled job.
 *
 * A deployment wired to real workspaces polls them for work, polls the
 * manager's replies and posts digests on its own schedule, so it cannot be
 * upgraded, restored or looked at without doing work unless those jobs can be
 * held. The switch is a deployment env value rather than a row because the
 * setup must be able to set it on whatever release is running before it
 * pushes the next one, and `npx convex env set` works on every release; a row
 * would need the running release to already know the table. Its value says
 * why, so the one line each skipped job logs is its own explanation.
 *
 * `pnpm sync:env` never touches it: it is state the setup's `pause`,
 * `unpause` and `upgrade` verbs own, not configuration `.env.local` carries.
 *
 * The work loop reads it too (wave 12, 12-P): no evaluation, draft, execution
 * or apply claims while it is set, so a step queued before the pause holds at
 * its claim rather than running to its end, and the stalled-step sweep queues
 * it again once the jobs run. A bed walked with the switch set therefore
 * moves no work: unpause before driving a run.
 */
export const CRONS_PAUSED_FLAG = 'DAY0_CRONS_PAUSED';

/**
 * Why this deployment's scheduled jobs are paused, or `undefined` while they run.
 *
 * Read at call time, not at import, so the next job after a change reads it;
 * the setup's verbs restart a self-hosted backend as well, because a module
 * there keeps the env it was first evaluated with.
 *
 * @param env - The deployment environment; the process's own by default.
 */
export function cronsPauseReason(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const reason = env[CRONS_PAUSED_FLAG]?.trim();
  return reason ? reason : undefined;
}
