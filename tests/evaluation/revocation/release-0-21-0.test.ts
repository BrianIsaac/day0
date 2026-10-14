import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  renderRevocationReport,
  summariseRevocationTrials,
  type RevocationEvidence,
} from '../../../evaluation/revocation/report';

const RESULTS = new URL('../../../evaluation/results/', import.meta.url);

/** One tracked revocation result: its evidence and the report written beside it. */
function result(directory: string): { evidence: RevocationEvidence; report: string } {
  return {
    evidence: JSON.parse(
      readFileSync(new URL(`${directory}/trials.json`, RESULTS), 'utf8'),
    ) as RevocationEvidence,
    report: readFileSync(new URL(`${directory}/trials.md`, RESULTS), 'utf8'),
  };
}

describe('the revocation trials recorded again on the v0.21.0 release commit', (): void => {
  const recorded = result('revocation-2026-10-14T06-29-07Z');
  const earlier = result('revocation-2026-09-02T12-17-54Z');

  it('render their report from their own evidence, byte for byte', (): void => {
    expect(renderRevocationReport(recorded.evidence)).toBe(recorded.report);
  });

  it('hold the figures the evaluation page quotes', (): void => {
    const all = summariseRevocationTrials(recorded.evidence.trials).all;
    expect(all).toMatchObject({
      trials: 17,
      attempted: 19,
      blocked: 15,
      landed: 4,
      landedByDesign: 4,
      unexpected: 0,
      timeToBlockMs: { n: 15, median: 56, max: 197 },
    });
    expect(recorded.evidence.summary.switchOff).toMatchObject({
      attempted: 5,
      blocked: 5,
      timeToBlockMs: { n: 5, median: 51, max: 59 },
    });
    expect(recorded.evidence.metricsReconciliation.matches).toBe(true);
    expect(recorded.evidence.configuration).toMatchObject({
      commit: 'c6cc7e6a268100f697b5817a12b45300d48d5183',
      model: 'zai-org/GLM-5.3-Flash',
      surfaceMode: 'real',
      composeProject: 'day0-w17q',
    });
  });

  it('block at the same checkpoints as the 2 September set, and no blocked attempt reached the provider', (): void => {
    const now = summariseRevocationTrials(recorded.evidence.trials).all;
    const then = summariseRevocationTrials(earlier.evidence.trials).all;
    expect(now.byCheckpoint).toEqual(then.byCheckpoint);
    const blocked = recorded.evidence.trials
      .flatMap((trial) => trial.attempts)
      .filter((attempt) => attempt.outcome === 'blocked');
    expect(blocked).toHaveLength(15);
    expect(blocked.every((attempt) => attempt.providerCallDelta === 0)).toBe(true);
  });
});
