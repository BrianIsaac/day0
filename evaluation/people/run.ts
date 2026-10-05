#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractedFromTrace, gradeExtraction, renderGrade } from './grade';
import { PEOPLE_LABELS } from './labels';

/** A time as a directory name. */
function stamp(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
}

/**
 * Grade the people a bed run extracted, read from an employee's exported trace, and write the
 * grade under `evaluation/people/<stamp>/` (V10).
 *
 *   pnpm exec tsx evaluation/people/run.ts <trace.json>
 *
 * @param tracePath - The exported trace of an employee of the bed's owner.
 * @returns The directory written.
 */
export async function runPeopleGrade(tracePath: string, now = new Date()): Promise<string> {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const trace: unknown = JSON.parse(await readFile(tracePath, 'utf8'));
  const grade = gradeExtraction(PEOPLE_LABELS, extractedFromTrace(trace), commit, now);
  const directory = resolve('evaluation/people', stamp(now));
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(`${directory}/grade.json`, `${JSON.stringify(grade, null, 2)}\n`, 'utf8'),
    writeFile(`${directory}/grade.md`, renderGrade(grade), 'utf8'),
  ]);
  return directory;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const tracePath = process.argv[2];
  if (tracePath === undefined) {
    console.error('usage: tsx evaluation/people/run.ts <trace.json>');
    process.exitCode = 2;
  } else {
    runPeopleGrade(tracePath)
      .then((directory) => console.log(`[people] grade: ${directory}`))
      .catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      });
  }
}
