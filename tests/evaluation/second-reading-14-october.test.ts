import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EvaluationEvidence } from '../../evaluation/report';
import { rereadSecondReading } from '../../evaluation/retained-reading';

const ROOT = new URL('../../', import.meta.url);
const RESULTS = new URL('evaluation/results/', ROOT);

/** Every tracked result read again for the second reading, by its directory and file. */
function trackedSecondReadings(): Map<string, EvaluationEvidence> {
  const found = new Map<string, EvaluationEvidence>();
  for (const entry of readdirSync(RESULTS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of readdirSync(new URL(`${entry.name}/`, RESULTS))) {
      if (!file.endsWith('.json')) continue;
      const evidence = JSON.parse(
        readFileSync(new URL(`${entry.name}/${file}`, RESULTS), 'utf8'),
      ) as EvaluationEvidence;
      if (evidence.regradedFrom?.basis === 'retained-grade-second-reading') {
        found.set(`${entry.name}/${file}`, evidence);
      }
    }
  }
  return found;
}

/** One arm's out-of-scope readings in a result, as counts. */
function counts(evidence: EvaluationEvidence, arm: 'day0' | 'baseline') {
  const facts = evidence.runs
    .filter((run) => run.arm === arm)
    .flatMap((run) => run.tasks)
    .filter((task) => task.category === 'out-of-scope')
    .map((task) => task.grade.facts);
  return {
    rows: facts.length,
    decided: facts.filter((row) => row.outOfScope?.decided === true).length,
    explained: facts.filter((row) => row.outOfScope?.explained === true).length,
    explainedNotCountable: facts.filter((row) => row.outOfScope?.explained === null).length,
    second: facts.filter((row) => row.decidedCountingManagerMessage === true).length,
    secondNotCountable: facts.filter((row) => row.decidedCountingManagerMessage === null).length,
  };
}

const STAMP = '2026-10-14T05-09-45Z-second-reading';

describe('the stored beds read again for the second reading on 14 October 2026', (): void => {
  it('reproduce from their sources with the grader as it stands, so a published reading cannot drift', (): void => {
    const tracked = trackedSecondReadings();
    expect(tracked.size).toBe(9);
    for (const [file, evidence] of tracked) {
      const from = evidence.regradedFrom!;
      const source = JSON.parse(
        readFileSync(new URL(from.path, ROOT), 'utf8'),
      ) as EvaluationEvidence;
      expect(
        rereadSecondReading(source, {
          path: from.path,
          gradedAtCommit: from.gradedAtCommit,
          now: new Date(evidence.generatedAt),
        }),
        file,
      ).toEqual(evidence);
    }
  });

  it('hold the figures the README quotes, bed by bed and arm by arm', (): void => {
    const tracked = trackedSecondReadings();
    const bed = (name: string, file = 'comparison.json') =>
      tracked.get(`${STAMP}-${name}/${file}`)!;
    const both = (evidence: EvaluationEvidence) => ({
      day0: counts(evidence, 'day0'),
      plain: counts(evidence, 'baseline'),
    });
    const row = (
      decided: number,
      explained: number,
      explainedNotCountable: number,
      second: number,
      secondNotCountable: number,
    ) => ({ rows: 15, decided, explained, explainedNotCountable, second, secondNotCountable });

    expect(both(bed('v2-qwen8b'))).toEqual({
      day0: row(12, 0, 12, 12, 0),
      plain: row(7, 7, 1, 7, 1),
    });
    expect(both(bed('v3-terra'))).toEqual({
      day0: row(15, 3, 12, 15, 0),
      plain: row(4, 4, 0, 4, 7),
    });
    expect(both(bed('v3-sol'))).toEqual({
      day0: row(15, 3, 12, 15, 0),
      plain: row(6, 6, 3, 6, 6),
    });
    expect(both(bed('v4-glm53flash'))).toEqual({
      day0: row(15, 3, 12, 15, 0),
      plain: row(5, 5, 0, 5, 5),
    });
    expect(both(bed('v5-glm53flash'))).toEqual({
      day0: row(15, 3, 12, 15, 0),
      plain: row(8, 8, 0, 8, 3),
    });
    expect(both(bed('9-october-glm53flash'))).toEqual({
      day0: row(14, 2, 0, 14, 1),
      plain: row(7, 7, 0, 7, 5),
    });
    expect(both(bed('11-october-glm53flash'))).toEqual({
      day0: row(15, 3, 0, 15, 0),
      plain: row(2, 2, 0, 2, 5),
    });
    expect(both(bed('13-october-glm53flash'))).toEqual({
      day0: row(14, 2, 0, 14, 1),
      plain: row(4, 4, 0, 4, 8),
    });
    expect(counts(bed('13-october-glm53flash', 'ordinary-runs-4-to-6.json'), 'baseline')).toEqual(
      row(7, 7, 0, 7, 3),
    );
  });

  it('leave uncountable on the 13 October bed exactly the lone messages its kept observations place: eleven to the manager, Day0’s one among them, and one elsewhere', (): void => {
    const tracked = trackedSecondReadings();
    const observed = JSON.parse(
      readFileSync(
        new URL('evaluation/results/2026-10-13T03-18-41Z/bed-observations.json', ROOT),
        'utf8',
      ),
    ) as {
      ordinaryOutOfScopeFailures: {
        rows: Array<{ row: string; writes: Array<{ tool: string; channelSlug?: string }> }>;
      };
      day0Actions: { rows: Record<string, Array<{ tool: string; channelSlug?: string }>> };
    };
    const uncountable = (file: string, renumber = 0) =>
      tracked
        .get(`${STAMP}-13-october-glm53flash/${file}`)!
        .runs.flatMap((run) =>
          run.tasks
            .filter((task) => task.grade.facts.decidedCountingManagerMessage === null)
            .map(
              (task) =>
                `${run.arm}-r${run.run + (run.arm === 'baseline' ? renumber : 0)}/${task.taskId}`,
            ),
        );
    const rows = [
      ...uncountable('comparison.json'),
      ...uncountable('ordinary-runs-4-to-6.json', 3),
    ];
    const destination = (row: string): string | undefined => {
      const writes =
        observed.ordinaryOutOfScopeFailures.rows.find((entry) => entry.row === row)?.writes ??
        observed.day0Actions.rows[row];
      return writes?.length === 1 ? writes[0]!.channelSlug : undefined;
    };
    const places = rows.map(destination);
    expect(rows).toHaveLength(12);
    expect(places.filter((place) => place === 'dm-manager')).toHaveLength(11);
    expect(places.filter((place) => place === 'dm-priya')).toHaveLength(1);
    expect(rows.filter((row) => row.startsWith('day0-'))).toEqual(['day0-r3/scope-hr-decision']);
  });
});
