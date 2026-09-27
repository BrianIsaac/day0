#!/usr/bin/env tsx

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  structuredOutputDiagnostics,
  structuredOutputRecord,
} from '../evaluation/structured-output';
import type { EvaluationEvidence } from '../evaluation/report';

/**
 * Write the structured-output record for an evidence file beside it.
 *
 * An evidence directory is frozen once written, so an existing record is
 * never replaced: the write is exclusive and fails when the file is there.
 *
 * @param evidencePath - The evidence JSON the record describes.
 * @param logsPath - The function-log capture covering the run.
 * @returns The path written and the record it holds.
 * @throws when a structured-output record already exists beside the evidence.
 */
export function writeStructuredOutputRecord(
  evidencePath: string,
  logsPath: string,
): { output: string; record: ReturnType<typeof structuredOutputRecord> } {
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as EvaluationEvidence;
  const calls = structuredOutputDiagnostics(readFileSync(logsPath, 'utf8'));
  const record = structuredOutputRecord(evidence, calls);
  const output = join(dirname(evidencePath), 'structured-output.json');
  try {
    writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    throw new Error(
      `a structured-output record already exists at ${output}; the evidence directory is frozen`,
      { cause: error },
    );
  }
  return { output, record };
}

function main(): void {
  const [evidencePath, logsPath] = process.argv.slice(2);
  if (!evidencePath || !logsPath) {
    throw new Error(
      'Usage: tsx scripts/eval-structured-output.ts <evidence.json> <function-logs.jsonl>',
    );
  }
  const { output, record } = writeStructuredOutputRecord(evidencePath, logsPath);
  console.log(
    JSON.stringify({
      output,
      totals: record.totals,
      incompleteRows: record.rows.filter((row) => row.coverage === 'incomplete').length,
    }),
  );
  if (record.rows.some((row) => row.coverage === 'incomplete')) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) main();
