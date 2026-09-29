'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Button, ButtonLink } from '../../components/Button';

/** The words of the one way back from every page-wide answer about a missing employee. */
const BACK = 'Back to your employees';

/**
 * The frame every page-wide answer about a missing employee is drawn in: its heading, what
 * happened, and the way on.
 *
 * @param focus - Take focus on mount: the page changed under the manager, so the heading says
 *   where they are now.
 */
function Answer({
  title,
  focus = false,
  children,
}: {
  title: string;
  focus?: boolean;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) heading.current?.focus();
  }, [focus]);
  return (
    <div className="mx-auto grid w-full max-w-7xl justify-items-start gap-3 px-4 py-10 sm:px-6">
      <h1
        ref={heading}
        tabIndex={focus ? -1 : undefined}
        className="text-2xl font-semibold tracking-[-0.02em] outline-none"
      >
        {title}
      </h1>
      {children}
    </div>
  );
}

/**
 * The employee page for an address that names no employee of the caller's: one retired before
 * the page opened, one that never existed, or another owner's.
 */
export function NoSuchEmployee() {
  return (
    <Answer title="No such employee">
      <p className="text-[var(--color-fg-2)]">
        This employee has been retired, or this link is for an employee that is not yours.
      </p>
      <ButtonLink href="/" variant="text">
        {BACK}
      </ButtonLink>
    </Answer>
  );
}

/**
 * The employee page once the employee it was showing is gone: retired from this page, from
 * another tab, or by a reset. The heading takes focus, since the page changed under the manager.
 *
 * @param name - The employee's name, as the page last showed it.
 */
export function EmployeeRetired({ name }: { name: string }) {
  return (
    <Answer title={`${name} is retired`} focus>
      <p className="text-[var(--color-fg-2)]">{name} was retired while this page was open.</p>
      <ButtonLink href="/" variant="text">
        {BACK}
      </ButtonLink>
    </Answer>
  );
}

/**
 * The employee page when loading it failed for a reason the page has no words for.
 *
 * @param retry - Loads the page again.
 */
export function EmployeePageFailed({ retry }: { retry: () => void }) {
  return (
    <Answer title="This page did not load">
      <p className="text-[var(--color-fg-2)]">
        Something went wrong loading this employee. Try again, or go back to your employees.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={retry}>
          Try again
        </Button>
        <ButtonLink href="/" variant="text">
          {BACK}
        </ButtonLink>
      </div>
    </Answer>
  );
}
