'use client';

import { useMemo, useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { Card } from '../../../components/Card';
import { Columns } from '../../../components/Columns';
import { ReadBoundary } from '../../../components/ReadBoundary';
import { FiguresUnread } from '../EmployeeRail';
import { useEmployee } from '../employee-context';
import { useEmployeeFigures } from '../use-employee-figures';
import type { AgentMetrics } from '@/metrics/types';
import { useAgentZone } from '../../../components/time';
import { KnowledgeProjection } from './KnowledgeProjection';
import { MetricsCard } from './MetricsCard';
import { RecordExport } from './RecordExport';
import {
  RecordFilters,
  RecordList,
  type RecordManagers,
  type RecordView as Shown,
} from './RecordList';
import { WorkspacePanel } from './WorkspacePanel';

/**
 * The employee's figures so far, drawn under the tab's `ReadBoundary`: a read that failed is
 * thrown to it, so the record stands (C1, 17-FW; W16-R31), and the boundary draws the figures
 * again once the read, held above it, answers again (W17-R28).
 */
function RecordFigures({ read }: { read: AgentMetrics | undefined | Error }) {
  if (read instanceof Error) throw read;
  return <MetricsCard metrics={read} />;
}

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
  // Above the boundary, so it hears the read answer again; read by pages past one read (C1).
  const figures = useEmployeeFigures(agentId);
  const projection = useQuery(api.memoryProjection.forAgent, { agentId });
  const workspace = useQuery(api.workspace.read, { agentId });
  const earlier = useQuery(api.managerTransfers.earlierManagers, { agentId });
  const managers = useMemo(
    (): RecordManagers | undefined =>
      earlier === undefined ? undefined : { reader: agent.bossEmail, earlier },
    [earlier, agent.bossEmail],
  );
  return (
    <Columns
      arriving={arriving}
      aside={
        <>
          <KnowledgeProjection name={agent.name} projection={projection} />
          <ReadBoundary
            what="metrics.forAgent"
            resetKey={figures}
            fallback={
              <Card title="So far" meta="since deploy" tone="accent">
                <FiguresUnread />
              </Card>
            }
          >
            <RecordFigures read={figures} />
          </ReadBoundary>
          <WorkspacePanel name={agent.name} workspace={workspace} />
        </>
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <RecordFilters selected={shown} onSelect={setShown} />
        <RecordExport agentId={agentId} name={agent.name} />
      </div>
      <RecordList agentId={agentId} name={agent.name} view={shown} managers={managers} />
      <p className="text-[13px] text-[var(--color-muted)]">
        Times in {zone ?? 'your zone'}, dated; the export carries the same instants. The payload
        behind each line is the event as it is stored, credential shapes taken out; the export also
        takes out the names its policy lists and every value you store.
      </p>
    </Columns>
  );
}
