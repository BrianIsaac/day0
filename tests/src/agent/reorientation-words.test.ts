import { describe, expect, it } from 'vitest';
import {
  approvedResultWords,
  closingHeldReason,
  conflictQuestionText,
  decisionWords,
  heldWords,
  pendingWords,
  sentenceOf,
} from '../../../src/agent/reorientation-words';

describe('the reorientation card’s words (section 7, RM24)', (): void => {
  it('says a held closing phase with the card’s summary set apart, one full stop each (the second pass’s minors)', (): void => {
    expect(closingHeldReason('Mira', 'Its access “linear:write” was revoked')).toBe(
      'Mira stopped before its closing steps: a reorientation card is still open (Its access “linear:write” was revoked). Decide it, then Retry.',
    );
    expect(
      closingHeldReason('Mira', 'The organisation’s Linear connection was revoked: rotated.'),
    ).toBe(
      'Mira stopped before its closing steps: a reorientation card is still open (The organisation’s Linear connection was revoked: rotated). Decide it, then Retry.',
    );
    expect(sentenceOf('Priya, its approver, changed')).toBe('Priya, its approver, changed.');
    expect(sentenceOf('The connection was revoked: rotated.')).toBe(
      'The connection was revoked: rotated.',
    );
  });

  it('labels the question’s two pages as the answer names them, and says Retry runs the held steps', (): void => {
    expect(
      conflictQuestionText('Mira', 'Thresholds', [
        { title: 'Pipeline variance runbook', source: 'Company folder' },
        { title: 'Finance variance escalation', source: 'Company folder' },
      ]),
    ).toBe(
      'Two pages disagree under “Thresholds”: A, Pipeline variance runbook (Company folder), and B, Finance variance escalation (Company folder). Which is right? Mira runs the other steps now and holds the ones that may rely on this until you answer and Retry.',
    );
  });

  it('says Defer keeps what a card holds held', (): void => {
    expect(
      decisionWords({
        name: 'Mira',
        approves: 'Approve writes version 0.2.',
        revisit: '3 October',
      }),
    ).toBe(
      'Approve writes version 0.2. Defer revisits on 3 October and changes nothing. Dismiss closes the card and nothing changes.',
    );
    expect(
      decisionWords({
        name: 'Mira',
        approves: 'Approve writes version 0.2.',
        revisit: '3 October',
        holds: true,
      }),
    ).toBe(
      'Approve writes version 0.2. Defer revisits on 3 October and keeps what the card holds held until then. Dismiss closes the card and nothing changes.',
    );
  });

  it('says what a card holds as the hold stops it: plans at approval, runs before closing (second pass M3)', (): void => {
    expect(heldWords({ plans: 0, runs: 0 })).toBe('nothing held');
    expect(heldWords({ plans: 1, runs: 0 })).toBe('1 plan held');
    expect(heldWords({ plans: 2, runs: 1 })).toBe('2 plans held, 1 run held before closing');
    expect(heldWords({ plans: 0, runs: 3 })).toBe('3 runs held before closing');
    expect(pendingWords('Mira', { plans: 0, runs: 0 })).toBe(
      'Mira is working out what to propose. Nothing is held while it does.',
    );
    expect(pendingWords('Mira', { plans: 1, runs: 0 })).toBe(
      'Mira is working out what to propose. The plan it holds waits until you decide the card.',
    );
    expect(pendingWords('Mira', { plans: 0, runs: 2 })).toBe(
      'Mira is working out what to propose. The 2 runs it holds stop before their closing steps until you decide the card.',
    );
    expect(pendingWords('Mira', { plans: 2, runs: 1 })).toBe(
      'Mira is working out what to propose. The 2 plans it holds wait, and the run it holds stops before its closing steps, until you decide the card.',
    );
  });

  it('says what each Approve did', (): void => {
    expect(approvedResultWords.charter('0.2')).toBe('the charter was amended to version 0.2');
    expect(approvedResultWords.page('active', 'Runbook')).toBe('“Runbook” was marked current');
    expect(approvedResultWords.page('clear', 'Runbook')).toBe(
      '“Runbook” follows its source’s own status again',
    );
    expect(approvedResultWords.scope('grant', 'notion:read')).toBe(
      'access “notion:read” was granted',
    );
    expect(approvedResultWords.skill('withdraw', 'kanban')).toBe(
      'the skill “kanban” was withdrawn from every employee',
    );
  });
});
