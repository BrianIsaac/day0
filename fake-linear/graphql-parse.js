/**
 * A small GraphQL parser for the fake: operations with variables, fields with aliases, arguments
 * and nested selections. Enough for the queries Day0 and a bed send (`viewer`, `issueUpdate` and
 * kin); fragments and directives are refused, so a query that needs them fails loudly rather than
 * being answered wrongly. The fake runs on Node alone, with no package installed beside it.
 */

/** Why a document cannot be parsed, with GraphQL's own phrasing where it has one. */
export class GraphqlSyntaxError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'GraphqlSyntaxError';
  }
}

const PUNCTUATORS = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|']);

/**
 * @typedef {{ kind: 'punct' | 'name' | 'int' | 'float' | 'string' | 'spread', value: string }} Token
 */

/**
 * @param {string} source
 * @returns {Token[]}
 */
function tokenise(source) {
  /** @type {Token[]} */
  const tokens = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at] ?? '';
    if (/[\s,﻿]/.test(char)) {
      at += 1;
      continue;
    }
    if (char === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (source.startsWith('...', at)) {
      tokens.push({ kind: 'spread', value: '...' });
      at += 3;
      continue;
    }
    if (PUNCTUATORS.has(char)) {
      tokens.push({ kind: 'punct', value: char });
      at += 1;
      continue;
    }
    const name = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(at));
    if (name) {
      tokens.push({ kind: 'name', value: name[0] });
      at += name[0].length;
      continue;
    }
    const number = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(at));
    if (number) {
      tokens.push({ kind: number[2] || number[3] ? 'float' : 'int', value: number[0] });
      at += number[0].length;
      continue;
    }
    if (source.startsWith('"""', at)) {
      const end = source.indexOf('"""', at + 3);
      if (end < 0) throw new GraphqlSyntaxError('Syntax Error: Unterminated string.');
      tokens.push({ kind: 'string', value: source.slice(at + 3, end) });
      at = end + 3;
      continue;
    }
    if (char === '"') {
      let end = at + 1;
      let text = '';
      while (end < source.length && source[end] !== '"') {
        if (source[end] === '\n')
          throw new GraphqlSyntaxError('Syntax Error: Unterminated string.');
        if (source[end] === '\\') {
          const escaped = source[end + 1] ?? '';
          if (escaped === 'u') {
            text += String.fromCharCode(parseInt(source.slice(end + 2, end + 6), 16));
            end += 6;
            continue;
          }
          text += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }[escaped] ?? escaped;
          end += 2;
          continue;
        }
        text += source[end];
        end += 1;
      }
      if (end >= source.length) throw new GraphqlSyntaxError('Syntax Error: Unterminated string.');
      tokens.push({ kind: 'string', value: text });
      at = end + 1;
      continue;
    }
    throw new GraphqlSyntaxError(`Syntax Error: Unexpected character: "${char}".`);
  }
  return tokens;
}

/**
 * Parse a document into its one operation (the first, or the one named).
 *
 * @param {string} source
 * @param {string | null} [operationName]
 * @returns {import('./linear').GraphqlOperation}
 */
export function parseOperation(source, operationName = null) {
  const tokens = tokenise(source);
  let at = 0;

  const peek = () => tokens[at];
  /** @param {string} value */
  const isPunct = (value) => peek()?.kind === 'punct' && peek()?.value === value;
  /** @param {string} value */
  function expectPunct(value) {
    const token = tokens[at];
    if (token?.kind !== 'punct' || token.value !== value) {
      throw new GraphqlSyntaxError(
        `Syntax Error: Expected "${value}", found ${token ? `"${token.value}"` : '<EOF>'}.`,
      );
    }
    at += 1;
  }
  function expectName() {
    const token = tokens[at];
    if (token?.kind !== 'name') {
      throw new GraphqlSyntaxError(
        `Syntax Error: Expected Name, found ${token ? `"${token.value}"` : '<EOF>'}.`,
      );
    }
    at += 1;
    return token.value;
  }

  /** @returns {import('./linear').GraphqlValue} */
  function value() {
    const token = tokens[at];
    if (!token) throw new GraphqlSyntaxError('Syntax Error: Unexpected <EOF>.');
    if (token.kind === 'punct' && token.value === '$') {
      at += 1;
      return { variable: expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      at += 1;
      const list = [];
      while (!isPunct(']')) list.push(value());
      expectPunct(']');
      return { list };
    }
    if (token.kind === 'punct' && token.value === '{') {
      at += 1;
      /** @type {Record<string, import('./linear').GraphqlValue>} */
      const object = {};
      while (!isPunct('}')) {
        const name = expectName();
        expectPunct(':');
        object[name] = value();
      }
      expectPunct('}');
      return { object };
    }
    at += 1;
    if (token.kind === 'int' || token.kind === 'float') return { literal: Number(token.value) };
    if (token.kind === 'string') return { literal: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { literal: true };
      if (token.value === 'false') return { literal: false };
      if (token.value === 'null') return { literal: null };
      return { literal: token.value };
    }
    throw new GraphqlSyntaxError(`Syntax Error: Unexpected "${token.value}".`);
  }

  /** @returns {Record<string, import('./linear').GraphqlValue>} */
  function argumentsOf() {
    /** @type {Record<string, import('./linear').GraphqlValue>} */
    const args = {};
    if (!isPunct('(')) return args;
    expectPunct('(');
    while (!isPunct(')')) {
      const name = expectName();
      expectPunct(':');
      args[name] = value();
    }
    expectPunct(')');
    return args;
  }

  /** @returns {import('./linear').GraphqlField[]} */
  function selectionSet() {
    expectPunct('{');
    /** @type {import('./linear').GraphqlField[]} */
    const fields = [];
    while (!isPunct('}')) {
      if (peek()?.kind === 'spread') {
        throw new GraphqlSyntaxError('This fake answers no fragments.');
      }
      let name = expectName();
      let alias = name;
      if (isPunct(':')) {
        at += 1;
        name = expectName();
      }
      const args = argumentsOf();
      if (isPunct('@')) throw new GraphqlSyntaxError('This fake answers no directives.');
      fields.push({
        alias,
        name,
        args,
        selections: isPunct('{') ? selectionSet() : null,
      });
    }
    expectPunct('}');
    return fields;
  }

  function skipType() {
    if (isPunct('[')) {
      at += 1;
      skipType();
      expectPunct(']');
    } else {
      expectName();
    }
    if (isPunct('!')) at += 1;
  }

  /** @type {import('./linear').GraphqlOperation[]} */
  const operations = [];
  while (at < tokens.length) {
    if (isPunct('{')) {
      operations.push({ type: 'query', name: null, defaults: {}, selections: selectionSet() });
      continue;
    }
    const keyword = expectName();
    if (keyword === 'fragment') throw new GraphqlSyntaxError('This fake answers no fragments.');
    if (keyword !== 'query' && keyword !== 'mutation') {
      throw new GraphqlSyntaxError(`Syntax Error: Unexpected Name "${keyword}".`);
    }
    const name = peek()?.kind === 'name' ? expectName() : null;
    /** @type {Record<string, import('./linear').GraphqlValue>} */
    const defaults = {};
    if (isPunct('(')) {
      at += 1;
      while (!isPunct(')')) {
        expectPunct('$');
        const variable = expectName();
        expectPunct(':');
        skipType();
        if (isPunct('=')) {
          at += 1;
          defaults[variable] = value();
        }
      }
      expectPunct(')');
    }
    operations.push({ type: keyword, name, defaults, selections: selectionSet() });
  }
  const chosen = operationName
    ? operations.find((operation) => operation.name === operationName)
    : operations[0];
  if (!chosen) {
    throw new GraphqlSyntaxError(
      operationName
        ? `Unknown operation named "${operationName}".`
        : 'Syntax Error: Unexpected <EOF>.',
    );
  }
  return chosen;
}

/**
 * The plain value of a parsed argument, its variables filled in.
 *
 * @param {import('./linear').GraphqlValue} parsed
 * @param {Record<string, unknown>} variables
 * @returns {unknown}
 */
export function valueOf(parsed, variables) {
  if ('variable' in parsed) return variables[parsed.variable];
  if ('list' in parsed) return parsed.list.map((item) => valueOf(item, variables));
  if ('object' in parsed) {
    // An input field whose variable was not sent is absent, not null (GraphQL's coercion of input
    // objects), so `{ assigneeId: $assigneeId }` with no `$assigneeId` leaves the assignee alone.
    return Object.fromEntries(
      Object.entries(parsed.object)
        .filter(([, item]) => !('variable' in item) || item.variable in variables)
        .map(([name, item]) => [name, valueOf(item, variables)]),
    );
  }
  return parsed.literal;
}
