/** @vitest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RepairNote } from '../../../../../app/agent/[agentId]/work/RunDetails';
import { PendingActions } from '../../../../../app/agent/[agentId]/work/PendingActions';
import {
  HELD_BEFORE_AUTONOMY_NOTE,
  HELD_WITHHELD_TRANSITION_NOTE,
} from '../../../../../src/work/autonomy';
import { HELD_WITHHELD_TRANSITION } from '../../../../../src/surfaces/policy';

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
    expect(markup).toContain(HELD_WITHHELD_TRANSITION);
  });
});
