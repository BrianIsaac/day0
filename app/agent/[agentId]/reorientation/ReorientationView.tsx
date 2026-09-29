'use client';

import Link from 'next/link';
import { Card } from '../../../components/Card';
import { Columns } from '../../../components/Columns';
import { useEmployee } from '../employee-context';
import { EmployeeRail } from '../EmployeeRail';
import { employeeTabHref } from '../employee-tabs';

/**
 * The reorientation page, under the Needs you tab (`/agent/<id>/reorientation`): where a card
 * opens when something the charter relies on (a page, a person, a connection) changes. No trigger
 * opens one yet (A11). What real mode does re-check on its own is said, with where the manager
 * changes the charter meanwhile.
 */
export function ReorientationView() {
  const { agent, surfaceMode, arriving } = useEmployee();
  const charter = <Link href={employeeTabHref(agent._id, 'charter')}>Charter tab</Link>;
  const surfaces = <Link href={employeeTabHref(agent._id, 'surfaces')}>Surfaces tab</Link>;
  return (
    <Columns arriving={arriving} aside={<EmployeeRail />}>
      <Card title="No reorientation card is open">
        {surfaceMode === 'real' ? (
          <p className="text-sm text-[var(--color-fg-2)]">
            After each documentation sync, {agent.name} checks again for the systems it could not
            find, and a connection whose scope the documentation changed waits for your approval
            again on the {surfaces}. A change to what its charter relies on opens no card here yet:
            when you know one has happened, amend the charter on the {charter}.
          </p>
        ) : (
          <p className="text-sm text-[var(--color-fg-2)]">
            The hosted office&apos;s pages do not change, so nothing here reopens. When you want{' '}
            {agent.name} to work differently, amend the charter on the {charter}.
          </p>
        )}
      </Card>
    </Columns>
  );
}
