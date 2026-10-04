import { describe, expect, it } from 'vitest';
import { slackEscaped } from '../../../src/surfaces/slack-markup';
import { summariseAction } from '../../../src/surfaces/summary';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import { batchRequestLines, decisionRequestText } from '../../../src/work/manager-channel';
import { digestText, landedNoteText, stoppedNoteText } from '../../../src/work/manager-notes';
import type { MockAction } from '../../../src/work/types';

/*
 * Slack's control characters in what Day0 quotes from a model or a ticket (12-H's "For the
 * cockpit"; the walk on real Slack, row 19 and "Unproven"). Slack reads `<!here>`, `<@U…>` and
 * `<#C…>` in a message's text as a mention or a link, and asks for `&`, `<` and `>` to be escaped;
 * Day0 sent row 19's sentence unescaped. Every builder of a message to the manager escapes what it
 * quotes, through one function, so a quoted control sequence is text.
 */

/** Row 19's sentence on the walk, as REVOPS-7's run handed it in. */
const ROW_19 =
  'I could not reconcile Halvorsen & Brightwater: the tracker shows <no rows> for Q3 > Q2, so nothing was done.';

/** The three control sequences the walk could not try on real Slack: they would notify. */
const CONTROL = '<!here> ask <@U0BTFHN6MKJ> in <#C0BSQTE1H7E>';
const CONTROL_ESCAPED = '&lt;!here&gt; ask &lt;@U0BTFHN6MKJ&gt; in &lt;#C0BSQTE1H7E&gt;';

const slack: SurfaceRecord = {
  slug: 'slack',
  displayName: 'Slack',
  class: 'chat',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: 1,
  path: 'documented-api',
  endpoint: 'https://slack.com/api/',
  toolAllowlist: ['chat.postMessage'],
  managerDmChannelId: 'D0MANAGER',
};

const linear: SurfaceRecord = {
  slug: 'linear',
  displayName: 'Linear',
  class: 'kanban',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: 1,
  path: 'mcp',
  endpoint: 'https://mcp.linear.app/mcp',
  toolAllowlist: ['save_comment', 'save_issue'],
};

const comment: MockAction = {
  tool: 'mcp.call',
  args: {
    surface: 'linear',
    tool: 'save_comment',
    toolArgsJson: JSON.stringify({ issueId: 'REVOPS-7', body: CONTROL }),
  },
};

const post: MockAction = {
  tool: 'http.request',
  args: {
    surface: 'slack',
    method: 'POST',
    path: 'chat.postMessage',
    body: JSON.stringify({ channel: 'C0BSQTE1H7E', text: `Heads up ${CONTROL}` }),
  },
};

const close: MockAction = {
  tool: 'mcp.call',
  args: {
    surface: 'linear',
    tool: 'save_issue',
    toolArgsJson: JSON.stringify({ id: 'REVOPS-7', state: 'Done' }),
  },
};

/** Whether a text carries a control sequence Slack would read, unescaped. */
const RAW_CONTROL = /<(?:!here|@U0BTFHN6MKJ|#C0BSQTE1H7E(?!\|?[^>]*>$))>/;

describe('slackEscaped', (): void => {
  it('escapes the three characters Slack reads as markup, ampersand first', (): void => {
    expect(slackEscaped(ROW_19)).toBe(
      'I could not reconcile Halvorsen &amp; Brightwater: the tracker shows &lt;no rows&gt; for Q3 &gt; Q2, so nothing was done.',
    );
    expect(slackEscaped(CONTROL)).toBe(CONTROL_ESCAPED);
    expect(slackEscaped('&lt;')).toBe('&amp;lt;');
  });
});

describe('every message builder escapes what it quotes from a model or a ticket', (): void => {
  it('the decision request: the title, the plan, the item and each held action', (): void => {
    const plan = decisionRequestText({
      agentName: 'Iris',
      title: `Reconcile ${CONTROL}`,
      id: 'n93g48',
      kind: 'plan',
      plan: {
        summary: `Plan ${CONTROL}`,
        steps: [`Step ${CONTROL}`],
        riskNotes: `Risk ${CONTROL}`,
        reversibility: `Undo ${CONTROL}`,
      },
      item: {
        sourceCategory: 'ticket-queue',
        externalId: `REVOPS-7 ${CONTROL}`,
        link: `https://linear.app/x?a=1&b=<!here>`,
      },
    });
    expect(plan).not.toMatch(/<!here>|<@U0BTFHN6MKJ>|<#C0BSQTE1H7E>/);
    expect(plan).toContain(`“Reconcile ${CONTROL_ESCAPED}”`);
    expect(plan).toContain(`Plan ${CONTROL_ESCAPED}`);
    expect(plan).toContain(`Step ${CONTROL_ESCAPED}`);
    expect(plan).toContain('a=1&amp;b=&lt;!here&gt;');

    const held = decisionRequestText({
      agentName: 'Iris',
      title: 'Row 19',
      id: 'n93g48',
      kind: 'actions',
      actions: [comment, post, close],
      heldIndexes: [0, 1],
      surfaces: [slack, linear],
      slackMarkup: true,
      refused: [{ index: 2, reason: `refused ${CONTROL}` }],
    });
    expect(held).toContain(CONTROL_ESCAPED);
    expect(held).not.toMatch(/<!here>|<@U0BTFHN6MKJ>/);
    // Day0's own mention of the post's channel stays Slack's link.
    expect(held).toContain('Post to Slack channel <#C0BSQTE1H7E>: ');
  });

  it('the held close: its sentence, as row 19 sent it', (): void => {
    const request = decisionRequestText({
      agentName: 'Iris',
      title: 'Row 19: note the Halvorsen Freight gap',
      id: 'n93g48',
      kind: 'actions',
      actions: [comment, close],
      heldIndexes: [0],
      surfaces: [slack, linear],
      leftForCard: { indexes: [1], clause: ROW_19 },
    });
    expect(request).toContain(
      'wrote “I could not reconcile Halvorsen &amp; Brightwater: the tracker shows &lt;no rows&gt; for Q3 &gt; Q2, so nothing was done”.',
    );
    const closeOnly = decisionRequestText({
      agentName: 'Iris',
      title: `Row 19 ${CONTROL}`,
      id: 'n93g48',
      kind: 'actions',
      actions: [comment, close],
      heldIndexes: [],
      surfaces: [slack, linear],
      leftForCard: { indexes: [1], clause: CONTROL },
    });
    expect(closeOnly).not.toMatch(/<!here>|<@U0BTFHN6MKJ>|<#C0BSQTE1H7E>/);
    expect(closeOnly).toContain(CONTROL_ESCAPED);
  });

  it('the batch lines: each member’s title', (): void => {
    const lines = batchRequestLines({
      id: 'b4tch1',
      members: [
        { title: `First ${CONTROL}`, decisionId: 'aaaaaa' },
        { title: 'Second', decisionId: 'bbbbbb' },
      ],
    }).join('\n');
    expect(lines).toContain(`First ${CONTROL_ESCAPED}`);
    expect(lines).not.toMatch(RAW_CONTROL);
  });

  it('the notes and the digest: the title, the reason and each landed line', (): void => {
    const landed = landedNoteText({
      agentName: 'Iris',
      title: `Close ${CONTROL}`,
      rows: [{ kind: 'write', line: summariseAction(comment, [linear]) }],
      outcome: 'failed',
      reason: `stopped ${CONTROL}`,
    });
    expect(landed).not.toMatch(/<!here>|<@U0BTFHN6MKJ>|<#C0BSQTE1H7E>/);
    expect(landed.match(/&lt;!here&gt;/g)).toHaveLength(3);
    const stopped = stoppedNoteText({ agentName: 'Iris', title: ROW_19, reason: CONTROL });
    expect(stopped).toContain('Halvorsen &amp; Brightwater');
    expect(stopped).toContain(CONTROL_ESCAPED);
    const digest = digestText({
      agentName: 'Iris',
      zone: 'UTC',
      notes: [{ text: stopped, createdAt: Date.UTC(2026, 9, 5, 9) }],
      owed: [{ title: `Owed ${CONTROL}`, decisionId: 'ab3xyz' }],
    });
    // A note is escaped once, when it is kept; the digest quotes it as kept.
    expect(digest).toContain(stopped);
    expect(digest).not.toContain('&amp;amp;');
    expect(digest).toContain(`“Owed ${CONTROL_ESCAPED}”`);
  });

  it('a held action’s line on the card stays as written: only a Slack message escapes it', (): void => {
    expect(summariseAction(comment, [linear])).toContain(CONTROL);
    expect(summariseAction(comment, [linear], { slackEscape: true })).toContain(CONTROL_ESCAPED);
  });
});
