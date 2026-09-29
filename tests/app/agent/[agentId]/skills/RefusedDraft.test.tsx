import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RefusedDraft } from '../../../../../app/agent/[agentId]/skills/RefusedDraft';

describe('the refused skill draft', (): void => {
  it('shows the refused SKILL.md and smoke test behind a disclosure', (): void => {
    const markup = renderToStaticMarkup(
      <RefusedDraft
        skill={{
          refusedBody: '# Refresh\n## Inputs\n- analytics-surface: the tile',
          refusedSmokeTest: 'def run(inputs: dict) -> dict:\n    return {}',
        }}
      />,
    );
    expect(markup).toContain('<details');
    expect(markup).toContain('The refused draft: SKILL.md and smoke.py · not registered');
    expect(markup).toContain('- analytics-surface: the tile');
    expect(markup).toContain('def run(inputs: dict) -&gt; dict:');
    expect(markup).not.toContain('<mark');
  });

  it('renders nothing for a row that kept no draft', (): void => {
    expect(renderToStaticMarkup(<RefusedDraft skill={{}} />)).toBe('');
    expect(renderToStaticMarkup(<RefusedDraft skill={{ refusedBody: '' }} />)).toBe('');
  });

  it('marks the smoke-test line the check refused, with a caret under the column it named', (): void => {
    const markup = renderToStaticMarkup(
      <RefusedDraft
        skill={{
          name: 'analytics-refresh-value',
          refusedSmokeTest:
            'def run(inputs: dict) -> dict:\n    return {"tile": inputs["tile-id"]\n',
          verificationLog:
            'smoke test rejected before sandbox: smoke test is not valid Python 3.12 source: its syntax does not parse at line 2, column 12: `    return {"tile": inputs["tile-id"]`',
        }}
      />,
    );
    expect(markup).toContain('The refused draft, with line 2 of smoke.py marked · not registered');
    expect(markup).toMatch(
      /<mark[^>]*>    return \{&quot;tile&quot;: inputs\[&quot;tile-id&quot;\]<\/mark>/,
    );
    expect(markup).toContain(`${' '.repeat(11)}^ the check refused line 2, column 12`);
    expect(markup).toContain('aria-label="Refused smoke.py: analytics-refresh-value"');
    // Unwrapped with its own scroll, so the caret stays under its column on a phone, and the mark
    // runs the width of the longest line; behind the page's chevron disclosure.
    expect(markup).toMatch(/<pre[^>]*class="[^"]*\bwhitespace-pre\b[^"]*"/);
    expect(markup).not.toMatch(/<pre[^>]*class="[^"]*\bwhitespace-pre-wrap\b/);
    // The files' column is held to the card's width, so the unwrapped line scrolls in its box
    // rather than widening the page.
    expect(markup).toContain('<div class="grid grid-cols-1 gap-2"><div class="min-w-0">');
    expect(markup).toMatch(/<span class="inline-block min-w-full">(<span class="block">|<span)/);
    expect(markup).toMatch(/<summary[^>]*class="[^"]*\bmin-h-11\b[^"]*"><span aria-hidden="true"/);
  });

  it('marks nothing when the reason quotes a line the kept draft does not carry', (): void => {
    const markup = renderToStaticMarkup(
      <RefusedDraft
        skill={{
          refusedSmokeTest: 'def run(inputs: dict) -> dict:\n    return {}',
          verificationLog: 'its syntax does not parse at line 2, column 5: `    print(x`',
        }}
      />,
    );
    expect(markup).not.toContain('<mark');
    expect(markup).toContain('The refused draft: smoke.py');
  });
});
