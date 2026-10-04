import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import type { ModelSpan, SpanModel } from '../../src/redaction/client';
import { HttpSpanModel, RedactorUnavailableError } from '../../src/redaction/client';
import { CORPUS_SLOTS, loadRedactionCorpus } from './redaction-corpus';

/**
 * Test doubles for the span model.
 *
 * `RecordedSpanModel` answers a corpus text with the spans recorded from the
 * real model (`tests/fixtures/redaction/spans.json`, written by
 * `pnpm redaction:record`), so a test that asserts precision and recall is
 * asserting the deployed model's. For a text a test made up on the spot it
 * answers from a small vocabulary of the values these tests use, which is a
 * stand-in for the model and nothing more: it is how a unit test says "the
 * model called this a password" without running one.
 */

export interface SpanRecording {
  model: string;
  labels: string[];
  threshold: number;
  recordedAt: string;
  cases: Record<string, ModelSpan[]>;
}

export const RECORDING_URL = new URL('./redaction/spans.json', import.meta.url);

/** Read the recording; a missing file is a plain error naming the command that writes it. */
export function loadSpanRecording(): SpanRecording {
  try {
    return JSON.parse(readFileSync(RECORDING_URL, 'utf8')) as SpanRecording;
  } catch (error) {
    throw new Error(
      `no span recording at ${RECORDING_URL.pathname}; run \`pnpm redaction:record\` against a running component (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
}

/** Values the unit tests use, and what the model would call them. */
export const DOUBLE_VOCABULARY: ReadonlyArray<{ value: string; label: string; score?: number }> = [
  { value: 'hunter2', label: 'password' },
  { value: 'abc123', label: 'password' },
  { value: 'pipeline-tile-local', label: 'password' },
  { value: 'warehouse-read-only', label: 'password' },
  { value: 'revops2026', label: 'password' },
  { value: 'P@ssw0rd!', label: 'password' },
  { value: 'Tr0ub4dor&3', label: 'password' },
  { value: 'Zq9!vT2#kL8mNp4rXs7wYb3e', label: 'password' },
  { value: 'q7Mz2Kv9Tx4Wp6Rn8Js3', label: 'api key' },
  { value: 'generic-contract-value-0123456789abcdef', label: 'api key' },
  { value: 'runtime-contract-value-0123456789', label: 'api key' },
  { value: 'local-value-only', label: 'access token' },
  { value: 'Priya', label: 'person' },
  { value: 'Aman', label: 'person' },
  { value: 'Alice Smith', label: 'person' },
  { value: '+65 9123 4567', label: 'phone number' },
  { value: 'S1234567D', label: 'id number' },
];

/** Token-shaped test values the model reads as a token wherever they occur. */
const TOKEN_SHAPED = /(?<![A-Za-z0-9])(?:lin_api_|xox[bpae][-.]|ntn_|secret_|sk-|ghp_|github_pat_|AKIA)[A-Za-z0-9._-]{8,}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export class RecordedSpanModel implements SpanModel {
  readonly name = 'recorded';
  private readonly byText = new Map<string, ModelSpan[]>();

  constructor(recording: SpanRecording | undefined = loadOptionalRecording()) {
    if (recording) {
      for (const entry of loadRedactionCorpus()) {
        const spans = recording.cases[entry.id];
        if (spans) this.byText.set(entry.text, spans);
      }
    }
  }

  async spans(text: string, labels: readonly string[], threshold: number): Promise<ModelSpan[]> {
    const recorded = this.byText.get(text);
    if (recorded) return recorded.filter((span) => labels.includes(span.label) && span.score >= threshold);
    return vocabularySpans(text, labels, threshold);
  }
}

function loadOptionalRecording(): SpanRecording | undefined {
  try {
    return loadSpanRecording();
  } catch {
    return undefined;
  }
}

/** Spans for a made-up test text, from the vocabulary and the token shapes above. */
export function vocabularySpans(text: string, labels: readonly string[], threshold: number): ModelSpan[] {
  const spans: ModelSpan[] = [];
  const push = (start: number, end: number, label: string, score = 0.9): void => {
    if (labels.includes(label) && score >= threshold) spans.push({ start, end, label, score });
  };
  for (const word of DOUBLE_VOCABULARY) {
    let from = 0;
    for (;;) {
      const index = text.indexOf(word.value, from);
      if (index === -1) break;
      push(index, index + word.value.length, word.label, word.score);
      from = index + word.value.length;
    }
  }
  for (const value of Object.values(CORPUS_SLOTS)) {
    let from = 0;
    for (;;) {
      const index = text.indexOf(value, from);
      if (index === -1) break;
      push(index, index + value.length, 'access token');
      from = index + value.length;
    }
  }
  for (const match of text.matchAll(TOKEN_SHAPED)) {
    if (match.index !== undefined) push(match.index, match.index + match[0].length, 'access token');
  }
  for (const match of text.matchAll(EMAIL)) {
    if (match.index !== undefined) push(match.index, match.index + match[0].length, 'email');
  }
  return spans.sort((left, right): number => left.start - right.start);
}

/** A model that is configured and cannot be reached. */
export class UnreachableSpanModel implements SpanModel {
  readonly name = 'unreachable';
  async spans(): Promise<ModelSpan[]> {
    throw new RedactorUnavailableError('redaction component unreachable at redactor:8000: connection refused');
  }
}

/**
 * A configured component that accepts the request and never answers: the
 * real HTTP client with a short deadline over a transport that only settles
 * when the deadline aborts it, so the timeout path is the one under test.
 */
export class StalledSpanModel extends HttpSpanModel {
  constructor(timeoutMs = 25) {
    super(
      'http://redactor.test:8000',
      (_input: URL, init: RequestInit): Promise<Response> =>
        new Promise<Response>((_resolve, reject): void => {
          init.signal?.addEventListener('abort', (): void => reject(new Error('aborted')), { once: true });
        }),
      timeoutMs,
    );
  }
}

/** A model that answers with a fixed list, for a test that scripts the answer. */
export class ScriptedSpanModel implements SpanModel {
  readonly name = 'scripted';
  readonly calls: Array<{ text: string; labels: readonly string[]; threshold: number }> = [];
  constructor(private readonly answer: (text: string) => ModelSpan[]) {}
  async spans(text: string, labels: readonly string[], threshold: number): Promise<ModelSpan[]> {
    this.calls.push({ text, labels, threshold });
    return this.answer(text);
  }
}

/** One request to the double, as both of its transports see it. */
interface SpanRequest {
  readonly method: string;
  readonly path: string;
  /** Reads the request's body; called only for a span request. */
  readonly readBody: () => Promise<string>;
}

/** A reply from the double: an HTTP status and the JSON body it carries. */
interface SpanReply {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Answer one request to the span model the way the compose component does:
 * `GET /healthz`, `POST /v1/spans`, and a 404 for anything else.
 *
 * @param model - The double that answers.
 */
async function answerSpanRequest(
  model: SpanModel,
  { method, path, readBody }: SpanRequest,
): Promise<SpanReply> {
  if (method === 'GET' && path === '/healthz') {
    return { status: 200, body: { ok: true, model: model.name, device: 'test', manifest: 'verified' } };
  }
  if (method !== 'POST' || path !== '/v1/spans') {
    return { status: 404, body: { error: 'not found' } };
  }
  try {
    const parsed = JSON.parse(await readBody()) as { text: string; labels: string[]; threshold: number };
    return { status: 200, body: { spans: await model.spans(parsed.text, parsed.labels, parsed.threshold) } };
  } catch (error) {
    return { status: 503, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}

/**
 * Answer the span model's HTTP requests in-process, for a test whose `fetch`
 * stub routes the component's address here instead of to a socket.
 *
 * No socket is opened, so a test that fakes `setTimeout` cannot hold the
 * call: from undici 6.28 (Node 22.23) a pooled keep-alive socket is reused
 * only after a zero-delay timer fires, and a faked clock that nothing
 * advances never fires it.
 *
 * @param model - The double to answer with.
 * @returns A `fetch`-shaped handler for requests to the component's address.
 */
export function spanModelFetch(
  model: SpanModel = new RecordedSpanModel(),
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const reply = await answerSpanRequest(model, {
      method: request.method,
      path: new URL(request.url).pathname,
      readBody: (): Promise<string> => request.text(),
    });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

/**
 * Serve a span model over HTTP the way the compose component does, for the
 * Convex action tests that reach it through `DAY0_REDACTOR_URL`.
 *
 * Args:
 *   model: The double to serve.
 *
 * Returns:
 *   The base URL and a function that stops the server.
 */
export async function serveSpanModel(model: SpanModel = new RecordedSpanModel()): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse): void => {
    const readBody = (): Promise<string> =>
      new Promise<string>((resolve, reject): void => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string): void => {
          body += chunk;
        });
        request.on('end', (): void => resolve(body));
        request.on('error', reject);
      });
    // The server's callback returns nothing; a failure to answer ends the response with a 500.
    void answerSpanRequest(model, {
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      readBody,
    }).then(
      (reply: SpanReply): void => {
        response.writeHead(reply.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(reply.body));
      },
      (error: unknown): void => {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      },
    );
  });
  await new Promise<void>((resolve): void => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: (): Promise<void> =>
      new Promise((resolve, reject): void => {
        server.close((error?: Error): void => (error ? reject(error) : resolve()));
      }),
  };
}
