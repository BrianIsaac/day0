import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** The repository root, which every path this module takes and returns is relative to. */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The extensions a relative specifier may leave off, in the order the bundlers try them. */
const CANDIDATES = ['.ts', '.tsx', '/index.ts', '/index.tsx'] as const;

/**
 * Whether an import statement is erased at build time: `import type`, or named imports that are
 * every one `type`. An erased import never runs, so it cannot close a runtime cycle.
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
 * The relative specifiers a module's text imports at runtime, in source order: a package or an
 * alias is not a module of this tree's graph, and a type-only import or re-export is erased.
 *
 * @param text - The module's source.
 * @param file - Its name, for the parser's choice of syntax (`.tsx` reads JSX).
 */
export function runtimeSpecifiers(text: string, file = 'module.ts'): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
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
    if (specifier.text.startsWith('.')) found.push(specifier.text);
  }
  return found;
}

/**
 * The project files one module imports at runtime, each resolved as the bundlers resolve a
 * relative specifier; one that names no file of the tree is left out.
 *
 * @param file - An absolute path to a `.ts` or `.tsx` module.
 */
function runtimeImports(file: string): string[] {
  const found: string[] = [];
  for (const specifier of runtimeSpecifiers(readFileSync(file, 'utf8'), file)) {
    const base = resolve(dirname(file), specifier);
    const target = CANDIDATES.map((suffix) => `${base}${suffix}`).find((path) => existsSync(path));
    if (target !== undefined) found.push(target);
  }
  return found;
}

/**
 * The cycles of a module graph: its strongly connected components of more than one module, and
 * any module that imports itself, each sorted by name and the list sorted by its first name, so
 * a failure reads the same on every run. Tarjan's walk, iterative so a deep chain cannot
 * overflow the stack.
 *
 * @param graph - Each module with the modules it imports; an import of a module the graph does
 *   not hold is no edge.
 */
export function importCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const edgesOf = (module: string): readonly string[] =>
    (graph.get(module) ?? []).filter((next) => graph.has(next));

  for (const root of graph.keys()) {
    if (order.has(root)) continue;
    const walk: { readonly module: string; next: number }[] = [{ module: root, next: 0 }];
    order.set(root, order.size);
    low.set(root, order.get(root)!);
    stack.push(root);
    onStack.add(root);
    for (let frame = walk.at(-1); frame !== undefined; frame = walk.at(-1)) {
      const edges = edgesOf(frame.module);
      const target = edges[frame.next];
      if (target !== undefined) {
        frame.next += 1;
        if (!order.has(target)) {
          order.set(target, order.size);
          low.set(target, order.get(target)!);
          stack.push(target);
          onStack.add(target);
          walk.push({ module: target, next: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.module, Math.min(low.get(frame.module)!, order.get(target)!));
        }
        continue;
      }
      walk.pop();
      const parent = walk.at(-1);
      if (parent !== undefined)
        low.set(parent.module, Math.min(low.get(parent.module)!, low.get(frame.module)!));
      if (low.get(frame.module) !== order.get(frame.module)) continue;
      const component: string[] = [];
      for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
        onStack.delete(member);
        component.push(member);
        if (member === frame.module) break;
      }
      if (component.length > 1 || edges.includes(frame.module)) cycles.push(component.sort());
    }
  }
  return cycles.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

/**
 * The runtime import graph among the Convex modules: every `convex/*.ts` by its module name
 * (`work`, `planApproval`) with the sibling modules it imports a value from. The generated files
 * sit in their own directory and are no node of it, and neither is anything under `src/`, which
 * `convex/` only ever imports downwards (the standard's 10.1).
 */
export function convexRuntimeImports(): Map<string, string[]> {
  const convex = join(ROOT, 'convex');
  const files = readdirSync(convex).filter(
    (file) => file.endsWith('.ts') && !file.endsWith('.d.ts'),
  );
  return new Map(
    files.map((file): [string, string[]] => [
      basename(file, '.ts'),
      runtimeImports(join(convex, file))
        .filter((target) => dirname(target) === convex)
        .map((target) => basename(target, '.ts')),
    ]),
  );
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
