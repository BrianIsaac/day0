/** @vitest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Doc } from '../../../../../convex/_generated/dataModel';
import type { SurfaceRecord } from '../../../../../src/surfaces/types';
import { ItemHead } from '../../../../../app/agent/[agentId]/work/ItemHead';
import { AT, DRAWN, SLACK, SURFACES, ZONE } from '../../../../fixtures/work/drawn-states';

function head(
  item: Doc<'workItems'>,
  fields: { stampDecision?: boolean; now?: number; surfaces?: SurfaceRecord[] } = {},
) {
  return renderToStaticMarkup(
    <ItemHead
      item={item}
      surfaces={fields.surfaces ?? SURFACES}
      now={fields.now ?? AT}
      zone={ZONE}
      busy={false}
      onAskAgain={(): void => undefined}
      {...(fields.stampDecision !== undefined ? { stampDecision: fields.stampDecision } : {})}
    />,
  );
}

describe('the top of a work item', (): void => {
  it("says the state in the manager's words beside where it came from, the title and the ask", (): void => {
    const markup = head(DRAWN.held);
    expect(markup).toMatch(/>Write held for you<\/span>/);
    // Where it came from, in words: a chat mention is the inbox, a ticket the ticket queue.
    expect(markup).toContain('>slack · inbox · P2</span>');
    expect(head(DRAWN.discovered)).toContain('>linear · ticket queue · low</span>');
    expect(markup).toMatch(
      /<h3 id="work-item-w-held"[^>]*>Draft response for new tier-two RevOps ask<\/h3>/,
    );
    expect(markup).toMatch(/Sara, in #revops-asks: <q [^>]*>Can you take this tier-2 question/);
  });

  it('names the confirmed requester and shows the ask without its raw Slack mention (W13V-7)', (): void => {
    const markup = head({
      ...DRAWN.held,
      requesterLabel: 'U0C78V6LAPP',
      requesterName: 'Rowan Hale',
      contentSummary: '<@U0C78V6LAPP> can you refresh the board?',
    } as Doc<'workItems'>);
    expect(markup).toMatch(/Rowan Hale, in #revops-asks: <q [^>]*>can you refresh the board\?/);
    expect(markup).not.toContain('U0C78V6LAPP');
    expect(markup).not.toContain('A Slack member');
  });

  it('stamps who decided with its time, unless the landed line says it', (): void => {
    expect(head(DRAWN.landed)).toMatch(
      /approved from the day0 dashboard at <time dateTime="2026-09-29T07:02:00.000Z"[^>]*>29 Sep 2026, 15:02<\/time>\./,
    );
    expect(head(DRAWN.landed, { stampDecision: false })).not.toContain('approved from');
  });

  it('offers to ask on the manager channel for a parked row that was never asked', (): void => {
    // A channel that knows the manager: their DM and their user.
    const markup = head(DRAWN.planPending, {
      surfaces: [{ ...SLACK, managerUserId: 'U0SAM' }],
    });
    expect(markup).toContain('This plan was not asked on Slack yet');
    expect(markup).toContain('>Ask on Slack</button>');
    expect(head(DRAWN.planPending)).not.toContain('Ask on Slack');
  });
});
