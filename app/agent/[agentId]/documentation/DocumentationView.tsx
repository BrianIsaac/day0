'use client';

import Link from 'next/link';
import { Card } from '../../../components/Card';
import { Columns } from '../../../components/Columns';
import { useEmployee } from '../employee-context';
import { EmployeeRail } from '../EmployeeRail';
import { employeeTabHref } from '../employee-tabs';

/**
 * The Documentation tab, as far as the product scopes documentation today: sources are linked
 * once for all of the manager's employees, on the Documentation page, and what this employee can
 * read shows on the Surfaces tab under Docs. Trust per source and the page table wait on the
 * documentation authority records (A5); the tab says where things are rather than copying them.
 */
export function DocumentationView() {
  const { agent, surfaceMode, arriving } = useEmployee();
  const surfaces = employeeTabHref(agent._id, 'surfaces');
  return (
    <Columns arriving={arriving} aside={<EmployeeRail />}>
      <Card title="What it reads">
        {surfaceMode === undefined ? (
          <p className="text-sm text-[var(--color-muted)]">Loading</p>
        ) : surfaceMode === 'real' ? (
          <p className="text-sm text-[var(--color-fg-2)]">
            You link documentation once for all your employees, on the{' '}
            <Link href="/documentation" prefetch={false}>
              Documentation page
            </Link>
            . The pages {agent.name} can read are on the <Link href={surfaces}>Surfaces tab</Link>,
            under Docs.
          </p>
        ) : (
          <p className="text-sm text-[var(--color-fg-2)]">
            In the hosted office {agent.name} reads the office&apos;s wiki and how-to guides, on the{' '}
            <Link href={surfaces}>Surfaces tab</Link> under Docs. Linking your own documentation is
            part of running Day0 on your own systems.
          </p>
        )}
      </Card>
    </Columns>
  );
}
