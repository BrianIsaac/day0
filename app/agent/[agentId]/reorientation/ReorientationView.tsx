'use client';

import Link from 'next/link';
import { Card } from '../../../components/Card';
import { Columns } from '../../../components/Columns';
import { useEmployee } from '../employee-context';
import { EmployeeRail } from '../EmployeeRail';
import { employeeTabHref } from '../employee-tabs';

/**
 * The reorientation page, under the Needs you tab (`/agent/<id>/reorientation`): where a card
 * opens when something the charter relies on (a page, a person, a connection) changes. Nothing
 * opens one yet: the trigger waits on A11. The page says so, and where the manager changes the
 * charter meanwhile.
 */
export function ReorientationView() {
  const { agent, arriving } = useEmployee();
  return (
    <Columns arriving={arriving} aside={<EmployeeRail />}>
      <Card title="No reorientation card is open">
        <p className="text-sm text-[var(--color-fg-2)]">
          {agent.name} does not yet notice on its own when a page, a person or a connection its
          charter relies on changes. When you know something has changed, amend the charter on the{' '}
          <Link href={employeeTabHref(agent._id, 'charter')}>Charter tab</Link>.
        </p>
      </Card>
    </Columns>
  );
}
