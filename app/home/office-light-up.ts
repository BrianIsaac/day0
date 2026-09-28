'use client';

import { useEffect, type RefObject } from 'react';

/** How much of the office must be in view before it lights up, as the prototype draws it. */
const LIGHT_UP_THRESHOLD = 1 / 3;

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
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        office.dataset.seen = 'seen';
        observer.disconnect();
      },
      { threshold: LIGHT_UP_THRESHOLD },
    );
    observer.observe(office);
    return () => {
      observer.disconnect();
      if (office.dataset.seen === 'waiting') delete office.dataset.seen;
    };
  }, [ref]);
}
