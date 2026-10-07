#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRetrievalGrade, renderRetrievalGrade } from './matrix';

function stamp(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
}

/**
 * Grade the selector over the labelled set at the checked-out commit and write the grade under
 * `evaluation/retrieval/<stamp>/`.
 *
 * @returns The directory written.
 */
export async function runRetrievalGrade(now = new Date()): Promise<string> {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const evidence = buildRetrievalGrade(commit, now);
  const directory = resolve('evaluation/retrieval', stamp(now));
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(`${directory}/grade.json`, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8'),
    writeFile(`${directory}/grade.md`, renderRetrievalGrade(evidence), 'utf8'),
  ]);
  return directory;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  runRetrievalGrade()
    .then((directory) => console.log(`[retrieval] evidence: ${directory}`))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
