import { describe, expect, it } from 'vitest';
import { withheldWithClaimedWriteReason } from '../../../src/work/claim-key';
import { reportsFindings, unsupportedClaimFindings } from '../../../src/work/evidence-claims';
import { approvalTenseFindings, withReportsOfWithheld } from '../../../src/work/execute-skill';
import { withheldForAnswerReason } from '../../../src/work/obligations';
import type { MockAction } from '../../../src/work/types';
import { withheldInWords, writeNoun } from '../../../src/work/withheld-words';
import { closingAgainstFactReason } from '../../../src/work/work-done';
import {
  PIP_COMMENT_AND_CLOSE,
  PIP_DOCS_DRAFT_DM,
  PIP_MANAGER_DM,
  PIP_REPLY_POST,
  PIP_WITHHELD_ROWS,
} from '../../fixtures/work/pip-same-set-report-2026-10-11';

/** Every way the card's words may slip into the checker's terms. */
const CHECKER_TERMS = ['`reports`', 'action 1', 'action 2', '[0]', 'workDone', 'ticket.update'];

function words(action: MockAction, reason: string): string {
  const said = withheldInWords({ action, reason }, 'Pip');
  for (const term of CHECKER_TERMS) expect(said).not.toContain(term);
  return said;
}

const post = (body: string): MockAction => ({
  tool: 'slack.postMessage',
  args: { channelSlug: 'revops', body },
});
const close = (comment: string, reports: number[]): MockAction => ({
  tool: 'ticket.update',
  args: { slug: 'REVOPS-204', status: 'done', comment },
  reports,
});

describe('withheldInWords: what a withheld write says to a manager (RM22 (a))', (): void => {
  it("reads the walk's two rows on Pip's card in a manager's words", (): void => {
    expect(words(PIP_WITHHELD_ROWS[0]!.action, PIP_WITHHELD_ROWS[0]!.reason)).toBe(
      'Not sent: this comment reports other writes of this run, and Day0 could not tell which, so it held the comment back rather than send it before them. Retry writes it again, and it is sent after the writes it reports.',
    );
    expect(words(PIP_WITHHELD_ROWS[1]!.action, PIP_WITHHELD_ROWS[1]!.reason)).toBe(
      'Not sent: this message to you reports another write of this run that was held back, so it would have said something untrue. Retry writes both again.',
    );
  });

  it('quotes the sentence an unsupported claim made, and says nothing shows it', (): void => {
    const coverage = post('Pipeline coverage this week: 68%.');
    const claim = close('Posted the pipeline coverage of 74% in #revops.', [0]);
    const [finding] = unsupportedClaimFindings([coverage, claim], {
      ledger: '',
      documentation: [],
      managerFeedback: [],
    });
    expect(words(claim, finding!.issue)).toBe(
      'Not sent: this comment says “Posted the pipeline coverage of 74% in #revops.”, and nothing Pip read or did shows it. Retry writes it again; a note can say where Pip finds it.',
    );
  });

  it('names a message bound to a withheld write by the write it reports', (): void => {
    const set = [PIP_REPLY_POST, PIP_COMMENT_AND_CLOSE, PIP_MANAGER_DM];
    const refusals = withReportsOfWithheld(set, [{ index: 0, reason: 'held for a claim' }]);
    expect(refusals.slice(1).map((refusal) => words(set[refusal.index]!, refusal.reason))).toEqual([
      'Not sent: this comment reports another write of this run that was held back, so it would have said something untrue. Retry writes both again.',
      'Not sent: this message to you reports another write of this run that was held back, so it would have said something untrue. Retry writes both again.',
    ]);
  });

  it('reads the reports tripwire that remains: a count the declaration cannot meet, a stray place, a later write', (): void => {
    const notes = [post('Fire alarm test is at 10 on Friday.'), post('Route: east stairs.')];
    const short = close('Posted both notes in #revops.', [1]);
    const stray = close('Both notes reached #revops.', [0, 7]);
    const ahead: MockAction = {
      tool: 'slack.postMessage',
      args: { channelSlug: 'dm-manager', body: 'Commented on REVOPS-204 and closed it.' },
      reports: [],
    };
    const [count] = reportsFindings([...notes, short]);
    const [place] = reportsFindings([...notes, stray]);
    const [later] = reportsFindings([ahead, close('Reply posted; closing.', [])]);
    expect(words(short, count!.issue)).toContain('Day0 could not tell which');
    expect(words(stray, place!.issue)).toContain('Day0 could not tell which');
    expect(words(ahead, later!.issue)).toBe(
      'Not sent: this message to you reports a write that would have gone out after it. Retry writes it again, after that write.',
    );
  });

  it('reads a close held against the run’s own answer, and a write held for another item', (): void => {
    const done = close('Closed it.', []);
    expect(
      words(done, closingAgainstFactReason({ workDone: 'partial', workDoneWhy: 'half' }, 'done')),
    ).toBe(
      'Not sent: this comment closes the ticket, while Pip answered that the work was not all done. The ticket stays open.',
    );
    expect(words(PIP_MANAGER_DM, withheldWithClaimedWriteReason('held by REVOPS-9'))).toContain(
      'another work item holds what a write beside this message to you changes',
    );
  });

  it("reads Pip's draft DM, withheld for its approval tense, in a manager's words (W19-4)", (): void => {
    const [finding] = approvalTenseFindings([PIP_DOCS_DRAFT_DM]);
    expect(words(PIP_DOCS_DRAFT_DM, finding!.issue)).toBe(
      'Not sent: this message to you says it is a draft waiting for your approval, and nothing holds it once it lands, so whoever asked would never have had the answer. Retry writes it again where it was asked.',
    );
  });

  it('reads the approval tense in a message to the manager only, and its "once you approve" shape (W16-R14, reader 4’s p3)', (): void => {
    const post = (channelSlug: string, body: string): MockAction => ({
      tool: 'slack.postMessage',
      args: { channelSlug, body },
    });
    // Ordinary messages to a colleague that the tripwire sent back, then withheld.
    for (const body of [
      'Here is the draft FAQ for your review: it covers refunds.',
      'The draft for review by finance is in the shared folder.',
      'I will post it once approved by finance.',
    ]) {
      expect(approvalTenseFindings([post('office-asks', body)]), body).toEqual([]);
    }
    // 16-FW's F7, the shape that landed, and Pip's DM, which it was built for.
    expect(
      approvalTenseFindings([post('dm-manager', 'Reply for Hana to send once you approve.')]),
    ).toHaveLength(1);
    expect(
      approvalTenseFindings([post('dm-manager', 'I will send it to Hana when you approve it.')]),
    ).toHaveLength(1);
    expect(approvalTenseFindings([PIP_DOCS_DRAFT_DM])).toHaveLength(1);
    // An escalation that holds something else for the manager is not a draft (the second pass):
    // it names no reply or draft and sends nothing itself.
    for (const body of [
      'I have not issued the refund; I will issue it once you approve.',
      'Confirm when you approve the plan and I will carry on.',
      'The close can go ahead after you approve the journal.',
    ]) {
      expect(approvalTenseFindings([post('dm-manager', body)]), body).toEqual([]);
    }
  });

  it('says a message withheld with a write that waits on the answer waits on it too (the second pass)', (): void => {
    const [, dependent] = withReportsOfWithheld(
      [PIP_REPLY_POST, PIP_COMMENT_AND_CLOSE],
      [{ index: 0, reason: withheldForAnswerReason(2) }],
    );
    expect(words(PIP_COMMENT_AND_CLOSE, dependent!.reason)).toBe(
      "Not sent: it waits on your answer to Pip's question.",
    );
  });

  it('says a write waiting on the answer waits on it, and anything else in plain words', (): void => {
    expect(words(PIP_MANAGER_DM, withheldForAnswerReason(2))).toBe(
      "Not sent: it waits on your answer to Pip's question.",
    );
    expect(words(PIP_REPLY_POST, 'some reason a later check gives')).toBe(
      "Not sent: Day0's checks held this post back; the record has the check's reason. Retry writes it again.",
    );
  });
});

describe('writeNoun', (): void => {
  it('calls each mock office write what a manager calls it', (): void => {
    expect(
      [
        PIP_REPLY_POST,
        PIP_COMMENT_AND_CLOSE,
        PIP_MANAGER_DM,
        { tool: 'ticket.update', args: { slug: 'REVOPS-1', status: 'done' } } as MockAction,
        { tool: 'twitter.reply', args: { tweetSlug: 't', body: 'Thanks.' } } as MockAction,
        { tool: 'spreadsheet.appendRow', args: { sheetSlug: 's', tabName: 't' } } as MockAction,
      ].map(writeNoun),
    ).toEqual(['post', 'comment', 'message to you', 'ticket change', 'reply', 'row']);
  });
});
