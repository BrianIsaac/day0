import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');

/** A `--color-*` token's hex value from the theme block. */
function token(name: string): string {
  const value = new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6});`, 'i').exec(CSS)?.[1];
  if (value === undefined) throw new Error(`--color-${name} is not a six-digit hex token`);
  return value;
}

/** WCAG 2.x relative luminance of a six-digit hex colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG 2.x contrast ratio between two colours. */
function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

describe('the theme tokens', () => {
  it('keeps muted text readable at WCAG AA on the page, a card and a border, as axe checks it', () => {
    expect(token('muted')).toBe('#a1a1aa');
    for (const background of ['bg', 'card', 'border']) {
      expect(contrast(token('muted'), token(background)), background).toBeGreaterThanOrEqual(4.5);
    }
  });
});
