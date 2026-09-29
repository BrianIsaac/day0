import type { ReactNode } from 'react';
import type { Id } from '@convex/_generated/dataModel';
import { EmployeeShell } from './EmployeeShell';

/**
 * The employee's page around whichever tab is open: its header, first-week rail and tab strip,
 * mounted once while the manager moves between tabs.
 */
export default async function EmployeeLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = await params;
  return <EmployeeShell agentId={agentId as Id<'agents'>}>{children}</EmployeeShell>;
}
