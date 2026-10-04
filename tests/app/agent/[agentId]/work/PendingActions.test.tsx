/** @vitest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RepairNote } from '../../../../../app/agent/[agentId]/work/RunDetails';
import {
  closeAgainstWordsNote,
  heldActionsWhy,
  heldSentence,
  PendingActions,
} from '../../../../../app/agent/[agentId]/work/PendingActions';
import {
  HELD_BEFORE_AUTONOMY_NOTE,
  HELD_WITHHELD_TRANSITION_NOTE,
} from '../../../../../src/work/autonomy';
import {
  HELD_CLOSE_AGAINST_WORDS,
  HELD_WITHHELD_TRANSITION,
} from '../../../../../src/surfaces/policy';

describe('a write re-authored once before the hold', (): void => {
  const reason =
    'Tool input validation failed against the probed schema: unknown argument comment for save_comment on linear; the schema accepts issueId, body';
  const first = '{"issueId":"REVOPS-7","comment":"Set to 74%."}';
  const held = {
    tool: 'mcp.call' as const,
    args: {
      surface: 'linear',
      tool: 'save_comment',
      toolArgsJson: '{"issueId":"REVOPS-7","body":"Set to 74%."}',
    },
  };
  const resolved = async (): Promise<void> => undefined;

  it('tells the manager the held payload is the second attempt and shows the first beside it', (): void => {
    const markup = renderToStaticMarkup(
      <PendingActions
        actions={[held]}
        verdicts={[{ disposition: 'held', reason: 'held for approval' }]}
        surfaces={[]}
        repairs={[{ index: 0, reason, toolArgsJson: first, repaired: true }]}
        onApprove={resolved}
        onReject={resolved}
      />,
    );
    expect(markup).toContain(
      'arguments re-authored once before the hold · this payload is the second attempt',
    );
    expect(markup).toContain('the schema accepts issueId, body');
    expect(markup).toContain(
      'first attempt: {&quot;issueId&quot;:&quot;REVOPS-7&quot;,&quot;comment&quot;',
    );
    expect(markup).toContain('Set to 74%.');
  });

  it('says when the one repair produced nothing and the first attempt stands, and stays silent with no repair', (): void => {
    const failed = renderToStaticMarkup(
      <RepairNote repair={{ reason, toolArgsJson: first, repaired: false }} />,
    );
    expect(failed).toContain('the one repair produced nothing usable · first attempt stands');
    expect(renderToStaticMarkup(<RepairNote repair={undefined} />)).toBe('');
    const untouched = renderToStaticMarkup(
      <PendingActions
        actions={[held]}
        verdicts={[{ disposition: 'held', reason: 'held for approval' }]}
        surfaces={[]}
        onApprove={resolved}
        onReject={resolved}
      />,
    );
    expect(untouched).not.toContain('re-authored');
  });
});

describe('a ticket state change the plan withholds', (): void => {
  const resolved = async (): Promise<void> => undefined;
  const done = {
    tool: 'mcp.call' as const,
    args: {
      surface: 'linear',
      tool: 'save_issue',
      toolArgsJson: '{"id":"REVOPS-5","state":"Done"}',
    },
  };

  it("says the move is the manager's call, not that the run predates the switch", (): void => {
    const markup = renderToStaticMarkup(
      <PendingActions
        actions={[done]}
        verdicts={[{ disposition: 'held', reason: HELD_WITHHELD_TRANSITION }]}
        surfaces={[]}
        autonomousActions
        onApprove={resolved}
        onReject={resolved}
      />,
    );
    expect(markup).toContain(HELD_WITHHELD_TRANSITION_NOTE);
    expect(markup).not.toContain(HELD_BEFORE_AUTONOMY_NOTE);
    // The gate's reason, said as a sentence of its own under the row.
    expect(markup).toContain(heldSentence(HELD_WITHHELD_TRANSITION));
    expect(heldSentence('held for the manager')).toBe('Held for you.');
    // Approving sends the ticked writes; a first phase then runs its closing phase.
    expect(heldActionsWhy('Mira', false)).not.toContain('nothing else');
    expect(heldActionsWhy('Mira', true, false, 'real')).toContain(
      'Approving starts the closing phase; when it finishes, reads and messages to you apply on their own',
    );
  });
});

describe('a close the tripwire sent to the manager (12-D)', (): void => {
  const resolved = async (): Promise<void> => undefined;
  const close = {
    tool: 'ticket.update' as const,
    args: { slug: 'REVOPS-204', status: 'done' as const, comment: 'Reconciled all three.' },
  };
  const clause = "I could not find a mismatch between the tracker and the ticket's figures.";

  it('names the sentence beside the held close, and the manager decides it', (): void => {
    const markup = renderToStaticMarkup(
      <PendingActions
        actions={[close]}
        verdicts={[{ disposition: 'held', reason: HELD_CLOSE_AGAINST_WORDS }]}
        surfaces={[]}
        employeeName="Quill"
        closeAgainstWords={clause}
        onApprove={resolved}
        onReject={resolved}
      />,
    );
    expect(markup).toContain('Close held:');
    expect(markup).toContain(
      'Quill answered that the work is done, but wrote “I could not find a mismatch between the tracker and the ticket&#x27;s figures”. Approve the close only if the work was done; otherwise withhold it.',
    );
  });

  it('leaves the held close unticked, so Approve selected never sends it without a choice', (): void => {
    const markup = renderToStaticMarkup(
      <PendingActions
        actions={[
          close,
          { tool: 'slack.postMessage', args: { channelSlug: 'dm-manager', body: 'Done.' } },
        ]}
        verdicts={[
          { disposition: 'held', reason: HELD_CLOSE_AGAINST_WORDS },
          { disposition: 'held', reason: 'write held for the manager' },
        ]}
        surfaces={[]}
        employeeName="Quill"
        closeAgainstWords={clause}
        onApprove={resolved}
        onReject={resolved}
      />,
    );
    expect(markup).toContain('Approve selected (1)');
    expect(markup.match(/type="checkbox"[^>]*checked=""/g) ?? []).toHaveLength(1);
    // Day0 left it unticked, not the manager: the card says so and does not count it as theirs.
    expect(markup).toContain(
      'Not ticked: approve it only if the work was done. Until you tick it, it will not be sent.',
    );
    expect(markup).toContain('>Include it<');
    expect(markup).not.toContain('withheld by you');
    expect(markup).not.toContain('Withheld by you');
  });

  it('says nothing of the kind on a set the tripwire did not trip', (): void => {
    const markup = renderToStaticMarkup(
      <PendingActions
        actions={[close]}
        verdicts={[{ disposition: 'held', reason: 'write held for the manager' }]}
        surfaces={[]}
        employeeName="Rook"
        onApprove={resolved}
        onReject={resolved}
      />,
    );
    expect(markup).not.toContain('answered that the work is done');
  });

  it('keeps the quoted sentence’s own question or exclamation mark', (): void => {
    expect(closeAgainstWordsNote('Moss', 'Where are the deals?')).toBe(
      'Moss answered that the work is done, but wrote “Where are the deals?” Approve the close only if the work was done; otherwise withhold it.',
    );
  });
});
