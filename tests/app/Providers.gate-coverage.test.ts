import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every page that reads the manager's own rows waits behind `SessionGate` (the second review's x2,
 * and the ruling that a new owned root must be wrapped). This walks `app/` from each route file
 * along the imports the page can render before the gate opens, and fails on any Convex data hook
 * it reaches that asks for a function other than the few that read no identity.
 */

const ROOT = resolve(__dirname, '../..');

/** The route files Next renders on its own: every one is a root the walk starts from. */
const ROUTE_FILES = new Set([
  'page.tsx',
  'layout.tsx',
  'template.tsx',
  'error.tsx',
  'global-error.tsx',
  'not-found.tsx',
  'loading.tsx',
  'default.tsx',
]);

/** The Convex hooks that ask the deployment for a function, by reference or through the client. */
const DATA_HOOKS = [
  'useQuery',
  'useQueries',
  'usePaginatedQuery',
  'useMutation',
  'useAction',
  'useConvex',
] as const;

/** Functions a page may ask for before the gate opens, each with why it reads no identity. */
const PUBLIC_FUNCTIONS: ReadonlyMap<string, string> = new Map([
  ['config.surfaceMode', "the deployment's mode, the same for every visitor"],
]);

/** Where the walk reads its files: the tree, or a test's own set. */
interface SourceTree {
  read(path: string): string | undefined;
  files(): readonly string[];
}

interface ImportEdge {
  readonly target: string;
  /** The names this file binds from the import; empty for a bare import, which runs it all. */
  readonly locals: readonly string[];
}

/** An owned hook reachable before a gate: the file and the function it asks for. */
interface Finding {
  readonly file: string;
  readonly functionRef: string;
  readonly via: readonly string[];
}

function resolveImport(tree: SourceTree, from: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const base = join(dirname(from), spec);
  const candidates = [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    join(base, 'index.tsx'),
    join(base, 'index.ts'),
  ];
  return candidates.find((candidate) => tree.read(candidate) !== undefined);
}

function localNames(clause: string): string[] {
  const names: string[] = [];
  const named = /\{([^}]*)\}/.exec(clause);
  if (named) {
    for (const part of named[1].split(',')) {
      const entry = part.trim();
      if (entry === '' || entry.startsWith('type ')) continue;
      const alias = /\bas\s+(\w+)$/.exec(entry);
      names.push(alias ? alias[1] : entry);
    }
  }
  const outside = clause.replace(/\{[^}]*\}/, '');
  const namespace = /\*\s+as\s+(\w+)/.exec(outside);
  if (namespace) names.push(namespace[1]);
  const fallback = /^\s*(\w+)\s*(?:,|$)/.exec(outside);
  if (fallback && fallback[1] !== 'type') names.push(fallback[1]);
  return names;
}

function importsOf(tree: SourceTree, file: string, text: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const add = (spec: string, locals: readonly string[]): void => {
    const target = resolveImport(tree, file, spec);
    if (target) edges.push({ target, locals });
  };
  for (const match of text.matchAll(/^import\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/gm)) {
    if (!match[1]) add(match[3], localNames(match[2]));
  }
  for (const match of text.matchAll(/^import\s+['"]([^'"]+)['"]/gm)) add(match[1], []);
  // A module handed on (`export { X } from`, `export * from`) is reached with its re-exporter.
  for (const match of text.matchAll(
    /^export\s+(type\s+)?(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/gm,
  )) {
    if (!match[1]) add(match[2], []);
  }
  const named = new Set<string>();
  for (const match of text.matchAll(
    /const\s+(\w+)\s*=\s*dynamic\(\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]\s*\)/g,
  )) {
    named.add(match[2]);
    add(match[2], [match[1]]);
  }
  // Any other `import()` (a `lazy`, a load on demand) reaches its module whatever renders it.
  for (const match of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!named.has(match[1])) add(match[1], []);
  }
  return edges;
}

/** The end of a JSX opening tag starting at `start`: the first `>` outside braces. */
function openingTagEnd(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    else if (char === '>' && depth === 0) return index;
  }
  return text.length;
}

/**
 * The file's text with each `SessionGate`'s children blanked, and the names used inside them:
 * what the page renders only once the gate opens. The fallback stays, since it renders first.
 */
function splitAtGates(text: string): { outside: string; gated: Set<string> } {
  const gated = new Set<string>();
  let outside = '';
  let cursor = 0;
  for (;;) {
    const open = text.indexOf('<SessionGate', cursor);
    if (open === -1) break;
    const bodyStart = openingTagEnd(text, open) + 1;
    const close = text.indexOf('</SessionGate>', bodyStart);
    if (close === -1) break;
    for (const name of text.slice(bodyStart, close).matchAll(/\b[A-Za-z_]\w*\b/g)) {
      gated.add(name[0]);
    }
    outside += text.slice(cursor, bodyStart);
    cursor = close;
  }
  return { outside: outside + text.slice(cursor), gated };
}

/**
 * Whether a module's binding is a leaf that renders nothing of its module's own and calls no
 * hook, so reaching it does not reach the rest of the module (a gate's fallback, such as
 * `EmployeeLoading`, lives beside the owned shell it stands in for).
 */
function isLeaf(text: string, name: string): boolean {
  const start = new RegExp(`^export function ${name}\\b`, 'm').exec(text);
  if (!start) return false;
  const end = text.indexOf('\n}\n', start.index);
  const body = text.slice(start.index, end === -1 ? undefined : end);
  return !/\buse[A-Z]\w*\(/.test(body) && !/<[A-Z]/.test(body);
}

function ownedRefsOf(text: string): string[] {
  const hooks = /import\s*\{([^}]*)\}\s*from\s*['"]convex\/react['"]/.exec(text)?.[1] ?? '';
  // A namespace import reaches every hook the module has.
  const everything = /import\s*\*\s*as\s+\w+\s+from\s*['"]convex\/react['"]/.test(text);
  const imported = DATA_HOOKS.filter((hook) => new RegExp(`\\b${hook}\\b`).test(hooks));
  if (imported.length === 0 && !everything) return [];
  const refs = [...text.matchAll(/\bapi\.(\w+)\.(\w+)/g)].map((match) => `${match[1]}.${match[2]}`);
  // A data hook with no function named in the file asks for one handed in: unknown, so owned.
  if (refs.length === 0) return ['<a function handed in>'];
  return [...new Set(refs)].filter((ref) => !PUBLIC_FUNCTIONS.has(ref));
}

/** Walk from every route file along ungated imports and report each owned hook reached. */
function ungatedOwnedHooks(tree: SourceTree): {
  findings: Finding[];
  gatedFiles: string[];
} {
  const findings: Finding[] = [];
  const gatedFiles = new Set<string>();
  const seen = new Set<string>();
  const routes = tree
    .files()
    .filter((file) => ROUTE_FILES.has(file.split('/').at(-1) ?? '') && !file.includes('/api/'));
  // A layout that renders its `children` behind the gate holds every route file below it, which
  // Next renders inside that layout (its error boundary included).
  const heldBelow = routes
    .filter((file) => file.endsWith('/layout.tsx'))
    .filter((file) => splitAtGates(tree.read(file) ?? '').gated.has('children'))
    .map((file) => `${dirname(file)}/`);
  const queue: Array<{ file: string; via: readonly string[] }> = routes
    .filter(
      (file) =>
        !heldBelow.some((directory) => file.startsWith(directory) && !file.endsWith('/layout.tsx')),
    )
    .map((file) => ({ file, via: [] }));
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || seen.has(next.file)) continue;
    seen.add(next.file);
    const text = tree.read(next.file) ?? '';
    for (const functionRef of ownedRefsOf(text)) {
      findings.push({ file: next.file, functionRef, via: next.via });
    }
    const { outside, gated } = splitAtGates(text);
    if (gated.size > 0) gatedFiles.add(next.file);
    const body = outside.replace(/^import\s[^;]*;$/gm, '');
    for (const edge of importsOf(tree, next.file, text)) {
      const reached = edge.locals.filter((name) => new RegExp(`\\b${name}\\b`).test(body));
      if (edge.locals.length > 0 && reached.length === 0) continue;
      const targetText = tree.read(edge.target) ?? '';
      if (reached.length > 0 && reached.every((name) => isLeaf(targetText, name))) continue;
      queue.push({ file: edge.target, via: [...next.via, next.file] });
    }
  }
  return { findings, gatedFiles: [...gatedFiles].sort() };
}

function appTree(): SourceTree {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) files.push(relative(ROOT, full));
    }
  };
  walk(join(ROOT, 'app'));
  return {
    files: () => files,
    read: (path) => {
      const full = join(ROOT, path);
      return existsSync(full) && statSync(full).isFile() ? readFileSync(full, 'utf8') : undefined;
    },
  };
}

function memoryTree(files: Record<string, string>): SourceTree {
  return { files: () => Object.keys(files), read: (path) => files[path] };
}

describe('the owned pages behind the session gate', (): void => {
  it('reaches no owned Convex hook from any route before its gate opens', (): void => {
    const { findings, gatedFiles } = ungatedOwnedHooks(appTree());
    expect(findings).toEqual([]);
    // The walk saw the three owned roots, so an empty list is not a walk that found nothing.
    expect(gatedFiles).toEqual([
      'app/agent/[agentId]/layout.tsx',
      'app/documentation/page.tsx',
      'app/page.tsx',
    ]);
  });

  it('finds an owned hook on a route with no gate, however it is imported, and not one behind a gate, below a gated layout or in a fallback leaf', (): void => {
    const shell = [
      "import { useQuery } from 'convex/react';",
      "import { api } from '@convex/_generated/api';",
      'export function Loading() {',
      '  return <p>loading</p>;',
      '}',
      'export function Shell() {',
      '  const row = useQuery(api.agents.get, {});',
      '  return <p>{row}</p>;',
      '}',
      '',
    ].join('\n');
    const tree = memoryTree({
      'app/shell.tsx': shell,
      'app/open/page.tsx': [
        "import { Shell } from '../shell';",
        'export default function Page() {',
        '  return <Shell />;',
        '}',
        '',
      ].join('\n'),
      'app/held/page.tsx': [
        "import { SessionGate } from '../gate';",
        "import { Loading, Shell } from '../shell';",
        'export default function Page() {',
        '  return (',
        '    <SessionGate fallback={<Loading />}>',
        '      <Shell />',
        '    </SessionGate>',
        '  );',
        '}',
        '',
      ].join('\n'),
      'app/gate.tsx': 'export function SessionGate() {\n  return null;\n}\n',
      'app/many.tsx': [
        "import { useQueries } from 'convex/react';",
        "import { api } from '@convex/_generated/api';",
        'export function Many() {',
        '  return useQueries({ a: { query: api.work.needsYou, args: {} } });',
        '}',
        '',
      ].join('\n'),
      'app/every.tsx': [
        "import * as convex from 'convex/react';",
        "import { api } from '@convex/_generated/api';",
        'export function Every() {',
        '  return convex.useQuery(api.metrics.forOwner, {});',
        '}',
        '',
      ].join('\n'),
      'app/handed-on.ts': "export { Many } from './many';\n",
      'app/queries/page.tsx': [
        "import { Many } from '../handed-on';",
        "import { Every } from '../every';",
        'export default function Page() {',
        '  return (<><Many /><Every /></>);',
        '}',
        '',
      ].join('\n'),
      'app/room/layout.tsx': [
        "import { SessionGate } from '../gate';",
        'export default function Layout({ children }) {',
        '  return <SessionGate fallback={null}>{children}</SessionGate>;',
        '}',
        '',
      ].join('\n'),
      'app/room/tab/page.tsx': [
        "import { Shell } from '../../shell';",
        'export default function Page() {',
        '  return <Shell />;',
        '}',
        '',
      ].join('\n'),
    });
    const { findings, gatedFiles } = ungatedOwnedHooks(tree);
    expect(findings).toEqual(
      expect.arrayContaining([
        { file: 'app/shell.tsx', functionRef: 'agents.get', via: ['app/open/page.tsx'] },
        {
          file: 'app/many.tsx',
          functionRef: 'work.needsYou',
          via: ['app/queries/page.tsx', 'app/handed-on.ts'],
        },
        { file: 'app/every.tsx', functionRef: 'metrics.forOwner', via: ['app/queries/page.tsx'] },
      ]),
    );
    expect(findings).toHaveLength(3);
    expect(gatedFiles).toEqual(['app/held/page.tsx', 'app/room/layout.tsx']);
  });
});
