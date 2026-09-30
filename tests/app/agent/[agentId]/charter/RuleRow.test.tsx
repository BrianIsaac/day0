import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RuleRow, ruleStanding } from '../../../../../app/agent/[agentId]/charter/RuleRow';

const rule = {
  kind: 'reporting-line' as const,
  quote: 'just me for now, your boss',
  wording: ['Sam'],
  origin: 'synthesis' as const,
};

function row(props: Partial<Parameters<typeof RuleRow>[0]> = {}): string {
  return renderToStaticMarkup(
    <ul>
      <RuleRow
        constraint={rule}
        index={0}
        preview={{ removedClauses: ['Reports to Sam.'], rewrittenClauses: [] }}
        justStruck={false}
        busy={false}
        onStrike={() => undefined}
        onRestore={() => undefined}
        {...props}
      />
    </ul>,
  );
}

describe('a rule of the charter (round two section 3.5)', (): void => {
  it('stands confirmed, struck, or kept where the charter cannot do without it', (): void => {
    expect(ruleStanding({}, { removedClauses: [], rewrittenClauses: [] })).toBe('confirmed');
    expect(ruleStanding({ struck: true }, undefined)).toBe('struck');
    expect(
      ruleStanding({}, { removedClauses: [], rewrittenClauses: [], refusal: 'one reporting line' }),
    ).toBe('kept');
  });

  it('capitalises the clauses it lists alike, so clauses written in mixed case read as one list (walk m22)', (): void => {
    const html = row({
      constraint: {
        ...rule,
        wording: ['answer routine asks from the team.', 'Post in any Slack channel.'],
      },
    });
    const listed = [...html.matchAll(/<b[^>]*>([^<]*)<\/b>/g)].map((match) => match[1]);
    expect(listed).toEqual(['Answer routine asks from the team', 'Post in any Slack channel.']);
    // One clause's words are left as the charter holds them.
    expect(row({ constraint: { ...rule, wording: ['owned, prioritized'] } })).toContain(
      '>owned, prioritized</b>',
    );
  });

  it("says the manager's words, what they became, what a strike removes, and Confirmed", (): void => {
    const html = row();
    expect(html).toContain('>“just me for now, your boss”</p>');
    expect(html).toContain('who I report to · in the charter as ');
    expect(html).toContain('strikes the clause: “Reports to Sam.”');
    expect(html).toMatch(/data-standing="confirmed"/);
    expect(html).toMatch(/<span[^>]*>Confirmed<\/span>/);
    expect(html).toMatch(
      /<button[^>]*aria-label="Strike: just me for now, your boss"[^>]*>Strike<\/button>/,
    );
  });

  it('says why a row cannot be struck, keeps it, and offers its Strike disabled with the reason', (): void => {
    const html = row({
      preview: {
        removedClauses: [],
        rewrittenClauses: [],
        refusal: 'a charter needs one reporting line',
      },
    });
    expect(html).toContain('cannot be struck: a charter needs one reporting line');
    expect(html).toMatch(/<span[^>]*>Kept<\/span>/);
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*title="a charter needs one reporting line"[^>]*>Strike<\/button>/,
    );
  });

  it('draws a struck rule struck, says Restore puts it back, and marks only a new strike to play', (): void => {
    const html = row({
      constraint: { ...rule, struck: true },
      preview: undefined,
      justStruck: true,
    });
    expect(html).toMatch(/<li data-just=""[^>]*data-standing="struck"/);
    expect(html).toMatch(/<span[^>]*>Struck<\/span>/);
    expect(html).toContain('<span data-struck-mark="">· struck</span>');
    expect(html).toContain('Restore puts them back.');
    expect(html).toMatch(/>Restore<\/button>/);
    expect(row({ constraint: { ...rule, struck: true }, preview: undefined })).not.toContain(
      'data-just',
    );
  });
});
