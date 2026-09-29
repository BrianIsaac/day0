'use client';

import { useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import { autonomousActionsOn } from '@/work/autonomy';
import { managerNotificationMode } from '@/work/manager-notes';
import { shownEmployeeState } from '@/work/state-labels';
import { Card } from '../../../components/Card';
import { Columns } from '../../../components/Columns';
import { TONE_FILL } from '../../../components/tone';
import { useEmployee } from '../employee-context';
import { EmployeeRail } from '../EmployeeRail';
import { connectedManagerChannel } from '../manager-channel';
import { useNow } from '../time';
import { AutonomyControl } from './AutonomyControl';
import { NotificationModeControl } from './NotificationModeControl';

/**
 * The Manage tab: the switches that change how the employee works for the manager. In real mode,
 * once its charter is approved, the autonomous-actions switch with its confirmation, and, once a
 * chat surface has found the manager's DM, how the manager hears that work landed or a run
 * stopped. Where a switch does not apply, the tab says why instead.
 */
export function ManageView() {
  const { agent, charter, surfaceMode, surfaces, arriving } = useEmployee();
  const setAutonomousActions = useMutation(api.agents.setAutonomousActions);
  const setManagerNotifications = useMutation(api.agents.setManagerNotifications);
  const now = useNow();
  const active = shownEmployeeState(agent.state, charter) === 'active';
  const real = surfaceMode === 'real';
  const channel = connectedManagerChannel(surfaces, now) !== undefined;
  return (
    <Columns arriving={arriving} aside={<EmployeeRail />}>
      <Card title="Autonomous actions">
        {real && active ? (
          <div className="flex flex-wrap">
            <AutonomyControl
              on={autonomousActionsOn(agent)}
              tone={TONE_FILL.ok}
              onChange={(on) => setAutonomousActions({ agentId: agent._id, on })}
            />
          </div>
        ) : (
          <p className="text-sm text-[var(--color-fg-2)]">
            {!real
              ? 'The hosted office keeps this switch off: reads and the DM to you apply on their own, and every other write waits for your decision before it lands in the mock office.'
              : `The switch is here once ${agent.name}'s charter is approved.`}
          </p>
        )}
      </Card>
      {real ? (
        <Card title="Manager DMs">
          {active && channel ? (
            <NotificationModeControl
              mode={managerNotificationMode(agent)}
              onChange={(mode) => setManagerNotifications({ agentId: agent._id, mode })}
            />
          ) : (
            <p className="text-sm text-[var(--color-fg-2)]">
              Once a chat surface finds your DM, choose here how you hear that work landed or a run
              stopped. Decision requests go to it at once either way.
            </p>
          )}
        </Card>
      ) : null}
    </Columns>
  );
}
