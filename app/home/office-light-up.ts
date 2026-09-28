'use client';

import { useEffect, type RefObject } from 'react';

/** How much of the office must be in view before it lights up, as the prototype draws it. */
const LIGHT_UP_THRESHOLD = 1 / 3;

/**
 * How long the light-up plays: the last room's wash (five 50 ms steps, 80 ms and 900 ms) is the
 * longest piece of the stylesheet's sequence.
 */
export const LIGHT_UP_MS = 5 * 50 + 80 + 900;

/**
 * Light the office up once, the first time it is seen (v3 section 5, as v4
 * section 1.3 re-times it).
 *
 * The state is a `data-seen` attribute on the office, `waiting` while it is
 * below the fold and `seen` once a third of it is in view; the stylesheet
 * hides the rooms while `waiting` and plays the sequence on `seen`. Without
 * the script, under reduced motion, or when the office is already on screen
 * as the page opens, the attribute is never set and the office is simply
 * there. The attribute is written on the element rather than held in React
 * state, so the sequence plays without a render.
 *
 * @param ref - The office container.
 */
export function useLightUpOnce(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const office = ref.current;
    if (!office || !('IntersectionObserver' in window)) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // Content already being read is never hidden and replayed.
    if (office.getBoundingClientRect().top < window.innerHeight) return;

    office.dataset.seen = 'waiting';
    let settle: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        office.dataset.seen = 'seen';
        observer.disconnect();
        // Once lit, the office is handed back: a figure deployed later walks in as it always has,
        // not 900 ms late behind a sequence that already played.
        settle = setTimeout(() => delete office.dataset.seen, LIGHT_UP_MS);
      },
      { threshold: LIGHT_UP_THRESHOLD },
    );
    observer.observe(office);
    return () => {
      observer.disconnect();
      clearTimeout(settle);
      delete office.dataset.seen;
    };
  }, [ref]);
}
