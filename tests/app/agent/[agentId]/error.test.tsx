/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EmployeeTabError from '../../../../app/agent/[agentId]/error';
import { mount, press, settle } from '../../../fixtures/dom/press';
import { SegmentBoundary } from '../../../fixtures/dom/segment-boundary';

const tab = vi.hoisted(() => ({ fails: true }));

/** A tab's page whose read throws until it is told not to. */
function FailingTab() {
  if (tab.fails) throw new Error('[CONVEX Q(work:listForAgent)] Server Error');
  return <p>the work tab</p>;
}

describe("a tab's net", (): void => {
  beforeEach((): void => {
    vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    tab.fails = true;
  });

  afterEach((): void => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("draws the tab's failure under a heading of its own, never a second h1, and reads the tab again", async (): Promise<void> => {
    const view = mount(
      <SegmentBoundary fallback={EmployeeTabError}>
        <FailingTab />
      </SegmentBoundary>,
    );
    await settle();
    expect(view.container.querySelector('h1')).toBeNull();
    expect(view.container.querySelector('h2')?.textContent).toBe('This tab could not be drawn');

    tab.fails = false;
    await press(view.container, 'Try again');
    expect(view.container.textContent).toBe('the work tab');
    view.unmount();
  });
});
