import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHORT_SCREEN } from '../../app/marketing/PinnedSequence';

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

  it('derives the second text step, the second hairline and each tone fill and line as round two pins them', () => {
    expect({
      'fg-2': token('fg-2'),
      'border-2': token('border-2'),
      inset: token('inset'),
      'accent-soft': token('accent-soft'),
      'accent-line': token('accent-line'),
      'warn-soft': token('warn-soft'),
      'warn-line': token('warn-line'),
      'ok-soft': token('ok-soft'),
      'ok-line': token('ok-line'),
      'danger-soft': token('danger-soft'),
      'danger-line': token('danger-line'),
    }).toEqual({
      'fg-2': '#d4d4d8',
      'border-2': '#3f3f46',
      inset: '#101012',
      'accent-soft': '#202b30',
      'accent-line': '#376772',
      'warn-soft': '#2e2621',
      'warn-line': '#735533',
      'ok-soft': '#202b28',
      'ok-line': '#396754',
      'danger-soft': '#281d1f',
      'danger-line': '#733937',
    });
  });

  it('keeps card prose and the accent, warn and ok tones on their fills readable at WCAG AA', () => {
    expect(contrast(token('fg-2'), token('card'))).toBeGreaterThanOrEqual(4.5);
    // Danger on its own fill is 4.34:1, short of AA: the design's pair, recorded in the wave 6 A
    // handover for a product call rather than changed here.
    for (const tone of ['accent', 'warn', 'ok']) {
      expect(contrast(token(tone), token(`${tone}-soft`)), tone).toBeGreaterThanOrEqual(4.5);
    }
  });
});

/** The text of every block opened by `opener`, its braces balanced. */
function blocks(opener: string): string[] {
  const found: string[] = [];
  for (let at = CSS.indexOf(opener); at >= 0; at = CSS.indexOf(opener, at + 1)) {
    const open = CSS.indexOf('{', at);
    let depth = 0;
    for (let index = open; index < CSS.length; index += 1) {
      if (CSS[index] === '{') depth += 1;
      if (CSS[index] === '}') depth -= 1;
      if (depth === 0) {
        found.push(CSS.slice(open + 1, index));
        break;
      }
    }
  }
  return found;
}

/** The stylesheet with its comments and every `@layer base` block taken out. */
function unlayered(): string {
  return CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@layer base\s*\{[\s\S]*?\n\}/g, '');
}

/** The declarations of every top-level-or-nested rule whose selector list is exactly `selector`. */
function rulesFor(source: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...source.matchAll(new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map(
    (match) => match[1] ?? '',
  );
}

describe('the public-page motion', () => {
  const noPreference = blocks('@media (prefers-reduced-motion: no-preference)').join('\n');
  const reduce = blocks('@media (prefers-reduced-motion: reduce)').join('\n');

  it('animates cards, reveals and frame sequences only when motion is welcome', () => {
    for (const selector of [
      '[data-cards] > *',
      '[data-rise]',
      "[data-frame][data-seen='seen'] [data-seq]",
      "[data-cards][data-seen='pending'] > *",
    ]) {
      const everywhere = rulesFor(CSS, selector).filter((rule) => /animation|opacity/.test(rule));
      const guarded = rulesFor(noPreference, selector).filter((rule) =>
        /animation|opacity/.test(rule),
      );
      expect(everywhere.length, selector).toBeGreaterThan(0);
      expect(guarded, selector).toEqual(everywhere);
    }
  });

  it('keeps the frame swap under reduced motion as a 200 ms crossfade of opacity alone', () => {
    const [rule] = rulesFor(reduce, '[data-pin-stack] > [data-frame]');
    expect(rule).toMatch(/transform:\s*none/);
    expect(rule).toMatch(/transition:\s*opacity 200ms/);
    expect(rule).not.toMatch(/transition:[^;]*transform/);
  });

  it('unpins the landing band on the short screen the script lays the frames inline on (M8)', () => {
    const [short] = blocks(`@media ${SHORT_SCREEN}`);
    expect(short).toBeDefined();
    expect(rulesFor(short ?? '', "[data-short='inline'] > [data-pin-side]")[0]).toMatch(
      /position:\s*static/,
    );
  });

  it('plays the page transition as a 90 ms exit then a 200 ms entry, the header and the document still (UX 11)', () => {
    expect(rulesFor(noPreference, '::view-transition-old(.day0-main-exit)')[0]).toMatch(
      /animation:\s*day0-page-out 90ms var\(--ease-arrive\) both/,
    );
    expect(rulesFor(noPreference, '::view-transition-new(.day0-main-enter)')[0]).toMatch(
      /animation:\s*day0-page-in 200ms var\(--ease-arrive\) 90ms both/,
    );
    expect(rulesFor(CSS, '::view-transition-old(root)')[0]).toMatch(/display:\s*none/);
    expect(rulesFor(CSS, '::view-transition-new(root)')[0]).toMatch(/animation:\s*none/);
    expect(rulesFor(CSS, '::view-transition-group(site-header)')[0]).toMatch(/animation:\s*none/);
  });

  it('swaps the page at once under reduced motion', () => {
    expect(rulesFor(reduce, '::view-transition-old(.day0-main-exit)')[0]).toMatch(
      /display:\s*none/,
    );
    expect(rulesFor(reduce, '::view-transition-new(.day0-main-enter)')[0]).toMatch(
      /animation:\s*none/,
    );
  });

  it('sets the walkthrough frame beside the copy on a phone on its side, and caps it there (M-a)', () => {
    const sideways = blocks('@media (max-width: 767px) and (max-height: 559px)').join('\n');
    expect(rulesFor(sideways, '[data-run]')[0]).toMatch(
      /grid-template-columns:\s*minmax\(0, 1\.15fr\) minmax\(0, 1fr\)/,
    );
    expect(rulesFor(sideways, '[data-run] > [data-pin-side]')[0]).toMatch(/top:\s*64px/);
    const short = blocks('@media (max-height: 559px)').join('\n');
    expect(rulesFor(short, '[data-run] [data-pin-stack]')[0]).toMatch(
      /max-height:\s*calc\(100svh - 204px\)/,
    );
  });

  it('draws the orbit traffic at rest under reduced motion, never leaving the packets invisible (m18)', () => {
    const [packet] = rulesFor(reduce, '.day0-surface-packet');
    expect(packet).toMatch(/opacity:\s*0\.85/);
    expect(packet).toMatch(/transform:\s*translate\(calc\(var\(--packet-x\) \/ 2\)/);
    const [held] = rulesFor(reduce, '.day0-surface-packet-held');
    expect(held).toMatch(/opacity:\s*1/);
  });

  it('arrives cards 8 px over 260 ms, 50 ms apart, for up to twelve cards', () => {
    expect(CSS).toMatch(
      /@keyframes day0-rise-in \{\s*from \{\s*opacity: 0;\s*transform: translateY\(8px\);/,
    );
    const [arrive] = rulesFor(noPreference, '[data-cards] > *');
    expect(arrive).toContain('day0-rise-in 260ms var(--ease-arrive)');
    expect(arrive).toContain('var(--i, 0) * 50ms');
    expect(noPreference).toContain('[data-cards] > :nth-child(12)');
    expect(noPreference).not.toContain('[data-cards] > :nth-child(13)');
  });

  it('never animates the translate property, which the positioning utilities own', () => {
    const keyframes = blocks('@keyframes ').join('\n');
    expect(keyframes).not.toMatch(/(^|[\s;{])translate:/);
    expect(CSS).toContain('Transform rule, one way everywhere');
  });

  it('selects text in the accent rather than the browser default', () => {
    expect(rulesFor(CSS, '::selection')[0]).toMatch(
      /background:\s*color-mix\(in oklab, var\(--color-accent\) 35%, transparent\)/,
    );
  });

  it("keeps the shell's scrollbars in the base layer, so an element's own scrollbar utility outranks them", () => {
    // Unlayered, the rule beat every Tailwind utility and the tab strip drew a scrollbar.
    const base = blocks('@layer base').join('\n');
    expect(rulesFor(base, '*').join('\n')).toMatch(/scrollbar-width:\s*thin/);
    expect(unlayered()).not.toMatch(/scrollbar-(width|color)|::-webkit-scrollbar/);
  });

  it("draws a tab's focus ring inside it, where the strip does not clip it", () => {
    expect(rulesFor(CSS, "[role='tab']:focus-visible")[0]).toMatch(/outline-offset:\s*-2px/);
  });

  it("keeps the focus ring in the base layer, so a control's own focus utility outranks it (C1)", () => {
    // Unlayered, the ring beat every utility: `focus-visible:outline-offset-[-3px]` on the
    // walkthrough's frame link and a control's own corners never applied.
    const base = blocks('@layer base').join('\n');
    const [ring] = rulesFor(
      base,
      ":where(a, button, input, select, summary, textarea, [tabindex='0']):focus-visible",
    );
    expect(ring).toMatch(
      /outline:\s*2px solid color-mix\(in oklab, var\(--color-accent\) 75%, transparent\)/,
    );
    expect(ring).toMatch(/outline-offset:\s*1px/);
    expect(rulesFor(base, "[role='tab']:focus-visible")[0]).toMatch(/outline-offset:\s*-2px/);
    expect(unlayered()).not.toContain(':focus-visible');
  });

  it("underlines a link in running text as ButtonLink's text look does, and only a link with no class of its own (C3)", () => {
    // Tailwind's preflight sets `a` to inherit its text's colour and decoration, so a bare link
    // inside a sentence read as prose.
    const base = blocks('@layer base').join('\n');
    const [link] = rulesFor(base, 'a[href]:not([class])');
    // Not zero-specificity: the preflight's own `a` rule shares the layer and would win.
    expect(base).not.toContain(':where(a[href]');
    expect(link).toMatch(/text-decoration-line:\s*underline/);
    expect(link).toMatch(/text-decoration-color:\s*var\(--color-border-2\)/);
    expect(link).toMatch(/text-underline-offset:\s*4px/);
    // No size: an inline link keeps the sentence's line, which the target floor exempts.
    expect(link).not.toMatch(/(min-)?(height|width|padding|display)\s*:/);
    expect(rulesFor(base, 'a[href]:not([class]):hover')[0]).toMatch(
      /text-decoration-color:\s*var\(--color-accent\)/,
    );
    // Nothing outside the base layer styles every link, which would outrank each link's own
    // classes; a component's scoped rule (`.day0-setup-nav a`) styles its own links only.
    const selectors = [...unlayered().matchAll(/(?:^|[;{}])\s*([^;{}@]+)\{/g)].flatMap((match) =>
      (match[1] ?? '').split(',').map((part) => part.trim()),
    );
    expect(selectors.filter((selector) => /^(:where\()?a($|[\s:.[)])/.test(selector))).toEqual([]);
  });

  it('takes the scroll position from nobody and leaves no trace of the removed cursor', () => {
    expect(CSS).not.toContain('scroll-behavior');
    expect(CSS).not.toContain('data-enter');
    expect(CSS).not.toMatch(/WhipCursor|cursor: none/);
  });
});

describe('the office light-up (v3 section 5, v4 section 1.3)', () => {
  const noPreference = blocks('@media (prefers-reduced-motion: no-preference)').join('\n');
  const officeRules = CSS.slice(CSS.indexOf('The office lights up once'));

  it('hides the pieces only while the office waits below the fold, and only when motion is welcome', () => {
    expect(noPreference).toMatch(
      /\.day0-pixel-office\[data-seen='waiting'\]\s*:is\([^)]*\.day0-pixel-room,[^)]*\.day0-office-agent\s*\)\s*\{\s*opacity: 0;/,
    );
    expect(CSS.match(/\[data-seen='waiting'\]/g)).toHaveLength(1);
  });

  it('lifts the rooms in 260 ms, 50 ms apart, then the rest, the figures last, in about a second', () => {
    const [rooms] = rulesFor(noPreference, ".day0-pixel-office[data-seen='seen'] .day0-pixel-room");
    expect(rooms).toContain('day0-office-piece-on 260ms');
    expect(rooms).toContain('var(--i, 0) * 50ms');
    const [figures] = rulesFor(
      noPreference,
      ".day0-pixel-office[data-seen='seen'] .day0-office-agent",
    );
    expect(figures).toMatch(/day0-office-figure-in 260ms[^;]*900ms/);
    expect(CSS).toMatch(
      /@keyframes day0-office-piece-on \{\s*from \{\s*opacity: 0;\s*transform: translateY\(6px\);/,
    );
  });

  it('keeps the server and console blinking beside their arrival, after the decor rule they override', () => {
    const [server] = rulesFor(
      noPreference,
      ".day0-pixel-office[data-seen='seen'] .day0-pixel-server",
    );
    const [console] = rulesFor(
      noPreference,
      ".day0-pixel-office[data-seen='seen'] .day0-pixel-console",
    );
    expect(server).toContain('day0-server-blink 2.4s steps(3, end) infinite');
    expect(console).toContain('day0-console-glow 3.2s steps(3, end) infinite');
    const decor = officeRules.indexOf('.day0-pixel-decor, .day0-pixel-desk, .day0-pixel-chair');
    expect(decor).toBeGreaterThan(0);
    expect(officeRules.indexOf("[data-seen='seen'] .day0-pixel-server")).toBeGreaterThan(decor);
    expect(officeRules.indexOf("[data-seen='seen'] .day0-pixel-console")).toBeGreaterThan(decor);
  });

  it('follows the office keyframes and their reduced-motion block', () => {
    expect(CSS.indexOf('The office lights up once')).toBeGreaterThan(
      CSS.indexOf('@keyframes day0-agent-step'),
    );
    expect(CSS.indexOf('The office lights up once')).toBeGreaterThan(
      CSS.indexOf('.day0-office-agent-roaming {\n    animation: none;'),
    );
  });
});

describe('the product-surface moments (v3 section 5.2, v4 section 2)', () => {
  const noPreference = blocks('@media (prefers-reduced-motion: no-preference)').join('\n');
  const reduce = blocks('@media (prefers-reduced-motion: reduce)').join('\n');

  /** Each moment's selector, and what its animation must say: the drawn duration and curve. */
  const moments: readonly (readonly [string, RegExp])[] = [
    ['[data-arrive]', /day0-rise-in 240ms var\(--ease-arrive\)/],
    ['[data-just] [data-strike]', /day0-strike 400ms var\(--ease-arrive\) 150ms/],
    ['[data-just] [data-struck-mark]', /day0-settle 220ms var\(--ease-arrive\) 350ms/],
    ['.roll > .from', /day0-roll-out 220ms var\(--ease-move\) both/],
    ['.roll > .to', /day0-roll-in 220ms var\(--ease-move\) both/],
    ['.chip-swap > .from', /day0-fade-out 200ms var\(--ease-arrive\) both/],
    ['.chip-swap > .to', /day0-fade-in 220ms var\(--ease-arrive\) 100ms/],
    ['[data-land]', /day0-settle 260ms var\(--ease-arrive\) both/],
    [
      '[data-land] li',
      /day0-rise-in 240ms var\(--ease-arrive\)[\s\S]*var\(--i, 0\) \* 70ms \+ 120ms/,
    ],
    [
      '.rail[data-advanced] .rail-step.now::after',
      /var\(--rail-slide, day0-rail-slide\) 280ms var\(--ease-move\) 150ms/,
    ],
    [
      '.rail[data-advanced] .rail-step.done:has(+ .now) .rail-title::before',
      /day0-dot-fill 240ms var\(--ease-arrive\)/,
    ],
    ['[data-dialog]', /day0-dialog-in 200ms var\(--ease-arrive\)/],
    ['[data-dialog-backdrop]', /day0-fade-in 200ms var\(--ease-arrive\)/],
  ];

  it.each(moments)(
    'plays %s at its drawn timing, and only when motion is welcome',
    (selector, timing) => {
      const everywhere = rulesFor(CSS, selector).filter((rule) => rule.includes('animation'));
      expect(everywhere, selector).toHaveLength(1);
      expect(rulesFor(noPreference, selector).filter((rule) => rule.includes('animation'))).toEqual(
        everywhere,
      );
      expect(everywhere[0]).toMatch(timing);
    },
  );

  it('stops the stagger at 150 ms on a product page and leaves the landing groups their full stagger', () => {
    expect(rulesFor(noPreference, '[data-cards]:not([data-seen]) > :nth-child(n + 5)')[0]).toMatch(
      /--i:\s*3;/,
    );
    expect(
      noPreference.indexOf('[data-cards]:not([data-seen]) > :nth-child(n + 5)'),
    ).toBeGreaterThan(noPreference.indexOf('[data-cards] > :nth-child(12)'));
  });

  it('starts the rows inside a card 200 ms after the page, as the Work tab draws them', () => {
    expect(rulesFor(noPreference, "[data-cards='rows']")[0]).toMatch(/--arrive-after:\s*200ms/);
  });

  it("drops the first-week rail's fill down its column on a phone, where the rail stacks", () => {
    const [phone] = blocks('@media (max-width: 767px) {').filter((block) =>
      block.includes('--rail-slide'),
    );
    expect(phone).toMatch(/\.rail\s*\{\s*--rail-slide:\s*day0-rail-drop;/);
    expect(blocks('@keyframes day0-rail-drop ')[0]).toMatch(/translateY\(-100%\)/);
  });

  it('moves the whole first week by transitions from its placed start, so an interrupted open or close turns back from where it is (review m1)', () => {
    // Keyframes restart from their first frame when swapped; a transition starts from the value
    // on screen. The start is the card: the week's size scaled to it, transparent, set before the
    // week opens and never itself transitioned.
    const [placing] = rulesFor(noPreference, "[data-week='placing']");
    expect(placing).toMatch(/opacity:\s*0;/);
    expect(placing).toMatch(/transform:\s*scale\(var\(--week-from/);
    expect(placing).not.toMatch(/transition/);
    const [open] = rulesFor(noPreference, "[data-week='open']");
    expect(open).toMatch(
      /transition:\s*transform 260ms var\(--ease-arrive\),\s*opacity 260ms var\(--ease-arrive\);/,
    );
    const [closing] = rulesFor(noPreference, "[data-week='closing']");
    expect(closing).toMatch(/opacity:\s*0;/);
    expect(closing).toMatch(/transform:\s*scale\(var\(--week-from/);
    expect(closing).toMatch(
      /transition:\s*transform 200ms var\(--ease-arrive\),\s*opacity 200ms var\(--ease-arrive\);/,
    );
    for (const state of ['placing', 'open', 'closing']) {
      expect(rulesFor(noPreference, `[data-week-scrim='${state}']`)[0], state).toBeDefined();
    }
    expect(CSS).not.toMatch(/\[data-week[^\]]*\][^{]*\{[^}]*animation/);
    expect(CSS).not.toMatch(/@keyframes day0-week-/);
  });

  it('fades the rail out before the first week’s card settles in where it was, only when motion is welcome (review m4)', () => {
    expect(rulesFor(noPreference, '[data-rail-leaving]')[0]).toMatch(
      /animation:\s*day0-fade-out 150ms var\(--ease-arrive\) both;/,
    );
    expect(rulesFor(noPreference, '.rail[data-arriving]')[0]).toMatch(
      /animation:\s*day0-settle 220ms var\(--ease-arrive\) both;/,
    );
    expect(rulesFor(CSS, '[data-rail-leaving]')).toHaveLength(1);
    expect(rulesFor(CSS, '.rail[data-arriving]')).toHaveLength(1);
  });

  it('shows only the new value of a rolled count or a swapped chip under reduced motion', () => {
    expect(reduce).toMatch(/\.roll > \.from,\s*\.chip-swap > \.from\s*\{\s*display:\s*none;/);
  });

  it('moves only transform and opacity, the strike line colour apart', () => {
    for (const name of [
      'settle',
      'fade-in',
      'fade-out',
      'roll-out',
      'roll-in',
      'rail-slide',
      'rail-drop',
      'dot-fill',
      'dialog-in',
    ]) {
      const [frames] = blocks(`@keyframes day0-${name} `);
      const properties = [...(frames ?? '').matchAll(/([a-z-]+):/g)].map((match) => match[1]);
      expect(properties.length, name).toBeGreaterThan(0);
      expect(
        properties.filter((property) => property !== 'opacity' && property !== 'transform'),
        name,
      ).toEqual([]);
    }
  });
});
