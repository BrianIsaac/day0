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
