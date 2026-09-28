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
    ['.roll > .from', /day0-roll-out 220ms var\(--ease-move\) 700ms/],
    ['.roll > .to', /day0-roll-in 220ms var\(--ease-move\) 700ms/],
    ['.chip-swap > .from', /day0-fade-out 200ms ease-out/],
    ['.chip-swap > .to', /day0-fade-in 220ms var\(--ease-arrive\) 100ms/],
    ['[data-land]', /day0-settle 260ms var\(--ease-arrive\) 200ms/],
    [
      '[data-land] li',
      /day0-rise-in 240ms var\(--ease-arrive\)[\s\S]*var\(--i, 0\) \* 70ms \+ 350ms/,
    ],
    [
      '.rail[data-advanced] .rail-step.now::after',
      /day0-rail-slide 280ms var\(--ease-move\) 150ms/,
    ],
    [
      '.rail[data-advanced] .rail-step.done:has(+ .now)::before',
      /day0-dot-fill 240ms var\(--ease-arrive\)/,
    ],
    ['[data-dialog]', /day0-dialog-in 200ms var\(--ease-arrive\)/],
    ['[data-dialog-backdrop]', /day0-fade-in 200ms ease-out/],
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

  it('starts the rows inside a card 200 ms after the page, as the Work tab draws them', () => {
    expect(rulesFor(noPreference, "[data-cards='rows']")[0]).toMatch(/--arrive-after:\s*200ms/);
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
