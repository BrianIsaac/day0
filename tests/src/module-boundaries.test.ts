import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
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

/** A source file with its block and line comments removed, so a path in prose is not an import or a read. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/**
 * The module specifiers a source file imports at runtime, static and dynamic.
 * A type-only import or re-export is erased by the bundler and is no edge.
 */
function importsOf(path: string): string[] {
  const source = withoutComments(readFileSync(join(root, path), 'utf8')).replace(
    /(?:import|export)\s+type\s[^;]*?from\s+['"][^'"]+['"]/g,
    '',
  );
  return [...source.matchAll(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
    (match) => (match[1] ?? match[2])!,
  );
}

/**
 * A `convex/` implementation module: anything under `convex/` other than the
 * generated `api`, `dataModel` and `server` files, through the alias or a
 * relative path. The `convex` package itself (`convex/react`, `convex/values`)
 * is a dependency, not the directory.
 */
function isConvexImplementation(fromPath: string, specifier: string): boolean {
  const target = resolveImport(fromPath, specifier);
  return (
    target !== undefined && target.startsWith('convex/') && !target.startsWith('convex/_generated/')
  );
}

describe('layer direction (standard 1.3 and 10.1)', (): void => {
  it('no module under app/ or src/ imports a convex/ implementation module', (): void => {
    const offenders: string[] = [];
    for (const path of [...modulesUnder('app'), ...modulesUnder('src')]) {
      for (const specifier of importsOf(path)) {
        if (isConvexImplementation(path, specifier)) offenders.push(`${path} -> ${specifier}`);
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

/**
 * Resolve one import specifier to a repository-relative module path, or
 * undefined for a package. The aliases, a relative path and, because
 * `tsconfig.json` sets `baseUrl`, a bare `convex/<module>` all resolve; the
 * result is normalised so `@convex/_generated/../work` is `convex/work`.
 */
function resolveImport(fromPath: string, specifier: string): string | undefined {
  let base: string;
  if (specifier.startsWith('@/')) base = join(root, 'src', specifier.slice(2));
  else if (specifier.startsWith('@convex/')) base = join(root, 'convex', specifier.slice(8));
  else if (specifier.startsWith('.')) base = resolve(join(root, dirname(fromPath)), specifier);
  else if (
    /^(?:convex|src|app)\//.test(specifier) &&
    existsSync(join(root, specifier.split('/')[0]!))
  )
    base = join(root, specifier);
  else return undefined;
  base = normalize(base);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return relative(root, candidate);
  }
  return undefined;
}

/**
 * Every module reachable from a client component through the project's own
 * imports: what Next bundles for the browser, where a non-public variable
 * is an empty string.
 */
function reachableFromClientComponents(): Set<string> {
  const seen = new Set<string>();
  const queue = modulesUnder('app').filter((path) =>
    /^'use client';/m.test(readFileSync(join(root, path), 'utf8')),
  );
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    for (const specifier of importsOf(path)) {
      const target = resolveImport(path, specifier);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

/**
 * Non-public variables a client-reachable module may read, each with the
 * reason the read is safe in the browser bundle, where it is an empty string.
 */
const CLIENT_SAFE_ENV_READS: ReadonlyMap<string, readonly string[]> = new Map([
  // `NODE_ENV` is inlined by Next on both sides.
  ['*', ['NODE_ENV']],
  // The Vercel marker only tightens a check `NODE_ENV=development` already
  // decides, and Vercel never builds with that value; dev-auth.ts says so.
  ['src/lib/dev-auth.ts', ['VERCEL']],
  // A read by variable name inside a function only server actions call; in
  // the browser it reads nothing and returns undefined.
  ['src/surfaces/slack-endpoint.ts', ['[name]']],
  // The whole environment as a default parameter of two resolvers only
  // server code calls; in the browser the default is an empty object.
  ['src/lib/surface-mode.ts', ['*']],
]);

describe('server-only settings (standard 1.8)', (): void => {
  it('no module reachable from a client component reads a non-public variable the browser bundle would blank', (): void => {
    const offenders: string[] = [];
    const met = new Set<string>();
    for (const path of reachableFromClientComponents()) {
      const allowed = new Set([
        ...(CLIENT_SAFE_ENV_READS.get('*') ?? []),
        ...(CLIENT_SAFE_ENV_READS.get(path) ?? []),
      ]);
      const source = withoutComments(readFileSync(join(root, path), 'utf8'));
      // A dotted name, an indexed read (`process.env[name]`, reported as
      // `[name]`) or the whole object handed on (reported as `*`).
      for (const match of source.matchAll(
        /process\.env(?:\.([A-Z_][A-Z0-9_]*)|(\[)|(?![.[\w]))/g,
      )) {
        const name = match[1] ?? (match[2] ? '[name]' : '*');
        if (name.startsWith('NEXT_PUBLIC_')) continue;
        if (allowed.has(name)) {
          met.add(`${path}:${name}`);
          continue;
        }
        offenders.push(`${path} reads ${name}`);
      }
    }
    expect(offenders).toEqual([]);
    // Every allowlisted read is still there; an entry that outlives its read is removed.
    for (const [path, names] of CLIENT_SAFE_ENV_READS) {
      if (path === '*') continue;
      for (const name of names)
        expect(met, `${path} no longer reads ${name}`).toContain(`${path}:${name}`);
    }
  });
});
