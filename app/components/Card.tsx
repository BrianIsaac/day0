'use client';

import { useId } from 'react';

export function Card({
  title,
  children,
  tone,
  focusRef,
}: {
  title: string;
  children: React.ReactNode;
  tone?: 'default' | 'accent' | 'warn' | 'ok';
  /** Makes the card the place focus returns to when a change removes the control that made it. */
  focusRef?: React.Ref<HTMLElement>;
}) {
  const headingId = useId();
  const border = {
    default: 'border-[var(--color-border)]',
    accent: 'border-[var(--color-accent)]/40',
    warn: 'border-[var(--color-warn)]/40',
    ok: 'border-[var(--color-ok)]/40',
  }[tone ?? 'default'];
  return (
    <section
      ref={focusRef}
      {...(focusRef ? { tabIndex: -1, 'aria-labelledby': headingId } : {})}
      className={`bg-[var(--color-card)] border ${border} rounded-xl p-4`}
    >
      <h2
        id={focusRef ? headingId : undefined}
        className="text-sm font-semibold tracking-tight text-[var(--color-fg)] mb-3"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}
