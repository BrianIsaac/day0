/** A tab strip that scrolls sideways, and one of its tabs. */
export interface TabInStrip {
  /** The strip: a positioned scroll box, so its tabs' offsets are measured from it. */
  readonly list: HTMLElement;
  readonly tab: HTMLElement;
}

/**
 * Scroll a strip sideways so a tab past either edge is in view, centred where the strip allows;
 * a tab already in view leaves the strip where it is. Self-contained, since the browser job runs
 * it as a page function against the strip's own markup.
 *
 * @param strip - The strip and the tab to bring into view.
 */
export function bringTabIntoView({ list, tab }: TabInStrip): void {
  const left = tab.offsetLeft;
  const right = left + tab.offsetWidth;
  if (left < list.scrollLeft || right > list.scrollLeft + list.clientWidth) {
    list.scrollLeft = Math.max(0, left - (list.clientWidth - tab.offsetWidth) / 2);
  }
}
