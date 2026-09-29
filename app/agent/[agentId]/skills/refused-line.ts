/**
 * Where in a refused draft the check refused it, read back from the reason the row keeps.
 *
 * Two refusals name a position, both in the smoke test: the syntax check's
 * `does not parse at line N, column C: \`text\`` (`src/work/smoke-test.ts`), and a sandbox run's
 * traceback, whose last `File "authored_smoke.py", line N` frame is the smoke test's own line
 * (`src/work/smoke-harness.ts`), followed by that line's text. The static gate names a literal
 * but no position, so it marks nothing.
 */

/** A line of the smoke test the check refused, and the column when the check named one. */
export interface RefusedLine {
  /** One-based, as the check counts. */
  readonly line: number;
  readonly column?: number;
}

const SYNTAX = /does not parse at line (\d+), column (\d+): `([^`]*)`/;
const FRAME = /File "authored_smoke\.py", line (\d+)[^\n]*\n([^\n]*)/g;

/** How much of a quoted line is compared: the check cuts its quote at 160 characters. */
const COMPARED = 60;

/** Whether the draft's line is the one the reason quoted, so a mark never lands on another line. */
function sameLine(draftLine: string, quoted: string | undefined): boolean {
  if (quoted === undefined || quoted.trim() === '') return true;
  const expected = quoted.replace(/…$/, '').trim().slice(0, COMPARED);
  return draftLine.trim().startsWith(expected);
}

/**
 * The smoke-test line a refusal names, when it names one that is in the draft as quoted.
 *
 * @param log - The reason the row keeps (`verificationLog`).
 * @param smokeTest - The refused smoke test as stored.
 * @returns The line and column, or undefined when the reason names none or the draft's line
 *   differs from the one it quotes (a redaction or a later draft moved it).
 */
export function refusedLineOf(log: string, smokeTest: string): RefusedLine | undefined {
  const lines = smokeTest.split('\n');
  const syntax = SYNTAX.exec(log);
  if (syntax) {
    const line = Number(syntax[1]);
    const column = Number(syntax[2]);
    const draftLine = lines[line - 1];
    return draftLine !== undefined && sameLine(draftLine, syntax[3]) ? { line, column } : undefined;
  }
  const frames = [...log.matchAll(FRAME)];
  const last = frames.at(-1);
  if (last === undefined) return undefined;
  const line = Number(last[1]);
  const draftLine = lines[line - 1];
  return draftLine !== undefined && sameLine(draftLine, last[2]) ? { line } : undefined;
}
