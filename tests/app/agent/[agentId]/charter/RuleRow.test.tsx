import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ConstraintList,
  RuleRow,
  ruleStanding,
} from '../../../../../app/agent/[agentId]/charter/RuleRow';

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

  it('offers no Strike for a rule whose words no clause carries any more, whatever took them out', (): void => {
    const html = row({ preview: { removedClauses: [], rewrittenClauses: [], changes: false } });
    expect(html).toContain('nothing to strike: no clause carries these words any more');
    expect(html).toMatch(/<span[^>]*>Not in the clauses<\/span>/);
    expect(html).not.toContain('>Strike<');
    expect(html).not.toContain('>Confirmed<');
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
    // A clause that opens on a name written in lower case keeps it (second review x10).
    const named = row({
      constraint: {
        ...rule,
        wording: ['dbt models for the close.', 'answer routine asks.', 'iPhone alerts.'],
      },
    });
    expect([...named.matchAll(/<b[^>]*>([^<]*)<\/b>/g)].map((match) => match[1])).toEqual([
      'dbt models for the close',
      'Answer routine asks',
      'iPhone alerts.',
    ]);
    // A hyphenated word and a word ending its sentence are words, and are capitalised alike.
    const words = row({
      constraint: {
        ...rule,
        wording: ['follow-up on stalled tickets', 'stripe.com refunds', 'sync.'],
      },
    });
    expect([...words.matchAll(/<b[^>]*>([^<]*)<\/b>/g)].map((match) => match[1])).toEqual([
      'Follow-up on stalled tickets',
      'stripe.com refunds',
      'Sync.',
    ]);
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

describe('a rule bound to the clauses it produced (13-R)', (): void => {
  const bound = {
    kind: 'system-boundary' as const,
    quote: 'Never change a deal amount in the tracker.',
    wording: ['change a deal amount in the tracker.'],
    origin: 'synthesis' as const,
    binds: [{ field: 'willNotDo' as const, index: 0 }],
  };
  const strikes = {
    removedClauses: ['Change a deal amount in the tracker.'],
    rewrittenClauses: [],
    changes: true,
  };
  const clausesOf = (html: string): string[] =>
    [...html.matchAll(/<span data-clause=""[^>]*>([^<]*)<\/span>/g)].map((match) => match[1]!);

  it('stands confirmed, to be checked, or in no clause by where it is placed', (): void => {
    const clause = 'Change a deal amount in the tracker.';
    expect(
      ruleStanding(bound, strikes, {
        kind: 'bound',
        clauses: [clause],
        carriesWords: true,
        notCarrying: [],
      }),
    ).toBe('confirmed');
    expect(
      ruleStanding(bound, strikes, {
        kind: 'bound',
        clauses: [clause],
        carriesWords: false,
        notCarrying: [clause],
      }),
    ).toBe('check');
    expect(
      ruleStanding(
        { ...bound, wording: [] },
        { removedClauses: [], rewrittenClauses: [], changes: false },
        { kind: 'in-no-clause' },
      ),
    ).toBe('in-no-clause');
    expect(ruleStanding({ ...bound, struck: true }, undefined, { kind: 'in-no-clause' })).toBe(
      'struck',
    );
  });

  it('lists the clauses it binds as what it became, in plain weight, with no "not verified" line', (): void => {
    const html = row({
      constraint: { ...bound, wording: [] },
      preview: strikes,
      placement: {
        kind: 'bound',
        clauses: ['Change a deal amount in the tracker.', 'Escalate any amount change.'],
        carriesWords: true,
        notCarrying: [],
      },
    });
    expect(html).toContain('where I may act · in the charter as ');
    expect(clausesOf(html)).toEqual([
      'Change a deal amount in the tracker',
      'Escalate any amount change.',
    ]);
    expect(html).not.toMatch(/<b[ >]/);
    expect(html).not.toContain('not verified');
    expect(html).toMatch(/<span[^>]*>Confirmed<\/span>/);
    expect(html).toMatch(/>Strike<\/button>/);
  });

  it("asks the manager to check bound clauses that do not carry the rule's words, in the warn tone", (): void => {
    const html = row({
      constraint: bound,
      preview: {
        removedClauses: ['Draft replies for routine tickets.'],
        rewrittenClauses: [],
        changes: true,
      },
      placement: {
        kind: 'bound',
        clauses: ['Draft replies for routine tickets.'],
        carriesWords: false,
        notCarrying: ['Draft replies for routine tickets.'],
      },
    });
    expect(html).toMatch(/data-standing="check"/);
    expect(html).toMatch(/<span class="[^"]*color-warn[^"]*">Check the clause<\/span>/);
    expect(html).toContain('This clause does not carry your words.');
    expect(html).toContain(
      'strikes the clause, though it may not be this rule: “Draft replies for routine tickets.”',
    );
    expect(html).not.toContain('not verified');
    const two = row({
      constraint: bound,
      preview: { removedClauses: ['A.', 'B.'], rewrittenClauses: [], changes: true },
      placement: {
        kind: 'bound',
        clauses: ['A.', 'B.'],
        carriesWords: false,
        notCarrying: ['A.', 'B.'],
      },
    });
    expect(two).toContain('These clauses do not carry your words.');
    expect(two).toContain('strikes the clauses, though they may not be this rule: “A.”; “B.”');
  });

  it('says a bound rule whose strike would change nothing, without blaming another strike', (): void => {
    const html = row({
      constraint: bound,
      preview: { removedClauses: [], rewrittenClauses: [], changes: false },
      placement: {
        kind: 'bound',
        clauses: ['keep the tracker clean'],
        carriesWords: true,
        notCarrying: [],
      },
    });
    expect(html).toContain('nothing to strike: striking it would change no clause');
    expect(html).not.toContain('>Strike<');
  });

  it('says a rule in no clause is not enforced, offers no Strike, and on a draft asks for changes', (): void => {
    const html = row({
      constraint: { ...bound, wording: [], binds: [] },
      preview: { removedClauses: [], rewrittenClauses: [], changes: false },
      placement: { kind: 'in-no-clause' },
      name: 'Nell',
      onKeep: () => undefined,
    });
    expect(html).toMatch(/data-standing="in-no-clause"/);
    expect(html).toMatch(/<span class="[^"]*color-warn[^"]*">In no clause<\/span>/);
    expect(html).toContain('where I may act · in no clause</p>');
    expect(html).toMatch(
      /<p class="[^"]*text-\[var\(--color-fg\)\][^"]*">The charter does not enforce it\. Ask Nell for changes to add it, or approve without it\.<\/p>/,
    );
    expect(html).toMatch(
      /<button[^>]*aria-label="Ask for changes to add: Never change a deal amount in the tracker."[^>]*>Ask for changes<\/button>/,
    );
    expect(html).not.toContain('>Strike<');
    expect(html).not.toContain('not verified');
  });

  it('offers to add a rule in no clause to its list on the approved record', (): void => {
    const html = row({
      constraint: { ...bound, wording: [], binds: [] },
      preview: undefined,
      placement: { kind: 'in-no-clause' },
      record: true,
      name: 'Nell',
      onStrike: undefined,
      onRestore: undefined,
      onKeep: () => undefined,
    });
    expect(html).toContain('The charter does not enforce it. Add it to will not do to enforce it.');
    expect(html).toMatch(
      /<button[^>]*aria-label="Add to will not do: Never change a deal amount in the tracker."[^>]*>Add to will not do<\/button>/,
    );
  });
});

describe('a strike that takes only the clauses carrying its rule (W13-R6, W13-R7)', (): void => {
  const clausesOf = (html: string): string[] =>
    [...html.matchAll(/<span data-clause=""[^>]*>([^<]*)<\/span>/g)].map((match) => match[1]!);
  const bound = {
    kind: 'reporting-line' as const,
    quote: 'The support lead owns tone and billing owns refunds. Go through me for both.',
    wording: [],
    origin: 'synthesis' as const,
    binds: [
      { field: 'willNotDo' as const, index: 2 },
      { field: 'willNotDo' as const, index: 3 },
    ],
  };

  it('says which clause a strike keeps and why, beside the one it takes', (): void => {
    const html = row({
      constraint: bound,
      preview: {
        removedClauses: ['Contact the support lead or billing directly.'],
        rewrittenClauses: [],
        changes: true,
        keptClauses: [
          {
            clause: 'Promise a refund in a reply.',
            because: 'another-rule',
            rule: 'Never promise a refund in a reply.',
          },
          { clause: 'Read each social mention.', because: 'not-this-rule' },
          { clause: 'Draft replies.', because: 'no-words' },
        ],
      },
      placement: {
        kind: 'bound',
        clauses: ['Promise a refund in a reply.', 'Contact the support lead or billing directly.'],
        carriesWords: true,
        notCarrying: ['Promise a refund in a reply.'],
      },
    });
    expect(html).toContain('strikes the clause: “Contact the support lead or billing directly.”');
    expect(html).toContain(
      'keeps the clause “Promise a refund in a reply.” because another rule still needs it: “Never promise a refund in a reply.”',
    );
    expect(html).toContain(
      'keeps the clause “Read each social mention.”: it does not carry your words',
    );
    expect(html).toContain(
      'keeps the clause “Draft replies.”: your words are not in it to take out',
    );
    // Named once, by its kept line; the note names only a bound clause no kept line names.
    expect(html).not.toContain('Also linked to this rule');
    const recordRow = row({
      constraint: bound,
      preview: undefined,
      placement: {
        kind: 'bound',
        clauses: ['Promise a refund in a reply.', 'Contact the support lead or billing directly.'],
        carriesWords: true,
        notCarrying: ['Promise a refund in a reply.'],
      },
    });
    expect(recordRow).toContain(
      'Also linked to this rule, but it does not carry your words: “Promise a refund in a reply.”',
    );
    expect(html).toMatch(/<span[^>]*>Confirmed<\/span>/);
    // Shown as the clause that carries it; the other is said beneath, not listed as the rule.
    expect(html).toContain('who I report to · in the charter as ');
    expect(clausesOf(html)).toEqual(['Contact the support lead or billing directly.']);
  });

  it('says on the list that a strike takes only what carries the rule, not that nothing else changes', (): void => {
    const html = renderToStaticMarkup(
      <ConstraintList
        constraints={[bound]}
        approved={false}
        onStrike={() => undefined}
        onRestore={() => undefined}
        previewStrike={() => ({ removedClauses: [], rewrittenClauses: [], changes: false })}
      />,
    );
    expect(html).toContain(
      'Each rule is a sentence you said, and what it became. Strike removes the clauses that carry it; each row says what it takes and what it keeps.',
    );
    expect(html).not.toContain('nothing else changes');
  });
});
