/// <reference types="node" />
/**
 * Record the span model's answers over the labelled corpus.
 *
 *   pnpm redaction:record                       # DAY0_REDACTOR_URL from .env.local
 *   DAY0_REDACTOR_URL=http://127.0.0.1:8765 pnpm redaction:record
 *
 * The corpus tests replay this recording through the guard, the structural
 * grammar and the entity policy, so the precision and recall they assert are
 * the deployed model's and the suite needs no model to run. Re-record after
 * changing the model, the requested labels or the corpus; the file names the
 * model it was taken from and the test refuses a recording of another one.
 *
 * Only offsets, labels and scores are written: no text, so the file carries
 * no token-shaped value even though the corpus is expanded at runtime.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { HttpSpanModel } from '../src/redaction/client';
import { MODEL_THRESHOLD, REQUESTED_LABELS } from '../src/redaction/policy';
import { loadRedactionCorpus } from '../tests/fixtures/redaction-corpus';

export const RECORDING_PATH = new URL('../tests/fixtures/redaction/spans.json', import.meta.url);

export interface SpanRecording {
  model: string;
  labels: string[];
  threshold: number;
  recordedAt: string;
  cases: Record<string, Array<{ start: number; end: number; label: string; score: number }>>;
}

async function main(): Promise<number> {
  const url = process.env.DAY0_REDACTOR_URL?.trim();
  if (!url) {
    console.error('DAY0_REDACTOR_URL is unset; start the component (`pnpm redactor:up`) and point at it.');
    return 1;
  }
  const model = new HttpSpanModel(url);
  const health = await fetch(new URL('/healthz', url.endsWith('/') ? url : `${url}/`));
  const body = (await health.json()) as { ok?: boolean; model?: string; device?: string };
  if (!body.ok || !body.model) {
    console.error(`the component at ${url} is not healthy`);
    return 1;
  }
  const recording: SpanRecording = {
    model: body.model,
    labels: [...REQUESTED_LABELS],
    threshold: MODEL_THRESHOLD,
    recordedAt: new Date().toISOString(),
    cases: {},
  };
  const cases = loadRedactionCorpus();
  const started = Date.now();
  for (const entry of cases) {
    recording.cases[entry.id] = (await model.spans(entry.text, REQUESTED_LABELS, MODEL_THRESHOLD)).map(
      (span) => ({ ...span, score: Number(span.score.toFixed(4)) }),
    );
  }
  writeFileSync(RECORDING_PATH, `${JSON.stringify(recording, null, 1)}\n`, 'utf8');
  const spans = Object.values(recording.cases).reduce((sum, list): number => sum + list.length, 0);
  console.log(
    `Recorded ${spans} spans over ${cases.length} cases from ${body.model} on ${body.device ?? 'unknown device'} in ${((Date.now() - started) / 1000).toFixed(1)} s.`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code: number): void => {
      process.exitCode = code;
    },
    (error: unknown): void => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}

export { main as recordSpans };
