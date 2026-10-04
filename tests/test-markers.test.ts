import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The standard's 11.6, which the lint does not check: no `.skip`, `.only`, `.todo` or `.fails`
 * is left in a committed Vitest test without its reason, as a comment on the marker's line or,
 * where the formatter breaks the call, on the line after it (the wave 12 review's W12-R6). Read
 * from the files themselves, so a marker added without one fails here.
 */

const TESTS = new URL('./', import.meta.url).pathname;

/** A marker the rule covers, at the start of a call. */
const MARKER = new RegExp(String.raw`\b(?:it|test|describe)\.(?:skip|only|todo|fails)\(`);

/** Every Vitest test file under `tests/`, by path. */
function testFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testFiles(path);
    return /\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * The markers in one file's text with no reason beside them, as `file:line`.
 *
 * @param file - The file's path, for the answer.
 * @param text - The file's text.
 */
function markersWithoutReason(file: string, text: string): string[] {
  const lines = text.split('\n');
  return lines.flatMap((line, index): string[] => {
    const at = line.search(MARKER);
    if (at < 0 || line.trimStart().startsWith('//')) return [];
    const sameLine = line.slice(at).includes('//');
    const nextLine = (lines[index + 1] ?? '').trimStart().startsWith('//');
    return sameLine || nextLine ? [] : [`${file}:${index + 1}`];
  });
}

describe('the markers a committed test may carry (standard 11.6)', (): void => {
  it('finds a reason beside every skip, only, todo and fails in the tree', (): void => {
    // This file's own cases quote markers as data.
    const self = new URL(import.meta.url).pathname;
    const missing = testFiles(TESTS)
      .filter((path) => path !== self)
      .flatMap((path) => markersWithoutReason(relative(TESTS, path), readFileSync(path, 'utf8')));
    expect(missing).toEqual([]);
  });

  it('takes the reason on the line or the one after it, and nothing else', (): void => {
    expect(markersWithoutReason('a', "it.fails('x', run); // until the fix lands")).toEqual([]);
    expect(markersWithoutReason('a', "it.fails(\n  // until the fix lands\n  'x',")).toEqual([]);
    expect(markersWithoutReason('a', "it.skip('x', run);")).toEqual(['a:1']);
    expect(markersWithoutReason('a', "describe.only(\n  'x',\n  // too late\n")).toEqual(['a:1']);
  });
});
