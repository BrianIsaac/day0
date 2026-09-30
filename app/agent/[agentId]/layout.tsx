import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import type { Id } from '@convex/_generated/dataModel';
import { SessionGate } from '../../Providers';
import { EmployeeLoading, EmployeeShell } from './EmployeeShell';
import { employeeTitle } from './employee-title';

/** The tab's title: the employee's name, then the tab each page names, then Day0. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ agentId: string }>;
}): Promise<Metadata> {
  const { agentId } = await params;
  return { title: await employeeTitle(agentId as Id<'agents'>) };
}

/**
 * The employee's page around whichever tab is open: its header, first-week rail and tab strip,
 * mounted once while the manager moves between tabs. It reads the manager's own rows, so it waits
 * for Convex to hold the manager's token.
 */
export default async function EmployeeLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = await params;
  return (
    <SessionGate fallback={<EmployeeLoading />}>
      <EmployeeShell agentId={agentId as Id<'agents'>}>{children}</EmployeeShell>
    </SessionGate>
  );
}
