import type { ReactNode } from 'react';

/** A disclosure's summary with a 44 px target (N14), for a `details` a card draws itself. */
export const DISCLOSURE_SUMMARY =
  'min-h-11 py-3 cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-accent)]';

/**
 * Something one step away: a summary line with a chevron that turns as it opens, and the content
 * shown at once beneath it (round two section 4.4: the chevron rotates in 180 ms, the content is
 * never animated by height). A native `details`, so it opens by keyboard and is found by the
 * browser's find-in-page while closed.
 *
 * @param summary - What opening it shows, in words.
 * @param open - Whether it starts open.
 */
export function Disclosure({
  summary,
  open,
  children,
}: {
  summary: ReactNode;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={open} className="group">
      <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 text-[13px] text-[var(--color-muted)] hover:text-[var(--color-fg)] [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden="true"
          className="inline-block size-[7px] -rotate-45 border-r-[1.5px] border-b-[1.5px] border-current transition-transform duration-[180ms] ease-out group-open:rotate-45 motion-reduce:transition-none"
        />
        {summary}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
