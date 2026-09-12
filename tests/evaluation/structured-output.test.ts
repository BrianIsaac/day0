import { describe, expect, it } from 'vitest';
import {
  decodeConsoleString,
  structuredOutputDiagnostics,
  structuredOutputRecord,
} from '../../evaluation/structured-output';
import type { StructuredOutputDiagnostics } from '../../src/lib/structured-repair';
import type { EvaluationEvidence } from '../../evaluation/report';

const call: StructuredOutputDiagnostics = {
  version: 1,
  id: 'call-1',
  agent: 'executor',
  mode: 'prompt',
  startedAt: '2026-09-12T07:00:01.000Z',
  finishedAt: '2026-09-12T07:00:02.000Z',
  firstReplyValid: false,
  validationFailures: 1,
  repairAttempts: 1,
  coercions: 0,
  outcome: 'valid',
};
const message = JSON.stringify({ msg: 'structured-output-call', diagnostics: call });
const log = JSON.stringify({ logLines: [{ messages: [`'${message}'`], isTruncated: false }] });
const evidence = {
  generatedAt: '2026-09-12T07:01:00.000Z',
  runs: [
    {
      id: 'day0-r1',
      arm: 'day0',
      tasks: [
        {
          taskId: 'test',
          startedAt: '2026-09-12T07:00:00.000Z',
          finishedAt: '2026-09-12T07:00:03.000Z',
          modelCalls: { logicalStages: 1 },
        },
      ],
    },
  ],
} as unknown as EvaluationEvidence;

describe('structured-output evaluation record', () => {
  it('counts each call once when progress and completion repeat its log', () => {
    const calls = structuredOutputDiagnostics(`${log}\n${log}\n`);
    expect(calls).toEqual([call]);
    const record = structuredOutputRecord(evidence, calls);
    expect(record.totals).toEqual({
      calls: 1,
      invalidFirstReplies: 1,
      validationFailures: 1,
      repairAttempts: 1,
      coercions: 0,
      failedCalls: 0,
    });
    expect(record.rows[0]).toMatchObject({
      taskId: 'test',
      coverage: 'complete',
      repairAttempts: 1,
    });
  });

  it('marks absent telemetry as incomplete rather than treating it as proof of zero repairs', () => {
    const record = structuredOutputRecord(evidence, []);
    expect(record.rows[0].coverage).toBe('incomplete');
  });

  it('keeps onboarding and other calls outside task windows separately', () => {
    const record = structuredOutputRecord(evidence, [
      { ...call, startedAt: '2026-09-12T06:59:00.000Z' },
    ]);
    expect(record.outsideTaskWindows).toEqual(['call-1']);
    expect(record.rows[0].calls).toBe(0);
  });

  it('rejects truncated diagnostics and conflicting duplicate ids', () => {
    const truncated = JSON.stringify({ logLines: [{ messages: [message], isTruncated: true }] });
    expect(() => structuredOutputDiagnostics(truncated)).toThrow('truncated');
    const conflicting = JSON.stringify({
      logLines: [
        {
          messages: [
            JSON.stringify({
              msg: 'structured-output-call',
              diagnostics: { ...call, repairAttempts: 2 },
            }),
          ],
        },
      ],
    });
    expect(() => structuredOutputDiagnostics(`${log}\n${conflicting}`)).toThrow('conflicting');
  });

  it('decodes console quoting as data and never executes expressions', () => {
    expect(decodeConsoleString("'a\\nb\\'c\\\\d'")).toBe("a\nb'c\\d");
    expect(decodeConsoleString('`value \\${process.exit()}`')).toBe('value ${process.exit()}');
  });
});
