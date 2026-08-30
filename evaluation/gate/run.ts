#!/usr/bin/env tsx

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildGateMatrix, renderGateMatrix } from './matrix';

function stamp(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
}

export async function runGateMatrix(now = new Date()): Promise<string> {
  const evidence = buildGateMatrix(now);
  const directory = resolve('evaluation/gate', stamp(now));
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(`${directory}/matrix.json`, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8'),
    writeFile(`${directory}/matrix.md`, renderGateMatrix(evidence), 'utf8'),
  ]);
  return directory;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  runGateMatrix()
    .then((directory) => console.log(`[gate] evidence: ${directory}`))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
