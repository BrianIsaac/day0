'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import { autonomousActionsOn, autonomyLabel } from '@/work/autonomy';
import { managerNotificationMode } from '@/work/manager-notes';
import { shownEmployeeState } from '@/work/state-labels';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { Columns } from '../../../components/Columns';
import { Pill } from '../../../components/Pill';
import { useEmployee } from '../employee-context';
import { EmployeeRail } from '../EmployeeRail';
import { connectedManagerChannel } from '../manager-channel';
import { useNow } from '../time';
import { AutonomyControl } from './AutonomyControl';
import { NotificationModeControl } from './NotificationModeControl';
import { RetireDialog } from './RetireDialog';

/** The body copy of a Manage card. */
const COPY = 'text-sm text-[var(--color-fg-2)]';

/**
 * The Manage tab (round two section 3.9, `agent-manage.html`): the controls that change how the
 * employee works for the manager, and the one that ends its employment. In real mode, once its
 * charter is approved, the autonomous-actions switch with its confirmation, and, above the rail
 * (whose last card says where decisions reach the manager) once a chat surface has found the
 * manager's DM, how the manager hears that work landed or a run stopped. Pause is said to be absent, because the employee has no paused state; Retire opens
 * the retire dialog and, once the employee is gone, takes the manager to the company home.
 * Appearance is not drawn: the stylesheet carries no light theme.
 */
export function ManageView() {
  const { agent, charter, surfaceMode, surfaces, arriving } = useEmployee();
  const router = useRouter();
  const setAutonomousActions = useMutation(api.agents.setAutonomousActions);
  const setManagerNotifications = useMutation(api.agents.setManagerNotifications);
  const now = useNow();
  const [retiring, setRetiring] = useState(false);
  const active = shownEmployeeState(agent.state, charter) === 'active';
  const real = surfaceMode === 'real';
  const autonomous = autonomousActionsOn(agent);
  const channel = connectedManagerChannel(surfaces, now) !== undefined;

  const decisions = real ? (
    <Card title="Notifications">
      {active && channel ? (
        <NotificationModeControl
          mode={managerNotificationMode(agent)}
          onChange={(mode) => setManagerNotifications({ agentId: agent._id, mode })}
        />
      ) : (
        <p className={COPY}>
          {!active
            ? `Once ${agent.name}'s charter is approved, choose here how you hear that work landed or a run stopped.`
            : 'Once a chat surface finds your DM, choose here how you hear that work landed or a run stopped. Decision requests go to it at once either way.'}
        </p>
      )}
    </Card>
  ) : null;

  return (
    <Columns
      arriving={arriving}
      aside={
        <>
          {decisions}
          <EmployeeRail />
        </>
      }
    >
      <Card
        title="Autonomy"
        meta={
          real && active ? (
            <Pill tone={autonomous ? 'warn' : 'ok'}>{autonomyLabel(autonomous)}</Pill>
          ) : undefined
        }
      >
        {surfaceMode === undefined ? (
          <p className="text-sm text-[var(--color-muted)]">Loading the switch</p>
        ) : real && active ? (
          <AutonomyControl
            on={autonomous}
            onChange={(on) => setAutonomousActions({ agentId: agent._id, on })}
          />
        ) : (
          <p className={COPY}>
            {!real
              ? 'The hosted office has no switch: the employee holds its writes for your decision, and what you approve lands in the mock office only.'
              : `The switch is here once ${agent.name}'s charter is approved.`}
          </p>
        )}
      </Card>
      <Card title="Pause">
        {surfaceMode === undefined ? (
          <p className="text-sm text-[var(--color-muted)]">Loading</p>
        ) : (
          <p className={COPY}>
            {real
              ? `There is no pause for one employee: while ${agent.name} is employed it keeps reading its queue and working. To hold every write for your approval, leave autonomous actions off.`
              : `There is no pause for one employee: ${agent.name} keeps working through the hosted office's queue, and every write waits for your decision.`}
          </p>
        )}
      </Card>
      <Card title={`Retire ${agent.name}`} tone="danger">
        <div className="grid justify-items-start gap-3">
          {surfaceMode === undefined ? (
            <p className="text-sm text-[var(--color-muted)]">Loading</p>
          ) : (
            <p className={COPY}>
              {real
                ? `Ends ${agent.name}'s employment now. A credential only ${agent.name} binds is revoked at once, its working rows are deleted, and one record is kept so the audit export can say it existed.`
                : `Removes ${agent.name} and everything it made in the hosted office. Nothing is kept.`}
            </p>
          )}
          <Button
            variant="danger"
            disabled={surfaceMode === undefined}
            aria-haspopup="dialog"
            onClick={() => setRetiring(true)}
          >
            Retire {agent.name}…
          </Button>
        </div>
      </Card>
      {retiring && surfaceMode !== undefined ? (
        <RetireDialog
          agent={agent}
          mode={surfaceMode}
          onClose={() => setRetiring(false)}
          onRetired={() => router.replace('/')}
        />
      ) : null}
    </Columns>
  );
}
