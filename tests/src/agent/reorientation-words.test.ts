import { describe, expect, it } from 'vitest';
import {
  approvedResultWords,
  closedByHandSummary,
  closingHeldReason,
  conflictChoiceWords,
  conflictNoticeText,
  conflictQuestionText,
  conflictNoticeReplyLine,
  conflictReplyLine,
  decidedElsewhereOf,
  decidedElsewhereWords,
  decisionWords,
  failedProposalWords,
  deferredWords,
  heldWords,
  pendingWords,
  proposalFingerprint,
  sentenceOf,
  unproposedWords,
  PROPOSAL_DID_NOT_FINISH,
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

  it('says how long a deferred card’s plans stay held, and only the date where it holds none (W16-R24; section 7)', (): void => {
    expect(deferredWords('3 October', { plans: 0, runs: 0 })).toBe('Deferred until 3 October.');
    expect(deferredWords('3 October', { plans: 1, runs: 0 })).toBe(
      'Deferred until 3 October. Its 1 plan stays held until then.',
    );
    expect(deferredWords('3 October', { plans: 2, runs: 1 })).toBe(
      'Deferred until 3 October. Its 2 plans and 1 run stay held until then.',
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
    // A change that reached more open work than a card holds says the rest (W16-R22; section 7).
    expect(heldWords({ plans: 10, runs: 0, notHeld: 90 })).toBe(
      '10 plans held, and 90 more not held: a card holds at most ten',
    );
    expect(heldWords({ plans: 7, runs: 3, notHeld: 1 })).toBe(
      '7 plans held, 3 runs held before closing, and 1 more not held: a card holds at most ten',
    );
    expect(heldWords({ plans: 2, runs: 0, notHeld: 0 })).toBe('2 plans held');
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

describe('a judgement that failed, and an Approve of what the manager was shown (17-O; W16-R23, W16-R24)', (): void => {
  it('says of a decided card’s missing proposal only that none came, and why when the judgement failed', (): void => {
    expect(unproposedWords('Mira', {})).toBe(
      'Mira had proposed nothing when the card was decided.',
    );
    expect(unproposedWords('Mira', { failedAt: 1, failure: 'Not Found' })).toBe(
      'Mira could not work out a proposal (Not Found).',
    );
    expect(unproposedWords('Mira', { failedAt: 1, failure: PROPOSAL_DID_NOT_FINISH })).toBe(
      'Mira did not finish working out a proposal.',
    );
  });

  it('names the ways on from a failed judgement, Discuss first, with its reason or that it did not finish', (): void => {
    const ways =
      'Nothing changes unless you act: talk it through with Mira, dismiss the card, or amend the charter yourself.';
    expect(failedProposalWords('Mira', 'timed out.')).toBe(
      `Mira could not work out a proposal (timed out). ${ways}`,
    );
    expect(failedProposalWords('Mira', PROPOSAL_DID_NOT_FINISH)).toBe(
      `Mira did not finish working out a proposal. ${ways}`,
    );
    expect(failedProposalWords('Mira')).toBe(
      `Mira could not work out a proposal for this change. ${ways}`,
    );
  });

  it('gives one proposal one fingerprint whatever order its fields are stored in, and another proposal another', (): void => {
    const shown = { kind: 'relationship', action: 'retire', relationshipId: 'e1', rationale: 'r' };
    expect(
      proposalFingerprint({
        rationale: 'r',
        relationshipId: 'e1',
        action: 'retire',
        kind: 'relationship',
      }),
    ).toBe(proposalFingerprint(shown));
    expect(proposalFingerprint({ ...shown, action: 'edit' })).not.toBe(proposalFingerprint(shown));
    expect(
      proposalFingerprint({ kind: 'charter-change', changes: [{ index: 1, field: 'willDo' }] }),
    ).toBe(
      proposalFingerprint({ changes: [{ field: 'willDo', index: 1 }], kind: 'charter-change' }),
    );
  });
});

describe('a card decided on another employee’s card, and one closed at a handover (17-O)', (): void => {
  it('stores whose card decided it and what that did, and reads both back for the card’s line', (): void => {
    const stored = approvedResultWords.decidedElsewhere('Priya', 'the relationship was changed');
    expect(stored).toBe('decided on Priya’s card: the relationship was changed');
    const read = decidedElsewhereOf(stored);
    expect(read).toEqual({ name: 'Priya', result: 'the relationship was changed' });
    expect(decidedElsewhereWords(read!, '13 October')).toBe(
      'Decided on Priya’s card on 13 October: the relationship was changed. Nothing more to do here.',
    );
    // Any other outcome is not one.
    expect(decidedElsewhereOf(approvedResultWords.dismissed)).toBeUndefined();
    expect(decidedElsewhereOf(approvedResultWords.handedOver)).toBeUndefined();
    expect(decidedElsewhereOf(undefined)).toBeUndefined();
  });

  it('says who opened a by-hand card a handover closed, and none of what they typed (D-5’s remainder)', (): void => {
    expect(closedByHandSummary('priya@acme.test')).toBe(
      'A card priya@acme.test opened was closed at the handover',
    );
  });
});

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

// W17-R1 with D-11 (a) (17-J's W3, reproduced on the review's bed 1): two pages of one title in
// one source read "A, Close review window (Company folder), and B, Close review window (Company
// folder)" everywhere a pair is drawn, the two answers' names a letter apart.
describe('a conflict’s two pages of one title in one source named apart (W17-R1, D-11 (a))', (): void => {
  const WALK_PAGES = [
    {
      title: 'Close review window',
      source: 'Company folder',
      ref: 'policies/close-review-window.md',
    },
    {
      title: 'Close review window',
      source: 'Company folder',
      ref: 'revops/runbooks/close-review-window.md',
    },
  ] as const;

  it('names each page’s folder where the title and the source collide, in the question, the notice and the answers', (): void => {
    expect(conflictQuestionText('Priya', 'Review window', WALK_PAGES)).toBe(
      'Two pages disagree under “Review window”: A, Close review window (Company folder, policies), and B, Close review window (Company folder, revops/runbooks). Which is right? Priya runs the other steps now and holds the ones that may rely on this until you answer and Retry.',
    );
    expect(conflictNoticeText('Priya', 'Review window', WALK_PAGES)).toContain(
      '“Review window”: A, Close review window (Company folder, policies), and B, Close review window (Company folder, revops/runbooks).',
    );
    expect(
      (['from', 'to'] as const).map((choice) => conflictChoiceWords(choice, WALK_PAGES)),
    ).toEqual([
      'A, Close review window (Company folder, policies) is right',
      'B, Close review window (Company folder, revops/runbooks) is right',
    ]);
  });

  it('names each page by its whole ref where the folders do not tell them apart: one at the source’s top, or both in one folder', (): void => {
    expect(
      conflictChoiceWords('from', [
        { ...WALK_PAGES[0], ref: 'close-review-window.md' },
        WALK_PAGES[0],
      ]),
    ).toBe('A, Close review window (Company folder, close-review-window.md) is right');
    expect(
      conflictChoiceWords('to', [
        { ...WALK_PAGES[0], ref: 'policies/close-review-window.md' },
        { ...WALK_PAGES[0], ref: 'policies/close-review-window-copy.md' },
      ]),
    ).toBe(
      'B, Close review window (Company folder, policies/close-review-window-copy.md) is right',
    );
  });

  it('names no folder where the titles or the sources already tell the pages apart, or where a page stored before carries no ref', (): void => {
    expect(
      conflictChoiceWords('from', [WALK_PAGES[0], { ...WALK_PAGES[1], title: 'Close runbook' }]),
    ).toBe('A, Close review window (Company folder) is right');
    expect(
      conflictChoiceWords('from', [WALK_PAGES[0], { ...WALK_PAGES[1], source: 'Handbook' }]),
    ).toBe('A, Close review window (Company folder) is right');
    expect(
      conflictChoiceWords('from', [
        { title: 'Close review window', source: 'Company folder' },
        WALK_PAGES[1],
      ]),
    ).toBe('A, Close review window (Company folder) is right');
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

  it('says nothing of the item waits beside one that is done or turned down (the joins’ W3k)', (): void => {
    expect(conflictQuestionText('Priya', 'Comment length', pages, 'nothing')).toBe(
      'Two pages disagree under “Comment length”: A, Close comment limits (Revops folder), and B, Close comment limits (Policies folder). Which is right? Nothing of this item waits on the answer: other plans of Priya’s that rest on these pages do.',
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
