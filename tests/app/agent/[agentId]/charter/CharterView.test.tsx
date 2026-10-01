import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ queries: {} as Record<string, unknown> }));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown =>
    args === 'skip' ? undefined : backend.queries[getFunctionName(reference as never)],
  useMutation: () => async (): Promise<void> => undefined,
  useAction: () => async (): Promise<void> => undefined,
}));

import { CharterView } from '../../../../../app/agent/[agentId]/charter/CharterView';
import { APPROVED_CHARTER, asEmployee } from '../../../../fixtures/dom/employee';
import { strikeRefusalBody } from '../../../../fixtures/charter-strike-refusal-2026-09-15';

describe('CharterView', () => {
  it('shows the charter card for the charter the page has', () => {
    const charter = {
      ...APPROVED_CHARTER,
      body: {
        whyThisHire: 'Close week.',
        proposedFunction: 'Own routine revenue operations work.',
        shortTermGoals: { day30: 'a', day60: 'b', day90: 'c' },
        proposedBoundaries: { willDo: [], willNotDo: [], escalationTriggers: [] },
        namedCollaborators: [],
        priorityReading: [],
        openQuestions: [],
      },
    };
    expect(renderToStaticMarkup(asEmployee(<CharterView />, { charter }))).toContain('Close week.');
  });

  it('says the one-to-one drafts it when there is none yet', () => {
    expect(renderToStaticMarkup(asEmployee(<CharterView />, { charter: null }))).toContain(
      'Mira has no charter yet: the Day-1 one-to-one drafts it.',
    );
  });
});

describe('a charter carried through a handover (wave 9 review, decision 1 (a))', () => {
  const charter = {
    ...APPROVED_CHARTER,
    body: {
      whyThisHire: 'Close week.',
      proposedFunction: 'Own routine revenue operations work.',
      shortTermGoals: { day30: 'a', day60: 'b', day90: 'c' },
      proposedBoundaries: { willDo: [], willNotDo: [], escalationTriggers: [] },
      namedCollaborators: [],
      priorityReading: [],
      openQuestions: [],
    },
  };

  it('says whose one-to-one drafted it, and offers none of its words', () => {
    backend.queries = {
      'charters:transcriptOf': { heldBy: 'sam@company.com' },
      'charters:listForAgent': [charter],
    };
    const html = renderToStaticMarkup(asEmployee(<CharterView />, { charter }));
    backend.queries = {};
    expect(html).toContain('v0.1 drafted from sam@company.com&#x27;s one-to-one');
    expect(html).toContain(
      'The one-to-one this charter was drafted from was held by sam@company.com. What they said stayed with them at the handover.',
    );
    expect(html).not.toContain('What you said');
    expect(html).not.toContain('Read what you said');
    expect(html).not.toContain('drafted from your one-to-one');
  });

  it('says who approved and amended it before the handover, never "you" for the earlier manager', () => {
    const approved = { ...charter, approvedAt: 1_000 };
    const amended = {
      ...charter,
      _id: 'charter-2' as typeof charter._id,
      version: '0.2',
      supersedes: charter._id,
      createdAt: 2_000,
      approvedAt: 2_000,
    };
    const mine = {
      ...charter,
      _id: 'charter-3' as typeof charter._id,
      version: '0.3',
      supersedes: amended._id,
      createdAt: 9_000,
      approvedAt: 9_000,
    };
    backend.queries = {
      'charters:transcriptOf': { heldBy: 'sam@company.com' },
      'charters:listForAgent': [mine, amended, approved],
      'managerTransfers:earlierManagers': [{ fromAddress: 'sam@company.com', decidedAt: 5_000 }],
    };
    const before = renderToStaticMarkup(asEmployee(<CharterView />, { charter: approved }));
    const after = renderToStaticMarkup(asEmployee(<CharterView />, { charter: mine }));
    backend.queries = {};
    expect(before).toContain('approved by sam@company.com');
    expect(before).not.toContain('approved by you');
    expect(after).toContain('v0.2 amended by sam@company.com');
    expect(after).toContain('v0.3 amended by you');
    expect(after).toContain('v0.1 approved by sam@company.com');
  });

  it('names the earlier manager who struck, answered and added before the handover, never "you" (the v0.12.0 walk)', () => {
    const rule = (quote: string) => ({
      kind: 'candidate-property' as const,
      quote,
      wording: [quote],
      origin: 'manager' as const,
    });
    const struck = { field: 'escalationTriggers' as const, text: 'An ask falls outside scope.' };
    const rewritten = {
      field: 'willDo' as const,
      text: 'Chase stale deals.',
      rewrittenAs: 'Chase deals.',
    };
    const answer = {
      question: 'Who to meet first.',
      answer: 'Priya.',
      answeredAt: new Date(3_000).toISOString(),
    };
    const bodyAt = (extra: object) => ({
      ...charter.body,
      proposedBoundaries: { willDo: ['Chase deals.'], willNotDo: [], escalationTriggers: [] },
      struckClauses: [struck, rewritten],
      ...extra,
    });
    const approved = { ...charter, approvedAt: 1_000, body: bodyAt({}) };
    const amended = {
      ...charter,
      _id: 'charter-2' as typeof charter._id,
      version: '0.2',
      supersedes: charter._id,
      createdAt: 2_000,
      approvedAt: 2_000,
      body: bodyAt({ constraints: [rule('never touch closed-won deals')] }),
    };
    const answered = {
      ...amended,
      _id: 'charter-3' as typeof charter._id,
      version: '0.3',
      supersedes: amended._id,
      createdAt: 3_000,
      approvedAt: 3_000,
      body: bodyAt({
        constraints: [rule('never touch closed-won deals')],
        answeredQuestions: [answer],
      }),
    };
    const mine = {
      ...charter,
      _id: 'charter-4' as typeof charter._id,
      version: '0.4',
      supersedes: answered._id,
      createdAt: 9_000,
      approvedAt: 9_000,
      body: bodyAt({
        constraints: [rule('never touch closed-won deals'), rule('never email a customer')],
        answeredQuestions: [answer],
      }),
    };
    backend.queries = {
      'charters:transcriptOf': { heldBy: 'sam@company.com' },
      'charters:listForAgent': [mine, answered, amended, approved],
      'managerTransfers:earlierManagers': [{ fromAddress: 'sam@company.com', decidedAt: 5_000 }],
    };
    const html = renderToStaticMarkup(asEmployee(<CharterView />, { charter: mine }));
    backend.queries = {};
    expect(html).toMatch(/An ask falls outside scope\.<\/s> struck by sam@company\.com/);
    expect(html).toContain('(before sam@company.com&#x27;s strike: ');
    expect(html).toMatch(/answered by sam@company\.com at /);
    expect(html).toMatch(/never touch closed-won deals[^]*?added by sam@company\.com/);
    expect(html).toMatch(/never email a customer[^]*?added by you/);
    expect(html).not.toContain('struck by you');
    expect(html).not.toContain('answered by you');
    expect(html).not.toContain('before your strike');
  });

  it('says the one-to-one was the reader’s own when it comes back to the manager who held it', () => {
    backend.queries = {
      'charters:transcriptOf': { heldBy: 'Boss@Day0.local' },
      'charters:listForAgent': [charter],
    };
    const html = renderToStaticMarkup(asEmployee(<CharterView />, { charter }));
    backend.queries = {};
    expect(html).toContain('v0.1 drafted from your one-to-one');
    expect(html).toContain(
      'You held the one-to-one this charter was drafted from. What you said was cleared when it was handed over.',
    );
  });
});

describe('the charter review, one rule struck (charter-review-struck.html)', () => {
  const struckDraft = (): typeof APPROVED_CHARTER => {
    const body = strikeRefusalBody(false);
    body.constraints![0] = { ...body.constraints![0]!, struck: true };
    return {
      ...APPROVED_CHARTER,
      _id: 'charter-2' as typeof APPROVED_CHARTER._id,
      version: '0.0',
      approved: false,
      body,
    };
  };

  it('counts the strike on Approve, says what approval does, and strikes the clauses it takes out', () => {
    backend.queries = {
      'charters:transcriptOf': { transcript: 'ASSISTANT: Why?\n\nUSER: Ops left.', endedAt: 1 },
    };
    const html = renderToStaticMarkup(asEmployee(<CharterView />, { charter: struckDraft() }));
    expect(html).toContain('Mira&#x27;s charter · version 0.0');
    expect(html).toContain('>1 rule struck<');
    expect(html).toContain('>Approve charter, 1 rule struck</button>');
    expect(html).toContain(
      'The struck rule takes its clauses out of the charter. Approving lets Mira read the office and start on the work the charter implies. Every write still waits for you. The charter can be amended later, by version.',
    );
    expect(html).toContain('leaves the charter on approval');
    expect(html).toMatch(/data-standing="struck"/);
    expect(html).toContain('What you said');
    expect(html).toContain('Ask Mira for changes');
    backend.queries = {};
  });

  it('says why the reporting line cannot be struck, and keeps it', () => {
    const html = renderToStaticMarkup(asEmployee(<CharterView />, { charter: struckDraft() }));
    const kept = /<li[^>]*data-standing="kept"[\s\S]*?<\/li>/.exec(html)?.[0] ?? '';
    expect(kept).toContain('cannot be struck: ');
    expect(kept).toMatch(/<span[^>]*>Kept<\/span>/);
    expect(kept).toMatch(/<button[^>]*disabled=""[^>]*>Strike<\/button>/);
  });
});
