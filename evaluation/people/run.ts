#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractedFromPeopleRows, extractedFromTrace, gradeExtraction, renderGrade } from './grade';
import { PEOPLE_LABELS } from './labels';

/** A time as a directory name. */
function stamp(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
}

/**
 * Grade the people a bed run extracted and write the grade under `evaluation/people/<stamp>/`
 * (V10). The input is the bed's people table as `npx convex export` writes it
 * (`people/documents.jsonl`), or an employee's exported trace, which redacts addresses.
 *
 *   pnpm exec tsx evaluation/people/run.ts <people/documents.jsonl | trace.json>
 *
 * @param inputPath - The people rows, or a trace.
 * @returns The directory written.
 */
export async function runPeopleGrade(inputPath: string, now = new Date()): Promise<string> {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const text = await readFile(inputPath, 'utf8');
  const extracted = inputPath.endsWith('.jsonl')
    ? extractedFromPeopleRows(
        text
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line): unknown => JSON.parse(line)),
      )
    : extractedFromTrace(JSON.parse(text));
  const grade = gradeExtraction(PEOPLE_LABELS, extracted, commit, now);
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
  const inputPath = process.argv[2];
  if (inputPath === undefined) {
    console.error('usage: tsx evaluation/people/run.ts <people/documents.jsonl | trace.json>');
    process.exitCode = 2;
  } else {
    runPeopleGrade(inputPath)
      .then((directory) => console.log(`[people] grade: ${directory}`))
      .catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      });
  }
}
