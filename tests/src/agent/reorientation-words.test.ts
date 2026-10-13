import { describe, expect, it } from 'vitest';
import {
  approvedResultWords,
  closingHeldReason,
  conflictChoiceWords,
  conflictNoticeText,
  conflictQuestionText,
  conflictNoticeReplyLine,
  conflictReplyLine,
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

/** 16-J's walk (W3j): two folder sources each holding a page of one title, disagreeing. */
const SAME_TITLED = [
  { title: 'Close escalation window', source: 'Policies folder' },
  { title: 'Close escalation window', source: 'Revops folder' },
] as const;

describe('a conflict’s two pages named apart (W16-R12)', (): void => {
  it('gives the answer buttons two names when the pages share a title, as the question letters them', (): void => {
    const names = (['from', 'to', 'both'] as const).map((choice) =>
      conflictChoiceWords(choice, SAME_TITLED),
    );
    expect(names).toEqual([
      'A, Close escalation window (Policies folder) is right',
      'B, Close escalation window (Revops folder) is right',
      'Both hold',
    ]);
    expect(new Set(names).size).toBe(3);
  });
});

describe('the conflict question says what it holds (W16-R10)', (): void => {
  const pages = [
    { title: 'Close comment limits', source: 'Revops folder' },
    { title: 'Close comment limits', source: 'Policies folder' },
  ] as const;

  it('names the surfaces whose writes wait, since every write to them waits, not only the held step’s', (): void => {
    expect(conflictQuestionText('Priya', 'Comment length', pages, ['Linear'])).toBe(
      'Two pages disagree under “Comment length”: A, Close comment limits (Revops folder), and B, Close comment limits (Policies folder). Which is right? Priya runs the other steps now and holds its writes to Linear until you answer and Retry.',
    );
    expect(conflictQuestionText('Priya', 'Comment length', pages, ['Linear', 'Slack'])).toContain(
      'holds its writes to Linear and Slack until you answer and Retry.',
    );
  });

  it('says every write waits when the plan declares no writes to tell them apart', (): void => {
    expect(conflictQuestionText('Priya', 'Comment length', pages, 'every')).toContain(
      'Which is right? Priya holds every write of the plan until you answer and Retry.',
    );
  });
});

describe('the question as the thread of a delivered request asks it (17-C; section 7)', (): void => {
  const pages = [
    { title: 'Close comment limits', source: 'Revops folder' },
    { title: 'Close comment limits', source: 'Policies folder' },
  ] as const;

  it('says the conflict was confirmed since the plan was asked about, and what is held meanwhile', (): void => {
    expect(conflictNoticeText('Priya', 'Comment length', pages, ['Linear', 'Slack'])).toBe(
      'Since I asked you about this plan, you confirmed that two pages disagree under “Comment length”: A, Close comment limits (Revops folder), and B, Close comment limits (Policies folder). Which is right? Priya holds its writes to Linear and Slack until you answer.',
    );
    expect(conflictNoticeText('Priya', 'Comment length', pages, 'every')).toContain(
      'Which is right? Priya holds every write of the plan until you answer.',
    );
    expect(conflictNoticeText('Priya', 'Comment length', pages)).toContain(
      'Which is right? Priya holds the steps that may rely on this until you answer.',
    );
  });

  it('shows how to answer a numbered question, and a lone one without its number', (): void => {
    expect(conflictReplyLine('ab3xyz')).toBe(
      'Answer with “answer ab3xyz A”, “answer ab3xyz B” or “answer ab3xyz both”.',
    );
    expect(conflictReplyLine('ab3xyz', 2)).toBe(
      'Answer each by its number: “answer ab3xyz 2 A”, “answer ab3xyz 2 B” or “answer ab3xyz 2 both”.',
    );
  });

  it('says which question a thread’s message asks, where the plan has several, in the words to type', (): void => {
    expect(conflictNoticeReplyLine('ab3xyz')).toBe(conflictReplyLine('ab3xyz'));
    expect(conflictNoticeReplyLine('ab3xyz', 2)).toBe(
      'This is question 2 of the plan: answer with “answer ab3xyz 2 A”, “answer ab3xyz 2 B” or “answer ab3xyz 2 both”.',
    );
  });
});
