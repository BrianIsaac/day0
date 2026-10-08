import { describe, expect, it } from 'vitest';
import { allConvexModules } from './all-modules';

/**
 * The count of public functions the anonymous-caller sweep reads (W12-R26, W13-R49). The sweep's
 * own floor (`tests/convex/anonymous-caller.test.ts`, more than 150) would pass if a refactor
 * stopped it reading half the modules; the sweep stays as it is and the count is pinned here,
 * read the way the sweep reads it: every export Convex registered as public in every module the
 * generated `api` names (`schema` and `auth.config` are configuration).
 *
 * The rule: a commit that adds a public function raises this pin by one, and one that removes a
 * function lowers it, so the diff says the sweep reads it. A change in the count with no function
 * added or removed means the sweep's reading changed: find out why before re-pinning.
 */

/** What Convex sets on a function a module exports, as the sweep reads it. */
interface RegisteredFunction {
  readonly isPublic?: boolean;
  readonly exportArgs?: () => string;
}

/** Re-pinned with the function added or removed named in the commit (207 at v0.17.0). */
const PINNED_COUNT = 207;

const CONFIGURATION_MODULES = new Set(['schema', 'auth.config']);

/** Every public query, mutation and action, as `module:export`, in path order. */
async function publicFunctionPaths(): Promise<string[]> {
  const paths: string[] = [];
  for (const [file, load] of Object.entries(allConvexModules())) {
    const name = /\/convex\/(.+)\.ts$/.exec(file)?.[1];
    if (name === undefined || name.startsWith('_generated/') || CONFIGURATION_MODULES.has(name)) {
      continue;
    }
    const exports = (await load()) as Record<string, RegisteredFunction | undefined>;
    for (const [exported, registered] of Object.entries(exports)) {
      if (registered?.isPublic === true && registered.exportArgs !== undefined) {
        paths.push(`${name}:${exported}`);
      }
    }
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

describe('the public functions the anonymous-caller sweep reads', (): void => {
  it('are exactly as many as the tree registers: a new one raises this pin in its own commit', async (): Promise<void> => {
    expect((await publicFunctionPaths()).length).toBe(PINNED_COUNT);
  });
});
