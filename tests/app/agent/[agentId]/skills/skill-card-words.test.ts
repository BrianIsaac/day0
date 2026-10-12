import { describe, expect, it } from 'vitest';
import {
  adoptedFromWords,
  registeredSourceChip,
  attemptLine,
  attemptsSpentSentence,
  checkInWords,
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
    // The stored newer-version reason is said in words (the pre-tag walk, W-1: "V2 is verified").
    expect(recheckSentence('v3 is verified; this runs v2', 'Mira')).toBe(
      'Version 3 is verified; this runs version 2. Mira keeps running the verified version until it is re-checked.',
    );
    expect(recheckSentence('v3 is verified; this runs v2.', 'Mira')).toBe(
      'Version 3 is verified; this runs version 2. Mira keeps running the verified version until it is re-checked.',
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

describe('where a registered skill came from (the real-Linear walk, m2)', (): void => {
  it('chips a skill the employee wrote, one it adopted and a built-in one apart', (): void => {
    expect(registeredSourceChip({ sourceType: 'agent-authored' })).toBe('authored');
    expect(registeredSourceChip({ sourceType: 'agent-authored', adoptedAt: 5 })).toBe('adopted');
    expect(registeredSourceChip({ sourceType: 'builtin' })).toBe('built in');
  });

  it('says whose version an adopted skill runs', (): void => {
    expect(adoptedFromWords({ version: 2, authorName: 'Priya' })).toBe(
      'version 2, adopted from Priya',
    );
  });
});

describe('why a draft did not pass its check, in a manager’s words (W19-8)', (): void => {
  // Nell's "Write a new one instead" on the v0.19.0 walk: attempt 1 and attempt 2, their logs.
  const UNDECLARED =
    "the authored skill is not a reusable procedure: SKILL.md uses `<closed-state>` without declaring it under `## Inputs`; declare it there as a line starting with `<closed-state>`, as in: - `<record-id>`: the candidate's identifier on the surface the work came from (the `Refs:` line or the candidate id).";
  const SMOKE =
    'verification in Daytona failed - smoke test exited 1. ran in Daytona (ec1cf0ac-a3b1-4ef5-8ad8-0e4e15c080e6)';

  it('says what the check found and what Retry does, with no checker terms', (): void => {
    expect(checkInWords(UNDECLARED, 'Nell')).toBe(
      'The draft uses <closed-state> without listing it as one of its inputs, so it would not run for the next item like this one. Retry hands Nell the reason.',
    );
    expect(checkInWords(SMOKE, 'Nell')).toBe(
      'Its smoke test failed when it ran in the sandbox. Retry hands Nell the failure to fix.',
    );
    for (const said of [checkInWords(UNDECLARED, 'Nell'), checkInWords(SMOKE, 'Nell')]) {
      expect(said).not.toMatch(/SKILL\.md|## Inputs|exited 1|Daytona|`/);
    }
  });

  it('says a syntax refusal and a one-item draft in words, and leaves a reason already in words', (): void => {
    expect(
      checkInWords('the smoke test does not parse at line 4, column 2: `assert x ==`', 'Nell'),
    ).toBe('Its smoke test is not valid at line 4. Retry hands Nell the error to fix.');
    expect(
      checkInWords(
        'the authored skill is not a reusable procedure: it repeats one item values',
        'Nell',
      ),
    ).toBe(
      'The draft is written for one item rather than as a procedure for any item like it. Retry hands Nell the reason.',
    );
    // An exit 0 that showed nothing is no failed run (the second pass).
    expect(
      checkInWords(
        'verification in Daytona failed - smoke test exited 0 but printed nothing, so the run produced no verification signal',
        'Nell',
      ),
    ).toBe(
      'Its smoke test ran in the sandbox but did not show the skill following its inputs. Retry hands Nell the reason.',
    );
    expect(checkInWords('The sandbox component is not running.', 'Nell')).toBe(
      'The sandbox component is not running.',
    );
  });
});
