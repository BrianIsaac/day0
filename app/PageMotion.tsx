'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/** Content stays visible until the browser can observe it; SSR needs no motion state. */
export function PageMotion({ children, className }: { children: ReactNode; className?: string }) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = root.current;
    if (!container || !('IntersectionObserver' in window)) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const targets = Array.from(container.querySelectorAll<HTMLElement>('[data-reveal]'));
    const reveal = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const target = entry.target as HTMLElement;
        target.dataset.reveal = 'visible';
        reveal.unobserve(target);
      }
    });

    if (!reducedMotion.matches) {
      for (const target of targets) {
        // Do not hide content already being read, including a restored scroll position or hash.
        if (
          target.getBoundingClientRect().top >= window.innerHeight &&
          !target.matches(':target')
        ) {
          target.dataset.reveal = 'pending';
          reveal.observe(target);
        }
      }
    }

    const finishMotion = () => {
      if (!reducedMotion.matches) return;
      reveal.disconnect();
      for (const target of targets) delete target.dataset.reveal;
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
      for (const target of targets) target.dataset.reveal = '';
      for (const link of links) link.removeAttribute('aria-current');
    };
  }, []);

  return (
    <div ref={root} className={className}>
      {children}
    </div>
  );
}
