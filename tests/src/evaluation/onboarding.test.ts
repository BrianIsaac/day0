import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { loadEvaluationTasks } from '../../../evaluation/graders';
import { MOCK_OFFICE_SYSTEMS } from '../../fixtures/mock-office';

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

  it('carries no word any task grader looks for, since only day0 receives it', async (): Promise<void> => {
    const transcript = (await readTranscript()).toLowerCase();
    for (const task of await loadEvaluationTasks()) {
      for (const effect of task.grader.requiredEffects) {
        const needles =
          effect.kind === 'terminal-reason'
            ? effect.includesAny
            : effect.kind === 'slack-message' || effect.kind === 'tweet-reply'
              ? effect.includesAll
              : effect.kind === 'ticket'
                ? (effect.commentIncludesAll ?? [])
                : [];
        for (const needle of needles) {
          expect(transcript, `transcript contains ${task.id}'s "${needle}"`).not.toContain(
            needle.toLowerCase(),
          );
        }
      }
    }
  });

  it('does not place team guidance in Notion, which the graded office does not have', async (): Promise<void> => {
    expect(await readTranscript()).not.toMatch(/\bNotion\b/);
  });
});

async function readTranscript(): Promise<string> {
  const fixture = JSON.parse(
    await readFile(new URL('../../../evaluation/onboarding/day0.json', import.meta.url), 'utf8'),
  ) as { transcript: string };
  return fixture.transcript;
}
