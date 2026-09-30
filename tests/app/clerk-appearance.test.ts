import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dark } from '@clerk/themes';
import { describe, expect, it } from 'vitest';
import { DAY0_MARK_URL, clerkAppearance, headedClerkAppearance } from '../../app/clerk-appearance';

/** A file of the checkout, read by path (under Vite `new URL(path, import.meta.url)` is an asset). */
function checkoutFile(path: string): string {
  return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..', path), 'utf8');
}

/** The rectangles an SVG draws, as their geometry attributes. */
function rects(svg: string): string[] {
  return [...svg.matchAll(/<rect ([^>]*?)\s*\/>/g)].map(([, attributes]) =>
    attributes.replace(/\s*(fill|class)="[^"]*"/g, ''),
  );
}

/**
 * The CSS-in-JS selector keys under a style object: a key starting with `&` is the kind Clerk
 * reports as structural when it names another element.
 */
function selectorKeys(style: unknown): string[] {
  if (typeof style !== 'object' || style === null) return [];
  return Object.entries(style).flatMap(([key, value]) => [
    ...(key.startsWith('&') ? [key] : []),
    ...selectorKeys(value),
  ]);
}

/** The names Clerk's Core 2 read and Core 3 ignores, which left the hosted widget unreadable. */
const RETIRED_VARIABLES = [
  'colorText',
  'colorTextSecondary',
  'colorTextOnPrimaryBackground',
  'colorInputBackground',
  'colorInputText',
  'colorAlphaShade',
];

describe('the Clerk appearance', () => {
  it("builds on Clerk's dark theme, so every surface it does not name is dark too", () => {
    expect(clerkAppearance.theme).toBe(dark);
  });

  it('names no variable Clerk 7 no longer reads', () => {
    for (const name of RETIRED_VARIABLES)
      expect(clerkAppearance.variables).not.toHaveProperty(name);
  });

  it("gives the widget's text, muted text, inputs and primary button the product's tokens", () => {
    expect(clerkAppearance.variables).toMatchObject({
      colorBackground: '#18181b',
      colorForeground: '#f4f4f5',
      colorMutedForeground: '#a1a1aa',
      colorInput: '#0a0a0b',
      colorInputForeground: '#f4f4f5',
      colorPrimary: '#22d3ee',
      colorPrimaryForeground: '#0a0a0b',
      colorDanger: '#ef4444',
      colorSuccess: '#34d399',
      colorWarning: '#f59e0b',
    });
  });

  it('keeps the neutral light and leaves the borders to it, so the social button and divider show', () => {
    expect(clerkAppearance.variables.colorNeutral).toBe('#f4f4f5');
    expect(clerkAppearance.variables).not.toHaveProperty('colorBorder');
  });

  it("puts Day0's mark on every card, inside it above the title, leading home within the product", () => {
    expect(clerkAppearance.options).toEqual({
      logoImageUrl: '/day0-mark.svg',
      logoPlacement: 'inside',
      logoLinkUrl: '/',
    });
    expect(DAY0_MARK_URL).toBe('/day0-mark.svg');
  });

  it("serves the mark from public/ in the brand's own geometry, the head in the accent and the eyes cut in the card's colour", () => {
    const mark = checkoutFile('public/day0-mark.svg');
    expect(rects(mark)).toEqual(rects(checkoutFile('app/icon.svg')));
    expect(mark).toMatch(/viewBox="0 0 16 16"/);
    expect(mark.match(/fill="#22d3ee"/g)).toHaveLength(2);
    expect(
      mark.match(new RegExp(`fill="${clerkAppearance.variables.colorBackground}"`, 'g')),
    ).toHaveLength(2);
  });
});

describe('the appearance of a Clerk widget under a page heading', () => {
  it("hides the first step's title and subtitle and the gap under the mark, through Clerk's own element styles", () => {
    const first = headedClerkAppearance(true);
    expect(first).toMatchObject({ ...clerkAppearance });
    expect(first.elements).toEqual({
      header: { gap: 0 },
      headerTitle: { display: 'none' },
      headerSubtitle: { display: 'none' },
    });
    expect(first.elements).not.toHaveProperty('logoBox');
  });

  it('keeps every later step as the shared appearance draws it, header and all', () => {
    expect(headedClerkAppearance(false)).toBe(clerkAppearance);
  });

  it('names no selector Clerk reports as structural CSS', () => {
    expect(selectorKeys(headedClerkAppearance(true).elements)).toEqual([]);
  });
});
