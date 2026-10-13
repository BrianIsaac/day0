/** @vitest-environment jsdom */

import { getFunctionName } from 'convex/server';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../../../convex/_generated/dataModel';

const backend = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; args: unknown }>,
  /** What a query answers, by function name; one left out stays loading. */
  queries: {} as Record<string, unknown>,
  /** Whether a card opened by hand joined one already standing that day. */
  joins: false,
  onCard: true,
  /** Whether the join asked the judgement again. */
  asks: true,
}));

vi.mock('convex/react', () => ({
  useMutation:
    (reference: unknown) =>
    async (args: unknown): Promise<unknown> => {
      const name = getFunctionName(reference as never);
      backend.calls.push({ name, args });
      if (name === 'reorientationDecisions:approve') {
        return { result: 'the charter was amended to version 0.2' };
      }
      if (name === 'reorientationDecisions:defer') return { revisitAt: Date.UTC(2026, 9, 3, 9) };
      if (name === 'reorientationDecisions:openByHand') {
        return {
          reorientationId: 'card-1',
          joined: backend.joins,
          asked: backend.asks,
          onCard: backend.onCard,
        };
      }
      return null;
    },
  useQuery: (reference: unknown, args: unknown): unknown =>
    args === 'skip' ? undefined : backend.queries[getFunctionName(reference as never)],
}));

import {
  ReorientationCard,
  type CardView,
} from '../../../../../app/agent/[agentId]/reorientation/ReorientationCard';
import { ReorientationView } from '../../../../../app/agent/[agentId]/reorientation/ReorientationView';
import { AgentZoneContext } from '../../../../../app/components/time';
import { asEmployee } from '../../../../fixtures/dom/employee';
import { axeViolations } from '../../../../fixtures/dom/axe';
import { mount, press, said, typeInto } from '../../../../fixtures/dom/press';
import { underTarget } from '../../../../fixtures/dom/targets';

/**
 * A reorientation card in every state of `agent-reorientation.html` (16-O; the wave file's
 * section 7, RM24): open with its proposal, waiting on it (holding nothing, or its plans), a
 * proposal that could not be had, nothing to change, each other kind of change, deferred, and
 * decided; each with axe and the 44 px floor.
 */

/** 26 September 2026, 14:44 UTC: the prototype's card. */
const OPENED = Date.UTC(2026, 8, 26, 14, 44);

const BASE: CardView = {
  card: {
    _id: 'card-1' as Id<'reorientations'>,
    _creationTime: OPENED,
    agentId: 'agent-1' as Id<'agents'>,
    userId: 'owner',
    trigger: 'page-status-changed',
    triggerKey: 'event-1',
    triggerSummary: '“Escalation paths” was superseded by “Escalation paths, draft v2”',
    evidence: {
      eventIds: [],
      pageRefs: [{ sourceId: 'source-1' as Id<'docSources'>, ref: 'escalation-paths-v2.md' }],
      relationIds: [],
      correctionIds: [],
      relationshipIds: [],
      skillIds: [],
      skillVersionIds: [],
    },
    affected: {
      charterClauses: [
        {
          field: 'escalationTriggers',
          index: 0,
          text: 'Surface tier-2 answer drafts to the manager for review.',
        },
      ],
      agreements: [],
      relationships: [],
      skills: ['skill-1' as Id<'skills'>],
      surfaces: [],
      workItems: [],
    },
    proposed: {
      kind: 'charter-change',
      changes: [
        {
          kind: 'edit-clause',
          field: 'escalationTriggers',
          index: 0,
          text: 'Surface tier-2 answer drafts about committee-deck numbers to Priya first, then to the manager; everything else to the manager.',
        },
      ],
      rationale:
        'The draft says tier-2 answers about committee-deck numbers now go to Priya first.',
      before: 'Surface tier-2 answer drafts to the manager for review.',
      after:
        'Surface tier-2 answer drafts about committee-deck numbers to Priya first, then to the manager; everything else to the manager.',
    },
    risk: 'low',
    blockingWork: [],
    status: 'open',
    day: '2026-09-26',
    createdAt: OPENED,
  },
  workItems: [],
  pages: [
    {
      sourceId: 'source-1' as Id<'docSources'>,
      ref: 'escalation-paths-v2.md',
      title: 'Escalation paths, draft v2',
    },
  ],
  skills: [{ _id: 'skill-1' as Id<'skills'>, name: 'kanban-comment-and-close' }],
  agreements: [],
  people: [],
  held: { plans: 0, runs: 0 },
  charterVersion: '0.1',
};

/** The card with some of its fields set otherwise. */
function withCard(fields: Partial<CardView['card']>, view: Partial<CardView> = {}): CardView {
  return { ...BASE, ...view, card: { ...BASE.card, ...fields } };
}

beforeEach((): void => {
  backend.calls.length = 0;
  backend.queries = {};
  backend.joins = false;
  backend.onCard = true;
  backend.asks = true;
});

afterEach((): void => {
  document.body.replaceChildren();
});

function drawn(view: CardView): ReturnType<typeof mount> {
  return mount(
    <AgentZoneContext.Provider value="UTC">
      <ReorientationCard view={view} name="Mira" zone="UTC" now={OPENED} />
    </AgentZoneContext.Provider>,
  );
}

/** The card's controls by their names. */
function controls(root: Element): string[] {
  return [...root.querySelectorAll('button')].map((control) => control.textContent ?? '');
}

/** axe and the 44 px floor over a drawn card. */
async function floor(root: Element): Promise<void> {
  expect(await axeViolations(root, ['region'])).toEqual([]);
  expect(underTarget(root)).toEqual([]);
}

describe('a reorientation card', (): void => {
  it('draws the prototype’s card: what changed, what it reaches, the clause before and after, and the three decisions', async (): Promise<void> => {
    const view = drawn(BASE);
    const text = view.container.textContent ?? '';
    expect(view.container.querySelector('h2')?.textContent).toBe(
      "Something Mira's charter assumed has changed: “Escalation paths” was superseded by “Escalation paths, draft v2”",
    );
    expect(text).toContain('opened automatically 26 Sep 2026, 14:44 · low risk · nothing held');
    expect(text).toContain('Affected1 charter clause · 1 skill · 0 plans held');
    expect(text).toContain('Evidence“Escalation paths, draft v2”');
    expect(view.container.querySelector('s')?.textContent).toBe(
      'Surface tier-2 answer drafts to the manager for review.',
    );
    expect(text).toContain('What Mira proposes');
    expect(controls(view.container)).toEqual(['Approve', 'Defer a week', 'Dismiss']);
    expect(text).toContain(
      'Approve writes charter version 0.2. Defer revisits on 3 October and changes nothing. Dismiss closes the card and Mira keeps working under version 0.1.',
    );
    await floor(view.container);
    view.unmount();
  });

  it('approves, defers and dismisses through the card’s own decisions, and says what each did', async (): Promise<void> => {
    const view = drawn(BASE);
    await press(view.container, 'Approve');
    expect(said(view.container).at(-1)).toBe('Approved: the charter was amended to version 0.2.');
    await press(view.container, 'Defer a week');
    expect(said(view.container).at(-1)).toBe('Deferred until 3 October.');
    await press(view.container, 'Dismiss');
    expect(said(view.container).at(-1)).toBe('Dismissed: nothing changed.');
    expect(backend.calls).toEqual([
      { name: 'reorientationDecisions:approve', args: { reorientationId: 'card-1' } },
      { name: 'reorientationDecisions:defer', args: { reorientationId: 'card-1' } },
      { name: 'reorientationDecisions:dismiss', args: { reorientationId: 'card-1' } },
    ]);
    view.unmount();
  });

  it('says the employee is working out its proposal, and that nothing is held, with Approve unavailable', async (): Promise<void> => {
    const view = drawn(withCard({ proposed: { kind: 'pending' } }));
    expect(view.container.textContent).toContain(
      'Mira is working out what to propose. Nothing is held while it does.',
    );
    expect(
      [...view.container.querySelectorAll('button')].find(
        (control) => control.textContent === 'Approve',
      )?.disabled,
    ).toBe(true);
    await floor(view.container);
    view.unmount();
  });

  it('says a high-risk card’s plans wait while the proposal is worked out', async (): Promise<void> => {
    const view = drawn(
      withCard(
        {
          proposed: { kind: 'pending' },
          risk: 'high',
          blockingWork: ['item-1' as Id<'workItems'>],
        },
        {
          workItems: [
            {
              _id: 'item-1' as Id<'workItems'>,
              title: 'Answer the tier-2 ask',
              state: 'plan-pending',
            },
          ],
          held: { plans: 1, runs: 0 },
        },
      ),
    );
    const text = view.container.textContent ?? '';
    expect(text).toContain('high risk · 1 plan held');
    expect(text).toContain(
      'Mira is working out what to propose. The plan it holds waits until you decide the card.',
    );
    expect(text).toContain('Work“Answer the tier-2 ask”');
    await floor(view.container);
    view.unmount();
  });

  it('ends a summary with one full stop, and says Defer keeps a holding card’s plans held (the second pass’s minors)', async (): Promise<void> => {
    const view = drawn(
      withCard(
        {
          triggerSummary: 'The organisation’s Linear connection was revoked: rotated.',
          risk: 'high',
          blockingWork: ['item-1' as Id<'workItems'>],
        },
        { held: { plans: 1, runs: 0 } },
      ),
    );
    const text = view.container.textContent ?? '';
    expect(text).toContain('was revoked: rotated.Affected');
    expect(text).not.toContain('rotated..');
    expect(text).toContain(
      'Defer revisits on 3 October and keeps what the card holds held until then.',
    );
    view.unmount();
  });

  it('draws no Defer sentence on a deferred card, no empty Affected row, and one full stop after an edge’s new scope (the walk’s W-6, W-7, W-8)', async (): Promise<void> => {
    const deferred = drawn(
      withCard(
        { status: 'deferred', revisitAt: Date.UTC(2026, 9, 3) },
        { held: { plans: 0, runs: 0 } },
      ),
    );
    expect(controls(deferred.container)).not.toContain('Defer a week');
    expect(deferred.container.textContent).not.toContain('Defer revisits');
    deferred.unmount();
    const decided = drawn(
      withCard(
        {
          status: 'dismissed',
          decidedAt: OPENED,
          outcome: { summary: 'nothing changed' },
          affected: { ...BASE.card.affected, charterClauses: [], skills: [] },
        },
        { skills: [] },
      ),
    );
    expect(decided.container.textContent).not.toContain('Affected');
    decided.unmount();
    const edge = drawn(
      withCard(
        {
          proposed: {
            kind: 'relationship',
            relationshipId: 'edge-1' as Id<'relationships'>,
            action: 'edit',
            type: 'escalation-contact',
            scope: 'variance escalations.',
            rationale: 'Aman takes them now.',
          },
        },
        {
          people: [
            { _id: 'edge-1' as Id<'relationships'>, words: 'Aman Rao, its escalation contact' },
          ],
        },
      ),
    );
    expect(edge.container.textContent).toContain(
      'Change: Aman Rao, its escalation contact, now for variance escalations.',
    );
    expect(edge.container.textContent).not.toContain('escalations..');
    edge.unmount();
  });

  it('says a running item is held only before its closing steps, and a decided card holds nothing (second pass M3)', async (): Promise<void> => {
    const running = drawn(
      withCard(
        {
          proposed: { kind: 'pending' },
          risk: 'high',
          blockingWork: ['item-1' as Id<'workItems'>],
        },
        {
          workItems: [
            {
              _id: 'item-1' as Id<'workItems'>,
              title: 'Answer the tier-2 ask',
              state: 'executing',
            },
          ],
          held: { plans: 0, runs: 1 },
        },
      ),
    );
    const text = running.container.textContent ?? '';
    expect(text).toContain('high risk · 1 run held before closing');
    expect(text).toContain('Affected1 charter clause · 1 skill · 1 run held before closing');
    expect(text).toContain(
      'Mira is working out what to propose. The run it holds stops before its closing steps until you decide the card.',
    );
    expect(text).not.toContain('plan held');
    running.unmount();
    const decided = drawn(
      withCard(
        {
          status: 'dismissed',
          risk: 'high',
          blockingWork: ['item-1' as Id<'workItems'>],
          decidedAt: OPENED,
          outcome: { summary: 'nothing changed' },
        },
        { held: { plans: 0, runs: 0 } },
      ),
    );
    expect(decided.container.textContent).toContain('Affected1 charter clause · 1 skill');
    expect(decided.container.textContent).not.toContain('held');
    decided.unmount();
  });

  it('says a proposal could not be had, and leaves Dismiss', async (): Promise<void> => {
    const view = drawn(
      withCard({ proposed: { kind: 'pending', failedAt: OPENED, failure: 'timed out' } }),
    );
    expect(view.container.textContent).toContain(
      'Mira could not work out a proposal for this change. Nothing changes unless you act: dismiss the card, or amend the charter yourself.',
    );
    await floor(view.container);
    view.unmount();
  });

  it('says nothing needs to change on a card that proposes nothing', async (): Promise<void> => {
    const view = drawn(
      withCard({ proposed: { kind: 'none', rationale: 'The page changed only its title.' } }),
    );
    const text = view.container.textContent ?? '';
    expect(text).toContain('Nothing needs to change; confirm or dismiss.');
    expect(text).toContain('Approve confirms the card and changes nothing.');
    await floor(view.container);
    view.unmount();
  });

  it('draws each other kind of change in the manager’s words', async (): Promise<void> => {
    const cases: Array<[CardView, string, string]> = [
      [
        withCard(
          {
            proposed: {
              kind: 'agreement',
              agreementId: 'wa1' as Id<'workingAgreements'>,
              action: 'edit',
              statement: 'Copy Priya on committee-deck answers only.',
              rationale: 'The correction narrowed it.',
            },
          },
          {
            agreements: [
              { _id: 'wa1' as Id<'workingAgreements'>, statement: 'Copy Priya on tier-2 answers.' },
            ],
          },
        ),
        'Copy Priya on committee-deck answers only.',
        'Approve changes the working agreement once its check passes.',
      ],
      [
        withCard(
          {
            proposed: {
              kind: 'relationship',
              relationshipId: 'edge-1' as Id<'relationships'>,
              action: 'retire',
              rationale: 'Priya left.',
            },
          },
          { people: [{ _id: 'edge-1' as Id<'relationships'>, words: 'Priya, its approver' }] },
        ),
        'Retire: Priya, its approver.',
        'Approve retires the relationship.',
      ],
      [
        withCard({
          proposed: {
            kind: 'page-status',
            page: { sourceId: 'source-1' as Id<'docSources'>, ref: 'escalation-paths-v2.md' },
            status: 'archived',
            rationale: 'It is a draft.',
          },
        }),
        'Mark “Escalation paths, draft v2” archived.',
        'Approve marks “Escalation paths, draft v2” archived.',
      ],
      [
        withCard({
          proposed: {
            kind: 'scope',
            scope: 'linear:write',
            action: 'grant',
            rationale: 'It needs it.',
          },
        }),
        'Grant access “linear:write”.',
        'Approve grants access “linear:write”.',
      ],
      [
        withCard({
          proposed: {
            kind: 'skill-action',
            skillId: 'skill-1' as Id<'skills'>,
            action: 'recheck',
            rationale: 'The page it read changed.',
          },
        }),
        'Re-check the skill “kanban-comment-and-close”.',
        'Approve re-checks “kanban-comment-and-close”.',
      ],
    ];
    for (const [card, proposes, approves] of cases) {
      const view = drawn(card);
      const text = view.container.textContent ?? '';
      expect(text, proposes).toContain(proposes);
      expect(text, approves).toContain(approves);
      await floor(view.container);
      view.unmount();
    }
  });

  it('says a deferred card’s date and offers no second Defer', async (): Promise<void> => {
    const view = drawn(withCard({ status: 'deferred', revisitAt: Date.UTC(2026, 9, 3, 9) }));
    expect(view.container.textContent).toContain('· deferred until 3 October');
    expect(controls(view.container)).toEqual(['Approve', 'Dismiss']);
    await floor(view.container);
    view.unmount();
  });

  it('keeps what a decision did on a decided card, with no control', async (): Promise<void> => {
    for (const [status, words] of [
      ['applied', 'Approved: the charter was amended to version 0.2.'],
      ['dismissed', 'Dismissed: nothing changed.'],
    ] as const) {
      const view = drawn(
        withCard({
          status,
          decidedAt: OPENED + 60_000,
          outcome: {
            summary:
              status === 'applied' ? 'the charter was amended to version 0.2' : 'nothing changed',
          },
        }),
      );
      expect(view.container.textContent).toContain(words);
      expect(view.container.textContent).toContain(
        `${status === 'applied' ? 'approved' : 'dismissed'} 26 Sep 2026, 14:45`,
      );
      expect(controls(view.container)).toEqual([]);
      await floor(view.container);
      view.unmount();
    }
  });

  it('names on a handover’s card the reporting-line rule that binds no clause (W16-R21, W7a)', async (): Promise<void> => {
    const view = drawn(
      withCard(
        {
          trigger: 'manager-changed',
          triggerSummary: 'priya@acme.test handed Mira over to you',
          evidence: { ...BASE.card.evidence, pageRefs: [] },
        },
        { pages: [], carriedRules: ['Go through me for all of them for now, I’ll intro you.'] },
      ),
    );
    expect(view.container.textContent).toContain(
      'Its reporting-line rule: “Go through me for all of them for now, I’ll intro you.”',
    );
    await floor(view.container);
    view.unmount();
  });

  it('says a card closed by a handover was closed there, not dismissed (W16-R1, D-5 (a))', async (): Promise<void> => {
    const view = drawn(
      withCard({
        status: 'dismissed',
        decidedAt: OPENED + 60_000,
        outcome: { summary: 'closed at the handover, as it was the previous manager’s to decide' },
      }),
    );
    const text = view.container.textContent ?? '';
    expect(text).toContain('Closed at the handover: it was the previous manager’s to decide.');
    expect(text).toContain('closed at the handover 26 Sep 2026, 14:45');
    expect(text).not.toContain('Dismissed');
    expect(controls(view.container)).toEqual([]);
    await floor(view.container);
    view.unmount();
  });

  it('offers Discuss with Mira after the three decisions, to the card’s own talk', async (): Promise<void> => {
    const view = drawn(BASE);
    const foot = [...view.container.querySelectorAll('button, a')].map(
      (control) => control.textContent ?? '',
    );
    expect(foot.slice(-4)).toEqual(['Approve', 'Defer a week', 'Dismiss', 'Discuss with Mira']);
    expect(
      view.container.querySelector('a[href="/agent/agent-1/reorientation/talk/card-1"]')
        ?.textContent,
    ).toBe('Discuss with Mira');
    await floor(view.container);
    view.unmount();
  });

  it('offers to carry on a talk under way, on a pending card and a deferred one too', async (): Promise<void> => {
    for (const card of [
      { status: 'discussing' as const },
      { status: 'discussing' as const, proposed: { kind: 'pending' as const } },
    ]) {
      const view = drawn(withCard(card));
      expect(
        view.container.querySelector('a[href="/agent/agent-1/reorientation/talk/card-1"]')
          ?.textContent,
      ).toBe('Carry on the talk with Mira');
      view.unmount();
    }
    const deferred = drawn(withCard({ status: 'deferred', revisitAt: Date.UTC(2026, 9, 3, 9) }));
    expect(deferred.container.querySelector('a[href$="/talk/card-1"]')?.textContent).toBe(
      'Discuss with Mira',
    );
    deferred.unmount();
  });

  it('offers no Discuss on a decided card', async (): Promise<void> => {
    const view = drawn(withCard({ status: 'applied', decidedAt: OPENED + 60_000 }));
    expect(view.container.querySelector('a[href$="/talk/card-1"]')).toBeNull();
    view.unmount();
  });
});

describe('an address naming a card lands on it once the cards are drawn (16-D’s W-3)', (): void => {
  it('brings the card into view and focus on a client-side arrival, and again when the hash changes', async (): Promise<void> => {
    // The bed's probe: Back to the card and the inbox's Review navigate on the client, where the
    // browser's own jump to the fragment finds no card yet: the card's top sat under the sticky
    // header and focus stayed on the page.
    const scrolled: string[] = [];
    const scroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element): void {
      scrolled.push(this.id);
    };
    try {
      const second = withCard({ _id: 'card-2' as Id<'reorientations'> });
      backend.queries['reorientationDecisions:listForAgent'] = [BASE, second];
      window.location.hash = '#card-card-1';
      const view = mount(asEmployee(<ReorientationView />, { surfaceMode: 'real' }));
      await vi.waitFor((): void => {
        expect(document.activeElement?.id).toBe('card-card-1');
      });
      expect(scrolled).toContain('card-card-1');
      await act(async (): Promise<void> => {
        window.location.hash = '#card-card-2';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      await vi.waitFor((): void => {
        expect(document.activeElement?.id).toBe('card-card-2');
      });
      // jsdom fires its own hashchange beside the one dispatched here: where it lands is the point.
      expect(scrolled.at(-1)).toBe('card-card-2');
      view.unmount();
    } finally {
      window.location.hash = '';
      Element.prototype.scrollIntoView = scroll;
    }
  });

  it('draws the page and lands nowhere on a fragment that is not a valid escape (the second pass)', (): void => {
    backend.queries['reorientationDecisions:listForAgent'] = [BASE];
    window.location.hash = '#card-%E0%A4%A';
    try {
      const view = mount(asEmployee(<ReorientationView />, { surfaceMode: 'real' }));
      expect(view.container.textContent).toContain('What Mira proposes');
      view.unmount();
    } finally {
      window.location.hash = '';
    }
  });

  it('says a card opened by hand was opened, or that the change joined the card already open today (W16-R24)', async (): Promise<void> => {
    backend.queries['reorientationDecisions:listForAgent'] = [BASE];
    const typed = async (): Promise<string | undefined> => {
      const view = mount(asEmployee(<ReorientationView />, { surfaceMode: 'real' }));
      typeInto(view.container.querySelector('input[type="text"]')!, 'Mira now covers renewals too');
      await press(view.container, 'Open a card');
      const outcome = said(view.container).at(-1);
      view.unmount();
      return outcome;
    };
    expect(await typed()).toBe('A card is open. Mira is working out what to propose.');
    backend.joins = true;
    expect(await typed()).toBe(
      'Added to today’s card. Mira is working out what to propose over both.',
    );
    // Where the card's proposal stands (the manager's own talk put it there), nothing says otherwise.
    backend.asks = false;
    expect(await typed()).toBe('Added to today’s card.');
    // A card whose summary is full keeps the words in the record, and the page says where they are.
    backend.onCard = false;
    expect(await typed()).toBe(
      'Today’s card has no room for more words, so this change is in Mira’s record and not on the card.',
    );
  });
});
