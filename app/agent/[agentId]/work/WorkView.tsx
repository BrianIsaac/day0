'use client';

import { useMemo } from 'react';
import { useMutation, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@convex/_generated/api';
import { autonomousActionsOn } from '@/work/autonomy';
import { runHoldOf } from '@/work/item-display';
import { isPaused } from '@/work/pause';
import { needsYouItemIds } from '@/work/state-display';
import { Card } from '../../../components/Card';
import { Columns } from '../../../components/Columns';
import {
  AgreementProposals,
  KeptCorrectionsPanel,
  keptCorrectionsTitle,
  type KeptCorrection,
} from '../corrections-panel';
import { amendCharterHref } from '../employee-tabs';
import { useEmployee } from '../employee-context';
import { EmployeeRail } from '../EmployeeRail';
import { StateGlossary } from './StateGlossary';
import { refusedSkillsOf } from './VerdictSection';
import type { HoldingCard } from './WorkItemCard';
import { WorkQueue } from './WorkQueue';

/**
 * The plans a standing high-risk reorientation card holds, each by its work item (W-9): what
 * `reorientation.heldByReorientation` stops Day0 approving on its own.
 *
 * @param cards - The employee's cards, as the reorientation page lists them.
 */
export function holdingCardsOf(
  cards: FunctionReturnType<typeof api.reorientationDecisions.listForAgent>,
): Map<string, HoldingCard> {
  const held = new Map<string, HoldingCard>();
  for (const { card } of cards) {
    if (card.risk !== 'high' || card.status === 'applied' || card.status === 'dismissed') continue;
    for (const workItemId of card.blockingWork) {
      if (!held.has(workItemId)) {
        held.set(workItemId, { reorientationId: card._id, summary: card.triggerSummary });
      }
    }
  }
  return held;
}

/**
 * The Work tab: the employee's queue, what needs the manager first, beside the corrections the
 * manager asked it to keep and the working agreements Day0 proposes from them (real mode), and the
 * page's rail.
 */
export function WorkView() {
  const { agent, charter, surfaceMode, scheduledWorkPaused, surfaces, arriving } = useEmployee();
  const agentId = agent._id;
  const real = surfaceMode === 'real';
  const employeePaused = isPaused(agent);
  // What the cards say holds a step, in place of the step under way (12-P's words).
  const hold = useMemo(
    () => runHoldOf({ real, employeeName: agent.name, employeePaused, scheduledWorkPaused }),
    [real, agent.name, employeePaused, scheduledWorkPaused],
  );
  const workItems = useQuery(api.work.listForAgent, { agentId });
  const openQuestions = useQuery(api.managerQuestions.openForAgent, { agentId });
  // A plan's conflict question beside it (RM20 (a)): real mode only, as documentation conflicts are.
  const conflictQuestions = useQuery(
    api.managerQuestions.conflictsForAgent,
    real ? { agentId } : 'skip',
  );
  // The high-risk reorientation cards that hold a plan from Day0's own approval, so the plan's
  // card says so (W-9); the first card that names an item is the one said.
  const reorientationCards = useQuery(api.reorientationDecisions.listForAgent, { agentId });
  const heldByCards = useMemo(() => holdingCardsOf(reorientationCards ?? []), [reorientationCards]);
  const registeredSkills = useQuery(api.skills.registered, { agentId });
  // A card waiting on a skill whose draft failed its check says so and links to its Retry (D3).
  const failedSkills = useQuery(api.skills.verificationFailed, { agentId });
  const refusedSkills = useMemo(() => refusedSkillsOf(failedSkills ?? []), [failedSkills]);
  // Real mode only, as the corrections are: the mock keeps none.
  const correctionRows = useQuery(api.corrections.listForAgent, real ? { agentId } : 'skip');
  const corrections: KeptCorrection[] = correctionRows ?? [];
  // Real mode only: the mock has no switch, so nothing there ever flips it.
  const autonomyChanges = useQuery(api.events.autonomyChanges, real ? { agentId } : 'skip');
  const retireCorrection = useMutation(api.corrections.retire);
  // Real mode only, as agreements are: the working agreements Day0 proposes from the corrections.
  const agreements = useQuery(api.workingAgreements.listForAgent, real ? { agentId } : 'skip');
  const keepAgreement = useMutation(api.workingAgreements.keep);
  const dismissAgreement = useMutation(api.workingAgreements.dismiss);
  const recheckAgreement = useMutation(api.workingAgreements.recheck);
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
            <AgreementProposals
              agreements={agreements ?? []}
              employeeName={agent.name}
              charterHref={amendCharterHref(agentId)}
              onKeep={(agreementId, forEveryEmployee) =>
                keepAgreement({ agreementId, agentId, forEveryEmployee, via: 'promotion-card' })
              }
              onDismiss={(agreementId) => dismissAgreement({ agreementId, agentId })}
              onRecheck={(agreementId) => recheckAgreement({ agreementId, agentId })}
            />
          ) : null}
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
        conflictQuestions={conflictQuestions ?? []}
        heldByCards={heldByCards}
        surfaces={surfaces}
        registeredSkillCount={(registeredSkills ?? []).length}
        charterApproved={!!charter?.approved}
        autonomousActions={autonomousActionsOn(agent)}
        surfaceMode={surfaceMode}
        corrections={corrections}
        agreements={agreements ?? []}
        autonomyChanges={autonomyChanges ?? []}
        loading={workItems === undefined}
        employeeName={agent.name}
        managerKey={agent.userId}
        needsYou={needsYou}
        refusedSkills={refusedSkills}
        hold={hold}
      />
      <StateGlossary />
    </Columns>
  );
}
