import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

/** The repository root, which every path this module takes and returns is relative to. */
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../..');

/** The extensions a relative specifier may leave off, in the order the bundlers try them. */
const CANDIDATES = ['.ts', '.tsx', '/index.ts', '/index.tsx'] as const;

/**
 * Whether an import statement is erased at build time: `import type`, or named imports that are
 * every one `type`. An erased import never runs, so it cannot close a runtime cycle.
 *
 * @param statement - An import declaration.
 */
function erased(statement: ts.ImportDeclaration): boolean {
  const clause = statement.importClause;
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  return (
    clause.name === undefined &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

/**
 * The project files one module imports at runtime: relative specifiers only (a package or an
 * alias is not a module of this tree's graph), type-only imports and re-exports left out.
 *
 * @param file - An absolute path to a `.ts` or `.tsx` module.
 */
function runtimeImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
  const found: string[] = [];
  for (const statement of source.statements) {
    const specifier = ts.isImportDeclaration(statement)
      ? erased(statement)
        ? undefined
        : statement.moduleSpecifier
      : ts.isExportDeclaration(statement) && !statement.isTypeOnly
        ? statement.moduleSpecifier
        : undefined;
    if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
    if (!specifier.text.startsWith('.')) continue;
    const base = resolve(dirname(file), specifier.text);
    const target = CANDIDATES.map((suffix) => `${base}${suffix}`).find((path) => existsSync(path));
    if (target !== undefined) found.push(target);
  }
  return found;
}

/**
 * The shortest chain of runtime imports that leads from a module back to itself, or null when
 * none does. A breadth-first walk of the module's runtime imports, as madge draws them, over
 * relative specifiers; each path is relative to the repository root.
 *
 * @param entry - The module, relative to the repository root (`convex/agents.ts`).
 */
export function runtimeCycleThrough(entry: string): readonly string[] | null {
  const start = resolve(ROOT, entry);
  const reached = new Set<string>([start]);
  const queue: (readonly string[])[] = [[start]];
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    const at = path[path.length - 1];
    if (at === undefined) continue;
    for (const next of runtimeImports(at)) {
      if (next === start) return [...path, next].map((file) => relative(ROOT, file));
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push([...path, next]);
    }
  }
  return null;
}
