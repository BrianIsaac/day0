'use client';

import Link from 'next/link';
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { RollingCount } from './RollingCount';
import { bringTabIntoView } from './strip-scroll';

/** One tab: where it goes and what it counts. */
export interface TabItem {
  readonly key: string;
  readonly label: string;
  readonly href: string;
  /** A count beside the label; none is drawn while it is undefined. */
  readonly count?: number;
  /** Whether a count above zero waits on the manager, drawn in the warn tone. */
  readonly hot?: boolean;
}

/**
 * The id a tab's element carries, so its panel can name it: the panel's id and the tab's key,
 * so two strips on one page never share an id.
 *
 * @param panelId - The id of the panel the strip controls.
 * @param key - The tab.
 */
export function tabId(panelId: string, key: string): string {
  return `${panelId}-${key}`;
}

/** Where arrow keys, Home and End move focus from `index` in a strip of `count` tabs. */
export function nextTabIndex(key: string, index: number, count: number): number | undefined {
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return undefined;
  }
}

/**
 * A strip of tabs, each its own address (a route segment), so the address names the tab and a
 * tab can be linked to. It is the ARIA tabs pattern with manual activation: the strip is one tab
 * stop, arrow keys, Home and End move focus along it, and Enter or Space follows the focused tab. A count
 * beside a label rolls when it changes (`RollingCount`), and one that waits on the manager is in
 * the warn tone. A tab change itself is never animated (round two section 4.4).
 *
 * @param label - What the strip is, for the tablist's name.
 * @param items - The tabs, in order.
 * @param selected - The key of the tab whose panel is showing.
 * @param panelId - The id of the `TabPanel` the selected tab controls.
 */
export function Tabs({
  label,
  items,
  selected,
  panelId,
}: {
  label: string;
  items: readonly TabItem[];
  selected: string;
  panelId: string;
}) {
  const strip = useRef<HTMLDivElement>(null);
  // The strip is one tab stop: the selected tab, or the first when the key names none (a page
  // under a tab, such as reorientation under Needs you, selects the tab it sits under).
  const stop = items.some((item) => item.key === selected) ? selected : items[0]?.key;
  // On a narrow window the strip scrolls sideways: the selected tab is brought into view, so the
  // tab the page is on is never off the edge.
  useEffect(() => {
    const list = strip.current;
    const tab = list?.querySelector<HTMLElement>(`#${CSS.escape(tabId(panelId, selected))}`);
    if (list && tab) bringTabIntoView({ list, tab });
  }, [panelId, selected]);
  function onKeyDown(event: KeyboardEvent<HTMLAnchorElement>, index: number): void {
    if (event.key === ' ') {
      // Space follows the tab as Enter does (the ARIA tabs pattern), not scroll the page.
      event.preventDefault();
      event.currentTarget.click();
      return;
    }
    const next = nextTabIndex(event.key, index, items.length);
    if (next === undefined) return;
    event.preventDefault();
    strip.current?.querySelectorAll<HTMLAnchorElement>('[role="tab"]')[next]?.focus();
  }
  return (
    // The strip's line is a border under it, which snaps to whole device pixels as every other
    // line on the page does (an inset shadow smeared over two rows at a ratio of 1.5). The strip
    // overlaps it by a pixel, so the selected tab's underline covers the line, while every tab
    // stays inside the strip's own box: a tab hanging below made the strip scroll vertically, and
    // a scroll box draws a scrollbar wherever one is not hidden. The strip is positioned so its
    // tabs' offsets are measured from it when a tab is brought into view.
    <div className="border-b border-[var(--color-border)]">
      <div
        ref={strip}
        role="tablist"
        aria-label={label}
        className="relative -mb-px flex gap-0.5 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {items.map((item, index) => {
          const current = item.key === selected;
          const hot = item.hot === true && (item.count ?? 0) > 0;
          return (
            <Link
              key={item.key}
              id={tabId(panelId, item.key)}
              href={item.href}
              role="tab"
              aria-selected={current}
              // Only the selected tab's panel is on the page; the others name no element.
              aria-controls={current ? panelId : undefined}
              tabIndex={item.key === stop ? 0 : -1}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={`inline-flex h-11 shrink-0 items-center gap-2 border-b-2 px-3 text-sm font-medium whitespace-nowrap no-underline ${
                current
                  ? 'border-[var(--color-accent)] text-[var(--color-fg)]'
                  : 'border-transparent text-[var(--color-muted)] hover:text-[var(--color-fg)]'
              }`}
            >
              {item.label}
              {/* A space the flex layout ignores, so the name reads "Work 3", not "Work3". */}
              {item.count !== undefined ? ' ' : null}
              {item.count !== undefined ? (
                <span
                  className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full border px-1.5 text-xs font-semibold tabular-nums ${
                    hot
                      ? 'border-transparent bg-[var(--color-warn-soft)] text-[var(--color-warn)]'
                      : 'border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-muted)]'
                  }`}
                >
                  <RollingCount value={item.count} />
                </span>
              ) : null}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The panel a strip of tabs controls: named by the selected tab, and focusable so a skip to it
 * lands on its content.
 *
 * @param id - The id the tabs' `aria-controls` names.
 * @param selected - The key of the selected tab.
 */
export function TabPanel({
  id,
  selected,
  children,
}: {
  id: string;
  selected: string;
  children: ReactNode;
}) {
  return (
    <div id={id} role="tabpanel" aria-labelledby={tabId(id, selected)} tabIndex={-1}>
      {children}
    </div>
  );
}
