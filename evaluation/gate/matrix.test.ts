import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GATE_FIXTURE } from './fixture';
import { buildGateMatrix, renderGateMatrix, type GateMatrixEvidence } from './matrix';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

/** Every tracked matrix: the published runs and the reruns kept beside a bed. */
function trackedMatrices(): URL[] {
  const gateRuns = readdirSync(new URL('./', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => new URL(`./${entry.name}/matrix.json`, import.meta.url));
  const bedReruns = readdirSync(new URL('../results/', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => new URL(`../results/${entry.name}/gate/matrix.json`, import.meta.url));
  return [...gateRuns, ...bedReruns].filter((url) => existsSync(url));
}

describe('the gate-accuracy fixture', (): void => {
  it('reviews 28 labelled actions in both switch states without a model', (): void => {
    const evidence = buildGateMatrix(COMMIT, new Date('2026-08-30T09:30:00.000Z'));
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
    const evidence = buildGateMatrix(COMMIT, new Date('2026-08-30T09:30:00.000Z'));
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

  it('records and renders the commit the matrix was measured at', (): void => {
    const evidence = buildGateMatrix(COMMIT, new Date('2026-09-27T09:00:00.000Z'));
    expect(evidence.commit).toBe(COMMIT);
    expect(renderGateMatrix(evidence)).toContain(
      `Generated 2026-09-27T09:00:00.000Z at commit \`${COMMIT}\``,
    );
  });

  it('reproduces every tracked matrix from the current gate, so a published cell cannot drift', (): void => {
    const current = buildGateMatrix(COMMIT);
    const files = trackedMatrices();
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const file of files) {
      const published = JSON.parse(readFileSync(file, 'utf8')) as GateMatrixEvidence;
      expect(
        {
          fixtureSize: current.fixtureSize,
          observations: current.observations,
          summaries: current.summaries,
        },
        file.pathname,
      ).toEqual({
        fixtureSize: published.fixtureSize,
        observations: published.observations,
        summaries: published.summaries,
      });
    }
  });
});
