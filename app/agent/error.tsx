'use client';

import { isEmployeeNotYours } from '@/agent/employee-access';
import { EmployeePageFailed, NoSuchEmployee } from './[agentId]/NoSuchEmployee';

/**
 * The employee page's net (Next's `error.js`), placed above the page's own segment because a
 * segment's boundary never wraps its own layout, where the shell reads the employee. Another
 * owner's employee is drawn as the page's "No such employee"; any other throw offers the read
 * again. React reports the caught error itself, so nothing is swallowed here.
 */
export default function EmployeePageError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return isEmployeeNotYours(error) ? (
    <NoSuchEmployee />
  ) : (
    <EmployeePageFailed retry={unstable_retry} />
  );
}
