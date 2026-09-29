'use client';

import { useId, type ReactNode, type Ref } from 'react';
import { TONE_LINE, type Tone } from './tone';

/** Data attributes a card carries for what reads it by them (the rehearsal driver, a view's state). */
export interface CardDataAttributes {
  readonly [attribute: `data-${string}`]: string | undefined;
}

/**
 * A card: a titled section one step above the page, with a hairline border that takes a tone's
 * line colour when the card is about something in that tone (a charter awaiting review, a write
 * held for the manager).
 *
 * @param title - The card's heading, an `h2`.
 * @param meta - A short muted note beside the title: how the list is ordered, how many there are.
 * @param tone - The border's tone; the page's own hairline when absent.
 * @param focusRef - Makes the card the place focus returns to when a change removes the control
 *   that made it: the card takes `tabIndex={-1}` and is named by its heading.
 * @param id - Makes the card addressable: a link or a view that names the id focuses it and
 *   scrolls it clear of the header, so it takes `tabIndex={-1}` as well.
 * @param data - Any `data-*` attributes, carried on the section.
 */
export function Card({
  title,
  meta,
  tone,
  focusRef,
  id,
  children,
  ...data
}: {
  title: ReactNode;
  meta?: ReactNode;
  tone?: Exclude<Tone, 'muted'>;
  focusRef?: Ref<HTMLElement>;
  id?: string;
  children: ReactNode;
} & CardDataAttributes) {
  const headingId = useId();
  const border = tone ? TONE_LINE[tone] : 'border-[var(--color-border)]';
  return (
    <section
      ref={focusRef}
      id={id}
      aria-labelledby={headingId}
      {...(focusRef || id !== undefined ? { tabIndex: -1 } : {})}
      {...data}
      className={`rounded-xl border bg-[var(--color-card)] ${border}${id !== undefined ? ' scroll-mt-24' : ''}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-[var(--color-border)] px-4 py-3.5 sm:px-5">
        <h2 id={headingId} className="text-[15px] font-semibold text-[var(--color-fg)]">
          {title}
        </h2>
        {meta !== undefined ? (
          <span className="text-[13px] text-[var(--color-muted)]">{meta}</span>
        ) : null}
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}
