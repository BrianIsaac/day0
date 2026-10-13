import { readFileSync } from 'node:fs';

/** The product's stylesheet, read once, as the theme tests check it. */
export const THEME_CSS = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');

/**
 * A `--color-*` token's hex value from the theme block.
 *
 * @throws Error when the token is missing or is not a six-digit hex value.
 */
export function token(name: string): string {
  const value = new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6});`, 'i').exec(THEME_CSS)?.[1];
  if (value === undefined) throw new Error(`--color-${name} is not a six-digit hex token`);
  return value;
}

/** The three 0 to 255 channels of a six-digit hex colour. */
function channels(hex: string): readonly number[] {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
}

/** WCAG 2.x relative luminance of a six-digit hex colour. */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG 2.x contrast ratio between two colours. */
export function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

/**
 * The colour a browser paints for `colour` at `alpha` over an opaque `background`: what a
 * Tailwind `/NN` opacity modifier or a `color-mix(..., transparent)` comes to on that ground.
 */
export function over(colour: string, alpha: number, background: string): string {
  const below = channels(background);
  return `#${channels(colour)
    .map((channel, index) =>
      Math.round(alpha * channel + (1 - alpha) * (below[index] ?? 0))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** The selector the light set is declared under (`app/globals.css`). */
export const LIGHT_SELECTOR = ":root[data-theme='light']";

/**
 * The declarations of the one rule whose selector list is exactly `selector`.
 *
 * @throws Error when the stylesheet has no such rule, or more than one.
 */
export function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = [...THEME_CSS.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
  if (found.length !== 1) throw new Error(`${selector} is declared ${found.length} times`);
  return found[0]?.[1] ?? '';
}

/**
 * A `--color-*` token's hex value in the light set.
 *
 * @throws Error when the light set does not declare it as a six-digit hex value.
 */
export function lightToken(name: string): string {
  const value = new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6});`, 'i').exec(
    ruleBody(LIGHT_SELECTOR),
  )?.[1];
  if (value === undefined) throw new Error(`the light --color-${name} is not a six-digit hex token`);
  return value;
}
