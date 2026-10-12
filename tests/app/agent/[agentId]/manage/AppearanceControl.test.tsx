/** @vitest-environment jsdom */

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APPEARANCE_COPY,
  AppearanceControl,
} from '../../../../../app/agent/[agentId]/manage/AppearanceControl';
import {
  THEME_ATTRIBUTE,
  THEME_HINT_SCRIPT,
  THEME_STORAGE_KEY,
} from '../../../../../app/theme-preference';
import { axeViolations } from '../../../../fixtures/dom/axe';
import { mount, said, settle, unmountAll } from '../../../../fixtures/dom/press';
import { underTarget } from '../../../../fixtures/dom/targets';

/** The three choices as the control draws them: each radio's label and whether it is checked. */
function choices(scope: ParentNode): Array<readonly [string, boolean]> {
  return [...scope.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((radio) => [
    radio.closest('label')?.textContent?.trim() ?? '',
    radio.checked,
  ]);
}

/** Pick a choice by its label, as a click on it does. */
async function pick(scope: ParentNode, label: string): Promise<void> {
  const radio = [...scope.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
    (candidate) => candidate.closest('label')?.textContent?.trim() === label,
  );
  if (!radio) throw new Error(`no choice labelled "${label}"`);
  radio.focus();
  await act(async (): Promise<void> => {
    radio.click();
  });
  await settle();
}

afterEach((): void => {
  unmountAll();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  // A sentinel rather than no attribute: an earlier test's head script still watches the root and
  // draws the theme again the moment the attribute is removed.
  document.documentElement.setAttribute(THEME_ATTRIBUTE, 'unset');
});

describe('AppearanceControl (16-T, the Manage tab’s Appearance card)', (): void => {
  it("says the prototype's sentence and offers Dark, Light and Follow system, Dark checked by default", (): void => {
    const view = mount(<AppearanceControl />);
    expect(APPEARANCE_COPY).toBe(
      'Dark is the default. Light follows your system if you ask for it.',
    );
    expect(view.container.textContent).toContain(APPEARANCE_COPY);
    expect(choices(view.container)).toEqual([
      ['Dark', true],
      ['Light', false],
      ['Follow system', false],
    ]);
    expect(view.container.querySelector('fieldset legend')?.textContent).toBe('Theme');
  });

  it('checks the choice this browser keeps', (): void => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'system');
    const view = mount(<AppearanceControl />);
    expect(choices(view.container)).toEqual([
      ['Dark', false],
      ['Light', false],
      ['Follow system', true],
    ]);
  });

  it('keeps a choice, draws the page in it at once and says so, focus staying on the choice', async (): Promise<void> => {
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: (): void => undefined,
    }));
    new Function(THEME_HINT_SCRIPT)();
    const view = mount(<AppearanceControl />);
    await pick(view.container, 'Light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe('light');
    expect(choices(view.container)).toEqual([
      ['Dark', false],
      ['Light', true],
      ['Follow system', false],
    ]);
    expect(said(view.container)).toEqual(['Theme: Light.']);
    expect((document.activeElement as HTMLInputElement | null)?.value).toBe('light');
  });

  it('says a choice the browser refuses to keep holds for this visit only', async (): Promise<void> => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const view = mount(<AppearanceControl />);
    await pick(view.container, 'Follow system');
    expect(choices(view.container).find(([, checked]) => checked)?.[0]).toBe('Follow system');
    expect(said(view.container)).toEqual([
      'Theme: Follow system, for this visit: this browser does not keep the choice.',
    ]);
  });

  it('shows the choice another tab stores after one this browser refused to keep', async (): Promise<void> => {
    const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const view = mount(<AppearanceControl />);
    await pick(view.container, 'Follow system');
    refuse.mockRestore();
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    await act(async (): Promise<void> => {
      window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY }));
    });
    expect(choices(view.container).find(([, checked]) => checked)?.[0]).toBe('Light');
  });

  it('takes a choice made in another tab', async (): Promise<void> => {
    const view = mount(<AppearanceControl />);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    await act(async (): Promise<void> => {
      window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY }));
    });
    expect(choices(view.container).find(([, checked]) => checked)?.[0]).toBe('Light');
  });

  it('meets the floor: no axe violation, and every choice a 44 px target (N14)', async (): Promise<void> => {
    const view = mount(<AppearanceControl />);
    expect(await axeViolations(view.container)).toEqual([]);
    expect(underTarget(view.container)).toEqual([]);
  });
});
