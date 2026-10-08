import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The standard's 1.5: a Convex module without `'use node'` runs in Convex's own runtime and is
 * bundled for it, so it must not import a `'use node'` module, which may pull Node's built-ins
 * (Mastra's `crypto`, `node:async_hooks`) into that bundle and fail the push. The wave 14 joins
 * bed met it: `documentationWindows.ts` imported `skillAuthorPrompt.ts` and the upgrade's
 * `convex dev --once` refused every Node built-in Mastra reaches.
 */

const CONVEX = new URL('../../convex/', import.meta.url);

/** The module names in `convex/`, each with whether it declares `'use node'`. */
function modules(): Map<string, boolean> {
  return new Map(
    readdirSync(CONVEX)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
      .map((file): [string, boolean] => [
        file.slice(0, -'.ts'.length),
        /^\s*['"]use node['"];/.test(readFileSync(new URL(file, CONVEX), 'utf8')),
      ]),
  );
}

/** The sibling modules a file imports a value or a type from, by name. */
function siblingImports(file: string): string[] {
  const text = readFileSync(new URL(`${file}.ts`, CONVEX), 'utf8');
  return [...text.matchAll(/from '\.\/([A-Za-z0-9_]+)'/g)].map((match) => match[1]!);
}

describe("the 'use node' boundary in convex/ (the standard's 1.5)", (): void => {
  it("imports no 'use node' module from a module without the directive", (): void => {
    const all = modules();
    const crossings = [...all]
      .filter(([, node]) => !node)
      .flatMap(([file]) =>
        siblingImports(file)
          .filter((imported) => all.get(imported) === true)
          .map((imported) => `${file} imports ${imported}`),
      );
    expect(crossings).toEqual([]);
  });
});
