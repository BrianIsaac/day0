'use client';

import { Fragment } from 'react';
import Link from 'next/link';
import type { Id } from '@convex/_generated/dataModel';
import { employeeTabHref } from '../agent/[agentId]/employee-tabs';
import { reportingElsewhereChoice, reportingElsewhereLead } from '../handover-words';

/** One employee that reports to an address other than the manager's. */
export interface ReportingElsewhereEmployee {
  readonly agentId: Id<'agents'>;
  readonly name: string;
}

/** The link style of running text on the page. */
const INLINE_LINK =
  'text-[var(--color-fg)] underline decoration-[var(--color-link-line)] underline-offset-4 [overflow-wrap:anywhere] hover:decoration-[var(--color-accent)]';

/**
 * The home's one line under the company line while any employee reports to someone who is not
 * the manager (the transfer plan, section 11.2; D17 (a)): how many, each named as a link to its
 * People tab, where the flag is resolved, and where to choose. Nothing is drawn while there is
 * none.
 *
 * @param employees - As `agents.employeesReportingElsewhere` names them.
 */
export function ReportingElsewhere({
  employees,
}: {
  readonly employees: readonly ReportingElsewhereEmployee[];
}) {
  if (employees.length === 0) return null;
  return (
    <p className="mt-1 text-sm text-[var(--color-warn)]">
      {reportingElsewhereLead(employees.length)}{' '}
      {employees.map((employee, index) => (
        <Fragment key={employee.agentId}>
          {index === 0 ? '' : index === employees.length - 1 ? ' and ' : ', '}
          <Link href={employeeTabHref(employee.agentId, 'people')} className={INLINE_LINK}>
            {employee.name}
          </Link>
        </Fragment>
      ))}
      . {reportingElsewhereChoice(employees.length)}
    </p>
  );
}
