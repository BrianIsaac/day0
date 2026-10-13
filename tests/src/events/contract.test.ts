import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AGENT_EVENT_TYPES,
  CONNECTION_EVENT_TYPES,
  EVENT_TYPES,
  isConnectionEventType,
  isEventOf,
  isEventType,
  type AmendmentVia,
  type CharterQuestionAnsweredPayload,
  type DecisionAcknowledgementKind,
  type DecisionNoticeKind,
  type DecisionQuestionNoticePayload,
  type EventPayloads,
  type PlanHeldForReorientation,
  type ReorientationCardNotOpenedPayload,
  type ReorientationNamed,
} from '../../../src/events/contract';
import type { Doc, Id } from '../../../convex/_generated/dataModel';
import type { ManagerQuestionType } from '../../../src/agent/manager-questions';

const ROOT = join(import.meta.dirname, '..', '..', '..');

/**
 * The writers every event goes through: an employee's two (`convex/eventLog.ts`) and the
 * organisation connections' ledger's one (`convex/connectionEvents.ts`, AC11).
 */
const WRITERS = new Set(['appendEvent', 'logEvent', 'appendConnectionEvent']);

/** The module that defines the employee's writers: its own insert forwards a type rather than writes one. */
const WRITER_MODULE = join(ROOT, 'convex', 'eventLog.ts');

/** The module that defines the ledger's writer, whose own insert forwards a type likewise. */
const CONNECTION_WRITER_MODULE = join(ROOT, 'convex', 'connectionEvents.ts');

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
function writtenEventTypes(): {
  types: Set<string>;
  byWriter: Map<string, Set<string>>;
  unresolved: string[];
} {
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
  const byWriter = new Map<string, Set<string>>([...WRITERS].map((writer) => [writer, new Set()]));
  const unresolved: string[] = [];
  const read = new Set(
    files.filter((file) => file !== WRITER_MODULE && file !== CONNECTION_WRITER_MODULE),
  );
  for (const source of program.getSourceFiles()) {
    if (!read.has(source.fileName)) continue;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        WRITERS.has(node.expression.text) &&
        // The event is the second argument; `logEvent` may take the action's fence third.
        node.arguments.length >= 2
      ) {
        const eventType = checker.getTypeAtLocation(node.arguments[1]).getProperty('type');
        const literals = eventType
          ? literalMembers(checker.getTypeOfSymbolAtLocation(eventType, node.arguments[1]))
          : undefined;
        if (literals === undefined || literals.length === EVENT_TYPES.length) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          unresolved.push(`${relative(ROOT, source.fileName)}:${line + 1}`);
        } else {
          for (const literal of literals) {
            types.add(literal);
            byWriter.get(node.expression.text)?.add(literal);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { types, byWriter, unresolved };
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

  it('writes the organisation connections’ types only to their ledger, and no employee’s type there (AC11)', (): void => {
    const { byWriter } = writtenEventTypes();
    const ledger = [...(byWriter.get('appendConnectionEvent') ?? [])];
    expect(ledger.sort()).toEqual([...CONNECTION_EVENT_TYPES].sort());
    for (const writer of ['appendEvent', 'logEvent']) {
      expect(
        [...(byWriter.get(writer) ?? [])].filter((type) => isConnectionEventType(type)),
        writer,
      ).toEqual([]);
    }
  }, 120_000);

  it('splits every type between an employee’s ledger and the organisation’s, in the contract’s order', (): void => {
    expect(AGENT_EVENT_TYPES.filter((type) => isConnectionEventType(type))).toEqual([]);
    expect(AGENT_EVENT_TYPES).toEqual(
      EVENT_TYPES.filter((type) => !(CONNECTION_EVENT_TYPES as readonly string[]).includes(type)),
    );
    expect(AGENT_EVENT_TYPES.length + CONNECTION_EVENT_TYPES.length).toBe(EVENT_TYPES.length);
  });

  it('leaves the ledger’s writer the only code that inserts into connectionEvents', (): void => {
    const direct = [...sourceFiles('convex'), ...sourceFiles('src')]
      .filter((path) => path !== CONNECTION_WRITER_MODULE)
      .filter((path) => /\.insert\(\s*['"]connectionEvents['"]/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path));
    expect(direct).toEqual([]);
  });

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

describe('the wave 16 types, declared by the schema step for 16-O (16-K)', (): void => {
  it('lists the six reorientation events and the typed question, each with its writer (16-O)', (): void => {
    for (const type of [
      'reorientation.opened',
      'reorientation.proposed',
      'reorientation.reopened',
      'reorientation.approved',
      'reorientation.dismissed',
      'reorientation.deferred',
      'manager.question-asked',
    ]) {
      expect(isEventType(type), type).toBe(true);
    }
  });

  it('types the seventh hold reason, the seven payloads, an amendment by reorientation and a charter answer by its two ways', (): void => {
    expectTypeOf<AmendmentVia>().toEqualTypeOf<'dashboard' | 'plan-approval' | 'reorientation'>();
    // A charter question is answered on the dashboard or with a plan approval; a reorientation
    // amends without one, and a Slack answer decides what its question is about (16-O).
    expectTypeOf<CharterQuestionAnsweredPayload['via']>().toEqualTypeOf<
      'dashboard' | 'plan-approval'
    >();
    expectTypeOf<PlanHeldForReorientation['reason']>().toEqualTypeOf<'reorientation-pending'>();
    expectTypeOf<PlanHeldForReorientation['reorientationId']>().toEqualTypeOf<
      Id<'reorientations'>
    >();
    expectTypeOf<
      EventPayloads['manager.question-asked']['type']
    >().toEqualTypeOf<ManagerQuestionType>();
    // A proposal an event records is never the pending one.
    expectTypeOf<'pending'>().not.toMatchTypeOf<EventPayloads['reorientation.proposed']['kind']>();
    expectTypeOf<'none'>().toMatchTypeOf<EventPayloads['reorientation.approved']['kind']>();
    expectTypeOf<EventPayloads['reorientation.dismissed']>().toEqualTypeOf<ReorientationNamed>();
  });
});

describe('the wave 17 types, declared by the schema step for 17-O and 17-C (17-K)', (): void => {
  it("types a notice's kind as the schema stores it, an acknowledgement as the three kinds that answer a reply, and a question notice by its question", (): void => {
    expectTypeOf<Doc<'managerDecisionNotices'>['kind']>().toEqualTypeOf<DecisionNoticeKind>();
    expectTypeOf<DecisionAcknowledgementKind>().toEqualTypeOf<
      'received' | 'unknown' | 'replaced'
    >();
    // Re-taken by 17-C, which joined the question's payload to the event as its second member
    // in the commit that queues, sends and renders the notice: the event names all four kinds.
    expectTypeOf<
      EventPayloads['work.decision-acknowledging']['kind']
    >().toEqualTypeOf<DecisionNoticeKind>();
    expectTypeOf<DecisionQuestionNoticePayload['kind']>().toEqualTypeOf<'question'>();
    expectTypeOf<DecisionQuestionNoticePayload['questionId']>().toEqualTypeOf<
      Id<'managerQuestions'>
    >();
    expectTypeOf<DecisionQuestionNoticePayload['questionId']>().toEqualTypeOf<
      NonNullable<Doc<'managerDecisionNotices'>['questionId']>
    >();
  });

  it('takes an owed agreement check as the trigger a card opened on (RM34 (a))', (): void => {
    expectTypeOf<'agreement-check-owed'>().toMatchTypeOf<
      EventPayloads['reorientation.opened']['trigger']
    >();
    expectTypeOf<EventPayloads['reorientation.opened']['trigger']>().toEqualTypeOf<
      Doc<'reorientations'>['trigger']
    >();
  });

  it('lists a card that could not be opened by its trigger and its key, naming no card (17-O writes it from the chain)', (): void => {
    expect(isEventType('reorientation.card-not-opened')).toBe(true);
    expectTypeOf<
      EventPayloads['reorientation.card-not-opened']
    >().toEqualTypeOf<ReorientationCardNotOpenedPayload>();
    expectTypeOf<ReorientationCardNotOpenedPayload['trigger']>().toEqualTypeOf<
      Doc<'reorientations'>['trigger']
    >();
    expectTypeOf<ReorientationCardNotOpenedPayload['triggerKey']>().toEqualTypeOf<string>();
    expectTypeOf<ReorientationCardNotOpenedPayload>().not.toHaveProperty('reorientationId');
  });
});
