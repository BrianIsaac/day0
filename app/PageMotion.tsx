'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/** One element the observer reveals: the data attribute it carries and the value that shows it. */
interface Reveal {
  readonly target: HTMLElement;
  readonly key: 'reveal' | 'rise';
  readonly shown: 'visible' | 'in';
}

/** Whether the stylesheet can scrub `[data-rise]` against a view timeline by itself. */
function scrubs(): boolean {
  return typeof CSS !== 'undefined' && CSS.supports('animation-timeline: view()');
}

/**
 * The public pages' scroll behaviour. Headings and ledes (`[data-rise]`) are scrubbed by the
 * stylesheet where the browser has view timelines; this observer is their fallback elsewhere,
 * and it reveals the setup guide's sections (`[data-reveal]`) everywhere. It also marks the
 * section link a `[data-section-link]` nav points at while its `[data-scroll-section]` is read.
 * Content stays visible until the browser can observe it, so the server's markup needs no
 * motion state, and nothing below the fold is hidden when reduced motion is asked for.
 */
export function PageMotion({
  children,
  className,
  revealMargin = '0px',
}: {
  children: ReactNode;
  className?: string;
  revealMargin?: string;
}) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = root.current;
    if (!container || !('IntersectionObserver' in window)) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const reveals: Reveal[] = [
      ...Array.from(
        container.querySelectorAll<HTMLElement>('[data-reveal]'),
        (target): Reveal => ({ target, key: 'reveal', shown: 'visible' }),
      ),
      ...(scrubs()
        ? []
        : Array.from(
            container.querySelectorAll<HTMLElement>('[data-rise]'),
            (target): Reveal => ({ target, key: 'rise', shown: 'in' }),
          )),
    ];
    const byTarget = new Map(reveals.map((reveal) => [reveal.target, reveal]));
    const reveal = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const found = byTarget.get(entry.target as HTMLElement);
          if (!entry.isIntersecting || !found) continue;
          found.target.dataset[found.key] = found.shown;
          reveal.unobserve(found.target);
        }
      },
      { rootMargin: revealMargin },
    );

    if (!reducedMotion.matches) {
      for (const { target, key } of reveals) {
        // Do not hide content already being read, including a restored scroll position or hash.
        if (
          target.getBoundingClientRect().top >= window.innerHeight &&
          !target.matches(':target')
        ) {
          target.dataset[key] = 'pending';
          reveal.observe(target);
        }
      }
    }

    const finishMotion = () => {
      if (!reducedMotion.matches) return;
      reveal.disconnect();
      for (const { target, key } of reveals) target.dataset[key] = '';
    };
    reducedMotion.addEventListener('change', finishMotion);

    const sections = Array.from(container.querySelectorAll<HTMLElement>('[data-scroll-section]'));
    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('[data-section-link]'));
    const inView = new Set<Element>();
    const navigation = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) inView.add(entry.target);
          else inView.delete(entry.target);
        }
        const current = sections.findLast((section) => inView.has(section));
        if (!current) return;
        for (const link of links) {
          if (link.hash === `#${current.id}`) link.setAttribute('aria-current', 'location');
          else link.removeAttribute('aria-current');
        }
      },
      { rootMargin: '-80px 0px -55% 0px' },
    );
    for (const section of sections) navigation.observe(section);

    return () => {
      reveal.disconnect();
      navigation.disconnect();
      reducedMotion.removeEventListener('change', finishMotion);
      for (const { target, key } of reveals) target.dataset[key] = '';
      for (const link of links) link.removeAttribute('aria-current');
    };
  }, [revealMargin]);

  return (
    <div ref={root} className={className}>
      {children}
    </div>
  );
}
