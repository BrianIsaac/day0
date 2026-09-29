/** @vitest-environment jsdom */

import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reset = vi.hoisted(() => vi.fn());
vi.mock('convex/react', () => ({ useMutation: () => reset }));

import { ResetCard, resetWarning } from '../../../app/home/ResetCard';
import { focusedName, mount, press, said, unmountAll } from '../../fixtures/dom/press';

const buttonOf = (markup: string): string =>
  /<button[^>]*>(?:Reset everything|Resetting…)<\/button>/.exec(markup)?.[0] ?? '';

describe('ResetCard', (): void => {
  beforeEach((): void => {
    reset.mockReset();
  });

  afterEach((): void => {
    unmountAll();
    document.body.replaceChildren();
  });

  it('says what it wipes in the manager’s word for the employees (N29)', (): void => {
    const html = renderToStaticMarkup(<ResetCard hasEmployees hasDocumentation={false} />);
    expect(html).toContain('Wipe every employee and its workspace');
    expect(html).not.toMatch(/\bagents?\b/i);
  });

  it('gives the button and the unlink choice a 44 px target (N14, m26)', (): void => {
    const html = renderToStaticMarkup(<ResetCard hasEmployees hasDocumentation />);
    expect(buttonOf(html)).toMatch(/\bmin-h-11\b/);
    expect(/<label[^>]*>/.exec(html)?.[0]).toMatch(/\bmin-h-11\b/);
  });

  it('is disabled while there is nothing to wipe', (): void => {
    expect(
      buttonOf(renderToStaticMarkup(<ResetCard hasEmployees={false} hasDocumentation />)),
    ).toContain('disabled=""');
    expect(
      buttonOf(renderToStaticMarkup(<ResetCard hasEmployees hasDocumentation={false} />)),
    ).not.toContain('disabled=""');
  });

  it('asks in the shared dialog, not the browser’s confirm, with Keep everything focused first', async (): Promise<void> => {
    const confirm = vi.fn();
    vi.stubGlobal('confirm', confirm);
    const view = mount(<ResetCard hasEmployees hasDocumentation />);
    await press(view.container, 'Reset everything');
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(
      document.getElementById(dialog?.getAttribute('aria-labelledby') ?? '')?.textContent,
    ).toBe('Reset everything?');
    expect(
      document.getElementById(dialog?.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe(resetWarning(false));
    expect(focusedName()).toBe('Keep everything');
    expect(confirm).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('wipes nothing when the manager keeps everything, and gives focus back to the button', async (): Promise<void> => {
    const view = mount(<ResetCard hasEmployees hasDocumentation />);
    await press(view.container, 'Reset everything');
    await press(document.body, 'Keep everything');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(reset).not.toHaveBeenCalled();
    expect(focusedName()).toBe('Reset everything');
  });

  it('wipes, with the documentation when ticked, once confirmed, and says what went', async (): Promise<void> => {
    reset.mockResolvedValue({ deleted: 2, unlinkedSources: 1 });
    const view = mount(<ResetCard hasEmployees hasDocumentation />);
    act(() => view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await press(view.container, 'Reset everything');
    expect(
      document.getElementById(
        document.querySelector('[role="alertdialog"]')?.getAttribute('aria-describedby') ?? '',
      )?.textContent,
    ).toBe(resetWarning(true));
    const confirmAt = [...document.querySelectorAll('[role="alertdialog"] button')].find(
      (control) => control.textContent === 'Reset everything',
    ) as HTMLButtonElement;
    await press(confirmAt.parentElement as HTMLElement, 'Reset everything');
    expect(reset).toHaveBeenCalledWith({ alsoUnlinkDocumentation: true });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(said(view.container)).toEqual([
      'Every employee and its data are deleted, and 1 documentation source is unlinked.',
    ]);
  });

  it('gives focus to the card once nothing is left for the button to wipe', async (): Promise<void> => {
    const view = mount(<ResetCard hasEmployees hasDocumentation={false} />);
    // Convex applies the emptied roster before the mutation resolves, as the page then draws it.
    reset.mockImplementation(async (): Promise<{ deleted: number; unlinkedSources: number }> => {
      view.root.render(<ResetCard hasEmployees={false} hasDocumentation={false} />);
      return { deleted: 1, unlinkedSources: 0 };
    });
    await press(view.container, 'Reset everything');
    const confirmAt = [...document.querySelectorAll('[role="alertdialog"] button')].find(
      (control) => control.textContent === 'Reset everything',
    ) as HTMLButtonElement;
    await press(confirmAt.parentElement as HTMLElement, 'Reset everything');
    expect(focusedName()).toBe('Reset demo');
    expect(said(view.container)).toEqual(['Every employee and its data are deleted.']);
  });

  it('says why a reset failed inside the dialog and keeps it open', async (): Promise<void> => {
    reset.mockRejectedValue(new Error('Reset is not available right now'));
    const view = mount(<ResetCard hasEmployees hasDocumentation={false} />);
    await press(view.container, 'Reset everything');
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    const confirmAt = [...dialog.querySelectorAll('button')].find(
      (control) => control.textContent === 'Reset everything',
    ) as HTMLButtonElement;
    await press(confirmAt.parentElement as HTMLElement, 'Reset everything');
    expect(said(dialog)).toEqual(['Reset is not available right now']);
    expect(said(view.container)).toEqual([]);
  });
});
