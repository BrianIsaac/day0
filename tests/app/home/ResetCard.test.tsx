/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reset = vi.hoisted(() => vi.fn());
vi.mock('convex/react', () => ({ useMutation: () => reset }));

import { ResetCard } from '../../../app/home/ResetCard';

const buttonOf = (markup: string): string =>
  /<button[^>]*>(?:Reset everything|Resetting…)<\/button>/.exec(markup)?.[0] ?? '';

describe('ResetCard', (): void => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach((): void => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    reset.mockReset();
    host = document.createElement('div');
    root = createRoot(host);
  });

  afterEach((): void => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
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

  it('wipes nothing when the manager declines the confirmation', async (): Promise<void> => {
    vi.stubGlobal('confirm', () => false);
    act(() => root.render(<ResetCard hasEmployees hasDocumentation />));
    await act(async () => host.querySelector('button')!.click());
    expect(reset).not.toHaveBeenCalled();
  });

  it('wipes, with the documentation when ticked, once confirmed', async (): Promise<void> => {
    vi.stubGlobal('confirm', () => true);
    reset.mockResolvedValue(undefined);
    act(() => root.render(<ResetCard hasEmployees hasDocumentation />));
    act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => host.querySelector('button')!.click());
    expect(reset).toHaveBeenCalledWith({ alsoUnlinkDocumentation: true });
  });

  it('says why a reset failed on the card instead of rejecting from the click', async (): Promise<void> => {
    vi.stubGlobal('confirm', () => true);
    reset.mockRejectedValue(new Error('Reset is not available right now'));
    act(() => root.render(<ResetCard hasEmployees hasDocumentation={false} />));
    await act(async () => host.querySelector('button')!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Reset is not available right now',
    );
    expect(host.querySelector('button')?.textContent).toBe('Reset everything');
  });
});
