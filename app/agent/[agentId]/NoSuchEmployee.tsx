import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button } from '../../components/Button';

/** The frame every page-wide answer about a missing employee is drawn in. */
function Answer({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto grid w-full max-w-7xl gap-3 px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-[-0.02em]">{title}</h1>
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
        This employee was retired, or the address names one that is not yours.{' '}
        <Link href="/">Your employees</Link>.
      </p>
    </Answer>
  );
}

/**
 * The employee page once the employee it was showing is gone: retired from this page, from
 * another tab, or by a reset.
 *
 * @param name - The employee's name, as the page last showed it.
 */
export function EmployeeRetired({ name }: { name: string }) {
  return (
    <Answer title={`${name} is retired`}>
      <p className="text-[var(--color-fg-2)]">
        <Link href="/">Back to your employees</Link>
      </p>
    </Answer>
  );
}

/**
 * The employee page when drawing it failed for a reason the page has no words for.
 *
 * @param retry - Reads the page again.
 */
export function EmployeePageFailed({ retry }: { retry: () => void }) {
  return (
    <Answer title="This page could not be drawn">
      <p className="text-[var(--color-fg-2)]">
        Reading this employee failed. Try again, or go back to your employees.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={retry}>
          Try again
        </Button>
        <Link href="/" className="inline-flex min-h-11 items-center">
          Your employees
        </Link>
      </div>
    </Answer>
  );
}
