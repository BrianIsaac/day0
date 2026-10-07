import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Id } from '../../../../../convex/_generated/dataModel';
import {
  ToolsRow,
  type ToolsSurface,
} from '../../../../../app/agent/[agentId]/surfaces/SurfaceControls';

describe('the tools line and the re-approval of a narrowed card (Q10, U10 D2 (b) and D3)', (): void => {
  const tools = (patch: Partial<ToolsSurface>): ToolsSurface => ({
    _id: 'surface-linear' as Id<'surfaces'>,
    displayName: 'Linear',
    verdict: 'connected',
    toolAllowlist: ['list_issues', 'save_comment'],
    approvedToolAllowlist: ['list_issues', 'save_comment', 'delete_issue'],
    ...patch,
  });

  it('prints the tools the card calls, the approved ones the provider no longer offers and those withheld', (): void => {
    const markup = renderToStaticMarkup(
      <ToolsRow
        surface={tools({ withheldTools: ['get_user'] })}
        onApprove={async () => undefined}
      />,
    );
    expect(markup).toMatch(/>May call<\/p><p[^>]*>list_issues, save_comment<\/p>/);
    expect(markup).toContain(
      'Approved, not offered by the provider at the last check: delete_issue',
    );
    expect(markup).toContain('Withheld, outside your approval: get_user.');
    expect(markup).toMatch(
      /<button[^>]*aria-expanded="false"[^>]*>Change approved tools<\/button>/,
    );
    expect(markup).toContain('role="status"');
  });

  it("says on an employee's own Slack app that its messages to you and its edit are Day0's whatever the list says (W13-R15, D-3)", (): void => {
    const slack = tools({ displayName: 'Slack', toolAllowlist: ['conversations.history'] });
    const own = renderToStaticMarkup(
      <ToolsRow surface={slack} ownSlackApp onApprove={async () => undefined} />,
    );
    expect(own.replace(/&#x27;/g, "'")).toContain(
      "Whatever this list says, this employee's own app can always message you and edit its own requests for your approval.",
    );
    const shared = renderToStaticMarkup(
      <ToolsRow surface={slack} onApprove={async () => undefined} />,
    );
    expect(shared).not.toContain('Day0 created for this employee');
  });

  it('says a card that may call nothing in words, not as a tool name', (): void => {
    const markup = renderToStaticMarkup(
      <ToolsRow surface={tools({ toolAllowlist: [] })} onApprove={async () => undefined} />,
    );
    expect(markup).toMatch(/<p class="text-sm text-\[var\(--color-fg-2\)\]">No tool/);
    expect(markup).toContain('No tool the provider offers is approved.');
  });

  it('says nothing is withheld when the row withholds nothing, and nothing for a card not connected', (): void => {
    const none = renderToStaticMarkup(
      <ToolsRow surface={tools({})} onApprove={async () => undefined} />,
    );
    expect(none).not.toContain('Withheld');
    expect(
      renderToStaticMarkup(
        <ToolsRow surface={tools({ verdict: 'proposed' })} onApprove={async () => undefined} />,
      ),
    ).toBe('');
  });
});
