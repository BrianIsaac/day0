/** @vitest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SurfaceRecord } from '../../../../../src/surfaces/types';
import type { ListedWorkItem } from '../../../../../src/work/item-display';
import { ItemHead } from '../../../../../app/agent/[agentId]/work/ItemHead';
import { AT, DRAWN, SLACK, SURFACES, ZONE } from '../../../../fixtures/work/drawn-states';

function head(
  item: ListedWorkItem,
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
    });
    expect(markup).toMatch(/Rowan Hale, in #revops-asks: <q [^>]*>can you refresh the board\?/);
    expect(markup).not.toContain('U0C78V6LAPP');
    expect(markup).not.toContain('A Slack member');
  });

  it('stamps who decided with its time, unless the landed line says it', (): void => {
    expect(head(DRAWN.landed)).toMatch(
      // Re-pinned for W17-R29: Day0 is capitalised wherever a sentence names it.
      /approved from the Day0 dashboard at <time dateTime="2026-09-29T07:02:00.000Z"[^>]*>29 Sep 2026, 15:02<\/time>\./,
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

describe('a set whose every row Day0’s gate refused (the wave 16 review’s section 6.3)', (): void => {
  // The review's bed 3: both closing sets held one Slack DM to the manager, refused by the gate
  // ("tool not in the surface allowlist"), and the card said "These actions were not asked on
  // Slack yet: they parked while no manager channel was connected." while the DM was connected.
  const connected = [{ ...SLACK, managerUserId: 'U0SAM' }];
  const refusedOnly = (count: number): ListedWorkItem => {
    const held = DRAWN.held as ListedWorkItem & { output: { actions: unknown[] } };
    const { decision: _decision, ...parked } = held;
    void _decision;
    return {
      ...parked,
      output: {
        ...held.output,
        actions: held.output.actions.slice(0, count),
        applied: [],
      },
      actionVerdicts: Array.from({ length: count }, () => ({
        disposition: 'refused',
        reason: 'tool not in the surface allowlist (chat.postMessage)',
      })),
    } as ListedWorkItem;
  };

  it('says nothing waits, and offers no ask on Slack, where the one action was refused', (): void => {
    const markup = head(refusedOnly(1), { surfaces: connected });
    expect(markup).toContain(
      'Nothing here waits on you: the one action was refused by Day0&#x27;s gate and cannot be sent.',
    );
    expect(markup).not.toContain('not asked on Slack yet');
    expect(markup).not.toContain('Ask on Slack');
  });

  it('counts the actions where the gate refused more than one', (): void => {
    expect(head(refusedOnly(2), { surfaces: connected })).toContain(
      'Nothing here waits on you: the 2 actions were refused by Day0&#x27;s gate and cannot be sent.',
    );
  });

  it('still offers the ask for a set with a write waiting, refused rows beside it or not', (): void => {
    const { decision: _decision, ...parked } = DRAWN.held;
    void _decision;
    const markup = head(parked as ListedWorkItem, { surfaces: connected });
    expect(markup).toContain('These actions were not asked on Slack yet');
    expect(markup).toContain('>Ask on Slack</button>');
    const mixed = {
      ...parked,
      actionVerdicts: [
        { disposition: 'refused', reason: 'tool not in the surface allowlist' },
        { disposition: 'auto' },
        { disposition: 'held', reason: 'write held for the manager' },
      ],
    } as ListedWorkItem;
    expect(head(mixed, { surfaces: connected })).toContain('>Ask on Slack</button>');
  });
});
