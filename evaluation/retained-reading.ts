import { retainedOutOfScopeReading } from './graders';
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
