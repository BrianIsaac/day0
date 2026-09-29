/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc } from '../../../../../convex/_generated/dataModel';
import { PlanExecutionLedger } from '../../../../../app/agent/[agentId]/work/RunDetails';
import { defaultRuleClause } from '../../../../../app/agent/[agentId]/charter/AmendCharterPanel';
import { CharterCard } from '../../../../../app/agent/[agentId]/charter/CharterCard';
import { ConstraintList } from '../../../../../app/agent/[agentId]/charter/RuleRow';
import { WorkItemCard } from '../../../../../app/agent/[agentId]/work/WorkItemCard';
import { button, focusedName, mount, press, said } from '../../../../fixtures/dom/press';
import { strikeOutcome, strikePreview } from '../../../../../src/agent/charter-constraints';
import type { Charter } from '../../../../../src/agent/charter';
import { strikeRefusalBody } from '../../../../fixtures/charter-strike-refusal-2026-09-15';
import {
  OPEN_QUESTIONS_2026_09_16,
  RECORDED_QUESTIONS_2026_09_16,
  SYNTHESIS_SELF_CHECK_NOTE_2026_09_16,
} from '../../../../fixtures/charter-synthesis-notes-2026-09-16';

const backend = vi.hoisted(() => ({
  /** Mutations and actions that reject, by function name, with the text they reject with. */
  refusals: {} as Record<string, string>,
  /** What a mutation or action resolves with, by function name; undefined otherwise. */
  results: {} as Record<string, unknown>,
  /** Every call made, by function name, with its arguments. */
  calls: [] as Array<{ name: string; args: unknown }>,
  /** What a query answers, by function name; undefined (loading) otherwise. */
  queries: {} as Record<string, unknown>,
}));

vi.mock('convex/react', () => {
  const call =
    (reference: unknown): ((args?: unknown) => Promise<unknown>) =>
    async (args?: unknown): Promise<unknown> => {
      const name = getFunctionName(reference as never);
      backend.calls.push({ name, args });
      const refusal = backend.refusals[name];
      if (refusal !== undefined) throw new Error(refusal);
      return backend.results[name];
    };
  return {
    useQuery: (reference: unknown): unknown => backend.queries[getFunctionName(reference as never)],
    useMutation: call,
    useAction: call,
  };
});

describe('charter confirm-or-strike list', (): void => {
  const constraints = [
    {
      kind: 'candidate-property' as const,
      quote: "if it's a ticket it has an owner and a priority",
      wording: ['owned, prioritized'],
      origin: 'synthesis' as const,
    },
    {
      kind: 'system-boundary' as const,
      quote: 'Never post to public channels.',
      wording: ['Post to public Slack channels.'],
      origin: 'derived' as const,
      struck: true,
    },
  ];

  it("shows each rule in the manager's words beside the clause phrase, with Strike and Restore before approval", (): void => {
    const markup = renderToStaticMarkup(
      <ConstraintList
        constraints={constraints}
        approved={false}
        onStrike={() => undefined}
        onRestore={() => undefined}
      />,
    );
    expect(markup).toContain('Confirm or strike each one');
    expect(markup).toContain('if it&#x27;s a ticket it has an owner and a priority');
    expect(markup).toContain('owned, prioritized');
    expect(markup).toContain('what work qualifies');
    expect(markup).toContain('found by checking the clauses');
    expect(markup).toContain('>Strike<');
    expect(markup).toContain('>Restore<');
    expect(markup).toContain('line-through');
  });

  it('keeps the list as a record after approval; Strike amends, nothing restores', (): void => {
    const record = renderToStaticMarkup(
      <ConstraintList constraints={constraints} approved={true} />,
    );
    expect(record).toContain('Rules this charter enforces');
    expect(record).toContain('struck');
    expect(record).not.toContain('>Strike<');
    expect(record).not.toContain('>Restore<');
    const amendable = renderToStaticMarkup(
      <ConstraintList constraints={constraints} approved={true} onStrike={() => undefined} />,
    );
    expect(amendable).toContain('>Strike<');
    expect(amendable).not.toContain('>Restore<');
  });

  it('renders nothing for a charter drafted before constraints existed', (): void => {
    expect(renderToStaticMarkup(<ConstraintList constraints={[]} approved={false} />)).toBe('');
  });

  it('draws the line through only a rule struck since the list rendered, and settles its mark', (): void => {
    /** The quote of every row the list marks as struck just now. */
    const just = (root: ParentNode): string[] =>
      [...root.querySelectorAll('li[data-just]')].map(
        (row) => row.querySelector('[data-strike]')?.textContent ?? '',
      );
    const list = (struck: boolean) => (
      <ConstraintList
        constraints={[{ ...constraints[0]!, struck }, constraints[1]!]}
        approved={false}
        onStrike={() => undefined}
        onRestore={() => undefined}
      />
    );
    const view = mount(list(false));
    expect(just(view.container)).toEqual([]);
    expect(view.container.querySelectorAll('[data-struck-mark]')).toHaveLength(1);

    act((): void => view.root.render(list(true)));
    expect(just(view.container)).toEqual(["“if it's a ticket it has an owner and a priority”"]);
    expect(view.container.querySelector('li[data-just] [data-struck-mark]')?.textContent).toBe(
      '· struck',
    );

    act((): void => view.root.render(list(false)));
    expect(just(view.container)).toEqual([]);
    view.unmount();
  });

  it('names the struck count on the Approve button', (): void => {
    const charter = {
      _id: 'charter-1',
      _creationTime: 1,
      agentId: 'agent-1',
      version: '0.0',
      approved: false,
      createdAt: 1,
      body: {
        whyThisHire: 'Close week.',
        proposedFunction:
          'Own routine revenue operations work from owned, prioritized Linear tickets.',
        shortTermGoals: { day30: 'a', day60: 'b', day90: 'c' },
        proposedBoundaries: { willDo: [], willNotDo: [], escalationTriggers: [] },
        namedCollaborators: [],
        priorityReading: [],
        openQuestions: [],
        constraints,
      },
    } as unknown as Doc<'charters'>;
    const markup = renderToStaticMarkup(<CharterCard charter={charter} />);
    expect(markup).toContain('>Approve charter, 1 rule struck<');
    const twoStruck = {
      ...charter,
      body: { ...charter.body, constraints: constraints.map((c) => ({ ...c, struck: true })) },
    } as unknown as Doc<'charters'>;
    expect(renderToStaticMarkup(<CharterCard charter={twoStruck} />)).toContain(
      '>Approve charter, 2 rules struck<',
    );
  });

  it.each([
    ['Strike', 0, false],
    ['Restore', 1, true],
  ] as const)(
    'shows why a %s the backend refused was not recorded, on the card',
    async (label, index, struck): Promise<void> => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      backend.refusals = {
        'charters:setConstraintStruck': `[CONVEX M(charters:setConstraintStruck)] [Request ID: 1] Server Error\nUncaught Error: The charter was approved while this page was open.\n    at handler (../convex/charters.ts:1:1)`,
      };
      const charter = {
        _id: 'charter-1',
        _creationTime: 1,
        agentId: 'agent-1',
        version: '0.0',
        approved: false,
        createdAt: 1,
        body: {
          whyThisHire: 'Close week.',
          proposedFunction:
            'Own routine revenue operations work from owned, prioritized Linear tickets.',
          shortTermGoals: { day30: 'a', day60: 'b', day90: 'c' },
          proposedBoundaries: { willDo: [], willNotDo: [], escalationTriggers: [] },
          namedCollaborators: [],
          priorityReading: [],
          openQuestions: [],
          constraints,
        },
      } as unknown as Doc<'charters'>;
      expect(constraints[index]?.struck === true).toBe(struck);
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      act((): void => root.render(<CharterCard charter={charter} />));

      const button = [...container.querySelectorAll('button')].find(
        (candidate) => candidate.textContent === label && !candidate.disabled,
      );
      expect(button).toBeDefined();
      await act(async (): Promise<void> => {
        button?.click();
      });

      expect(container.textContent).toContain('The charter was approved while this page was open.');
      expect(container.textContent).not.toContain('Request ID');
      act((): void => root.unmount());
      container.remove();
      backend.refusals = {};
    },
  );

  it('says what a strike removes, and disables one the effective charter refuses with the reason', (): void => {
    const markup = renderToStaticMarkup(
      <ConstraintList
        constraints={constraints}
        approved={false}
        onStrike={() => undefined}
        previewStrike={(index) =>
          index === 0
            ? {
                removedClauses: ['Handle owned, prioritized Linear tickets.'],
                rewrittenClauses: [
                  { from: 'Own the close checklist.', to: 'Run the close checklist.' },
                ],
              }
            : { removedClauses: [], rewrittenClauses: [] }
        }
      />,
    );
    expect(markup).toContain('strikes the clause: “Handle owned, prioritized Linear tickets.”');
    expect(markup).toContain(
      'rewrites the clause: “Own the close checklist.” to “Run the close checklist.”',
    );
    expect(markup).not.toContain('disabled=""');

    const refused = renderToStaticMarkup(
      <ConstraintList
        constraints={constraints}
        approved={false}
        onStrike={() => undefined}
        previewStrike={() => ({
          removedClauses: [],
          rewrittenClauses: [],
          refusal: 'strike refused: the only clause that bounds Linear',
        })}
      />,
    );
    expect(refused).toContain(
      'cannot be struck: strike refused: the only clause that bounds Linear',
    );
    expect(refused).toMatch(
      /<button[^>]*disabled=""[^>]*title="strike refused: the only clause that bounds Linear"[^>]*>Strike<\/button>/,
    );

    const plain = renderToStaticMarkup(
      <ConstraintList
        constraints={constraints}
        approved={false}
        onStrike={() => undefined}
        previewStrike={() => ({ removedClauses: [], rewrittenClauses: [] })}
      />,
    );
    expect(plain).not.toContain('strikes the clause');
    expect(plain).not.toContain('cannot be struck');
  });
});

describe('the charter card and the strikes approval can honour', (): void => {
  function draft(body: Charter): Doc<'charters'> {
    return {
      _id: 'charter-3',
      _creationTime: 3,
      agentId: 'agent-1',
      version: '0.0',
      approved: false,
      createdAt: 3,
      body,
    } as unknown as Doc<'charters'>;
  }

  /** The Strike buttons in order, with whether each is disabled. */
  function strikeButtons(markup: string): boolean[] {
    return [...markup.matchAll(/<button([^>]*)>Strike<\/button>/g)].map((match) =>
      match[1]!.includes('disabled=""'),
    );
  }

  it('offers the 15 September strike as the clause it removes, and disables the one strike that was always refused', (): void => {
    const markup = renderToStaticMarkup(<CharterCard charter={draft(strikeRefusalBody(false))} />);
    expect(markup).toContain(
      'strikes the clause: “Take ownership of Northstar CRM-dependent work that Sam must handle.”',
    );
    expect(markup).toContain(
      'cannot be struck: strike or edit the whole will-not-do clause; removing only part could change its boundary',
    );
    expect(strikeButtons(markup)).toEqual([false, true, false]);
  });

  it('refuses up front the strike that would drop the only clause bounding a system', (): void => {
    const body = strikeRefusalBody(false);
    body.proposedBoundaries.willNotDo = [
      'Take ownership of Northstar CRM-dependent work that Sam must handle.',
    ];
    body.proposedBoundaries.escalationTriggers = [];
    const markup = renderToStaticMarkup(<CharterCard charter={draft(body)} />);
    expect(markup).toContain(
      'cannot be struck: strike refused: “Take ownership of Northstar CRM-dependent work that Sam must handle.” is the only clause that bounds Northstar CRM',
    );
    expect(strikeButtons(markup)[2]).toBe(true);
  });

  it('enables exactly the strikes whose toggled charter approval would apply', (): void => {
    const bounded = strikeRefusalBody(false);
    bounded.proposedBoundaries.willNotDo = [
      'Take ownership of Northstar CRM-dependent work that Sam must handle.',
    ];
    bounded.proposedBoundaries.escalationTriggers = [];
    for (const body of [strikeRefusalBody(false), bounded]) {
      const markup = renderToStaticMarkup(<CharterCard charter={draft(body)} />);
      const refusedAtApproval = body.constraints!.map((_, index) => {
        const toggled = {
          ...body,
          constraints: body.constraints!.map((c, i) => (i === index ? { ...c, struck: true } : c)),
        };
        return !strikeOutcome(toggled).ok;
      });
      expect(strikeButtons(markup)).toEqual(refusedAtApproval);
      body.constraints!.forEach((_, index) => {
        expect(strikePreview(body, index).refusal !== undefined).toBe(refusedAtApproval[index]);
      });
    }
  });
});

describe("the synthesiser's notes on the charter card", (): void => {
  const charter = {
    _id: 'charter-3',
    _creationTime: 3,
    agentId: 'agent-1',
    version: '0.0',
    approved: true,
    approvedAt: 3,
    createdAt: 3,
    body: {
      whyThisHire: 'Close week.',
      proposedFunction: 'Own routine revenue operations work from Linear tickets.',
      shortTermGoals: { day30: 'a', day60: 'b', day90: 'c' },
      proposedBoundaries: { willDo: [], willNotDo: [], escalationTriggers: [] },
      namedCollaborators: [],
      priorityReading: [],
      openQuestions: [...OPEN_QUESTIONS_2026_09_16],
      synthesisNotes: [SYNTHESIS_SELF_CHECK_NOTE_2026_09_16],
      constraints: [
        {
          kind: 'system-boundary',
          quote: 'Never post to public channels.',
          wording: ['Post to public Slack channels.'],
          origin: 'synthesis',
        },
      ],
    },
  } as unknown as Doc<'charters'>;

  it('shows each note under the rules and offers no answer box for it', (): void => {
    const markup = renderToStaticMarkup(<CharterCard charter={charter} />);
    const rules = markup.indexOf('Rules this charter enforces');
    const notes = markup.indexOf('Notes from drafting');
    expect(rules).toBeGreaterThan(-1);
    expect(notes).toBeGreaterThan(rules);
    expect(markup.slice(notes)).toContain('Evidence check: 1 clause in this draft');
    const answerBoxes = markup.split('>Answer<').length - 1;
    expect(answerBoxes).toBe(OPEN_QUESTIONS_2026_09_16.length);
  });

  it('files a note an older charter recorded as a question under the notes, not the questions', (): void => {
    const legacy = {
      ...charter,
      body: {
        ...(charter.body as object),
        openQuestions: [...RECORDED_QUESTIONS_2026_09_16],
        synthesisNotes: undefined,
      },
    } as unknown as Doc<'charters'>;
    const markup = renderToStaticMarkup(<CharterCard charter={legacy} />);
    expect(markup.split('>Answer<').length - 1).toBe(OPEN_QUESTIONS_2026_09_16.length);
    expect(markup.slice(markup.indexOf('Notes from drafting'))).toContain(
      'Evidence check: 1 clause',
    );
  });
});

describe('the charter card carries what step 4 stored (U18 carried members)', (): void => {
  const baseBody = {
    whyThisHire: 'Close week.',
    proposedFunction: 'Own routine revenue operations work.',
    shortTermGoals: { day30: 'a', day60: 'b', day90: 'c' },
    proposedBoundaries: { willDo: [], willNotDo: [], escalationTriggers: [] },
    namedCollaborators: [],
    priorityReading: [],
    openQuestions: [],
  };

  it('shows the adjacent roles the scope check reads, which the manager could not see', (): void => {
    const charter = {
      _id: 'charter-1',
      _creationTime: 1,
      agentId: 'agent-1',
      version: '1.0',
      approved: true,
      createdAt: 1,
      body: {
        ...baseBody,
        adjacentRoles: [{ who: 'Finance ops', staysOutOfTheirLaneBy: 'never touching invoices' }],
      },
    } as unknown as Doc<'charters'>;
    const markup = renderToStaticMarkup(<CharterCard charter={charter} />);
    expect(markup).toContain('Adjacent roles');
    expect(markup).toContain('Finance ops - never touching invoices');
  });

  it("says a rule no clause carries is not verified, and marks derived wording as the charter's", (): void => {
    const markup = renderToStaticMarkup(
      <ConstraintList
        approved={true}
        constraints={[
          {
            kind: 'candidate-property',
            quote: 'Only owned tickets.',
            wording: [],
            origin: 'synthesis',
          },
          {
            kind: 'system-boundary',
            quote: 'Post to public Slack channels.',
            wording: ['Post to public Slack channels.'],
            origin: 'derived',
          },
        ]}
      />,
    );
    expect(markup).toContain(
      'not verified: no clause carries these words, so striking it changes nothing',
    );
    expect(markup).not.toContain('no clause carries it<');
    expect(markup).toContain('the charter&#x27;s wording, not a sentence of yours');
    expect(markup).not.toContain('&ldquo;Post to public Slack channels.&rdquo;');
    expect(markup).not.toContain('\u201cPost to public Slack channels.\u201d');
  });

  it('names the charter clause a closing step was decided under', (): void => {
    const markup = renderToStaticMarkup(
      <PlanExecutionLedger
        outcomes={[
          {
            step: 2,
            status: 'blocked',
            evidence: 'The close was withheld.',
            charterClause: {
              field: 'willNotDo',
              text: 'Close a ticket without an audit comment.',
              charterVersion: '1.2',
            },
          },
        ]}
      />,
    );
    expect(markup).toContain('under the charter clause');
    expect(markup).toContain('Close a ticket without an audit comment.');
    expect(markup).toContain('(will not do, charter v1.2)');
  });

  it('puts a prohibition under will-not-do by default, and anything else under will-do', (): void => {
    expect(defaultRuleClause('')).toBe('willNotDo');
    expect(defaultRuleClause('Never close a ticket on a Friday.')).toBe('willNotDo');
    expect(defaultRuleClause("Don't post in #general.")).toBe('willNotDo');
    expect(defaultRuleClause('No refunds over 500.')).toBe('willNotDo');
    expect(defaultRuleClause('Only tickets with an owner.')).toBe('willDo');
  });

  it('says a row parked on the charter waits for its approval', (): void => {
    const markup = renderToStaticMarkup(
      <WorkItemCard
        item={
          {
            _id: 'w1',
            _creationTime: 1,
            agentId: 'a1',
            state: 'deferred',
            title: 'Close REVOPS-5',
            contentSummary: 'Close it.',
            sourceSystem: 'linear',
            sourceCategory: 'ticket-queue',
            externalId: 'REVOPS-5',
            observedAt: 1,
            contentRefs: [],
            verdict: { decision: 'defer', reason: 'awaiting-charter', missingPermissions: [] },
          } as unknown as Doc<'workItems'>
        }
        surfaces={[]}
        autonomousActions={false}
        onApprovePlan={(): void => undefined}
        onCancelPlan={(): void => undefined}
        onRetryFailed={(): void => undefined}
        onReconcileFailed={async (): Promise<void> => undefined}
        onApproveActions={async (): Promise<void> => undefined}
        onRejectActions={async (): Promise<void> => undefined}
        onResendDecision={async (): Promise<void> => undefined}
      />,
    );
    expect(markup).toContain('waiting for you to approve the charter');
  });
});

describe('the charter card says what each change came to (step 45, K D6)', (): void => {
  const draft = {
    _id: 'charter-1',
    _creationTime: 1,
    agentId: 'agent-1',
    version: '0.1',
    approved: false,
    createdAt: 1,
    body: {
      whyThisHire: 'Close week.',
      proposedFunction: 'Own routine revenue operations work from Linear tickets.',
      shortTermGoals: { day30: 'a', day60: 'b', day90: 'c' },
      proposedBoundaries: { willDo: [], willNotDo: [], escalationTriggers: [] },
      namedCollaborators: [],
      priorityReading: [],
      openQuestions: [],
      constraints: [
        {
          kind: 'candidate-property',
          quote: 'only the close tickets',
          wording: ['close tickets'],
          origin: 'manager-said',
        },
      ],
    },
  } as unknown as Doc<'charters'>;

  beforeEach((): void => {
    backend.calls = [];
  });

  afterEach((): void => {
    backend.refusals = {};
    backend.results = {};
    backend.calls = [];
  });

  it('strikes a rule, says what approval will leave out, and keeps focus on the control', async (): Promise<void> => {
    backend.results = { 'charters:setConstraintStruck': { ok: true } };
    const view = mount(<CharterCard charter={draft} />);
    await press(view.container, 'Strike: only the close tickets');

    expect(backend.calls).toEqual([
      {
        name: 'charters:setConstraintStruck',
        args: { charterId: 'charter-1', index: 0, struck: true },
      },
    ]);
    expect(said(view.container)).toEqual([
      'Struck “only the close tickets”: approval leaves its clauses out.',
    ]);
    expect(focusedName()).toBe('Strike: only the close tickets');
    view.unmount();
  });

  it("says the strike the backend refused in the server's own words", async (): Promise<void> => {
    backend.results = {
      'charters:setConstraintStruck': { ok: false, reason: 'the rule is the only one on Linear' },
    };
    const view = mount(<CharterCard charter={draft} />);
    await press(view.container, 'Strike: only the close tickets');
    expect(said(view.container)).toEqual(['the rule is the only one on Linear']);
    view.unmount();
  });

  it('approves the charter and says the employee starts, with 44 px decision buttons', async (): Promise<void> => {
    backend.results = { 'charters:approve': { ok: true } };
    const view = mount(<CharterCard charter={draft} />);
    for (const name of ['Approve charter', 'Ask Your employee for changes']) {
      expect(button(view.container, name).className).toMatch(/\bmin-h-11\b/);
    }
    await press(view.container, 'Approve charter');
    expect(said(view.container)).toEqual([
      'Charter approved: the employee starts on the work it implies.',
    ]);
    view.unmount();
  });

  it('lays the 30, 60 and 90-day goals out in one column on a phone', (): void => {
    const goals = /<div class="([^"]*)"><div data-goal=/.exec(
      renderToStaticMarkup(<CharterCard charter={draft} />),
    );
    expect(goals?.[1].split(' ')).toEqual(
      expect.arrayContaining(['grid', 'grid-cols-1', 'sm:grid-cols-3']),
    );
  });
});
