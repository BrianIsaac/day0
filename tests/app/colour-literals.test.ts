import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every colour the product draws comes from a token (16-T, wave 16 section 5.5), so the light set
 * reaches every surface: a hex, an `rgb()` or a Tailwind palette class in a component is drawn the
 * same in both themes. The sweep's input is the wave file's own count at `5085e242` (section 4:
 * `SurfaceOrbit.tsx`'s 17, the two scrims, `clerk-appearance.ts`'s 14, `layout.tsx`'s chrome
 * colour) and the palette classes a grep found beside them (the marketing frames' zinc).
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** A hex colour, or a functional colour notation, as a component would write it. */
const LITERAL = /#[0-9a-fA-F]{3,8}\b|(?<![a-z-])(?:rgba?|hsla?|oklch|oklab)\(/;

/** A Tailwind palette colour on a utility: `text-zinc-300`, `bg-black/50`. */
const PALETTE =
  /\b(?:bg|text|border|ring|fill|stroke|from|to|via|divide|decoration|shadow|outline|caret|accent)-(?:black|white|zinc|gray|slate|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?\b/;

/**
 * The files allowed a literal, each with why. The stylesheet declares the tokens; the chrome
 * colours mirror two of them for the head's script, which runs before any stylesheet applies and
 * is pinned against them (`tests/app/theme-preference.test.ts`).
 */
const ALLOWED: Readonly<Record<string, string>> = {
  'app/globals.css': 'declares the token sets and the pixel office’s own palette (RM11 (a))',
  'app/theme-preference.ts': 'the chrome colours, each set’s page colour, pinned against the sets',
};

/** Every `.ts` and `.tsx` source under `app/`, tests and generated files apart. */
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('the colours the product draws', () => {
  it('come from tokens: no hex, functional colour or palette class in any component', () => {
    const found = sources(join(ROOT, 'app'))
      .map((path) => relative(ROOT, path))
      .filter((path) => !(path in ALLOWED))
      .flatMap((path) =>
        readFileSync(join(ROOT, path), 'utf8')
          .split('\n')
          .map((line, index) => ({ line, at: `${path}:${index + 1}` }))
          .filter(({ line }) => LITERAL.test(line) || PALETTE.test(line))
          .map(({ line, at }) => `${at} ${line.trim()}`),
      );
    expect(found).toEqual([]);
  });

  it('allow a literal only in the files that declare or mirror the tokens', () => {
    for (const path of Object.keys(ALLOWED)) {
      expect(readFileSync(join(ROOT, path), 'utf8'), path).toMatch(LITERAL);
    }
  });
});
