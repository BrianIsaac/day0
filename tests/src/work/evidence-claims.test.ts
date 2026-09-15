import { describe, expect, it } from 'vitest';
import { appliedLedgerPrompt } from '../../../src/work/execute-skill';
import type { MockAction } from '../../../src/work/types';
import {
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
      'Pipeline coverage tile: the tile shows 74%; audit line read back: "Last updated by revops at 2026-09-16 17:24:38 UTC".',
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
