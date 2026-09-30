/**
 * How long each moment of the first week's motion plays, as `app/globals.css` plays it: the
 * page holds a moment's markup for exactly that long, so a timing here and its rule there move
 * together (`tests/app/components/first-week-motion.test.ts` holds them to it).
 */

/** How long the first-week rail's advance plays: its 150 ms pause and 280 ms slide. */
export const RAIL_ADVANCE_MS = 430;

/**
 * How long the rail fades once the week has moved on to Working, before the card takes its place
 * (`[data-rail-leaving]`): the page's height still changes, as the transform rule allows no other
 * way, but it no longer cuts.
 */
export const RAIL_EXIT_MS = 150;

/** How long the card settles in where the rail was (`.rail[data-arriving]`). */
export const CARD_SETTLE_MS = 220;
