/** @vitest-environment jsdom */

import { getFunctionName } from 'convex/server';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The Surfaces tab's decisions pressed in a document: what each one says in
 * the tab's live region and where focus goes once the control that made it
 * has left the card (step 45; wave 3.5 review m10).
 */
const tab = vi.hoisted(() => ({
  verdict: 'proposed' as string,
  /** What a mutation or action answers, by function name, and what it rejects with. */
  results: {} as Record<string, unknown>,
  refusals: {} as Record<string, string>,
  /** Calls held open until the test releases them, by function name. */
  held: {} as Record<string, Promise<void>>,
  /** A second proposed card beside Linear, when set. */
  second: false,
}));

vi.mock('convex/react', () => {
  const call =
    (reference: unknown): (() => Promise<unknown>) =>
    async (): Promise<unknown> => {
      const name = getFunctionName(reference as never);
      await tab.held[name];
      if (tab.refusals[name] !== undefined) throw new Error(tab.refusals[name]);
      return tab.results[name];
    };
  return {
    useAction: call,
    useMutation: call,
    useQuery: (reference: unknown): unknown => {
      const name = getFunctionName(reference as never);
      if (name === 'surfaces:listForAgent') {
        const notion = {
          _id: 'surface-notion',
          agentId: 'agent-1',
          slug: 'notion',
          displayName: 'Notion',
          class: 'docs',
          verdict: 'proposed',
          path: 'mcp',
          whereFound: [],
          credentialLanded: false,
          createdAt: 1,
        };
        return [
          ...(tab.second ? [notion] : []),
          {
            _id: 'surface-linear',
            agentId: 'agent-1',
            slug: 'linear',
            displayName: 'Linear',
            class: 'kanban',
            verdict: tab.verdict,
            path: 'mcp',
            whereFound: [],
            credentialLanded: false,
            createdAt: 1,
          },
        ];
      }
      if (name === 'charters:latest') return null;
      if (name === 'config:components') return { browser: false };
      if (name === 'surfaces:installRedirectConfigured') return false;
      return [];
    },
  };
});

import type { Id } from '../../../../../convex/_generated/dataModel';
import { probeOutcomeText, SurfacesTab } from '../../../../../app/agent/[agentId]/mock/SurfacesTab';
import { focusedName, mount, press, said, settle } from '../../../../fixtures/dom/press';

afterEach((): void => {
  tab.verdict = 'proposed';
  tab.results = {};
  tab.refusals = {};
  tab.held = {};
  tab.second = false;
});

describe('a decision on a surface card', (): void => {
  it('says the approval, and gives focus to the card once Approve has become its verdict', async (): Promise<void> => {
    const view = mount(<SurfacesTab agentId={'agent-1' as Id<'agents'>} />);
    const approve = [...view.container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Approve',
    );
    approve?.focus();
    await act(async (): Promise<void> => {
      approve?.click();
      // The subscription answers before the call settles: the card is approved.
      tab.verdict = 'approved';
      view.root.render(<SurfacesTab agentId={'agent-1' as Id<'agents'>} />);
    });
    await settle();

    expect(said(view.container)).toEqual(['Approved Linear: the probe runs now.']);
    expect(focusedName()).toBe('Linear');
    view.unmount();
  });

  it('keeps a refused approval beside the button, says it once in the live region, and leaves focus on Approve', async (): Promise<void> => {
    tab.refusals = {
      'surfaces:approve': `[CONVEX M(surfaces:approve)] [Request ID: 1] Server Error\nUncaught Error: A documented intake queue changed; reject this card and re-run orientation before approval.\n    at handler (../convex/surfaces.ts:1:1)`,
    };
    const view = mount(<SurfacesTab agentId={'agent-1' as Id<'agents'>} />);
    await press(view.container, 'Approve');

    const refusal =
      'A documented intake queue changed; reject this card and re-run orientation before approval.';
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(refusal);
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe('');
    expect(focusedName()).toBe('Approve');
    view.unmount();
  });

  it('says a probe that did not run as not run, not as a check (P6-7)', (): void => {
    expect(
      probeOutcomeText('Linear', { verdict: 'skipped', reason: 'the card is not approved.' }),
    ).toBe('The probe of Linear did not run: the card is not approved.');
    expect(probeOutcomeText('Linear', { verdict: 'connected' })).toBe('Probed Linear: connected.');
  });

  it("keeps one card's approval in flight when another card's rejection settles first", async (): Promise<void> => {
    tab.second = true;
    let release = (): void => undefined;
    tab.held = {
      'surfaces:approve': new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const view = mount(<SurfacesTab agentId={'agent-1' as Id<'agents'>} />);
    const card = (slug: string): HTMLElement => {
      const found = view.container.querySelector<HTMLElement>(`#surface-${slug}`);
      if (!found) throw new Error(`no card ${slug}`);
      return found;
    };
    const approveLinear = [...card('linear').querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Approve',
    );
    await act(async (): Promise<void> => {
      approveLinear?.click();
    });
    await press(card('notion'), 'Reject');

    expect(card('linear').textContent).toContain('Approving...');
    await act(async (): Promise<void> => {
      release();
    });
    await settle();
    expect(card('linear').textContent).not.toContain('Approving...');
    view.unmount();
  });
});
