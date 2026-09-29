import type { ReactNode } from 'react';
import type { Doc, Id } from '../../../convex/_generated/dataModel';
import { EmployeeContext, type Employee } from '../../../app/agent/[agentId]/employee-context';
import { AgentZoneContext } from '../../../app/components/time';

/** The employee a tab's test renders it for: active, supervised, in UTC. */
export const EMPLOYEE_ROW = {
  _id: 'agent-1' as Id<'agents'>,
  _creationTime: 1,
  bossEmail: 'boss@day0.local',
  name: 'Mira',
  userId: 'owner',
  state: 'active',
  zone: 'UTC',
  createdAt: Date.UTC(2026, 8, 29, 9, 2),
} as unknown as Doc<'agents'>;

/** An approved charter with nothing in it beyond what the page reads. */
export const APPROVED_CHARTER = {
  _id: 'charter-1' as Id<'charters'>,
  _creationTime: 2,
  agentId: 'agent-1',
  version: '0.1',
  approved: true,
  createdAt: 2,
  body: {},
} as unknown as Doc<'charters'>;

/**
 * A tab of the employee page inside the context the shell gives it.
 *
 * @param node - The tab's view.
 * @param overrides - What differs from an active employee with an approved charter in mock mode.
 */
export function asEmployee(node: ReactNode, overrides: Partial<Employee> = {}): ReactNode {
  const employee: Employee = {
    agent: EMPLOYEE_ROW,
    charter: APPROVED_CHARTER,
    surfaceMode: 'mock',
    surfaces: [],
    arriving: false,
    reportSentBack: () => undefined,
    ...overrides,
  };
  return (
    <AgentZoneContext value="UTC">
      <EmployeeContext value={employee}>{node}</EmployeeContext>
    </AgentZoneContext>
  );
}
