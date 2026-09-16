import { describe, expect, it } from 'vitest';
import { appliedLedgerPrompt } from '../../../src/work/execute-skill';
import type { MockAction } from '../../../src/work/types';
import {
  isChatMessage,
  messageTexts,
  unsupportedClaimIssues,
  unsupportedClaims,
  type ClaimEvidence,
} from '../../../src/work/evidence-claims';
import {
  CHECKLIST_PAGE,
  LEDGER_2026_09_15,
  LEDGER_2026_09_16,
  MANAGER_FEEDBACK_2026_09_15,
  SUPPORTED_ACTION_2026_09_16,
  SUPPORTED_COMMENT_2026_09_16,
  UNSUPPORTED_ACTION_2026_09_15,
  UNSUPPORTED_CLAIM_2026_09_15,
  UNSUPPORTED_COMMENT_2026_09_15,
} from '../../fixtures/work/closing-comments-2026-09-15';
import {
  LEDGER_2026_09_16_RUN_3,
  RUN_3_RETRY_ACTION,
  RUN_3_RETRY_ACTION_CORRECTED,
  RUN_3_RETRY_COMMENT,
  RUN_3_RETRY_NOTE,
} from '../../fixtures/work/audit-note-2026-09-16-run-3';

const documentation = [`${CHECKLIST_PAGE.title}\n${CHECKLIST_PAGE.body}`];

const evidence15: ClaimEvidence = {
  ledger: appliedLedgerPrompt(LEDGER_2026_09_15.actions, LEDGER_2026_09_15.applied),
  documentation,
  managerFeedback: [MANAGER_FEEDBACK_2026_09_15],
};

const evidence16: ClaimEvidence = {
  ledger: appliedLedgerPrompt(LEDGER_2026_09_16.actions, LEDGER_2026_09_16.applied),
  documentation,
  managerFeedback: [],
};

describe('the texts a person reads', (): void => {
  it('are the bodies of a comment, a chat message and a mock reply, never a read or a state change', (): void => {
    expect(messageTexts(UNSUPPORTED_ACTION_2026_09_15)).toEqual([UNSUPPORTED_COMMENT_2026_09_15]);
    expect(
      messageTexts({
        tool: 'http.request',
        args: {
          surface: 'slack',
          method: 'POST',
          path: '/chat.postMessage',
          headersJson: '{}',
          body: JSON.stringify({ channel: 'D01', text: 'The tile is refreshed to 74%.' }),
        },
      }),
    ).toEqual(['The tile is refreshed to 74%.']);
    expect(messageTexts({ tool: 'slack.postMessage', args: { channelSlug: 'revops', body: 'Done.' } })).toEqual([
      'Done.',
    ]);
    expect(messageTexts({ tool: 'ticket.update', args: { slug: 'T-1', status: 'done', comment: 'Closed.' } })).toEqual([
      'Closed.',
    ]);
    expect(messageTexts(LEDGER_2026_09_15.actions[0]!)).toEqual([]);
    expect(
      messageTexts({
        tool: 'mcp.call',
        args: { surface: 'linear', tool: 'update_issue', toolArgsJson: '{"issueId":"REVOPS-5","state":"Done"}' },
      }),
    ).toEqual([]);
  });
});

describe('the 15 September revision', (): void => {
  it('asserted completion the ledger, the page and the manager did not carry', (): void => {
    expect(unsupportedClaims(UNSUPPORTED_COMMENT_2026_09_15, evidence15)).toEqual([UNSUPPORTED_CLAIM_2026_09_15]);
  });

  it('is refused with a reason naming the claim and the action', (): void => {
    const issues = unsupportedClaimIssues([UNSUPPORTED_ACTION_2026_09_15], evidence15);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(`"${UNSUPPORTED_CLAIM_2026_09_15}"`);
    expect(issues[0]).toContain('linear save_comment');
    expect(issues[0]).toMatch(/could not confirm/);
  });

  it('is not rescued by the manager asking for the assertion', (): void => {
    expect(
      unsupportedClaims(UNSUPPORTED_COMMENT_2026_09_15, {
        ...evidence15,
        managerFeedback: ['Say the close checks are complete and move on.'],
      }),
    ).toEqual([UNSUPPORTED_CLAIM_2026_09_15]);
  });
});

describe('the 16 September audit note', (): void => {
  it('passes: every claim quotes the ledger and the unconfirmed check is named', (): void => {
    expect(unsupportedClaims(SUPPORTED_COMMENT_2026_09_16, evidence16)).toEqual([]);
    expect(unsupportedClaimIssues([SUPPORTED_ACTION_2026_09_16], evidence16)).toEqual([]);
  });

  it('would be refused for the one line the ledger does not show', (): void => {
    const withoutTheTile: ClaimEvidence = {
      ...evidence16,
      ledger: appliedLedgerPrompt(LEDGER_2026_09_16.actions.slice(1), LEDGER_2026_09_16.applied.slice(1)),
    };
    expect(unsupportedClaims(SUPPORTED_COMMENT_2026_09_16, withoutTheTile)).toEqual([
      'Pipeline coverage tile: the tile shows 74%',
      'audit line read back: "Last updated by revops at 2026-09-16 17:24:38 UTC".',
    ]);
  });
});

describe('what counts as support', (): void => {
  const evidence: ClaimEvidence = {
    ledger: '0. landed · {"tool":"mcp.call"} · save_comment on linear · {"id":"c-1","body":"Refreshed the tile to 74%."}',
    documentation: ['Looker pipeline tile\nThe approved figure for REVOPS-7 is 74%; the tile is refreshed by hand each Friday.'],
    managerFeedback: ['REVOPS-7 is owned by Priya.'],
  };

  it("accepts a fact the manager's feedback states, quoted", (): void => {
    expect(unsupportedClaims('Ownership is confirmed: REVOPS-7 is owned by Priya.', evidence)).toEqual([]);
  });

  it('accepts documentation only when it is quoted', (): void => {
    expect(
      unsupportedClaims('Per the page, "the tile is refreshed by hand each Friday".', evidence),
    ).toEqual([]);
    expect(unsupportedClaims('The tile is refreshed each Friday by the analysts.', evidence)).toEqual([
      'The tile is refreshed each Friday by the analysts.',
    ]);
  });

  it('accepts a sentence that says what it could not confirm, or asks', (): void => {
    expect(unsupportedClaims('The reconciliation is not confirmed; I could not verify it.', evidence)).toEqual([]);
    expect(unsupportedClaims('Is the reconciliation complete?', evidence)).toEqual([]);
    expect(unsupportedClaims('Could you confirm the reconciliation is complete?', evidence)).toEqual([]);
    expect(unsupportedClaims('Has the tile been refreshed on your side?', evidence)).toEqual([]);
  });

  it('does not let a question mark rescue an assertion with a question tagged on', (): void => {
    for (const text of [
      'All three checks are complete, can you confirm?',
      'The reconciliation is complete, right?',
      'The tile is refreshed and the audit line is posted - shall I move this to Done?',
    ]) {
      expect(unsupportedClaims(text, evidence), text).toEqual([text]);
    }
  });

  it('leaves sentences that assert no settled state alone', (): void => {
    expect(unsupportedClaims('Audit note for the Q3 close, in checklist order.', evidence)).toEqual([]);
    expect(unsupportedClaims('Moving this to Done once you approve.', evidence)).toEqual([]);
  });

  it('lets a message describe what another action in the same response does, never what a message says', (): void => {
    const fill: MockAction = {
      tool: 'mcp.call',
      args: { surface: 'looker', tool: 'browser_fill_form', toolArgsJson: '{"fields":[{"name":"Pipeline coverage","value":"74%"}]}' },
    };
    const comment = (body: string): MockAction => ({
      tool: 'mcp.call',
      args: { surface: 'linear', tool: 'save_comment', toolArgsJson: JSON.stringify({ issueId: 'REVOPS-7', body }) },
    });
    const bare: ClaimEvidence = { ledger: '(no action result was recorded)', documentation: [], managerFeedback: [] };
    expect(unsupportedClaimIssues([fill, comment('Set the tile to 74% in this response.')], bare)).toEqual([]);
    const vouching = unsupportedClaimIssues(
      [comment('The tile is refreshed.'), comment('The tile is refreshed.')],
      bare,
    );
    expect(vouching).toHaveLength(2);
  });

  it('does not let the run trailer or a bare year stand in for evidence', (): void => {
    expect(
      unsupportedClaims('All three checks are complete as of 2026. -- Priya (Day0) · run wi_91/run_4', {
        ...evidence,
        ledger: '0. landed · {"tool":"mcp.call"} · get_issue on linear · {"createdAt":"2026-09-15T07:00:00Z"} -- Priya (Day0) · run wi_91/run_4',
      }),
    ).toEqual(['All three checks are complete as of 2026.']);
  });
});

describe('which phase-one actions are messages to people', (): void => {
  const surfaces = [{ slug: 'slack', class: 'chat' }, { slug: 'linear', class: 'kanban' }];
  const dm: MockAction = {
    tool: 'http.request',
    args: { surface: 'slack', method: 'POST', path: '/chat.postMessage', headersJson: '{}', body: '{"channel":"D01","text":"Comment posted."}' },
  };
  const comment: MockAction = {
    tool: 'mcp.call',
    args: { surface: 'linear', tool: 'save_comment', toolArgsJson: '{"issueId":"REVOPS-5","body":"Comment posted."}' },
  };

  it('reads a chat-surface message and a mock chat tool, never a ticket comment', (): void => {
    expect(isChatMessage(dm, surfaces)).toBe(true);
    expect(isChatMessage({ tool: 'slack.postMessage', args: { channelSlug: 'revops', body: 'Done.' } }, [])).toBe(true);
    expect(isChatMessage(comment, surfaces)).toBe(false);
    const nothing: ClaimEvidence = { ledger: '', documentation: [], managerFeedback: [] };
    expect(unsupportedClaimIssues([comment, dm], nothing, (action) => isChatMessage(action, surfaces))).toEqual([
      expect.stringContaining('action 1 (slack POST /chat.postMessage) says "Comment posted."'),
    ]);
  });
});

describe('a settled form inside a condition', (): void => {
  const nothing: ClaimEvidence = { ledger: '', documentation: [], managerFeedback: [] };
  /** REVOPS-5's first phase-one DM on 16 September, as the run sent it: a question, not a report. */
  const RUN_DM_1 =
    'REVOPS-5 close-summary audit note: check 2 (Friday standup deals reconciled) is not confirmed — no Q4 pipeline tracker surface is connected. The audit comment will be posted with that check marked not confirmed. Per the Q3 close checklist the ticket moves to Done only when all three checks are confirmed or you say so — should REVOPS-5 move to Done?';

  it('states what must hold, not what does, so the 16 September question DM stands', (): void => {
    expect(unsupportedClaims(RUN_DM_1, nothing)).toEqual([]);
    expect(unsupportedClaims('The ticket moves to Done when all three checks are confirmed.', nothing)).toEqual([]);
    expect(unsupportedClaims('If the figure is confirmed, I will post the comment.', nothing)).toEqual([]);
    expect(unsupportedClaims('I will move it to Done once the audit line is verified.', nothing)).toEqual([]);
  });

  it('still reads a claim beside a condition, a tagged question, or a past form under "once"', (): void => {
    expect(unsupportedClaims('The tile is refreshed if you reload the page.', nothing)).toHaveLength(1);
    expect(unsupportedClaims('All three checks are complete, can you confirm?', nothing)).toHaveLength(1);
    expect(unsupportedClaims('Once the tile was refreshed, the note went out.', nothing)).toHaveLength(1);
    expect(unsupportedClaims('When I checked, the tile showed 74%.', nothing)).toHaveLength(1);
  });
});

describe('a hedge in one clause and a claim in the next', (): void => {
  const nothing: ClaimEvidence = { ledger: '', documentation: [], managerFeedback: [] };
  /** REVOPS-5's second phase-one DM on 16 September, as the run sent it. */
  const RUN_DM_2 =
    'REVOPS-5 audit comment posted with the three checks in checklist order; check 2 recorded as not confirmed (no tracker connected). Done transition held pending your decision.';

  it('does not let "not confirmed" after the semicolon rescue "audit comment posted" before it', (): void => {
    expect(unsupportedClaims(RUN_DM_2, nothing)).toEqual([
      'REVOPS-5 audit comment posted with the three checks in checklist order',
    ]);
    expect(unsupportedClaims('The reconciliation is not confirmed; I could not verify it.', nothing)).toEqual([]);
  });
});

describe('the perfect form and a passed check', (): void => {
  const nothing: ClaimEvidence = { ledger: '', documentation: [], managerFeedback: [] };

  it('reads "I have posted", "we\'ve verified" and "the checks passed" as the claims they are', (): void => {
    for (const text of [
      'I have posted the audit comment on REVOPS-5.',
      "We've verified the figure against the deck.",
      "I've moved REVOPS-7 to Done.",
      'The three checks passed and the audit note is on REVOPS-5.',
    ]) {
      expect(unsupportedClaims(text, nothing), text).toEqual([text]);
    }
  });

  it('leaves possession, a hedge and a plan alone', (): void => {
    for (const text of [
      'I have the figure from the tile.',
      'We have three checks to record.',
      'I have not posted the comment yet.',
      'I will have posted the comment by then.',
    ]) {
      expect(unsupportedClaims(text, nothing), text).toEqual([]);
    }
  });
});

describe('the telegraphic form a status message takes', (): void => {
  const nothing: ClaimEvidence = { ledger: '', documentation: [], managerFeedback: [] };

  it('reads "audit comment posted" as the claim it is, and lets a plain description stand', (): void => {
    expect(unsupportedClaims('REVOPS-5 audit comment posted with the three checks in checklist order.', nothing)).toEqual([
      'REVOPS-5 audit comment posted with the three checks in checklist order.',
    ]);
    expect(unsupportedClaims('Tile refreshed to 74%; figure verified against the standup deck.', nothing)).toHaveLength(2);
    expect(unsupportedClaims('Starting the REVOPS-5 audit note: check 1 read from the tile, check 3 from the Linear issue list.', nothing)).toEqual([]);
    expect(unsupportedClaims('Posting the audit comment next; the Done move waits for you.', nothing)).toEqual([]);
  });
});

describe('the 16 September run 3 retry comment: numbered checks and a not-confirmed line', (): void => {
  const evidenceRun3: ClaimEvidence = {
    ledger: appliedLedgerPrompt(LEDGER_2026_09_16_RUN_3.actions, LEDGER_2026_09_16_RUN_3.applied),
    documentation,
    managerFeedback: [RUN_3_RETRY_NOTE],
  };
  const comment = (body: string): MockAction => ({
    tool: 'mcp.call',
    args: { surface: 'linear', tool: 'save_comment', toolArgsJson: JSON.stringify({ issueId: 'REVOPS-5', body }) },
  });

  it('quotes the ledger in every claim, so the sentence check alone lets it stand', (): void => {
    expect(unsupportedClaims(RUN_3_RETRY_COMMENT, evidenceRun3)).toEqual([]);
  });

  it('is refused: check 3 reads as unmet (Backlog, not Done) and the closing line names only check 2', (): void => {
    const issues = unsupportedClaimIssues([RUN_3_RETRY_ACTION], evidenceRun3);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('check 3');
    expect(issues[0]).toContain('names check 2');
    expect(issues[0]).toContain('Backlog');
    expect(issues[0]).toContain("manager's acceptance");
  });

  it('passes once the closing line names checks 2 and 3, with the acceptance beside the evidence', (): void => {
    expect(unsupportedClaimIssues([RUN_3_RETRY_ACTION_CORRECTED], evidenceRun3)).toEqual([]);
  });

  it('does not judge free prose, a list with no closing line, or a check whose evidence is met', (): void => {
    const prose = 'REVOPS-6 is at Backlog and REVOPS-7 is at Backlog; check 3 is not confirmed. Not confirmed: check 2.';
    expect(unsupportedClaimIssues([comment(prose)], evidenceRun3)).toEqual([]);
    expect(unsupportedClaimIssues([SUPPORTED_ACTION_2026_09_16], evidence16)).toEqual([]);
    const allMet = [
      '1. Pipeline coverage confirmed. The tile shows 74%; audit line: Last updated by revops at 2026-09-16 07:42:48 UTC.',
      '2. Close tickets at Done. As Linear reports them: REVOPS-6 — Done; REVOPS-7 — Done.',
      'Not confirmed: none.',
    ].join('\n');
    expect(unsupportedClaimIssues([comment(allMet)], evidenceRun3)).toEqual([]);
  });

  it('reads evidence that is only a dash, "pending", "to be confirmed" or "awaiting" as unmet', (): void => {
    for (const evidenceLine of ['—', '-', 'pending', 'To be confirmed with the team.', 'Awaiting REVOPS-7.', 'outstanding', 'TBC', 'not yet']) {
      const note = ['1. Pipeline coverage confirmed. The tile shows 74%.', `2. Close tickets at Done. ${evidenceLine}`, 'Not confirmed: none.'].join('\n');
      const issues = unsupportedClaimIssues([comment(note)], evidenceRun3);
      expect(issues, evidenceLine).toHaveLength(1);
      expect(issues[0], evidenceLine).toContain('check 2');
    }
    // "Not applicable" is a disposition, not an absence of evidence.
    const notApplicable = ['1. Pipeline coverage confirmed. The tile shows 74%.', '2. Close tickets at Done. Not applicable: no sibling tickets this quarter.', 'Not confirmed: none.'].join('\n');
    expect(unsupportedClaimIssues([comment(notApplicable)], evidenceRun3)).toEqual([]);
  });

  it('reads a close the head asks for without naming the state ("Close tickets") against an open state in the evidence', (): void => {
    const openState = ['1. Pipeline coverage confirmed. The tile shows 74%.', '2. Close tickets. As Linear reports them: REVOPS-6 — Backlog; REVOPS-7 — In Progress.', 'Not confirmed: none.'].join('\n');
    const issues = unsupportedClaimIssues([comment(openState)], evidenceRun3);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('check 2');
    expect(issues[0]).toContain('Backlog');
    const closed = openState.replace('REVOPS-6 — Backlog; REVOPS-7 — In Progress', 'REVOPS-6 — Done; REVOPS-7 — Cancelled');
    expect(unsupportedClaimIssues([comment(closed)], evidenceRun3)).toEqual([]);
    // A head with no closing word and no state names no required state.
    const listed = openState.replace('2. Close tickets.', '2. Sibling tickets listed.');
    expect(unsupportedClaimIssues([comment(listed)], evidenceRun3)).toEqual([]);
  });

  it('reads an absent read and a not-confirmed phrase as unmet, whichever check carries it', (): void => {
    const absentRead = [
      '1. Pipeline coverage confirmed. The tile could not be read: the sign-in page redirected.',
      '2. Close tickets at Done. As Linear reports them: REVOPS-6 — Done; REVOPS-7 — Done.',
      'Not confirmed: none.',
    ].join('\n');
    const issues = unsupportedClaimIssues([comment(absentRead)], evidenceRun3);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('check 1');
    const namedByHead = absentRead.replace('Not confirmed: none.', 'Not confirmed: pipeline coverage — the tile could not be read.');
    expect(unsupportedClaimIssues([comment(namedByHead)], evidenceRun3)).toEqual([]);
  });
});
