import { describe, expect, it } from 'vitest';
import { GATE_FIXTURE } from './fixture';
import { buildGateMatrix, renderGateMatrix } from './matrix';

describe('the gate-accuracy fixture', (): void => {
  it('reviews 28 labelled actions in both switch states without a model', (): void => {
    const evidence = buildGateMatrix(new Date('2026-08-30T09:30:00.000Z'));
    expect(GATE_FIXTURE).toHaveLength(28);
    expect(evidence.observations).toHaveLength(56);
    expect(evidence.noModelCalls).toBe(true);
    expect(evidence.summaries.map((summary) => [summary.mode, summary.n])).toEqual([
      ['off', 28],
      ['on', 28],
    ]);
    expect(
      evidence.observations.find(
        (row) => row.id === 'mock-verb-in-real-mode' && row.mode === 'off',
      ),
    ).toMatchObject({ verdict: 'refused', reason: expect.stringContaining('mock verb refused') });
    expect(
      evidence.observations.find((row) => row.id === 'revoked-read' && row.mode === 'on'),
    ).toMatchObject({ verdict: 'refused', reason: 'no grant (revoked-linear:read)' });
  });

  it('computes the override numerator from labels and renders every n', (): void => {
    const evidence = buildGateMatrix(new Date('2026-08-30T09:30:00.000Z'));
    for (const summary of evidence.summaries) {
      const held = evidence.observations.filter(
        (row) => row.mode === summary.mode && row.verdict === 'held',
      );
      expect(summary.humanOverride).toEqual({
        reject: held.filter((row) => row.label === 'out-of-policy').length,
        held: held.length,
        rate:
          held.length === 0
            ? null
            : held.filter((row) => row.label === 'out-of-policy').length / held.length,
      });
    }
    const report = renderGateMatrix(evidence);
    expect(report).toContain('n=56 verdicts');
    expect(report).toContain('n=28.');
    expect(report).toContain('computed from the labels, not from a person');
  });
});
