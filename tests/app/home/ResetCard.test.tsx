/** @vitest-environment jsdom */

import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Holdings {
  employees: boolean;
  skillLibrary: boolean;
  handoverWords: boolean;
  retiredBoundaries: boolean;
  documentation: boolean;
}

const reset = vi.hoisted(() => vi.fn());
const read = vi.hoisted(() => ({ holdings: undefined as Holdings | null | undefined }));
vi.mock('convex/react', () => ({
  useMutation: () => reset,
  useQuery: () => read.holdings,
}));

import { ResetCard, deletionWarning, heldNow } from '../../../app/home/ResetCard';
import { focusedName, mount, press, said, unmountAll } from '../../fixtures/dom/press';

const NOTHING: Holdings = {
  employees: false,
  skillLibrary: false,
  handoverWords: false,
  retiredBoundaries: false,
  documentation: false,
};

/** What the deletion's read answers for the owner, as the page subscribes to it. */
function holding(held: Partial<Holdings>): Holdings {
  return { ...NOTHING, ...held };
}

/** The card's own button in rendered markup; a markup without it fails the test that reads it. */
function buttonOf(markup: string): string {
  const button = /<button[^>]*>(?:Delete my data…|Deleting…)<\/button>/.exec(markup)?.[0];
  if (button === undefined) throw new Error('the card draws no Delete my data button');
  return button;
}

describe('ResetCard', (): void => {
  beforeEach((): void => {
    reset.mockReset();
    read.holdings = holding({ employees: true });
  });

  afterEach((): void => {
    unmountAll();
    document.body.replaceChildren();
  });

  it('says what it deletes in the manager’s word for the employees (N29)', (): void => {
    // Re-pinned (11-FD): the deletion names the library and the handover notes it takes too.
    const html = renderToStaticMarkup(<ResetCard />);
    expect(html).toContain('Deletes your employees and everything they made');
    expect(html).toContain('your skill library');
    expect(html).toContain('Your sign-in stays');
    expect(html).not.toMatch(/\bagents?\b/i);
  });

  it('is named for what it does, on the card, in its dialog and on its confirmation (the v0.13.0 walk)', async (): Promise<void> => {
    const view = mount(<ResetCard />);
    expect(view.container.querySelector('h2')?.textContent).toBe('Your data');
    await press(view.container, 'Delete my data…');
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(
      document.getElementById(dialog?.getAttribute('aria-labelledby') ?? '')?.textContent,
    ).toBe('Delete your data?');
    expect(
      [...(dialog?.querySelectorAll('button') ?? [])].map((control) => control.textContent),
    ).toEqual(expect.arrayContaining(['Keep my data', 'Delete my data']));
    // The opener ends in an ellipsis because it opens the dialog, as Retire's does.
    expect(
      [...view.container.querySelectorAll('button')].map((control) => control.textContent),
    ).toContain('Delete my data…');
  });

  it('gives the button and the unlink choice a 44 px target (N14, m26)', (): void => {
    const html = renderToStaticMarkup(<ResetCard />);
    expect(buttonOf(html)).toMatch(/\bmin-h-11\b/);
    expect(/<label[^>]*>/.exec(html)?.[0]).toMatch(/\bmin-h-11\b/);
  });

  it('is live for a manager with no employee who still holds a skill library or handover notes (the v0.13.0 walk)', (): void => {
    for (const held of [
      { skillLibrary: true },
      { handoverWords: true },
      { retiredBoundaries: true },
    ]) {
      read.holdings = holding(held);
      expect(buttonOf(renderToStaticMarkup(<ResetCard />))).not.toContain('disabled=""');
    }
  });

  it('is disabled while there is nothing to delete, or before the page knows', (): void => {
    for (const holdings of [holding({}), holding({ documentation: true }), null, undefined]) {
      read.holdings = holdings;
      expect(buttonOf(renderToStaticMarkup(<ResetCard />))).toContain('disabled=""');
    }
    read.holdings = holding({ employees: true });
    expect(buttonOf(renderToStaticMarkup(<ResetCard />))).not.toContain('disabled=""');
  });

  it('takes documentation alone once the manager ticks the unlink choice', (): void => {
    read.holdings = holding({ documentation: true });
    const view = mount(<ResetCard />);
    act(() => view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(
      [...view.container.querySelectorAll('button')].find(
        (control) => control.textContent === 'Delete my data…',
      )?.disabled,
    ).toBe(false);
  });

  it('says what is stored for the manager now, and that nothing is when the button is disabled', (): void => {
    expect(heldNow(holding({}), false)).toBe('Nothing of yours is stored now.');
    expect(heldNow(holding({ skillLibrary: true, handoverWords: true }), false)).toBe(
      'Stored for you now: your skill library and the notes on your handover requests.',
    );
    expect(
      heldNow(holding({ employees: true, skillLibrary: true, handoverWords: true }), false),
    ).toBe(
      'Stored for you now: your employees, your skill library and the notes on your handover requests.',
    );
    read.holdings = holding({ skillLibrary: true });
    expect(renderToStaticMarkup(<ResetCard />)).toContain(
      'Stored for you now: your skill library.',
    );
  });

  it('says linked documentation apart, as what goes only with the box ticked, so a disabled button says why (design pass)', (): void => {
    expect(heldNow(holding({ documentation: true }), false)).toBe(
      'Only your linked documentation is stored now: tick the box below to unlink it.',
    );
    expect(heldNow(holding({ documentation: true }), true)).toBe(
      'Only your linked documentation is stored now, and it goes with the box ticked.',
    );
    expect(heldNow(holding({ employees: true, documentation: true }), false)).toBe(
      'Stored for you now: your employees. Your linked documentation stays unless you tick the box below.',
    );
    expect(heldNow(holding({ employees: true, documentation: true }), true)).toBe(
      'Stored for you now: your employees. Your linked documentation goes too.',
    );
  });

  it('ties the button to the line that says what it would take', (): void => {
    read.holdings = holding({ documentation: true });
    const html = renderToStaticMarkup(<ResetCard />);
    const describedBy = /aria-describedby="([^"]+)"/.exec(buttonOf(html))?.[1];
    expect(describedBy).toBeDefined();
    const described = new RegExp(`<p id="${describedBy}"[^>]*>([^<]*)</p>`).exec(html)?.[1];
    expect(described).toBe(
      'Only your linked documentation is stored now: tick the box below to unlink it.',
    );
  });

  it('says it is still checking until the page has read what is stored, so nothing moves when it has', (): void => {
    read.holdings = undefined;
    expect(renderToStaticMarkup(<ResetCard />)).toContain('Checking what is stored for you…');
  });

  it('builds the warning from what is stored, says what stays, and never names employees there are none of', (): void => {
    expect(deletionWarning(holding({ skillLibrary: true, handoverWords: true }), false)).toBe(
      'This deletes your skill library and the notes on your handover requests. The requests stay in the other manager’s record. Your sign-in stays. It cannot be undone.',
    );
    expect(deletionWarning(holding({ employees: true, documentation: true }), false)).toBe(
      'This deletes every employee and its data. Your documentation stays linked. Your sign-in stays. It cannot be undone.',
    );
    expect(deletionWarning(holding({ employees: true, documentation: true }), true)).toBe(
      'This deletes every employee and its data, and unlinks every documentation source. Your sign-in stays. It cannot be undone.',
    );
    expect(deletionWarning(holding({ documentation: true }), true)).toBe(
      'This unlinks every documentation source. Your sign-in stays. It cannot be undone.',
    );
    expect(deletionWarning(holding({ retiredBoundaries: true }), false)).toBe(
      'This deletes the claims and rejections your retired employees kept. Your sign-in stays. It cannot be undone.',
    );
  });

  it('asks in the shared dialog, not the browser’s confirm, with Keep my data focused first', async (): Promise<void> => {
    const confirm = vi.fn();
    vi.stubGlobal('confirm', confirm);
    const view = mount(<ResetCard />);
    await press(view.container, 'Delete my data…');
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(
      document.getElementById(dialog?.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe(deletionWarning(holding({ employees: true }), false));
    expect(focusedName()).toBe('Keep my data');
    expect(confirm).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('deletes nothing when the manager keeps their data, and gives focus back to the button', async (): Promise<void> => {
    const view = mount(<ResetCard />);
    await press(view.container, 'Delete my data…');
    await press(document.body, 'Keep my data');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(reset).not.toHaveBeenCalled();
    expect(focusedName()).toBe('Delete my data…');
  });

  it('deletes, with the documentation when ticked, once confirmed, and says what went', async (): Promise<void> => {
    read.holdings = holding({ employees: true, documentation: true });
    reset.mockResolvedValue({ deleted: 2, unlinkedSources: 1 });
    const view = mount(<ResetCard />);
    act(() => view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await press(view.container, 'Delete my data…');
    expect(
      document.getElementById(
        document.querySelector('[role="alertdialog"]')?.getAttribute('aria-describedby') ?? '',
      )?.textContent,
    ).toBe(deletionWarning(holding({ employees: true, documentation: true }), true));
    const confirmAt = [...document.querySelectorAll('[role="alertdialog"] button')].find(
      (control) => control.textContent === 'Delete my data',
    ) as HTMLButtonElement;
    await press(confirmAt.parentElement as HTMLElement, 'Delete my data');
    expect(reset).toHaveBeenCalledWith({ alsoUnlinkDocumentation: true });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(said(view.container)).toEqual([
      'Your data is deleted, and 1 documentation source is unlinked.',
    ]);
  });

  it('gives focus to the card once nothing is left for the button to delete', async (): Promise<void> => {
    read.holdings = holding({ skillLibrary: true });
    const view = mount(<ResetCard />);
    // Convex applies the emptied holdings before the mutation resolves, as the page then draws them.
    reset.mockImplementation(async (): Promise<{ deleted: number; unlinkedSources: number }> => {
      read.holdings = holding({});
      view.root.render(<ResetCard />);
      return { deleted: 0, unlinkedSources: 0 };
    });
    await press(view.container, 'Delete my data…');
    const confirmAt = [...document.querySelectorAll('[role="alertdialog"] button')].find(
      (control) => control.textContent === 'Delete my data',
    ) as HTMLButtonElement;
    await press(confirmAt.parentElement as HTMLElement, 'Delete my data');
    expect(focusedName()).toBe('Your data');
    expect(said(view.container)).toEqual(['Your data is deleted.']);
  });

  it('says why a deletion failed inside the dialog and keeps it open', async (): Promise<void> => {
    reset.mockRejectedValue(new Error('Deletion is not available right now'));
    const view = mount(<ResetCard />);
    await press(view.container, 'Delete my data…');
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    const confirmAt = [...dialog.querySelectorAll('button')].find(
      (control) => control.textContent === 'Delete my data',
    ) as HTMLButtonElement;
    await press(confirmAt.parentElement as HTMLElement, 'Delete my data');
    expect(said(dialog)).toEqual(['Deletion is not available right now']);
    expect(said(view.container)).toEqual([]);
  });
});
