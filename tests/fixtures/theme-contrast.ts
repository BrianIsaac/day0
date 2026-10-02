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
