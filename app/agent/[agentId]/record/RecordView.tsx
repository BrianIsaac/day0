'use client';

import { useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { Columns } from '../../../components/Columns';
import { useEmployee } from '../employee-context';
import { useAgentZone } from '../../../components/time';
import { KnowledgeProjection } from './KnowledgeProjection';
import { MetricsCard } from './MetricsCard';
import { RecordExport } from './RecordExport';
import { RecordFilters, RecordList, type RecordView as Shown } from './RecordList';
import { WorkspacePanel } from './WorkspacePanel';

/**
 * The Record tab (round two section 3.9): every event of the employee's in plain words, narrowed
 * by the filter chips and exported whole, beside what the employee knows, its figures so far and
 * its files.
 */
export function RecordView() {
  const { agent, arriving } = useEmployee();
  const zone = useAgentZone();
  const agentId = agent._id;
  const [shown, setShown] = useState<Shown>('all');
  const projection = useQuery(api.memoryProjection.forAgent, { agentId });
  const metrics = useQuery(api.metrics.forAgent, { agentId });
  const workspace = useQuery(api.workspace.read, { agentId });
  return (
    <Columns
      arriving={arriving}
      aside={
        <>
          <KnowledgeProjection name={agent.name} projection={projection} />
          <MetricsCard metrics={metrics} />
          <WorkspacePanel name={agent.name} workspace={workspace} />
        </>
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <RecordFilters selected={shown} onSelect={setShown} />
        <RecordExport agentId={agentId} name={agent.name} />
      </div>
      <RecordList agentId={agentId} name={agent.name} view={shown} />
      <p className="text-[13px] text-[var(--color-muted)]">
        Times in {zone ?? 'your zone'}, dated; the export carries the same instants. The payload
        behind each line is the event as it is stored, credential shapes taken out; the export also
        takes out the names its policy lists and every value you store.
      </p>
    </Columns>
  );
}
