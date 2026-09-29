'use client';

import { useMemo } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { autonomousActionsOn } from '@/work/autonomy';
import { needsYouItemIds } from '@/work/state-display';
import { Card } from '../../../components/Card';
import { Columns } from '../../../components/Columns';
import {
  KeptCorrectionsPanel,
  keptCorrectionsTitle,
  type KeptCorrection,
} from '../corrections-panel';
import { useEmployee } from '../employee-context';
import { EmployeeRail } from '../EmployeeRail';
import { StateGlossary } from './StateGlossary';
import { WorkQueue } from './WorkQueue';

/**
 * The Work tab: the employee's queue, what needs the manager first, beside the corrections the
 * manager asked it to keep (real mode) and the page's rail.
 */
export function WorkView() {
  const { agent, charter, surfaceMode, surfaces, arriving } = useEmployee();
  const agentId = agent._id;
  const real = surfaceMode === 'real';
  const workItems = useQuery(api.work.listForAgent, { agentId });
  const openQuestions = useQuery(api.managerQuestions.openForAgent, { agentId });
  const registeredSkills = useQuery(api.skills.registered, { agentId });
  // Real mode only, as the corrections are: the mock keeps none.
  const correctionRows = useQuery(api.corrections.listForAgent, real ? { agentId } : 'skip');
  const corrections: KeptCorrection[] = correctionRows ?? [];
  // Real mode only: the mock has no switch, so nothing there ever flips it.
  const autonomyChanges = useQuery(api.events.autonomyChanges, real ? { agentId } : 'skip');
  const retireCorrection = useMutation(api.corrections.retire);
  // The inbox's own read, which the shell already holds: the Needs you filter is its rule set.
  const inbox = useQuery(api.work.needsYouForAgent, { agentId });
  const needsYou = useMemo(() => needsYouItemIds(inbox?.entries ?? []), [inbox]);
  const itemTitles = useMemo(
    (): Map<string, string> => new Map((workItems ?? []).map((item) => [item._id, item.title])),
    [workItems],
  );
  return (
    <Columns
      arriving={arriving}
      aside={
        <>
          {real ? (
            <Card title={keptCorrectionsTitle(corrections)}>
              <KeptCorrectionsPanel
                corrections={corrections}
                titles={itemTitles}
                onRetire={(correctionId) => retireCorrection({ correctionId })}
              />
            </Card>
          ) : null}
          <EmployeeRail />
        </>
      }
    >
      <WorkQueue
        agentId={agentId}
        workItems={workItems ?? []}
        openQuestions={openQuestions ?? []}
        surfaces={surfaces}
        registeredSkillCount={(registeredSkills ?? []).length}
        charterApproved={!!charter?.approved}
        autonomousActions={autonomousActionsOn(agent)}
        surfaceMode={surfaceMode}
        corrections={corrections}
        autonomyChanges={autonomyChanges ?? []}
        loading={workItems === undefined}
        employeeName={agent.name}
        needsYou={needsYou}
      />
      <StateGlossary />
    </Columns>
  );
}
