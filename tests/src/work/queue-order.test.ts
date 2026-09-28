import { describe, expect, it } from 'vitest';
import {
  EVALUATION_ATTEMPTS_SPENT,
  MAX_EVALUATION_ATTEMPTS,
  compareWaitingRows,
  queueRank,
} from '../../../src/work/queue-order';

const PRIORITIES = [
  undefined,
  '',
  'Urgent',
  'P0',
  'production-down',
  'High',
  'p1',
  'Medium',
  'P2 - medium',
  'Low',
  'p3',
  'No priority',
  'Highest',
];

describe('the waiting queue order the loop runs and its readers show', (): void => {
  it('ranks every priority label from urgent to none', (): void => {
    expect(PRIORITIES.map(queueRank)).toEqual([4, 4, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it('parks a row after three evaluations die, under a reason of its own', (): void => {
    expect(MAX_EVALUATION_ATTEMPTS).toBe(3);
    expect(EVALUATION_ATTEMPTS_SPENT).toBe('evaluation-attempts-spent');
  });

  it('serves the unattempted before the attempted, then the most urgent, then the oldest', (): void => {
    const rows = [
      { id: 'old-low', _creationTime: 1, priority: 'Low' },
      { id: 'new-urgent', _creationTime: 5, priority: 'Urgent' },
      { id: 'died-urgent', _creationTime: 0, priority: 'Urgent', evaluationAttempts: 1 },
      { id: 'old-urgent', _creationTime: 2, priority: 'Urgent' },
      { id: 'none', _creationTime: 3 },
    ];
    expect([...rows].sort(compareWaitingRows).map((row) => row.id)).toEqual([
      'old-urgent',
      'new-urgent',
      'old-low',
      'none',
      'died-urgent',
    ]);
  });
});
