import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEME_CSS, contrast, lightToken, token } from '../fixtures/theme-contrast';
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

/** A six-digit hex colour as HSL, hue in degrees, saturation and lightness in percent. */
function hsl(hex: string): readonly [number, number, number] {
  const [r, g, b] = [1, 3, 5].map(
    (start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255,
  );
  const max = Math.max(r!, g!, b!);
  const min = Math.min(r!, g!, b!);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const h =
    d === 0
      ? 0
      : max === r
        ? 60 * (((g! - b!) / d) % 6)
        : max === g
          ? 60 * ((b! - r!) / d + 2)
          : 60 * ((r! - g!) / d + 4);
  return [(h + 360) % 360, s * 100, l * 100];
}

/** HSL back to a six-digit hex colour. */
function hex([h, s, l]: readonly [number, number, number]): string {
  const c = (1 - Math.abs((2 * l) / 100 - 1)) * (s / 100);
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l / 100 - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return `#${[r, g, b]
    .map((v) =>
      Math.round((v + m) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** The step darker Clerk fills a danger button with under the pointer (`$danger600`). */
function clerkDarkerStep(colour: string): string {
  const [h, s, l] = hsl(colour);
  return hex([h, s, l - (l - 12) / 7]);
}

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
      colorDanger: 'var(--color-danger-solid)',
      colorSuccess: 'var(--color-ok)',
      colorWarning: 'var(--color-warn)',
      colorModalBackdrop: 'var(--color-scrim)',
      colorShadow: 'var(--color-shadow)',
    });
  });

  // The second pass on 17-FX: Clerk fills its destructive button with `colorDanger` and writes on
  // it in white (`danger: {accent: $danger500, accentContrast: $white}` in `@clerk/ui` 1.36), and
  // draws its error text in the same colour on the card. The dark danger token went one step
  // lighter for the product's chips (D-7 (b)); given to Clerk, white on that fill fell from 3.76:1
  // to 2.77:1, under the 3:1 a control is held to.
  it("gives Clerk's destructive button and error text a red of their own, which keeps white on the fill and the text on the card as they were at v0.20.0", () => {
    const WHITE = '#ffffff';
    expect(clerkAppearance.variables.colorDanger).toBe('var(--color-danger-solid)');
    for (const read of [token, lightToken]) {
      expect(contrast(WHITE, read('danger-solid'))).toBeGreaterThanOrEqual(3.76);
      expect(contrast(read('danger-solid'), read('card'))).toBeGreaterThanOrEqual(4.5);
    }
    // No one red holds white at 4.5:1 and reads at 4.5:1 on the dark card (the first needs a
    // luminance under 0.184, the second over 0.216), so the dark value is the design's own.
    expect(Number(contrast(WHITE, token('danger-solid')).toFixed(2))).toBe(3.76);
    expect(contrast(WHITE, token('danger'))).toBeLessThan(3);
  });

  // D-7 (a), W17-R31: on the review's bed 2 Clerk's "Delete account" was white on
  // rgb(239, 68, 68) in the dark scheme, 3.76:1, under the 4.5:1 a label is held to. Clerk writes
  // its danger button's label in white (`accentContrast: $white`, `@clerk/ui` 1.36
  // `primitives/Button.js`) unless the button's element style says otherwise, and under the pointer
  // fills it one step darker (`$danger600`: `hsl(from c h s calc(l - ((l - 12) / 7)))`,
  // `utils/colors/utils.js`).
  it("writes Clerk's destructive button's label at 4.5:1 or over on its fill in both schemes, at rest and under the pointer", (): void => {
    const style = (clerkAppearance as { elements?: Record<string, { color?: string }> }).elements
      ?.formButtonPrimary;
    const label =
      style?.color === undefined ? undefined : /^var\(--color-([a-z-]+)\)$/.exec(style.color)?.[1];
    for (const read of [token, lightToken]) {
      const ink = label === undefined ? '#ffffff' : read(label);
      const fill = read('danger-solid');
      expect(contrast(ink, fill), `${ink} on ${fill}`).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(ink, clerkDarkerStep(fill)),
        `${ink} on ${clerkDarkerStep(fill)}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    // The primary button's label is the page's colour already, so the one style moves only the
    // danger button's.
    expect(style?.color).toBe(clerkAppearance.variables.colorPrimaryForeground);
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
    // Re-pinned (18-T): the flows keep the shared element styles (the destructive label, the mark's
    // mask) beside the outside mark's margin, where they carried the margin alone.
    expect(clerkSignInAppearance.elements).toEqual({
      ...clerkAppearance.elements,
      logoBox: { marginBottom: '1.75rem' },
    });
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
    // Re-pinned (18-T): with the shared element styles beside them.
    expect(first.elements).toEqual({
      ...clerkAppearance.elements,
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
