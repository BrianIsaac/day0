import { describe, expect, it } from 'vitest';
import {
  attemptLine,
  attemptsSpentSentence,
  givenUpOutcome,
  namesInWords,
  recheckStartedOutcome,
  revisionRowSentence,
  recheckSentence,
  retireOutcome,
  revisionStartedOutcome,
  revisionSentence,
  usedTimes,
  withdrawOutcome,
} from '../../../../../app/agent/[agentId]/skills/skill-card-words';

describe('the skill cards’ words (10-C)', (): void => {
  it('says how often a skill was used, as the prototype does, and when it never was', (): void => {
    expect(usedTimes(1)).toBe('used 1 time');
    expect(usedTimes(2)).toBe('used 2 times');
    expect(usedTimes(0)).toBe('not used yet');
    expect(usedTimes(undefined)).toBe('not used yet');
  });

  it('counts the attempt a failed draft is on, out of three, and says nothing before the count', (): void => {
    expect(attemptLine(1)).toBe('Attempt 1 of 3');
    expect(attemptLine(3)).toBe('Attempt 3 of 3');
    expect(attemptLine(undefined)).toBeUndefined();
    expect(attemptLine(0)).toBeUndefined();
    // A row past the limit, from before Retry was withdrawn, is counted, not capped.
    expect(attemptLine(4)).toBe('4 attempts');
  });

  it('turns a re-check reason into the card’s sentence, naming who keeps running the skill', (): void => {
    expect(recheckSentence('the tools you approved on linear changed', 'Mira')).toBe(
      'The tools you approved on linear changed. Mira keeps running the verified version until it is re-checked.',
    );
    expect(recheckSentence('v3 is verified; this runs v2.', 'Mira')).toBe(
      'V3 is verified; this runs v2. Mira keeps running the verified version until it is re-checked.',
    );
  });

  it('says a revision began, and that the running version keeps running (C-m2)', (): void => {
    expect(revisionStartedOutcome('kanban-comment-and-close', 'Mira')).toBe(
      'A revision of kanban-comment-and-close is being written. Mira keeps running this version until the new one registers.',
    );
  });

  it('says a revision is written beside the running version', (): void => {
    expect(revisionSentence('Mira')).toBe(
      'A revision is being written. Mira keeps running this version until the new one registers.',
    );
  });

  it('says what a retire and a withdrawal did, for the live region', (): void => {
    expect(retireOutcome('kanban-comment-and-close', 'Mira', 0)).toBe(
      'kanban-comment-and-close is retired from Mira.',
    );
    expect(retireOutcome('kanban-comment-and-close', 'Mira', 2)).toBe(
      'kanban-comment-and-close is retired from Mira. 2 approved items wait for a skill again.',
    );
    expect(retireOutcome('kanban-comment-and-close', 'Mira', 1)).toBe(
      'kanban-comment-and-close is retired from Mira. 1 approved item waits for a skill again.',
    );
    expect(
      withdrawOutcome('kanban-comment-and-close', { holders: 2, returnedItems: 0, stoppedRuns: 0 }),
    ).toBe('kanban-comment-and-close is withdrawn from 2 employees.');
    expect(
      withdrawOutcome('kanban-comment-and-close', { holders: 1, returnedItems: 3, stoppedRuns: 0 }),
    ).toBe(
      'kanban-comment-and-close is withdrawn from 1 employee. 3 approved items wait for a skill again.',
    );
    expect(
      withdrawOutcome('kanban-comment-and-close', { holders: 2, returnedItems: 0, stoppedRuns: 2 }),
    ).toBe(
      'kanban-comment-and-close is withdrawn from 2 employees. 2 runs under way were stopped.',
    );
  });

  it('says why Retry is withdrawn at the third attempt, and what Give up does', (): void => {
    expect(attemptsSpentSentence(false)).toBe(
      'All 3 attempts failed, so Retry is no longer offered. Give up ends the skill and cancels the work waiting for it, with the reason.',
    );
    expect(attemptsSpentSentence(true)).toBe(
      'All 3 attempts failed, so Retry is no longer offered. Give up ends this revision; the registered version keeps running.',
    );
  });

  it('says a revision row is written beside the registered version', (): void => {
    expect(revisionRowSentence('Mira')).toBe(
      'A revision of a registered skill. Mira keeps running the registered version until this one registers.',
    );
  });

  it('says what a Give up and a re-check did, for the live region', (): void => {
    expect(givenUpOutcome('analytics-refresh-value', 0)).toBe(
      'analytics-refresh-value is given up.',
    );
    expect(givenUpOutcome('analytics-refresh-value', 1)).toBe(
      'analytics-refresh-value is given up; 1 waiting item is cancelled.',
    );
    expect(givenUpOutcome('analytics-refresh-value', 2)).toBe(
      'analytics-refresh-value is given up; 2 waiting items are cancelled.',
    );
    expect(recheckStartedOutcome('kanban-comment-and-close')).toBe(
      'A re-check of kanban-comment-and-close was asked for. It keeps running unless the check fails.',
    );
  });

  it('names a list of employees as a sentence does', (): void => {
    expect(namesInWords(['Mira'])).toBe('Mira');
    expect(namesInWords(['Mira', 'Tomas'])).toBe('Mira and Tomas');
    expect(namesInWords(['Mira', 'Tomas', 'Aiko'])).toBe('Mira, Tomas and Aiko');
  });
});
