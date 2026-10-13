import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEME_CSS, lightToken, token } from '../fixtures/theme-contrast';
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
  // Re-pinned (16-T, T-1): the appearance built on Clerk's dark theme while the product had one
  // scheme. Clerk's default theme follows the page's `color-scheme`, which each token set declares,
  // so Light, Dark and Follow system reach Clerk with no switch in script and no redraw.
  it("builds on Clerk's default theme, which follows the colour-scheme each token set declares (T-1)", () => {
    expect(clerkAppearance).not.toHaveProperty('theme');
    expect(THEME_CSS).toMatch(/color-scheme:\s*dark;/);
    expect(THEME_CSS).toMatch(/color-scheme:\s*light;/);
  });

  it('points every colour at a product token, so each theme reaches every Clerk surface', () => {
    const colours = Object.entries(clerkAppearance.variables).filter(([name]) =>
      name.startsWith('color'),
    );
    expect(colours.length).toBe(14);
    for (const [name, value] of colours) {
      const tokenName = /^var\(--color-([a-z0-9-]+)\)$/.exec(value)?.[1];
      expect(tokenName, name).toBeDefined();
      // Declared in both sets, so the variable resolves in either theme.
      expect(token(tokenName ?? ''), name).toMatch(/^#/);
      expect(lightToken(tokenName ?? ''), name).toMatch(/^#/);
    }
  });

  it('names no variable Clerk 7 no longer reads', () => {
    for (const name of RETIRED_VARIABLES)
      expect(clerkAppearance.variables).not.toHaveProperty(name);
  });

  // Re-pinned (16-T): the same pairs as the dark hex values they replace, now by token name.
  it("gives the widget's text, muted text, inputs and primary button the product's tokens", () => {
    expect(clerkAppearance.variables).toMatchObject({
      colorBackground: 'var(--color-card)',
      colorForeground: 'var(--color-fg)',
      colorMutedForeground: 'var(--color-muted)',
      colorInput: 'var(--color-bg)',
      colorInputForeground: 'var(--color-fg)',
      colorPrimary: 'var(--color-accent)',
      colorPrimaryForeground: 'var(--color-bg)',
      colorRing: 'var(--color-accent)',
      colorDanger: 'var(--color-danger)',
      colorSuccess: 'var(--color-ok)',
      colorWarning: 'var(--color-warn)',
      colorModalBackdrop: 'var(--color-scrim)',
      colorShadow: 'var(--color-shadow)',
    });
  });

  it('takes the neutral from the text and leaves the borders to it, so the social button and divider show in either theme', () => {
    expect(clerkAppearance.variables.colorNeutral).toBe('var(--color-fg)');
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
    expect(clerkSignInAppearance).toMatchObject({ variables: clerkAppearance.variables });
    expect(clerkSignInAppearance).not.toHaveProperty('theme');
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

  // Re-pinned (16-T): the mark drew the dark set's accent and card only. Chrome answers an
  // image's `prefers-color-scheme` from the colour-scheme of the page that draws it (probed on
  // Chromium 1248, 12 October 2026), so the mark takes each set's values from the scheme the page
  // is in, whichever way the viewer chose it.
  it("serves the mark from public/ in the brand's own geometry, the head in each theme's accent", () => {
    const mark = checkoutFile('public/day0-mark.svg');
    expect(rects(mark)).toEqual(rects(checkoutFile('app/icon.svg')));
    expect(mark).toMatch(/viewBox="0 0 16 16"/);
    const style = /<style>([\s\S]*?)<\/style>/.exec(mark)?.[1] ?? '';
    const [dark, light] = style.split('@media (prefers-color-scheme: light)');
    expect(dark).toContain(`.head { fill: ${token('accent')}; }`);
    expect(light).toContain(`.head { fill: ${lightToken('accent')}; }`);
    expect(mark.match(/class="head"/g)).toHaveLength(2);
  });

  // Re-pinned (17-FX, V17-10): probed on the bed in Playwright's Firefox 155 and WebKit 2359 (13
  // October 2026). Firefox answers the image's query from the page's colour-scheme, as Chromium
  // does; WebKit answers it from the system, so a viewer who chose Light on a dark system met the
  // dark set's eyes, two #18181b blocks on a white card, and one who chose Dark on a light system
  // two white ones. A cut eye shows the card behind it in every engine, whatever answers the query.
  it('cuts the eyes out of the head, so they are the colour of whatever the mark is drawn on, and names no eye colour for a scheme to pick', () => {
    const mark = checkoutFile('public/day0-mark.svg');
    const style = /<style>([\s\S]*?)<\/style>/.exec(mark)?.[1] ?? '';
    expect(style).not.toContain('.eye');
    expect(mark).not.toContain(token('card'));
    expect(mark).not.toContain(lightToken('card'));
    const mask = /<mask id="eyes">([\s\S]*?)<\/mask>/.exec(mark)?.[1] ?? '';
    // The two eyes of the icon, in its geometry, are what the mask takes out of the head.
    expect(rects(mask)).toEqual(rects(checkoutFile('app/icon.svg')).slice(2));
    expect(mask.match(/fill="#000"/g)).toHaveLength(2);
    expect(mark).toMatch(/<g mask="url\(#eyes\)">\s*<rect [^>]*class="head"/);
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
