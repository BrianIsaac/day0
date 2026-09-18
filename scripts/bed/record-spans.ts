/// <reference types="node" />
/**
 * Record the span model's answers over the company bed's pages.
 *
 *   DAY0_REDACTOR_URL=http://127.0.0.1:<port> pnpm bed:record-spans
 *
 * Documentation sync sends each page's title and body to the redaction
 * component whole, so the component's answer for a page's exact text is what
 * sync will act on. `tests/bed/company-docs.test.ts` replays this recording
 * through the guard, the structural grammar and the policy, which is how the
 * suite knows the deployed model stores the tile login and nothing else on
 * these pages without running a model. On 18 September the model took a
 * backticked Slack channel and a Web API method name on two drafts of these
 * pages for tokens; a page edited since the recording has no answer in it, and
 * the test says to record again.
 *
 * The component is internal to the Compose network, so the URL has to be one
 * this machine can reach (a published or forwarded port). Only hashes of the
 * texts, offsets, labels and scores are written.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { markdownPageTitle } from '../../src/docs/readers/folder';
import { HttpSpanModel } from '../../src/redaction/client';
import { MODEL_THRESHOLD, REQUESTED_LABELS } from '../../src/redaction/policy';
import { trackedPages } from './docs';
import { BED_DIR } from './spec';

export const SPANS_PATH = 'tests/fixtures/bed/company-spans.json';
/** The Notion texts, recorded as they are in git (the token line a placeholder). */
export const NOTION_PAGES: readonly string[] = ['linear-automation.md', 'slack-automation-policy.md'];

export interface BedSpanRecording {
  model: string;
  labels: string[];
  threshold: number;
  recordedAt: string;
  /** sha256 of the exact text sent, to the spans the model answered. */
  spans: Record<string, Array<{ start: number; end: number; label: string; score: number }>>;
}

/** The key a text is recorded under. */
export function textKey(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Every text sync sends to the model for the bed's pages: each title and each body.
 *
 * Args:
 *   cwd: Repository root.
 *
 * Returns:
 *   The texts, titles first per page.
 */
export function bedTexts(cwd: string): string[] {
  const texts: string[] = [];
  for (const page of trackedPages(join(cwd, BED_DIR, 'folder'))) {
    texts.push(markdownPageTitle(page.content, page.ref), page.content);
  }
  for (const file of NOTION_PAGES) {
    const content = readFileSync(join(cwd, BED_DIR, 'notion', file), 'utf8');
    texts.push(markdownPageTitle(content, file), content);
  }
  return texts;
}

async function main(): Promise<number> {
  const url = process.env.DAY0_REDACTOR_URL?.trim();
  if (!url) {
    console.error(
      'DAY0_REDACTOR_URL is unset. Point it at a redaction component this machine can reach, ' +
        'for example a port forwarded to a running bed\'s `redactor` service.',
    );
    return 1;
  }
  const health = await fetch(new URL('/healthz', url.endsWith('/') ? url : `${url}/`));
  const body = (await health.json()) as { ok?: boolean; model?: string };
  if (!body.ok || !body.model) {
    console.error(`the component at ${url} is not healthy`);
    return 1;
  }
  const model = new HttpSpanModel(url);
  const recording: BedSpanRecording = {
    model: body.model,
    labels: [...REQUESTED_LABELS],
    threshold: MODEL_THRESHOLD,
    recordedAt: new Date().toISOString(),
    spans: {},
  };
  for (const text of bedTexts(process.cwd())) {
    recording.spans[textKey(text)] = (await model.spans(text, REQUESTED_LABELS, MODEL_THRESHOLD)).map(
      (span) => ({ ...span, score: Number(span.score.toFixed(4)) }),
    );
  }
  mkdirSync(dirname(SPANS_PATH), { recursive: true });
  writeFileSync(SPANS_PATH, `${JSON.stringify(recording, null, 1)}\n`, 'utf8');
  console.log(`recorded ${Object.keys(recording.spans).length} texts from ${body.model} into ${SPANS_PATH}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
