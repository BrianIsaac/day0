/// <reference types="node" />
/**
 * Record the span model's answers over the labelled corpus.
 *
 *   DAY0_REDACTOR_URL=http://<address this machine reaches>:8000 pnpm redaction:record
 *
 * The redactor publishes no host port: the backend reaches it as
 * `http://redactor:8000` on the Compose network, which is what `.env.local`
 * holds and what this machine cannot resolve. So the address is given for the
 * one run, and the refusal prints the command that finds the container's own
 * address (reachable from a Linux host; Docker Desktop needs a published port).
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

/** Finds the redactor container's own address, which a Linux host can reach. */
const CONTAINER_ADDRESS =
  "DAY0_REDACTOR_URL=http://$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' " +
  '$(docker compose --env-file .env.local ps -q redactor)):8000 pnpm redaction:record';

/**
 * The redactor address a recording dials, or why the configured one will not
 * do from this machine: unset, or the backend container's own service name.
 *
 * Args:
 *   environment: The process environment, with `.env.local` loaded under it.
 *
 * Returns:
 *   The address, or the refusal with the command that finds a reachable one.
 */
export function recordingAddress(
  environment: Readonly<Record<string, string | undefined>>,
): { url: string } | { refusal: string } {
  const url = environment.DAY0_REDACTOR_URL?.trim() ?? '';
  const way =
    'Start it with `pnpm redactor:up` if it is not running, then give this run an address this ' +
    `machine reaches; on Linux the container's own:\n  ${CONTAINER_ADDRESS}`;
  if (url === '') return { refusal: `DAY0_REDACTOR_URL is unset. ${way}` };
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { refusal: `DAY0_REDACTOR_URL is ${url}, which is not a URL. ${way}` };
  }
  if (!host.includes('.') && !host.includes(':') && host !== 'localhost') {
    return {
      refusal:
        `DAY0_REDACTOR_URL is ${url}, which is the address the backend container uses; this machine cannot ` +
        `resolve ${host}, because the service publishes no host port. ${way}`,
    };
  }
  return { url };
}

async function main(): Promise<number> {
  const address = recordingAddress(process.env);
  if ('refusal' in address) {
    console.error(address.refusal);
    return 1;
  }
  const { url } = address;
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
    recording.cases[entry.id] = (
      await model.spans(entry.text, REQUESTED_LABELS, MODEL_THRESHOLD)
    ).map((span) => ({ ...span, score: Number(span.score.toFixed(4)) }));
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
