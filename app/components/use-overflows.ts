'use client';

import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * Whether a scroll region's content runs past the region's own height, read again whenever the
 * region or its content changes size: a phone's height, a section that opens, a list that loads.
 *
 * @param region - The element that scrolls.
 * @param content - The one element inside it that holds what scrolls, observed so a change of
 *   content height is read even when the region's own box is already at its cap.
 */
export function useOverflows(
  region: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
): boolean {
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const viewport = region.current;
    const inner = content.current;
    if (!viewport || !inner) return;
    const read = (): void => setOverflows(viewport.scrollHeight > viewport.clientHeight);
    read();
    // A layout-less environment (a test's jsdom) has no observer and no overflow to read again.
    if (typeof ResizeObserver === 'undefined') return;
    const resize = new ResizeObserver(read);
    resize.observe(viewport);
    resize.observe(inner);
    return () => resize.disconnect();
  }, [region, content]);
  return overflows;
}
