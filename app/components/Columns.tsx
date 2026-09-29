import type { ReactNode } from 'react';

/**
 * A page's two columns (round two section 3.3's 2:1 grid): the main column and, beside it on a
 * wide window, an aside a third as wide; one column below that, the aside after the main. While
 * `arriving`, both columns carry `data-cards`, so their cards rise in with the page and never
 * again (`useArrival`).
 *
 * @param aside - The narrow column's cards; the main column takes the whole width without them.
 * @param arriving - Whether the page's cards are still arriving.
 */
export function Columns({
  children,
  aside,
  arriving = false,
}: {
  children: ReactNode;
  aside?: ReactNode;
  arriving?: boolean;
}) {
  const cards = arriving ? '' : undefined;
  return (
    <div
      className={`grid grid-cols-1 items-start gap-4 ${aside !== undefined ? 'lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]' : ''}`}
    >
      <div data-cards={cards} className="grid min-w-0 content-start gap-4">
        {children}
      </div>
      {aside !== undefined ? (
        <div data-cards={cards} className="grid min-w-0 content-start gap-4">
          {aside}
        </div>
      ) : null}
    </div>
  );
}
