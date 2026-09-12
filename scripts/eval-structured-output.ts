import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  structuredOutputDiagnostics,
  structuredOutputRecord,
} from '../evaluation/structured-output';
import type { EvaluationEvidence } from '../evaluation/report';

const [evidencePath, logsPath] = process.argv.slice(2);
if (!evidencePath || !logsPath)
  throw new Error(
    'Usage: tsx scripts/eval-structured-output.ts <semifinal.json> <function-logs.jsonl>',
  );
const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as EvaluationEvidence;
const calls = structuredOutputDiagnostics(readFileSync(logsPath, 'utf8'));
const record = structuredOutputRecord(evidence, calls);
const output = join(dirname(evidencePath), 'structured-output.json');
writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`);
console.log(
  JSON.stringify({
    output,
    totals: record.totals,
    incompleteRows: record.rows.filter((row) => row.coverage === 'incomplete').length,
  }),
);
if (record.rows.some((row) => row.coverage === 'incomplete')) process.exitCode = 1;
