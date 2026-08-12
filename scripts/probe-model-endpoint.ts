/// <reference types="node" />
/**
 * Endpoint conformance probe for Day0's model layer.
 *
 * Answers the one question that decides whether a given
 * OpenAI-compatible server can run the loop: does it speak chat
 * completions, and how does it behave when asked for JSON? Run it
 * against any endpoint before wiring it into a demo.
 *
 *   OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_MODEL=qwen3:8b \
 *     pnpm probe:model
 *
 * Exit code 0 means the endpoint can drive charter synthesis, plan
 * drafting, execution and skill authoring. Non-zero names the step that
 * failed.
 */
import { z } from 'zod';
import { env } from '../src/env';
import {
  extractJsonPayload,
  jsonCompleteWithMode,
  MODEL,
  resetJsonModeMemo,
  textComplete,
} from '../src/lib/openai';
import { agentJson, makeAgent, resetStructuredModeMemo } from '../src/lib/mastra';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'pass' : 'FAIL'}  ${name.padEnd(28)} ${detail}\n`);
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = process.hrtime.bigint();
  const value = await fn();
  return { value, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

async function main(): Promise<void> {
  process.stdout.write(
    [
      'Day0 model-endpoint probe',
      `  base URL   ${env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1 (default)'}`,
      `  model      ${MODEL}`,
      `  json mode  ${env.OPENAI_JSON_MODE}`,
      `  api key    ${env.OPENAI_API_KEY ? 'set' : 'absent (fine for local runtimes)'}`,
      '',
    ].join('\n'),
  );

  // 1. Plain chat completion — the floor every other step stands on.
  try {
    const { value, ms } = await timed(() =>
      textComplete({
        system: 'You are terse. Answer in one word.',
        user: 'Reply with the word: ready',
        maxTokens: 2000,
      }),
    );
    record('chat completions', value.length > 0, `${ms.toFixed(0)}ms · "${value.slice(0, 40)}"`);
  } catch (err) {
    record('chat completions', false, (err as Error).message);
    return finish();
  }

  // 2. Pure function — no network, so it fails loudly on a regression
  //    rather than hiding behind a model that happened to behave.
  const messy = '<think>weighing it up</think>\n```json\n{"a": {"b": "}"}}\n```\ntrailing prose';
  record(
    'json extraction',
    extractJsonPayload(messy) === '{"a": {"b": "}"}}',
    `recovered ${extractJsonPayload(messy) ?? '(nothing)'}`,
  );

  // 3. Native JSON mode — response_format honoured?
  const jsonArgs = {
    system: 'You return JSON objects describing a work item.',
    user: 'Return {"title": string, "priority": "low"|"high"} for a task about refreshing a sales tracker.',
    maxTokens: 2000,
  };
  resetJsonModeMemo();
  try {
    const { value, ms } = await timed(() =>
      jsonCompleteWithMode<{ title?: string }>({ ...jsonArgs, mode: 'native' }),
    );
    record('json mode · native', !!value.value.title, `${ms.toFixed(0)}ms · title="${value.value.title}"`);
  } catch (err) {
    record('json mode · native', false, `${(err as Error).message} — prompt mode covers this`);
  }

  // 4. Prompt fallback — must work even where step 3 did.
  resetJsonModeMemo();
  try {
    const { value, ms } = await timed(() =>
      jsonCompleteWithMode<{ title?: string }>({ ...jsonArgs, mode: 'prompt' }),
    );
    record('json mode · prompt', !!value.value.title, `${ms.toFixed(0)}ms · title="${value.value.title}"`);
  } catch (err) {
    record('json mode · prompt', false, (err as Error).message);
  }

  // 5. The Mastra path every domain function actually calls.
  resetStructuredModeMemo();
  const agent = makeAgent(
    'day0-probe',
    'You are a probe agent. Answer with the requested structured fields and nothing else.',
  );
  const schema = z.object({ summary: z.string(), steps: z.array(z.string()) });
  try {
    const { value, ms } = await timed(() =>
      agentJson<z.infer<typeof schema>>({
        agent,
        user: 'Draft a two-step plan for updating a spreadsheet tracker. Keep each step under 12 words.',
        schema,
      }),
    );
    record('mastra · native', value.steps.length > 0, `${ms.toFixed(0)}ms · ${value.steps.length} steps`);
  } catch (err) {
    record('mastra · native', false, `${(err as Error).message} — prompt injection covers this`);
  }

  // 6. The same call with schema injection instead of response_format,
  //    which is where `auto` lands on a server that ignores the field.
  resetStructuredModeMemo();
  try {
    const { value, ms } = await timed(() =>
      agentJson<z.infer<typeof schema>>({
        agent,
        user: 'Draft a two-step plan for replying to a customer tweet. Keep each step under 12 words.',
        schema,
        mode: 'prompt',
      }),
    );
    record('mastra · prompt injection', value.steps.length > 0, `${ms.toFixed(0)}ms · ${value.steps.length} steps`);
  } catch (err) {
    record('mastra · prompt injection', false, (err as Error).message);
  }

  finish();
}

function finish(): void {
  const failed = checks.filter((c) => !c.ok);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  if (failed.length > 0) {
    process.stdout.write(`failed: ${failed.map((f) => f.name).join(', ')}\n`);
    process.exitCode = 1;
  }
}

void main();
