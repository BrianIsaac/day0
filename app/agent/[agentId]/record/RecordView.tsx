'use client';

import { useMemo } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { Columns } from '../../../components/Columns';
import { useEmployee } from '../employee-context';
import { RECENT_EVENTS } from '../EmployeeRail';
import { EventTicker } from './EventTicker';
import { MetricsCard } from './MetricsCard';
import { WorkspacePanel } from './WorkspacePanel';

/**
 * The Record tab: every recent event of the employee's in words, beside its supervision figures
 * and the eight files it keeps.
 */
export function RecordView() {
  const { agent, arriving } = useEmployee();
  const agentId = agent._id;
  const events = useQuery(api.events.recent, { agentId, limit: RECENT_EVENTS });
  const metrics = useQuery(api.metrics.forAgent, { agentId });
  const workspace = useQuery(api.workspace.read, { agentId });
  const workItems = useQuery(api.work.listForAgent, { agentId });
  const itemTitles = useMemo(
    (): Map<string, string> => new Map((workItems ?? []).map((item) => [item._id, item.title])),
    [workItems],
  );
  return (
    <Columns
      arriving={arriving}
      aside={
        <>
          <MetricsCard metrics={metrics} />
          <WorkspacePanel workspace={workspace ?? {}} />
        </>
      }
    >
      <EventTicker events={events} titles={itemTitles} />
    </Columns>
  );
}
