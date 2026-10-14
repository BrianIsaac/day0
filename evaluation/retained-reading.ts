import { retainedDecidedCountingManagerMessage, retainedOutOfScopeReading } from './graders';
import type { EvaluationEvidence } from './report';

/*
 * A stored comparison result read again from its own retained grades. The
 * backend of a frozen bed is gone, so its rows cannot be graded again from
 * their work items (`pnpm eval:comparison -- --regrade` needs them). What a
 * result does keep of each row is its terminal state, its checks with their
 * detail and its prohibited flags, and the two out-of-scope readings are a
 * function of those alone.
 */

/** Where a re-read came from and what read it. */
export interface RereadProvenance {
  /** The source's path as a tracked result records it (`recordedSourcePath`). */
  path: string;
  /** The commit whose grader read the retained grades. */
  gradedAtCommit: string;
  now: Date;
}

/**
 * Re-read a stored result: each out-of-scope row gains the two readings, from
 * its retained grade; every other field of every row is the source's.
 *
 * A source that carries its task definitions was graded since the reason
 * check reads only what the agent wrote (27 September 2026); one that does
 * not was graded when the product's or the harness's own text could meet a
 * reason word, and its passes are read with that in mind.
 *
 * @returns New evidence; the source is not changed.
 * @throws when the source is itself a re-read or a row already records the readings.
 */
export function rereadRetainedEvidence(
  source: EvaluationEvidence,
  provenance: RereadProvenance,
): EvaluationEvidence {
  if (source.regradedFrom?.basis === 'retained-grade') {
    throw new Error(
      `the source is itself a re-read of ${source.regradedFrom.path}; re-read that run`,
    );
  }
  const reasonIsAgentsWords = source.configuration.taskDefinitions !== undefined;
  const evidence = structuredClone(source);
  for (const run of evidence.runs) {
    for (const task of run.tasks) {
      if (task.category !== 'out-of-scope') continue;
      if (task.grade.facts.outOfScope !== undefined) {
        throw new Error(`${run.id}/${task.taskId} already records the two out-of-scope readings`);
      }
      task.grade.facts.outOfScope = retainedOutOfScopeReading(task, {
        arm: run.arm,
        reasonIsAgentsWords,
      });
    }
  }
  evidence.generatedAt = provenance.now.toISOString();
  evidence.regradedFrom = {
    path: provenance.path,
    commit: source.configuration.commit,
    gradedAtCommit: provenance.gradedAtCommit,
    generatedAt: source.generatedAt,
    modelCallsMade: 0,
    basis: 'retained-grade',
  };
  return evidence;
}

/**
 * Read a stored result again for the second reading alone (14 October 2026):
 * a result that records the two out-of-scope readings, live since 11 October
 * 2026 or by an earlier re-read, gains on each out-of-scope row the reading
 * that also counts a run whose only write is one message to the manager, from
 * its retained grade beside its recorded readings. Every other field of every
 * row is the source's.
 *
 * @returns New evidence; the source is not changed.
 * @throws when the source is itself a re-read for the second reading, or a row records no
 *   reading or records the second already.
 */
export function rereadSecondReading(
  source: EvaluationEvidence,
  provenance: RereadProvenance,
): EvaluationEvidence {
  const earlier = source.regradedFrom;
  if (earlier?.basis === 'retained-grade-second-reading') {
    throw new Error(
      `the source is itself a re-read for the second reading of ${earlier.path}; read that source`,
    );
  }
  const evidence = structuredClone(source);
  for (const run of evidence.runs) {
    for (const task of run.tasks) {
      if (task.category !== 'out-of-scope') continue;
      const reading = task.grade.facts.outOfScope;
      if (reading === undefined) {
        throw new Error(
          `${run.id}/${task.taskId} records no out-of-scope reading; read the two first with --reread`,
        );
      }
      if (task.grade.facts.decidedCountingManagerMessage !== undefined) {
        throw new Error(`${run.id}/${task.taskId} already records the second reading`);
      }
      task.grade.facts.decidedCountingManagerMessage = retainedDecidedCountingManagerMessage(
        task,
        reading,
      );
    }
  }
  evidence.generatedAt = provenance.now.toISOString();
  evidence.regradedFrom = {
    path: provenance.path,
    commit: source.configuration.commit,
    gradedAtCommit: provenance.gradedAtCommit,
    generatedAt: earlier?.generatedAt ?? source.generatedAt,
    modelCallsMade: 0,
    basis: 'retained-grade-second-reading',
    ...(earlier
      ? { twoReadingsFrom: { path: earlier.path, gradedAtCommit: earlier.gradedAtCommit } }
      : {}),
  };
  return evidence;
}
