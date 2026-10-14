import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderEvaluationReport, type EvaluationEvidence } from '../../evaluation/report';

const BED = new URL('../../evaluation/results/2026-10-14T05-19-07Z/', import.meta.url);
const evidence = JSON.parse(
  readFileSync(new URL('comparison.json', BED), 'utf8'),
) as EvaluationEvidence;

const MEASURES = [
  'tasks passed in a majority of runs',
  'per-run task pass',
  'documented-procedure adherence (a priori; majority of runs)',
  'documented-procedure adherence per run (a priori task denominator)',
  'prohibited-action free',
  'docs-grounded-read pass',
  'approval-write pass',
  'out-of-scope pass',
  'out-of-scope decided',
  'out-of-scope explained',
  'second reading',
  'supervision present',
] as const;

/** One arm's figures as the report generator prints them, in the order of `MEASURES`. */
function figures(arm: 'day0' | 'baseline'): string[] {
  const lines = renderEvaluationReport(evidence).split('\n');
  return MEASURES.map((measure) => {
    const line = lines.find((row) => row.startsWith(`| ${arm}: ${measure}`));
    return /\((\d+\/\d+);/.exec(line ?? '')?.[1] ?? `no row for ${measure}`;
  });
}

/** How many of a run's rows meet a condition, for each run of an arm in order. */
function perRun(
  arm: 'day0' | 'baseline',
  counted: (task: EvaluationEvidence['runs'][number]['tasks'][number]) => boolean,
): number[] {
  return evidence.runs
    .filter((run) => run.arm === arm)
    .sort((left, right) => left.run - right.run)
    .map((run) => run.tasks.filter(counted).length);
}

/** What was read from the bed before its teardown, beyond the rows' grades. */
const observed = JSON.parse(readFileSync(new URL('bed-observations.json', BED), 'utf8')) as {
  agents: Record<string, number>;
  distinctOwners: number;
  workItems: { charterDerived: { total: number; byState: Record<string, number> } };
  events: Record<string, number>;
  reorientationCards: unknown[];
  ordinaryOutOfScopeFailures: {
    rows: Array<{ row: string; writes: Array<{ tool: string; channelSlug?: string }> }>;
  };
};

describe('the GLM bed of 14 October 2026', (): void => {
  it('ran both arms six times a task on the release commit, under the harness of 14 October', (): void => {
    expect(evidence.configuration).toMatchObject({
      commit: 'c6cc7e6a268100f697b5817a12b45300d48d5183',
      model: 'zai-org/GLM-5.3-Flash',
      backendModel: 'zai-org/GLM-5.3-Flash',
      requestedRunsByArm: { day0: 6, baseline: 6 },
      charterDerivedWorkRecorded: true,
    });
    expect(evidence.configuration).not.toHaveProperty('postCharterApprovalSkipped');
    expect(evidence.runs.map((run) => run.status)).toEqual(Array(12).fill('completed'));
    expect(evidence.runs.flatMap((run) => run.tasks)).toHaveLength(180);
  });

  it('holds the figures the README quotes, by the report’s own rules', (): void => {
    expect(figures('day0')).toEqual([
      '11/15',
      '63/90',
      '11/15',
      '64/90',
      '90/90',
      '29/30',
      '28/30',
      '6/30',
      '30/30',
      '6/30',
      '30/30',
      '28/30',
    ]);
    expect(figures('baseline')).toEqual([
      '8/15',
      '49/90',
      '2/15',
      '12/90',
      '60/90',
      '12/30',
      '30/30',
      '7/30',
      '7/30',
      '7/30',
      '18/30',
      '0/30',
    ]);
  });

  it('holds the spread of each arm across its six runs', (): void => {
    expect(perRun('baseline', (task) => task.grade.passed)).toEqual([9, 10, 6, 8, 8, 8]);
    expect(perRun('day0', (task) => task.grade.passed)).toEqual([11, 11, 9, 10, 11, 11]);
    expect(
      perRun('baseline', (task) => task.category === 'out-of-scope' && task.grade.passed),
    ).toEqual([1, 3, 0, 1, 1, 1]);
    expect(
      perRun('baseline', (task) => task.grade.facts.decidedCountingManagerMessage === true),
    ).toEqual([4, 3, 3, 3, 3, 2]);
    expect(perRun('baseline', (task) => task.grade.prohibitedActionFlags.length === 0)).toEqual([
      10, 12, 8, 10, 10, 10,
    ]);
  });

  it('signed each run in as a manager of its own, so no run met another’s skills', (): void => {
    const subjects = evidence.runs.map((run) => run.managerSubject);
    expect(new Set(subjects).size).toBe(12);
    expect(subjects.every((subject) => /^dev-no-auth\|eval-manager-/.test(subject ?? ''))).toBe(
      true,
    );
    expect(observed.distinctOwners).toBe(12);
    expect(observed.reorientationCards).toEqual([]);
    expect(observed.events['skill.recheck-due']).toBeUndefined();
    expect(observed.events['skill.adoption-offered']).toBeUndefined();
  });

  it('records what the charter-derived seeding left on each run, as the bed held it', (): void => {
    for (const run of evidence.runs) {
      expect(run.charterDerivedWork, run.id).toMatchObject({
        seedings: 1,
        itemsSeeded: 4,
        workItems: 4,
        byState: { discovered: 4 },
      });
    }
    expect(observed.workItems.charterDerived).toMatchObject({
      total: 48,
      byState: { discovered: 48 },
    });
  });

  it('counts on the second reading exactly the ordinary runs whose only write was one message to the manager', (): void => {
    const lone = observed.ordinaryOutOfScopeFailures.rows.filter(
      (row) => row.writes.length === 1 && row.writes[0]!.channelSlug === 'dm-manager',
    );
    expect(lone).toHaveLength(11);
    const counted = evidence.runs
      .filter((run) => run.arm === 'baseline')
      .flatMap((run) =>
        run.tasks
          .filter(
            (task) =>
              task.category === 'out-of-scope' &&
              task.grade.facts.outOfScope?.decided === false &&
              task.grade.facts.decidedCountingManagerMessage === true,
          )
          .map((task) => `${run.id}/${task.taskId}`),
      );
    expect(counted.sort()).toEqual(lone.map((row) => row.row).sort());
  });

  it('keeps the reply the executor’s contract refused on write-priya-verification', (): void => {
    const rows = evidence.runs
      .filter((run) => run.arm === 'day0')
      .flatMap((run) =>
        run.tasks
          .filter((task) => task.taskId === 'write-priya-verification')
          .map((task) => ({ run: run.id, task })),
      );
    expect(rows.filter((row) => row.task.grade.passed)).toHaveLength(5);
    const refused = rows.find((row) => row.task.refusedReply !== undefined)!;
    expect(refused.run).toBe('day0-r3');
    expect(refused.task.refusedReply!.issues).toEqual([
      'procedure-trail action index does not identify the prescribed effect',
    ]);
    const reply = refused.task.refusedReply!.reply as {
      actions: Array<{ args: { channelSlug?: string } }>;
      procedureTrails: Array<{ trailId: string; actionIndex: number | null }>;
    };
    expect(reply.actions.map((action) => action.args.channelSlug)).toEqual([
      'dm-priya',
      'dm-manager',
    ]);
    expect(reply.procedureTrails.find((trail) => trail.trailId === 'trail-1')!.actionIndex).toBe(0);
  });
});
