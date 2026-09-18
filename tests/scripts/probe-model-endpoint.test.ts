import { readFileSync } from 'node:fs';
import type { Agent } from '@mastra/core/agent';
import { noopLogger } from '@mastra/core/logger';
import { describe, expect, it } from 'vitest';

import { SLOW_MODEL_HINT, silenceAgentLogs } from '../../scripts/probe-model-endpoint';
import { WAY_NAMES } from '../../src/setup/quickstart';

/**
 * `pnpm probe:model` is the first command the README hands a reader who is
 * deciding whether their endpoint can drive the loop, so everything it prints
 * has to be true of the README they then open: a heading that exists, and no
 * provider stack trace in the middle of a run the probe is calling a pass.
 */

const README = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

describe('the slow-model hint', (): void => {
  it('sends the reader to a heading the README actually has', (): void => {
    expect(SLOW_MODEL_HINT).toContain(`"${WAY_NAMES.local}"`);
    expect(README).toContain(`\n## ${WAY_NAMES.local}\n`);
  });

  it('does not name the heading the README dropped', (): void => {
    expect(SLOW_MODEL_HINT).not.toContain('Run it with no accounts');
    expect(README).not.toContain('## Run it with no accounts');
  });
});

describe('the probe agent', (): void => {
  it('logs nothing of its own, because the probe reports every failure itself', (): void => {
    const set: unknown[] = [];
    silenceAgentLogs({ __setLogger: (logger: unknown): void => void set.push(logger) } as Agent);
    expect(set).toEqual([noopLogger]);
  });
});
