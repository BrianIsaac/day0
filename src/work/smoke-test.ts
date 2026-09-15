import { parser as pythonParser } from '@lezer/python';
import { redactStructural } from '../redaction/redact';

/**
 * The preflight on an authored smoke test, run before either sandbox spends
 * a run: the source must parse as Python 3.12 and carry the two landmarks
 * the sandbox reads back, `run(inputs: dict) -> dict` and a printed line.
 *
 * A refusal names the form: the first parse error's line and column and the
 * offending line, so the retry corrects that line rather than guessing. The
 * quoted line goes through the structural redaction floor and is bounded,
 * because it lands on the row and in the retry prompt.
 *
 * Kept free of model clients and Convex imports.
 */

const FENCE = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/;

/** What the log says when a fenced smoke test was unwrapped rather than refused. */
export const FENCE_REMOVED_NOTE =
  'smoke test arrived wrapped in a markdown fence; the fence was removed before the program was checked';

/**
 * Remove a markdown code fence that wraps the whole source.
 *
 * Args:
 *   source: The smoke test as the model returned it.
 *
 * Returns:
 *   The program inside the fence and `unwrapped: true`, or the source as it
 *   was when no fence wraps the whole of it.
 */
export function unwrapMarkdownFence(source: string): { source: string; unwrapped: boolean } {
  const match = FENCE.exec(source);
  if (!match) return { source, unwrapped: false };
  return { source: match[1]!, unwrapped: true };
}

const MAX_QUOTED_LINE = 160;

function quotedLine(source: string, offset: number): { line: number; column: number; text: string } {
  const before = source.slice(0, offset);
  const lineStart = before.lastIndexOf('\n') + 1;
  const lineEnd = source.indexOf('\n', offset);
  const raw = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
  const safe = redactStructural(raw);
  const text = safe.length > MAX_QUOTED_LINE ? `${safe.slice(0, MAX_QUOTED_LINE)}…` : safe;
  return {
    line: before.split('\n').length,
    column: offset - lineStart + 1,
    text,
  };
}

/**
 * Why a smoke test is refused before any sandbox runs, if it is.
 *
 * Args:
 *   source: Python source, already unwrapped from any fence.
 *
 * Returns:
 *   The reason, or undefined when the source parses and carries both
 *   landmarks.
 */
export function smokeTestPreflightReason(source: string): string | undefined {
  const tree = pythonParser.parse(source);
  const cursor = tree.cursor();
  do {
    if (cursor.type.isError) {
      const at = quotedLine(source, cursor.from);
      return `smoke test is not valid Python 3.12 source: its syntax does not parse at line ${at.line}, column ${at.column}: \`${at.text}\``;
    }
  } while (cursor.next());
  const dictAnnotation = String.raw`dict(?:\s*\[[^\]]*\])?`;
  const runSignature = new RegExp(
    String.raw`^\s*(?:async\s+)?def\s+run\s*\(\s*inputs\s*:\s*${dictAnnotation}\s*\)\s*->\s*${dictAnnotation}\s*:`,
    'm',
  );
  if (!runSignature.test(source)) {
    return 'smoke test is not valid Python 3.12 source: it must define run(inputs: dict) -> dict';
  }
  if (!/\bprint\s*\(|\bsys\.stdout\.write\s*\(/.test(source)) {
    return 'smoke test is not valid Python 3.12 source: it must print a success line';
  }
  return undefined;
}
