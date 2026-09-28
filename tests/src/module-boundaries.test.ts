import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url).pathname;

/** Every TypeScript module under a directory, as paths relative to the repository root. */
function modulesUnder(directory: string): string[] {
  const found: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const child = join(path, entry);
      if (statSync(child).isDirectory()) {
        if (entry !== 'node_modules') walk(child);
      } else if (/\.tsx?$/.test(entry)) {
        found.push(relative(root, child));
      }
    }
  };
  walk(join(root, directory));
  return found.sort();
}

/** The module specifiers a source file imports, static and dynamic. */
function importsOf(path: string): string[] {
  const source = readFileSync(join(root, path), 'utf8');
  return [...source.matchAll(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
    (match) => match[1] ?? match[2],
  );
}

/**
 * A `convex/` implementation module: anything under `convex/` other than the
 * generated `api`, `dataModel` and `server` files, through the alias or a
 * relative path. The `convex` package itself (`convex/react`, `convex/values`)
 * is a dependency, not the directory.
 */
function isConvexImplementation(specifier: string): boolean {
  const viaAlias = /^@convex\/(.+)$/.exec(specifier)?.[1];
  const viaPath = /^(?:\.\.\/)+convex\/(.+)$/.exec(specifier)?.[1];
  const inside = viaAlias ?? viaPath;
  return inside !== undefined && !inside.startsWith('_generated/');
}

describe('layer direction (standard 1.3 and 10.1)', (): void => {
  it('no module under app/ or src/ imports a convex/ implementation module', (): void => {
    const offenders: string[] = [];
    for (const path of [...modulesUnder('app'), ...modulesUnder('src')]) {
      for (const specifier of importsOf(path)) {
        if (isConvexImplementation(specifier)) offenders.push(`${path} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no module outside app/ imports from app/', (): void => {
    const offenders: string[] = [];
    for (const path of [
      ...modulesUnder('src'),
      ...modulesUnder('convex'),
      ...modulesUnder('scripts'),
    ]) {
      for (const specifier of importsOf(path)) {
        if (/^(?:@\/\.\.\/|(?:\.\.\/)+)app\//.test(specifier))
          offenders.push(`${path} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
