import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dark } from '@clerk/themes';
import { describe, expect, it } from 'vitest';
import {
  DAY0_MARK_URL,
  clerkAppearance,
  clerkSignInAppearance,
  headedClerkAppearance,
} from '../../app/clerk-appearance';

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

  // Re-pinned (wave 9): the shared appearance no longer claims every card; the sign-in and
  // sign-up flows draw the mark outside (`clerkSignInAppearance`, below).
  it("gives the account menu's surfaces Day0's mark inside a card that asks for one, leading home within the product", () => {
    expect(clerkAppearance.options).toEqual({
      logoImageUrl: '/day0-mark.svg',
      logoPlacement: 'inside',
      logoLinkUrl: '/',
    });
    expect(DAY0_MARK_URL).toBe('/day0-mark.svg');
  });

  it('draws the mark above the card on every step of the sign-in and sign-up flows, the code steps among them (the v0.11.0 walk)', () => {
    expect(clerkSignInAppearance).toMatchObject({
      theme: clerkAppearance.theme,
      variables: clerkAppearance.variables,
    });
    expect(clerkSignInAppearance.options).toEqual({
      logoImageUrl: '/day0-mark.svg',
      logoPlacement: 'outside',
      logoLinkUrl: '/',
    });
    // Clerk spaces an outside mark from the card on small screens only; this keeps it at every width.
    expect(clerkSignInAppearance.elements).toEqual({ logoBox: { marginBottom: '1.75rem' } });
    expect(selectorKeys(clerkSignInAppearance.elements)).toEqual([]);
  });

  it("finds Clerk's code-entry card still asking for no logo, which is why the flows' mark sits outside", () => {
    // When this fails Clerk draws a logo on its code steps, and the mark can go back inside.
    const card = checkoutFile('node_modules/@clerk/ui/dist/elements/VerificationCodeCard.js');
    const header = card.slice(card.indexOf('Header.Root'), card.indexOf('Header.Title'));
    expect(header).not.toBe('');
    expect(header).not.toContain('showLogo');
    expect(checkoutFile('node_modules/@clerk/ui/dist/elements/Header.js')).toContain(
      'parsedOptions.logoPlacement === "inside" && showLogo',
    );
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
  // Re-pinned (wave 9): the mark is outside the card, so the first step's whole header, title
  // and subtitle, is left out rather than each beside a mark that is no longer in it.
  it("leaves the first step's header out through Clerk's own element styles, keeping the mark above the card", () => {
    const first = headedClerkAppearance(true);
    expect(first).toMatchObject({ options: clerkSignInAppearance.options });
    expect(first.elements).toEqual({
      logoBox: { marginBottom: '1.75rem' },
      header: { display: 'none' },
    });
  });

  it('keeps every later step as the sign-in flows draw it, header and mark', () => {
    expect(headedClerkAppearance(false)).toBe(clerkSignInAppearance);
  });

  it('names no selector Clerk reports as structural CSS', () => {
    expect(selectorKeys(headedClerkAppearance(true).elements)).toEqual([]);
  });
});
