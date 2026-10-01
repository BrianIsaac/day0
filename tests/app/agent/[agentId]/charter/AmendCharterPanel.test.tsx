/** @vitest-environment jsdom */

import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';
import type { Doc } from '../../../../../convex/_generated/dataModel';
import { AmendCharterPanel } from '../../../../../app/agent/[agentId]/charter/AmendCharterPanel';
import { CharterCard } from '../../../../../app/agent/[agentId]/charter/CharterCard';
import { focusedName, mount, press, said, settle, typeInto } from '../../../../fixtures/dom/press';

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

describe('amending an approved charter from the card', (): void => {
  const charter = {
    _id: 'charter-2',
    _creationTime: 2,
    agentId: 'agent-1',
    version: '0.1',
    approved: true,
    approvedAt: 2,
    supersedes: 'charter-1',
    createdAt: 2,
    body: {},
  } as unknown as Doc<'charters'>;
  const body = {
    whyThisHire: 'Close week.',
    proposedFunction: 'Own routine revenue operations work from Linear tickets.',
    shortTermGoals: { day30: 'a', day60: 'b', day90: 'c' },
    proposedBoundaries: {
      willDo: ['Handle Linear tickets in the Q3 close project.'],
      willNotDo: ['Post to public Slack channels.'],
      escalationTriggers: [],
    },
    namedCollaborators: [],
    namedSystems: [{ name: 'Linear', class: 'kanban', whereMentioned: 'Work is in Linear.' }],
    priorityReading: [],
    openQuestions: ['Whether Northstar CRM access will be granted.'],
    answeredQuestions: [
      { question: 'Who owns the Looker tile.', answer: 'Priya.', answeredAt: 'x' },
    ],
  };

  it('offers every typed change: the function, each clause list, the open questions, a rule and the systems', (): void => {
    const markup = renderToStaticMarkup(
      <AmendCharterPanel charter={charter} body={body} busy={false} onAmend={() => undefined} />,
    );
    expect(markup).toContain('next version v0.2');
    expect(markup).toContain('value="Own routine revenue operations work from Linear tickets."');
    expect(markup).toContain('value="Handle Linear tickets in the Q3 close project."');
    expect(markup).toContain('Add to escalation triggers');
    expect(markup).toContain('Whether Northstar CRM access will be granted.');
    expect(markup).toContain('>Answer<');
    expect(markup).toContain('Who owns the Looker tile.');
    expect(markup).toContain('- Priya.');
    expect(markup).toContain('>Add rule<');
    expect(markup).toContain('Linear (kanban)');
    expect(markup).toContain('>Add system<');
    expect(markup).toContain('>Remove<');
  });

  it("offers no approval chain of its own: the manager is the agent row's, handed over from People (U9 D3 (b), D14)", (): void => {
    const panel = renderToStaticMarkup(
      <AmendCharterPanel charter={charter} body={body} busy={false} onAmend={() => undefined} />,
    );
    expect(panel.toLowerCase()).not.toMatch(/approval chain|approver|who approves/);
    const card = renderToStaticMarkup(
      <CharterCard charter={{ ...charter, body }} manager="ana@kestrel.example" />,
    );
    // The header holds no control since D14; Hand over on People is the only one (the v0.12.0 walk).
    expect(card).toContain(
      'ana@kestrel.example. To move the employee to another manager, use Hand over on',
    );
    expect(card).not.toContain('change it there');
  });

  it("says the backend's refusal in the card's live region, with the panel closed or open, and keeps focus on the control", async (): Promise<void> => {
    backend.refusals = {
      'charters:amend': `[CONVEX M(charters:amend)] [Request ID: 1] Server Error\nUncaught Error: the amendment changes nothing\n    at handler (../convex/charters.ts:1:1)`,
    };
    const view = mount(<CharterCard charter={{ ...charter, body }} />);
    await press(view.container, 'Remove: Linear');

    expect(said(view.container)).toEqual(['the amendment changes nothing']);
    expect(focusedName()).toBe('Remove: Linear');
    view.unmount();
    backend.refusals = {};
  });

  it('says the new version once an amendment lands, and empties the field it came from', async (): Promise<void> => {
    const view = mount(<CharterCard charter={{ ...charter, body }} />);
    const field = [...view.container.querySelectorAll<HTMLLabelElement>('label')].find(
      (label) => label.textContent === 'Add to escalation triggers',
    )?.control as HTMLInputElement | null;
    if (!field) throw new Error('no field labelled for the escalation triggers');
    typeInto(field, 'A close figure moves by more than 5 points.');
    const add = [...view.container.querySelectorAll('button')].find(
      (candidate) =>
        candidate.textContent === 'Add' && candidate.parentElement?.contains(field) === true,
    );
    add?.focus();
    await act(async (): Promise<void> => {
      add?.click();
    });
    await settle();

    expect(said(view.container)).toEqual(['Charter amended: version 0.2 is the one in force.']);
    expect(field.value).toBe('');
    expect(document.activeElement).toBe(field);
    view.unmount();
  });

  it('strikes a rule of the approved charter from behind the disclosure, the record list itself read-only', async (): Promise<void> => {
    const ruled = {
      ...body,
      constraints: [
        {
          kind: 'system-boundary',
          quote: 'Never post to public channels.',
          wording: ['Post to public Slack channels.'],
          origin: 'synthesis',
        },
      ],
    };
    const view = mount(<CharterCard charter={{ ...charter, body: ruled }} />);
    const rules = view.container.querySelector('[data-standing]')?.closest('ul');
    expect(rules?.querySelector('button')).toBeNull();
    const strike = view.container.querySelector('details button[aria-label^="Strike:"]');
    expect(strike?.textContent).toBe('Strike');
    await press(view.container, 'Strike: Never post to public channels.');
    expect(backend.calls).toContainEqual({
      name: 'charters:amend',
      args: { agentId: 'agent-1', changes: [{ kind: 'strike-constraint', index: 0 }] },
    });
    view.unmount();
    backend.calls = [];
  });

  it('offers no amendment strike for a rule no clause carries, nor a second line for its sentence (production walk 6c)', (): void => {
    const sentence = 'Never post to public channels.';
    const ruled = {
      ...body,
      constraints: [
        {
          kind: 'system-boundary',
          quote: sentence,
          wording: ['Post to public Slack channels.'],
          origin: 'synthesis',
        },
        { kind: 'reporting-line', quote: sentence, wording: [], origin: 'synthesis' },
        { kind: 'candidate-property', quote: 'Only Q3 work.', wording: [], origin: 'synthesis' },
      ],
    };
    const markup = renderToStaticMarkup(<CharterCard charter={{ ...charter, body: ruled }} />);
    const strikes = [...markup.matchAll(/aria-label="Strike: ([^"]*)"/g)].map(([, quote]) => quote);
    expect(strikes).toEqual([sentence]);
  });

  it('is absent from a charter awaiting approval', (): void => {
    const draft = { ...charter, approved: false, body } as unknown as Doc<'charters'>;
    const markup = renderToStaticMarkup(<CharterCard charter={draft} />);
    expect(markup).not.toContain('Amend this charter');
    expect(markup).toContain('>Approve charter<');
  });
});
