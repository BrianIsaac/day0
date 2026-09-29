/** @vitest-environment jsdom */

import { act } from 'react';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../../../convex/_generated/dataModel';
import { WorkQueue } from '../../../../../app/agent/[agentId]/work/WorkQueue';
import { StateGlossary } from '../../../../../app/agent/[agentId]/work/StateGlossary';
import { AgentZoneContext } from '../../../../../app/components/time';
import { axeViolations } from '../../../../fixtures/dom/axe';
import { mount, press, settle } from '../../../../fixtures/dom/press';
import {
  DRAWN,
  DRAWN_ORDER,
  EMPLOYEE,
  QUESTION,
  SURFACES,
  ZONE,
} from '../../../../fixtures/work/drawn-states';

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown): unknown =>
    getFunctionName(reference as never) === 'work:latestListing'
      ? {
          tracker: { assigned: true, assigneeId: 'user-7', state: 'Todo', doNotAutomate: false },
          listedAt: DRAWN.discovered.observedAt,
        }
      : undefined,
  useMutation: (): (() => Promise<void>) => async (): Promise<void> => undefined,
  useAction: (): (() => Promise<void>) => async (): Promise<void> => undefined,
}));

afterEach((): void => {
  document.body.replaceChildren();
});

/**
 * The controls and standalone links whose own box, or the label wrapping them, is not 44 px tall
 * by class (N14): jsdom lays nothing out, so the class is what can be read; a link inside a
 * sentence is exempt (WCAG 2.5.8's inline exception). The same rule as the employee page's check.
 */
function underTarget(root: Element): string[] {
  const tall = /(^|\s)(min-h-11|h-11)(\s|$)/;
  const standalone = (control: Element): boolean =>
    control.tagName !== 'A' || control.closest('p, li, dd, td') === null;
  return [...root.querySelectorAll('button, input, select, textarea, summary, a[href]')]
    .filter((control) => (control as HTMLInputElement).type !== 'hidden')
    .filter(standalone)
    .filter(
      (control) =>
        !tall.test(control.getAttribute('class') ?? '') &&
        !tall.test(control.closest('label')?.getAttribute('class') ?? ''),
    )
    .map(
      (control) =>
        `${control.tagName.toLowerCase()} "${(control.getAttribute('aria-label') ?? control.textContent ?? '').trim().slice(0, 60)}"`,
    );
}

/** The Work tab's main column with every drawn state in its queue, in real mode. */
async function workTab(): Promise<ReturnType<typeof mount>> {
  const view = mount(
    <AgentZoneContext value={ZONE}>
      <main>
        <WorkQueue
          agentId={'a-mira' as Id<'agents'>}
          workItems={DRAWN_ORDER.map((state) => DRAWN[state])}
          openQuestions={[QUESTION]}
          surfaces={SURFACES}
          registeredSkillCount={1}
          charterApproved
          autonomousActions={false}
          surfaceMode="real"
          employeeName={EMPLOYEE}
        />
        <StateGlossary />
      </main>
    </AgentZoneContext>,
  );
  await settle();
  // Every reason form open and every disclosure open: what they hold is checked too.
  await press(view.container, 'Cancel this item');
  await press(view.container, 'Reject the run');
  for (const disclosure of view.container.querySelectorAll('details')) disclosure.open = true;
  await settle();
  return view;
}

describe('the Work tab against the accessibility floor (N14)', (): void => {
  it('has no axe violation with every drawn state on the page, its forms and disclosures open', async (): Promise<void> => {
    const view = await workTab();
    expect(view.container.querySelectorAll('article')).toHaveLength(DRAWN_ORDER.length);
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    view.unmount();
  }, 30_000);

  it('gives every control of every drawn state a 44 px target', async (): Promise<void> => {
    const view = await workTab();
    expect(underTarget(view.container)).toEqual([]);
    view.unmount();
  }, 30_000);

  it('keeps the page clear of the danger fill and of type under 12 px', async (): Promise<void> => {
    const view = await workTab();
    const html = view.container.innerHTML;
    expect(html).not.toMatch(/bg-\[var\(--color-danger\)\]/);
    expect(html).not.toMatch(/text-\[(9|10|11)px\]/);
    view.unmount();
  }, 30_000);

  it('filters the queue with the pressed state and its count said apart', async (): Promise<void> => {
    const view = await workTab();
    const pressed = (): string[] =>
      [...view.container.querySelectorAll('[aria-pressed="true"]')].map(
        (control) => control.textContent ?? '',
      );
    expect(pressed()).toEqual([`All ${DRAWN_ORDER.length}`]);
    const needsYou = [...view.container.querySelectorAll('button')].find((control) =>
      control.textContent?.startsWith('Needs you '),
    );
    await act(async (): Promise<void> => needsYou?.click());
    expect(pressed()).toEqual(['Needs you 3']);
    expect(
      [...view.container.querySelectorAll('article h3')].map((title) => title.textContent),
    ).toEqual([DRAWN.held.title, DRAWN.planPending.title, DRAWN.retried.title]);
    view.unmount();
  }, 30_000);
});
