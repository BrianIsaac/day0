import { expect, type Page } from '@playwright/test';
import {
  THEME_ATTRIBUTE,
  THEME_COLOURS,
  THEME_STORAGE_KEY,
  type Theme,
  type ThemePreference,
} from '../../app/theme-preference';

/** The two themes every page is checked in (16-T, N14). */
export const THEMES: readonly Theme[] = ['dark', 'light'];

/** A colour as the browser computes it: `rgb(250, 250, 250)`. */
function computed(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

/** The page colour of each theme, as the browser computes it. */
export const DRAWN_BACKGROUND: Readonly<Record<Theme, string>> = {
  dark: computed(THEME_COLOURS.dark),
  light: computed(THEME_COLOURS.light),
};

/**
 * Keep a choice in the page's storage before any of its scripts run, as a viewer who chose it on
 * the Appearance card earlier has it.
 *
 * @param page - The page, before it navigates.
 */
export async function chooseTheme(page: Page, preference: ThemePreference): Promise<void> {
  await page.addInitScript(
    ([key, value]: readonly [string, string]) => {
      window.localStorage.setItem(key, value);
    },
    [THEME_STORAGE_KEY, preference] as const,
  );
}

/**
 * Hold the page to having been drawn in a theme: the attribute on `<html>` and the page colour the
 * body is painted in, so a check meant for light never passes on a page still drawn dark.
 */
export async function expectDrawnIn(page: Page, theme: Theme): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute(THEME_ATTRIBUTE, theme);
  await expect(page.locator('body')).toHaveCSS('background-color', DRAWN_BACKGROUND[theme]);
}
