import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** The repository root, which every path this module takes is relative to. */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The builders a Convex module registers a function with. */
const REGISTRARS = new Set([
  'query',
  'mutation',
  'action',
  'internalQuery',
  'internalMutation',
  'internalAction',
]);

/** The module a guard is imported from: the ownership guards of the standard's 10.4. */
const GUARD_MODULE = './ownership';

/** The names a module imports from the guards' module. */
function guardsOf(source: ts.SourceFile): Set<string> {
  const guards = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier) || specifier.text !== GUARD_MODULE) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) guards.add(element.name.text);
  }
  return guards;
}

/** An expression with its `await` and parentheses taken off. */
function unwrapped(expression: ts.Expression): ts.Expression {
  let inner = expression;
  while (ts.isAwaitExpression(inner) || ts.isParenthesizedExpression(inner)) {
    inner = inner.expression;
  }
  return inner;
}

/** Whether an expression is a call of one of the module's guards. */
function isGuardCall(expression: ts.Expression, guards: ReadonlySet<string>): boolean {
  const inner = unwrapped(expression);
  return (
    ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && guards.has(inner.expression.text)
  );
}

/** Whether a statement is a guard alone: `await guard(...)` or `const row = await guard(...)`. */
function isGuardStatement(statement: ts.Statement, guards: ReadonlySet<string>): boolean {
  if (ts.isExpressionStatement(statement)) return isGuardCall(statement.expression, guards);
  if (!ts.isVariableStatement(statement)) return false;
  const [declaration, ...rest] = statement.declarationList.declarations;
  return (
    rest.length === 0 &&
    declaration?.initializer !== undefined &&
    isGuardCall(declaration.initializer, guards)
  );
}

/** Whether a call reads the clock, which an argument may do: `Date.now()`. */
function isClockRead(call: ts.CallExpression): boolean {
  return call.expression.getText() === 'Date.now' && call.arguments.length === 0;
}

/**
 * Whether an expression is one call of a named helper, or of a guard alone, whose arguments call
 * nothing but a guard or the clock: `await helperInTransaction(ctx, row, args)`.
 */
function isOneCall(expression: ts.Expression, guards: ReadonlySet<string>): boolean {
  const inner = unwrapped(expression);
  if (!ts.isCallExpression(inner) || !ts.isIdentifier(inner.expression)) return false;
  let further = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && !isGuardCall(node, guards) && !isClockRead(node)) {
      further = true;
    }
    ts.forEachChild(node, visit);
  };
  for (const argument of inner.arguments) visit(argument);
  return !further;
}

/** Whether a handler is guards, then one call: the standard's 9.3. */
function isThin(handler: ts.Expression, guards: ReadonlySet<string>): boolean {
  if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) return false;
  const body = handler.body;
  if (!ts.isBlock(body)) return isOneCall(body, guards);
  const statements = body.statements;
  const last = statements[statements.length - 1];
  if (last === undefined) return false;
  if (!statements.slice(0, -1).every((statement) => isGuardStatement(statement, guards))) {
    return false;
  }
  if (ts.isReturnStatement(last)) {
    return last.expression !== undefined && isOneCall(last.expression, guards);
  }
  return ts.isExpressionStatement(last) && isOneCall(last.expression, guards);
}

/** A registered function's configuration: the object its builder is called with, or undefined. */
function registrationOf(declaration: ts.VariableDeclaration): ts.ObjectLiteralExpression | undefined {
  const initializer = declaration.initializer;
  if (initializer === undefined || !ts.isCallExpression(initializer)) return undefined;
  if (!ts.isIdentifier(initializer.expression)) return undefined;
  if (!REGISTRARS.has(initializer.expression.text)) return undefined;
  const [config] = initializer.arguments;
  return config !== undefined && ts.isObjectLiteralExpression(config) ? config : undefined;
}

/** A property of a registration's configuration by name. */
function propertyOf(config: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of config.properties) {
    if (ts.isPropertyAssignment(property) && property.name.getText() === name) {
      return property.initializer;
    }
  }
  return undefined;
}

/**
 * The registered functions of a module's text that are more than a validator, a guard and one
 * call (the standard's 9.3), sorted by name. A function with no `args` validator, or whose handler
 * holds anything but the module's ownership guards and one call of a helper, is one of them.
 *
 * @param text - The module's source.
 */
export function thickHandlersIn(text: string): string[] {
  const source = ts.createSourceFile('module.ts', text, ts.ScriptTarget.Latest, true);
  const guards = guardsOf(source);
  const thick: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const config = registrationOf(declaration);
      if (config === undefined || !ts.isIdentifier(declaration.name)) continue;
      const handler = propertyOf(config, 'handler');
      const thin =
        propertyOf(config, 'args') !== undefined && handler !== undefined && isThin(handler, guards);
      if (!thin) thick.push(declaration.name.text);
    }
  }
  return thick.sort((left, right) => left.localeCompare(right));
}

/**
 * The registered functions of a Convex module that are more than a validator, a guard and one
 * call, sorted by name.
 *
 * @param path - The module's path from the repository root, `convex/work.ts`.
 */
export function thickHandlers(path: string): string[] {
  return thickHandlersIn(readFileSync(join(ROOT, path), 'utf8'));
}
