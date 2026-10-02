/**
 * The generated code a push rewrites (wave 11, 11-AI's finding 7): `npx convex dev --once`, like
 * `npx convex deploy`, regenerates `convex/_generated`, which the checkout tracks as its release
 * has it. The cloud verb puts it back after its deploy (`scripts/cloud/deployment.ts`); the local
 * verbs do the same here, so an installation's checkout is left as it was cloned and a later
 * `git pull` meets no change of Day0's own making.
 */

/** The tree Convex's codegen writes. */
export const GENERATED_CODE_PATH = 'convex/_generated';

/** The one command this needs: git, run in the checkout. */
export interface GitRunner {
  run(
    command: string,
    args: readonly string[],
  ): { readonly status: number | null; readonly stdout?: string; readonly stderr: string };
}

/**
 * What the checkout held at the generated code before a push: nothing changed, its own changes,
 * or unknown (not a git checkout, or git could not say).
 */
export type GeneratedCodeState = 'clean' | 'changed' | 'unknown';

/**
 * Read what the checkout holds at the generated code, before a push rewrites it.
 *
 * @param io - Where git runs.
 */
export function generatedCodeState(io: GitRunner): GeneratedCodeState {
  const status = io.run('git', ['status', '--porcelain', '--', GENERATED_CODE_PATH]);
  if (status.status !== 0 || status.stdout === undefined) return 'unknown';
  return status.stdout.trim() === '' ? 'clean' : 'changed';
}

/**
 * Put the generated code back as the checkout holds it, after a push rewrote it, only where it
 * held no change before: a developer's own regenerated files are never thrown away.
 *
 * @param io - Where git runs.
 * @param before - What {@link generatedCodeState} read before the push.
 * @returns The line the verb prints.
 */
export function restoreGeneratedCode(io: GitRunner, before: GeneratedCodeState): string {
  switch (before) {
    case 'clean': {
      const restored = io.run('git', ['checkout', '--', GENERATED_CODE_PATH]);
      if (restored.status === 0) return `${GENERATED_CODE_PATH} put back as this checkout has it.`;
      const why = restored.stderr.trim().split('\n')[0] || `exit ${restored.status ?? 'unknown'}`;
      return (
        `${GENERATED_CODE_PATH} could not be put back (${why}): run ` +
        `\`git checkout -- ${GENERATED_CODE_PATH}\` before building.`
      );
    }
    case 'changed':
      return `${GENERATED_CODE_PATH} held changes before the push, so it is left as the push wrote it.`;
    case 'unknown':
      return `${GENERATED_CODE_PATH} is left as the push wrote it: git cannot say what this checkout holds.`;
    default: {
      const unknown: never = before;
      throw new Error(`unhandled generated-code state ${String(unknown)}`);
    }
  }
}
