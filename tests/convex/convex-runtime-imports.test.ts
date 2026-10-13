import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What a Convex module without `'use node'` reaches through `src/` (16-D's bed finding): such a
 * module is bundled for Convex's own runtime, so nothing it imports, however far down, may import
 * a Node built-in or Mastra (which imports them). `tests/convex/use-node-boundary.test.ts` holds
 * the direct imports between `convex/` modules; this follows every value import into `src/` too.
 * The 16-D bed's push refused `convex/reorientationTalk.ts`, which reached Mastra through
 * `src/agent/charter.ts`: the store had imported the charter's quote guard. convex-test runs in
 * a runtime where the built-ins resolve, so only a push showed it.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONVEX = join(ROOT, 'convex');

/** The Node built-ins, as an import names them, with and without the `node:` scheme. */
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

/** The specifiers a file imports or re-exports a value from: a type-only import is erased. */
function valueImports(text: string): string[] {
  const statements = text.matchAll(
    /^(?:import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm,
  );
  return [...statements].filter((match) => match[1] === undefined).map((match) => match[2]!);
}

/** The file a relative specifier names, as TypeScript resolves it, or undefined. */
function resolved(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  return [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find(
    (file) => existsSync(file) && file.match(/\.tsx?$/) !== null,
  );
}

/**
 * The first import chain from `entry` that ends in a Node built-in or Mastra, or undefined when
 * there is none. Only relative imports are followed: a package is read by its name alone.
 */
function nodeOnlyChain(entry: string): string[] | undefined {
  const seen = new Set<string>();
  const walk = (file: string, chain: readonly string[]): string[] | undefined => {
    if (seen.has(file)) return undefined;
    seen.add(file);
    for (const specifier of valueImports(readFileSync(file, 'utf8'))) {
      if (BUILTINS.has(specifier) || specifier.startsWith('@mastra/')) {
        return [...chain, specifier];
      }
      // Generated code and the other Convex modules are the direct-import test's.
      if (!specifier.startsWith('.') || specifier.includes('_generated')) continue;
      const next = resolved(file, specifier);
      if (next === undefined || dirname(next) === CONVEX) continue;
      const found = walk(next, [...chain, relative(ROOT, next)]);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(entry, [relative(ROOT, entry)]);
}

/** Every Convex module without `'use node'`, by file. */
function convexRuntimeModules(): string[] {
  return readdirSync(CONVEX)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .map((file) => join(CONVEX, file))
    .filter((file) => !/^\s*['"]use node['"];/.test(readFileSync(file, 'utf8')));
}

describe('what a Convex module without use node reaches through src/', (): void => {
  it('reads a chain into Mastra as one, and a type-only import as none', (): void => {
    expect(valueImports("import { agentJson } from '../lib/mastra';")).toEqual(['../lib/mastra']);
    expect(valueImports("import type { Charter } from './charter';")).toEqual([]);
    expect(valueImports("export { x } from './y';\nimport z from 'node:fs';")).toEqual([
      './y',
      'node:fs',
    ]);
  });

  it('never reaches a Node built-in or Mastra, however far down', (): void => {
    const reached = convexRuntimeModules().flatMap((file) => {
      const chain = nodeOnlyChain(file);
      return chain === undefined ? [] : [chain.join(' -> ')];
    });
    expect(reached).toEqual([]);
  });
});
