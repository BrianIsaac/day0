import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const bed = 'evaluation/results/2026-09-11T20-08-51Z-v2-glm53flash';
describe('GLM evidence disclosure', () => {
  it('discloses the absent arm before the generated comparison', () => {
    const report = readFileSync(`${bed}/semifinal.md`, 'utf8');
    expect(report.split('## Comparison scores')[0]).toContain('baseline only');
    expect(report.split('## Comparison scores')[0]).toContain('charter');
  });
  it('indexes the bed and both pilots as audit history', () => {
    const index = readFileSync('evaluation/README.md', 'utf8');
    for (const directory of [bed.split('/').at(-1)!, '2026-09-11T19-24-41Z', '2026-09-11T19-56-20Z']) {
      expect(index).toContain(directory);
    }
    expect(index).toContain('baseline-only');
  });
});
