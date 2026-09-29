import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RunRecord } from '../../../../../app/agent/[agentId]/work/RunRecord';

const failed = { tool: 'mcp.call', ok: false, reason: 'provider returned 500' };
const unknown = { tool: 'mcp.call', ok: false, outcomeUnknown: true };

describe("a run's record beyond what landed", (): void => {
  it('heads the rows that never reached anything, the failure on a danger outline and never its fill', (): void => {
    const markup = renderToStaticMarkup(
      <RunRecord
        output={undefined}
        rows={[failed, unknown]}
        refused={[]}
        failed={[failed]}
        unknown={[unknown]}
        title="Close REVOPS-5"
      />,
    );
    expect(markup).toContain('1 action did not reach the work environment');
    expect(markup).toContain('border-[var(--color-danger-line)] bg-[var(--color-bg)]');
    expect(markup).not.toMatch(/bg-\[var\(--color-danger/);
    expect(markup).toContain('1 action with an unknown outcome · may have landed');
    expect(markup).toContain('the response was lost');
  });

  it('warns when provider evidence had only the structural redaction, and says nothing of an empty run', (): void => {
    const limited = { tool: 'mcp.call', ok: true, redaction: 'structural-only' as const };
    expect(
      renderToStaticMarkup(
        <RunRecord
          output={undefined}
          rows={[limited]}
          refused={[]}
          failed={[]}
          unknown={[]}
          title="t"
        />,
      ),
    ).toContain('Limited redaction');
    expect(
      renderToStaticMarkup(
        <RunRecord output={undefined} rows={[]} refused={[]} failed={[]} unknown={[]} title="t" />,
      ),
    ).toBe('');
  });
});
