'use client';

import { Button } from '../../components/Button';

/**
 * A tab's net (Next's `error.js`): a throw inside one tab's page is drawn in the tab's place, so
 * the employee's header, rail and tab strip stay and the manager can move to another tab. The
 * shell's own throws reach the page-wide net above it (`app/agent/error.tsx`). React reports the
 * caught error itself, so nothing is swallowed here.
 */
export default function EmployeeTabError({ unstable_retry }: { unstable_retry: () => void }) {
  return (
    <section
      aria-labelledby="employee-tab-error"
      className="grid gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-5"
    >
      <h2 id="employee-tab-error" className="text-base font-semibold">
        This tab could not be drawn
      </h2>
      <p className="text-sm text-[var(--color-fg-2)]">
        Reading it failed. Try again, or open another tab.
      </p>
      <Button variant="primary" className="self-start" onClick={unstable_retry}>
        Try again
      </Button>
    </section>
  );
}
