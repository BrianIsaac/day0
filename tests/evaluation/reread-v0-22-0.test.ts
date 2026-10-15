import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  retainedDecidedCountingManagerMessage,
  retainedOutOfScopeReading,
} from '../../evaluation/graders';
import type { EvaluationEvidence } from '../../evaluation/report';
import { rereadSecondReading } from '../../evaluation/retained-reading';

const ROOT = new URL('../../', import.meta.url);
const RESULTS = new URL('evaluation/results/', ROOT);
const DIRECTORY = '2026-10-14T23-33-56Z-reread-v0-22-0';
const RELEASE_COMMIT = 'fddf16bd3d5aa0f70285cc4ea3d247d70cc740b7';
const BEDS = [
  '11-october-glm53flash',
  '13-october-glm53flash',
  '9-october-glm53flash',
  'v2-qwen8b',
  'v3-sol',
  'v3-terra',
  'v4-glm53flash',
  'v5-glm53flash',
];

/** A tracked result read from the checkout. */
function evidenceAt(path: string): EvaluationEvidence {
  return JSON.parse(readFileSync(new URL(path, ROOT), 'utf8')) as EvaluationEvidence;
}

/** Every re-read in the directory, by `<bed>/<file>`. */
function rereads(): Map<string, EvaluationEvidence> {
  const found = new Map<string, EvaluationEvidence>();
  for (const bed of readdirSync(new URL(`${DIRECTORY}/`, RESULTS))) {
    if (bed.includes('.')) continue;
    for (const file of readdirSync(new URL(`${DIRECTORY}/${bed}/`, RESULTS))) {
      if (file.endsWith('.json')) {
        found.set(`${bed}/${file}`, evidenceAt(`evaluation/results/${DIRECTORY}/${bed}/${file}`));
      }
    }
  }
  return found;
}

describe('the stored beds read again on the v0.22.0 release commit', (): void => {
  it('are the nine 14 October re-reads, each read again from the same source by the release commit’s grader', (): void => {
    const found = rereads();
    expect([...found.keys()].sort()).toEqual(
      [
        ...BEDS.map((bed) => `${bed}/comparison.json`),
        '13-october-glm53flash/ordinary-runs-4-to-6.json',
      ].sort(),
    );
    for (const [file, evidence] of found) {
      const from = evidence.regradedFrom!;
      expect(from.gradedAtCommit, file).toBe(RELEASE_COMMIT);
      expect(
        rereadSecondReading(evidenceAt(from.path), {
          path: from.path,
          gradedAtCommit: from.gradedAtCommit,
          now: new Date(evidence.generatedAt),
        }),
        file,
      ).toEqual(evidence);
    }
  });

  it('read every row, reading and figure as the 14 October re-reads did: only the time and the grader’s commit differ', (): void => {
    for (const [file, evidence] of rereads()) {
      const [bed, name] = file.split('/');
      const before = evidenceAt(
        `evaluation/results/2026-10-14T05-09-45Z-second-reading-${bed}/${name}`,
      );
      expect(before.regradedFrom!.path, file).toBe(evidence.regradedFrom!.path);
      expect({ ...evidence, generatedAt: '', regradedFrom: undefined }, file).toEqual({
        ...before,
        generatedAt: '',
        regradedFrom: undefined,
      });
      expect({ ...evidence.regradedFrom, gradedAtCommit: '' }, file).toEqual({
        ...before.regradedFrom,
        gradedAtCommit: '',
      });
    }
  });

  it('agree on the 14 October bed, which --reread refuses, with every reading graded live where the retained grade can count it', (): void => {
    const evidence = evidenceAt('evaluation/results/2026-10-14T05-19-07Z/comparison.json');
    const reasonIsAgentsWords = evidence.configuration.taskDefinitions !== undefined;
    const tally = { day0: [0, 0, 0, 0, 0], baseline: [0, 0, 0, 0, 0] };
    const disagreements: string[] = [];
    for (const run of evidence.runs) {
      for (const task of run.tasks) {
        if (task.category !== 'out-of-scope') continue;
        const live = task.grade.facts.outOfScope!;
        const retained = retainedOutOfScopeReading(task, { arm: run.arm, reasonIsAgentsWords });
        const second = retainedDecidedCountingManagerMessage(task, retained);
        const row = `${run.arm}-r${run.run}/${task.taskId}`;
        if (retained.decided !== live.decided) disagreements.push(`${row} decided`);
        if (retained.explained !== null && retained.explained !== live.explained) {
          disagreements.push(`${row} explained`);
        }
        if (second !== null && second !== task.grade.facts.decidedCountingManagerMessage) {
          disagreements.push(`${row} second reading`);
        }
        const counts = tally[run.arm];
        counts[0]! += 1;
        if (retained.decided === true) counts[1]! += 1;
        if (retained.explained === true) counts[2]! += 1;
        if (second === true) counts[3]! += 1;
        if (second === null) counts[4]! += 1;
      }
    }
    expect(disagreements).toEqual([]);
    expect(tally).toEqual({ day0: [30, 30, 6, 30, 0], baseline: [30, 7, 7, 7, 14] });
  });
});
