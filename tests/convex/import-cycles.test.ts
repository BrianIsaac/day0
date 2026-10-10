import { describe, expect, it } from 'vitest';
import { convexRuntimeImports, importCycles, runtimeSpecifiers } from '../fixtures/import-graph';

/**
 * The standard's 10.2: no import cycle between modules, since a cycle makes each member's
 * initialisation depend on which of them is loaded first. The check is the wave 15 helpers
 * split's (its "Cycle check"), made a test: the relative value imports among `convex/*.ts`, read
 * off each module's syntax tree, with the generated files left out; a strongly connected
 * component of more than one module fails, naming its members.
 */

describe("a module's runtime imports", (): void => {
  it('leave out a type-only import or re-export, which the bundle erases', (): void => {
    expect(
      runtimeSpecifiers(
        [
          "import type { A } from './a';",
          "import { b, type C } from './b';",
          "import { type D, type E } from './d';",
          "import './effect';",
          "export { f } from './f';",
          "export type { G } from './g';",
          "export * from './h';",
          "import { v } from 'convex/values';",
        ].join('\n'),
      ),
    ).toEqual(['./b', './effect', './f', './h']);
  });
});

describe('the cycles of a module graph', (): void => {
  it('are its strongly connected components of more than one module, each named in full', (): void => {
    const graph = new Map<string, string[]>([
      ['floor', []],
      ['work', ['people', 'floor']],
      ['people', ['proposals']],
      ['proposals', ['reset']],
      ['reset', ['surfaces', 'sources']],
      ['sources', ['surfaces']],
      ['surfaces', ['work']],
      ['approval', ['work']],
      ['left', ['right']],
      ['right', ['left']],
    ]);
    expect(importCycles(graph)).toEqual([
      ['left', 'right'],
      ['people', 'proposals', 'reset', 'sources', 'surfaces', 'work'],
    ]);
  });

  it('count a module that imports itself and no chain that only runs one way', (): void => {
    expect(
      importCycles(
        new Map<string, string[]>([
          ['self', ['self']],
          ['top', ['middle']],
          ['middle', ['bottom', 'elsewhere']],
          ['bottom', []],
        ]),
      ),
    ).toEqual([['self']]);
  });
});

describe('the Convex modules', (): void => {
  it('are read as a graph that holds the work loop and what it stands on', (): void => {
    const graph = convexRuntimeImports();
    expect(graph.get('work')).toContain('workLoop');
    expect(graph.has('_generated')).toBe(false);
    expect([...graph.keys()].some((module) => module.endsWith('.d'))).toBe(false);
  });

  it('import one another in no cycle', (): void => {
    expect(importCycles(convexRuntimeImports())).toEqual([]);
  });
});
