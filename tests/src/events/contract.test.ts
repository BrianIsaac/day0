import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, isEventOf, isEventType } from '../../../src/events/contract';

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** The two writers every event goes through (`convex/eventLog.ts`). */
const WRITERS = new Set(['appendEvent', 'logEvent']);

/** The module that defines the writers: its own insert forwards a type rather than writes one. */
const WRITER_MODULE = join(ROOT, 'convex', 'eventLog.ts');

/** Every TypeScript source under one directory of the tree, generated code left out. */
function sourceFiles(directory: string): string[] {
  return readdirSync(join(ROOT, directory), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !path.includes(join('convex', '_generated')));
}

/** The string literals a type is made of, or undefined when it is not made of literals only. */
function literalMembers(type: ts.Type): string[] | undefined {
  const members = type.isUnion() ? type.types : [type];
  const literals = members.flatMap((member) => (member.isStringLiteral() ? [member.value] : []));
  return literals.length === members.length ? literals : undefined;
}

/**
 * Every event type the tree writes, read by the type checker from the `type`
 * of each writer call's event: a literal, a constant, a ternary and a value
 * narrowed by a switch all resolve to the literals they can be. A call whose
 * type is a plain string, or every type at once, is reported unresolved.
 */
function writtenEventTypes(): { types: Set<string>; unresolved: string[] } {
  const files = [...sourceFiles('convex'), ...sourceFiles('src')];
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    resolveJsonModule: true,
    jsx: ts.JsxEmit.ReactJSX,
  });
  const checker = program.getTypeChecker();
  const types = new Set<string>();
  const unresolved: string[] = [];
  const read = new Set(files.filter((file) => file !== WRITER_MODULE));
  for (const source of program.getSourceFiles()) {
    if (!read.has(source.fileName)) continue;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        WRITERS.has(node.expression.text) &&
        node.arguments.length === 2
      ) {
        const eventType = checker.getTypeAtLocation(node.arguments[1]).getProperty('type');
        const literals = eventType
          ? literalMembers(checker.getTypeOfSymbolAtLocation(eventType, node.arguments[1]))
          : undefined;
        if (literals === undefined || literals.length === EVENT_TYPES.length) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          unresolved.push(`${relative(ROOT, source.fileName)}:${line + 1}`);
        } else {
          for (const literal of literals) types.add(literal);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { types, unresolved };
}

describe('the event contract (decisions N10 and Q14)', (): void => {
  it('lists every type once', (): void => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });

  it('tells a listed type from anything else, an older release’s type included', (): void => {
    expect(isEventType('work.completed')).toBe(true);
    expect(isEventType('work.not-a-type')).toBe(false);
    expect(isEventType(42)).toBe(false);
  });

  it('narrows a stored row to the payload of the type it carries', (): void => {
    const row = { type: 'agent.zone-changed', payload: { from: 'UTC', to: 'Asia/Singapore' } };
    expect(isEventOf(row, 'agent.zone-changed') ? row.payload.to : undefined).toBe(
      'Asia/Singapore',
    );
    expect(isEventOf(row, 'agent.autonomy-changed')).toBe(false);
  });

  it('lists exactly the types the tree writes, each resolved from its writer call', (): void => {
    const { types, unresolved } = writtenEventTypes();
    expect(unresolved).toEqual([]);
    expect(EVENT_TYPES.filter((type) => !types.has(type))).toEqual([]);
    expect([...types].filter((type) => !isEventType(type))).toEqual([]);
  }, 120_000);

  it('leaves the two writers the only code that inserts into events', (): void => {
    const direct = [...sourceFiles('convex'), ...sourceFiles('src')]
      .filter((path) => path !== WRITER_MODULE)
      .filter((path) =>
        /\.insert\(\s*['"]events['"]|internal\.eventLog\.log\b/.test(readFileSync(path, 'utf8')),
      )
      .map((path) => relative(ROOT, path));
    expect(direct).toEqual([]);
  });

  it('reads events by type only through eventsOfType, so a type is always one the contract lists', (): void => {
    const direct = [...sourceFiles('convex'), ...sourceFiles('src')]
      .filter((path) => path !== WRITER_MODULE)
      .filter((path) => /withIndex\(\s*['"]by_agent_type['"]/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path));
    expect(direct).toEqual([]);
  });
});
