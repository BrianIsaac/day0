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
        preview={{ removedClauses: ['Reports to Sam.'], rewrittenClauses: [], changes: true }}
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
  it('stands confirmed, struck, kept where the charter cannot do without it, or not in the clauses', (): void => {
    const words = { wording: ['Sam'] };
    expect(ruleStanding(words, { removedClauses: [], rewrittenClauses: [], changes: true })).toBe(
      'confirmed',
    );
    expect(ruleStanding({ ...words, struck: true }, undefined)).toBe('struck');
    expect(
      ruleStanding(words, {
        removedClauses: [],
        rewrittenClauses: [],
        changes: false,
        refusal: 'one reporting line',
      }),
    ).toBe('kept');
    expect(ruleStanding({ wording: [] }, undefined)).toBe('unverified');
  });

  it('offers no Strike for a rule no clause carries, which would change nothing (production walk 6c)', (): void => {
    const html = row({
      constraint: { ...rule, wording: [] },
      preview: { removedClauses: [], rewrittenClauses: [], changes: false },
    });
    expect(html).toContain('who I report to · not verified: no clause carries these words');
    expect(html).toMatch(/<span[^>]*>Not in the clauses<\/span>/);
    expect(html).not.toContain('>Strike<');
    expect(html).not.toContain('>Confirmed<');
  });

  it('offers no Strike for a rule whose words another struck rule already takes out', (): void => {
    const html = row({ preview: { removedClauses: [], rewrittenClauses: [], changes: false } });
    expect(html).toContain('nothing to strike: another struck rule already takes its words out');
    expect(html).not.toContain('>Strike<');
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
        changes: false,
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
