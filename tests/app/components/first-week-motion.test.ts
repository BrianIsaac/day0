import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CARD_SETTLE_MS,
  RAIL_ADVANCE_MS,
  RAIL_EXIT_MS,
} from '../../../app/components/first-week-motion';

const CSS = readFileSync(new URL('../../../app/globals.css', import.meta.url), 'utf8');

describe('the first week’s motion timings', () => {
  it('times the rail’s advance, its fade and the card’s settle as the stylesheet plays them (second pass)', () => {
    // The page holds each moment's markup for as long as the stylesheet plays it: a timing that
    // drifted from its rule would cut the motion short or leave its markup behind.
    const slide =
      /\.rail\[data-advanced\] \.rail-step\.now::after\s*\{[^}]*animation:[^;]*?(\d+)ms var\(--ease-move\) (\d+)ms both;/.exec(
        CSS,
      );
    expect(Number(slide?.[1]) + Number(slide?.[2])).toBe(RAIL_ADVANCE_MS);
    expect(CSS).toMatch(
      new RegExp(
        `\\[data-rail-leaving\\]\\s*\\{\\s*animation:\\s*day0-fade-out ${RAIL_EXIT_MS}ms `,
      ),
    );
    expect(CSS).toMatch(
      new RegExp(
        `\\.rail\\[data-arriving\\]\\s*\\{\\s*animation:\\s*day0-settle ${CARD_SETTLE_MS}ms `,
      ),
    );
  });
});
