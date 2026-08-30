import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { loadEvaluationTasks } from '../../../evaluation/graders';
import { MOCK_OFFICE_SYSTEMS } from '../../../src/evaluation/scopes';

describe('day0 onboarding fixture', (): void => {
  it('states boundaries generically rather than naming the systems the out-of-scope tasks probe', async (): Promise<void> => {
    const fixture = JSON.parse(
      await readFile(new URL('../../../evaluation/onboarding/day0.json', import.meta.url), 'utf8'),
    ) as { transcript: string; provenance: string };
    const transcript = fixture.transcript.toLowerCase();
    expect(fixture.provenance).toContain('not a verbatim transcript');
    expect(transcript).not.toContain('eval-');
    const office = new Set<string>(MOCK_OFFICE_SYSTEMS);
    const probed = (await loadEvaluationTasks())
      .filter((task) => task.category === 'out-of-scope')
      .map((task) => task.seed.sourceSystem)
      .filter((system) => !office.has(system));
    expect(probed.length).toBeGreaterThanOrEqual(3);
    for (const system of probed) {
      expect(transcript, `transcript names ${system}`).not.toContain(system);
    }
  });
});
